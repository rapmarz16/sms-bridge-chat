import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import { localDayKey } from "../markdown.js";
import { normalizePhone } from "../phone.js";
import type { AuthService } from "../services/auth-service.js";
import type { SmsQueueWorker } from "../services/sms-queue.js";
import { HttpError, requireAdmin, requireCsrf } from "./guards.js";

const memberInput = z.object({
  displayName: z.string().trim().min(1).max(80),
  phoneNumber: z.string().min(7).max(30),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
  deliveryMode: z.enum(["APP", "SMS", "BOTH"]).default("APP")
});

export function registerAdminRoutes(
  app: FastifyInstance,
  auth: AuthService,
  store: SqliteStore,
  config: AppConfig,
  worker: SmsQueueWorker
): void {
  app.get("/api/admin/members", async (request) => {
    requireAdmin(request, auth);
    return { members: store.listMembers(store.getDefaultGroup().id) };
  });

  app.post("/api/admin/members", async (request, reply) => {
    requireAdmin(request, auth);
    requireCsrf(request, config);
    const input = memberInput.parse(request.body);
    try {
      const member = store.createMember({
        groupId: store.getDefaultGroup().id,
        displayName: input.displayName,
        phoneNumberE164: normalizePhone(input.phoneNumber, config.defaultPhoneRegion),
        role: input.role,
        deliveryMode: input.deliveryMode
      });
      return reply.code(201).send({ member });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: members.phone_number_e164/.test(error.message)) {
        throw new HttpError("That phone number already belongs to a member", 409, "PHONE_EXISTS");
      }
      throw error;
    }
  });

  app.patch("/api/admin/members/:memberId", async (request) => {
    const admin = requireAdmin(request, auth);
    requireCsrf(request, config);
    const { memberId } = z.object({ memberId: z.string().uuid() }).parse(request.params);
    const input = memberInput.partial().extend({ active: z.boolean().optional() }).parse(request.body);
    if (admin.id === memberId && (input.active === false || input.role === "MEMBER")) {
      throw new HttpError("You cannot remove your own administrator access", 409, "SELF_ADMIN_LOCKOUT");
    }
    try {
      const member = store.updateMember(memberId, {
        displayName: input.displayName,
        phoneNumberE164: input.phoneNumber ? normalizePhone(input.phoneNumber, config.defaultPhoneRegion) : undefined,
        role: input.role,
        deliveryMode: input.deliveryMode,
        active: input.active
      });
      if (!member) throw new HttpError("Member not found", 404, "NOT_FOUND");
      return { member };
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: members.phone_number_e164/.test(error.message)) {
        throw new HttpError("That phone number already belongs to a member", 409, "PHONE_EXISTS");
      }
      throw error;
    }
  });

  app.patch("/api/admin/group/sms", async (request) => {
    requireAdmin(request, auth);
    requireCsrf(request, config);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    return { group: store.setGroupSmsEnabled(store.getDefaultGroup().id, enabled) };
  });

  app.get("/api/admin/sms", async (request) => {
    requireAdmin(request, auth);
    const used = store.getSmsUsage(localDayKey(Date.now(), config.timezone));
    const gatewayHealth = config.smsProvider === "android_gateway" ? store.getGatewayHealth("android_gateway") : undefined;
    const gatewayStale = gatewayHealth
      ? Date.now() - new Date(gatewayHealth.lastEventAt).getTime() > config.androidGatewayHealthStaleSeconds * 1000
      : true;
    return {
      usage: {
        used,
        limit: config.smsDailyLimit,
        percentage: Math.round((used / config.smsDailyLimit) * 100)
      },
      failures: store.listDeliveryFailures(),
      recentEvents: store.listRecentSmsEvents(),
      bridge: {
        configured: config.smsEnabled,
        enabled: store.getDefaultGroup().smsEnabled,
        provider: config.smsProvider,
        providerParametersVerified: config.smsProvider === "android_gateway" || config.voipmsSendSmsParamsVerified
      },
      gateway: config.smsProvider === "android_gateway" ? {
        status: gatewayStale ? "stale" : gatewayHealth?.status ?? "unknown",
        stale: gatewayStale,
        version: gatewayHealth?.version,
        batteryLevel: gatewayHealth?.batteryLevel,
        charging: gatewayHealth?.charging,
        connectionAvailable: gatewayHealth?.connectionAvailable,
        cellularType: gatewayHealth?.cellularType,
        carrierName: gatewayHealth?.carrierName,
        lastSeenAt: gatewayHealth?.lastEventAt,
        lastPingAt: gatewayHealth?.lastPingAt,
        lastAppStartedAt: gatewayHealth?.lastAppStartedAt
      } : undefined
    };
  });

  app.post("/api/admin/sms/:deliveryId/retry", async (request, reply) => {
    requireAdmin(request, auth);
    requireCsrf(request, config);
    const { deliveryId } = z.object({ deliveryId: z.string().uuid() }).parse(request.params);
    if (!store.retryDelivery(deliveryId, config.smsProvider)) throw new HttpError("Delivery cannot be retried", 409, "NOT_RETRYABLE");
    worker.wake();
    return reply.code(202).send({ queued: true });
  });
}
