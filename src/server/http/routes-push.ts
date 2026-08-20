import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import type { AuthService } from "../services/auth-service.js";
import { HttpError, requireCsrf, requireMember } from "./guards.js";

const endpoint = z.string().url().max(4096).refine((value) => new URL(value).protocol === "https:", {
  message: "Push endpoint must use HTTPS"
});

const subscriptionInput = z.object({
  endpoint,
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256)
  })
});

export function registerPushRoutes(
  app: FastifyInstance,
  auth: AuthService,
  store: SqliteStore,
  config: AppConfig
): void {
  app.post("/api/push/subscriptions", async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    if (!config.webPushEnabled) {
      throw new HttpError("Background notifications are not configured", 503, "PUSH_DISABLED");
    }
    const input = subscriptionInput.parse(request.body);
    store.upsertPushSubscription({
      memberId: member.id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expirationTime: input.expirationTime ?? undefined
    });
    return reply.code(201).send({ subscribed: true });
  });

  app.delete("/api/push/subscriptions", async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    const input = z.object({ endpoint }).parse(request.body);
    store.deletePushSubscription(member.id, input.endpoint);
    return reply.code(204).send();
  });
}
