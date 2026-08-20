import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import { localDayKey } from "../markdown.js";
import type { AuthService } from "../services/auth-service.js";
import type { ChatService } from "../services/chat-service.js";
import { requireCsrf, requireMember } from "./guards.js";

const publicMember = (member: ReturnType<SqliteStore["getMemberById"]>) => member ? ({
  id: member.id,
  displayName: member.displayName,
  role: member.role,
  deliveryMode: member.deliveryMode,
  active: member.active
}) : undefined;

export function registerChatRoutes(
  app: FastifyInstance,
  auth: AuthService,
  chat: ChatService,
  store: SqliteStore,
  config: AppConfig
): void {
  app.get("/api/bootstrap", async (request) => {
    const member = requireMember(request, auth);
    const group = store.getDefaultGroup();
    const used = store.getSmsUsage(localDayKey(Date.now(), config.timezone));
    return {
      currentMember: member,
      group: { ...group, smsDid: undefined, smsEnabled: group.smsEnabled && config.smsEnabled },
      members: store.listMembers(group.id).filter((item) => item.active).map(publicMember),
      messages: store.listMessages(group.id, { limit: 50 }),
      smsUsage: {
        used,
        limit: config.smsDailyLimit,
        percentage: Math.round((used / config.smsDailyLimit) * 100),
        warning: used >= config.smsDailyLimit ? "STOPPED" : used >= config.smsDailyLimit * 0.95 ? "CRITICAL" : used >= config.smsDailyLimit * 0.8 ? "WARNING" : "OK"
      }
    };
  });

  app.get("/api/messages", async (request) => {
    const member = requireMember(request, auth);
    const group = store.getDefaultGroup();
    if (!store.memberBelongsToGroup(member.id, group.id)) return [];
    const query = z.object({
      before: z.coerce.number().int().positive().optional(),
      after: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50)
    }).parse(request.query);
    return { messages: store.listMessages(group.id, query) };
  });

  app.post("/api/messages", async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    const input = z.object({
      body: z.string().min(1).max(config.messageMaxLength),
      replyToMessageId: z.string().uuid().optional()
    }).parse(request.body);
    return reply.code(201).send({ message: chat.sendAppMessage(member, input) });
  });

  app.post("/api/messages/:messageId/reactions", async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    const params = z.object({ messageId: z.string().uuid() }).parse(request.params);
    const input = z.object({ emoji: z.enum(["👍", "❤️", "😂", "😮"]) }).parse(request.body);
    return reply.code(201).send({ reaction: chat.addReaction(member, params.messageId, input.emoji) });
  });

  app.delete("/api/messages/:messageId/reactions/:emoji", async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    const params = z.object({ messageId: z.string().uuid(), emoji: z.string().max(8) }).parse(request.params);
    chat.removeReaction(member, params.messageId, params.emoji);
    return reply.code(204).send();
  });
}
