import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { safeEqual } from "../security.js";
import type { ChatService } from "../services/chat-service.js";
import { HttpError } from "./guards.js";

export function registerWebhookRoutes(app: FastifyInstance, chat: ChatService, config: AppConfig): void {
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
      to: query.to,
      from: query.from,
      message: query.message,
      providerMessageId: query.id,
      timestamp: query.timestamp,
      media: query.media
    });
    return reply.type("text/plain").send("ok");
  });
}
