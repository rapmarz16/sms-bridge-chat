import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import { samePhone } from "../phone.js";
import { safeEqual } from "../security.js";
import type { ChatService } from "../services/chat-service.js";
import {
  androidGatewayWebhookSchema,
  verifyAndroidGatewaySignature,
  type AndroidGatewayWebhookEvent
} from "../sms/android-gateway.js";
import { HttpError } from "./guards.js";

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

function observedNumber(event: Extract<AndroidGatewayWebhookEvent, { event: "system:ping" }>, key: string): number | undefined {
  const value = event.payload.health.checks[key]?.observedValue;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function safeGatewayReason(reason?: string): string {
  return (reason?.trim() || "Android gateway reported a delivery failure")
    .replace(/\+?\d[\d() .-]{6,}\d/g, "[PHONE]")
    .slice(0, 500);
}

function webhookSimMatches(event: AndroidGatewayWebhookEvent, config: AppConfig): boolean {
  if (!("simNumber" in event.payload)) return true;
  return event.payload.simNumber == null || event.payload.simNumber === config.androidGatewaySimNumber;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  chat: ChatService,
  store: SqliteStore,
  config: AppConfig
): void {
  app.get("/api/webhooks/voipms/:secret", {
    config: { rateLimit: { max: 240, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { secret } = z.object({ secret: z.string().min(16).max(256) }).parse(request.params);
    if (!config.voipmsWebhookSecret || !safeEqual(secret, config.voipmsWebhookSecret)) {
      throw new HttpError("Webhook not found", 404, "NOT_FOUND");
    }
    const query = z.object({
      to: z.string().min(7).max(30),
      from: z.string().min(7).max(30),
      message: z.string().max(config.messageMaxLength),
      id: z.string().min(1).max(200),
      timestamp: z.string().max(100).optional(),
      media: z.string().max(4000).optional()
    }).parse(request.query);
    chat.receiveSms({
      provider: "voipms",
      to: query.to,
      from: query.from,
      message: query.message,
      providerMessageId: query.id,
      timestamp: query.timestamp,
      media: query.media
    });
    return reply.type("text/plain").send("ok");
  });

  app.register(async (androidRoutes) => {
    androidRoutes.removeContentTypeParser("application/json");
    androidRoutes.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request as RawBodyRequest).rawBody = rawBody;
      try {
        done(null, JSON.parse(rawBody.toString("utf8")));
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    androidRoutes.post("/api/webhooks/android/:secret", {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const { secret } = z.object({ secret: z.string().min(16).max(256) }).parse(request.params);
      if (
        config.smsProvider !== "android_gateway" ||
        !config.androidGatewayWebhookSecret ||
        !safeEqual(secret, config.androidGatewayWebhookSecret)
      ) {
        throw new HttpError("Webhook not found", 404, "NOT_FOUND");
      }

      const headers = z.object({
        "x-signature": z.string().min(1).max(200),
        "x-timestamp": z.string().regex(/^\d{10}$/)
      }).parse(request.headers);
      const rawBody = (request as RawBodyRequest).rawBody;
      const timestampSeconds = Number(headers["x-timestamp"]);
      const timestampIsFresh = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) <= config.androidGatewayWebhookMaxSkewSeconds;
      if (
        !rawBody ||
        !timestampIsFresh ||
        !config.androidGatewayWebhookSigningKey ||
        !verifyAndroidGatewaySignature({
          signingKey: config.androidGatewayWebhookSigningKey,
          rawBody,
          timestamp: headers["x-timestamp"],
          signature: headers["x-signature"]
        })
      ) {
        store.recordSecurityEvent("ANDROID_WEBHOOK_AUTH_FAILED");
        throw new HttpError("Webhook not found", 404, "NOT_FOUND");
      }

      const event = androidGatewayWebhookSchema.parse(request.body);
      if (!config.androidGatewayDeviceId || !safeEqual(event.deviceId, config.androidGatewayDeviceId)) {
        store.recordSecurityEvent("ANDROID_WEBHOOK_WRONG_DEVICE");
        return reply.send({ ok: true });
      }
      if (!webhookSimMatches(event, config)) {
        store.recordSecurityEvent("ANDROID_WEBHOOK_WRONG_SIM", undefined, { event: event.event });
        return reply.send({ ok: true });
      }

      store.updateGatewayHealth({ provider: "android_gateway", deviceId: event.deviceId });

      if (event.event === "sms:received") {
        const sender = event.payload.sender ?? event.payload.phoneNumber;
        if (!sender) {
          store.recordSecurityEvent("ANDROID_SMS_MISSING_SENDER");
          return reply.send({ ok: true });
        }
        const result = chat.receiveSms({
          provider: "android_gateway",
          to: event.payload.recipient ?? config.androidGatewayPhoneNumber ?? "",
          from: sender,
          message: event.payload.message,
          providerMessageId: event.payload.messageId,
          timestamp: event.payload.receivedAt
        });
        if (!result.ignored) {
          store.recordSecurityEvent(result.duplicate ? "ANDROID_SMS_DUPLICATE" : "ANDROID_SMS_ACCEPTED");
        }
        return reply.send({ ok: true });
      }

      if (event.event === "system:ping") {
        const batteryLevel = observedNumber(event, "battery:level");
        const charging = observedNumber(event, "battery:charging");
        const connectionAvailable = observedNumber(event, "connection:status");
        store.updateGatewayHealth({
          provider: "android_gateway",
          deviceId: event.deviceId,
          status: event.payload.health.status,
          version: event.payload.health.version,
          batteryLevel,
          charging: charging == null ? undefined : charging > 0,
          connectionAvailable: connectionAvailable == null ? undefined : connectionAvailable > 0,
          cellularType: observedNumber(event, "connection:cellular"),
          ping: true
        });
        return reply.send({ ok: true });
      }

      if (event.event === "app:started") {
        const selectedSim = event.payload.simCards.find((sim) => sim.simNumber === config.androidGatewaySimNumber);
        const wrongNumber = Boolean(
          selectedSim?.phoneNumber &&
          config.androidGatewayPhoneNumber &&
          !samePhone(selectedSim.phoneNumber, config.androidGatewayPhoneNumber, config.defaultPhoneRegion)
        );
        if (!selectedSim || wrongNumber) {
          store.recordSecurityEvent(!selectedSim ? "ANDROID_CONFIGURED_SIM_MISSING" : "ANDROID_SIM_NUMBER_MISMATCH");
        }
        store.updateGatewayHealth({
          provider: "android_gateway",
          deviceId: event.deviceId,
          status: !selectedSim || wrongNumber ? "warn" : undefined,
          carrierName: selectedSim?.carrierName ?? undefined,
          appStarted: true
        });
        return reply.send({ ok: true });
      }

      const status = event.event === "sms:sent" ? "SENT"
        : event.event === "sms:delivered" ? "DELIVERED"
          : event.event === "sms:cancelled" ? "CANCELLED"
            : "FAILED";
      const matched = store.updateDeliveryProviderStatus({
        provider: "android_gateway",
        providerMessageId: event.payload.messageId,
        providerStatus: status,
        partsCount: event.event === "sms:sent" ? event.payload.partsCount : undefined,
        error: event.event === "sms:failed" ? safeGatewayReason(event.payload.reason)
          : event.event === "sms:cancelled" ? "Android gateway cancelled the message"
            : undefined
      });
      if (!matched) store.recordSecurityEvent("ANDROID_STATUS_UNMATCHED", undefined, { event: event.event });
      return reply.send({ ok: true });
    });
  });
}
