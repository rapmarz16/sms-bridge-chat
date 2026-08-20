import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { SqliteStore } from "./db/store.js";
import { ChatEventBus } from "./events.js";
import { registerAdminRoutes } from "./http/routes-admin.js";
import { registerAttachmentRoutes } from "./http/routes-attachments.js";
import { registerAuthRoutes } from "./http/routes-auth.js";
import { registerChatRoutes } from "./http/routes-chat.js";
import { registerPushRoutes } from "./http/routes-push.js";
import { registerWebhookRoutes } from "./http/routes-webhook.js";
import { HttpError, SESSION_COOKIE } from "./http/guards.js";
import { cleanErrorMessage } from "./security.js";
import { AuthError, AuthService } from "./services/auth-service.js";
import { ChatService } from "./services/chat-service.js";
import { PushNotificationService, type PushTransport } from "./services/push-notification-service.js";
import { SmsQueueWorker } from "./services/sms-queue.js";
import { AndroidGatewayProvider } from "./sms/android-gateway.js";
import { DisabledSmsProvider, type SmsProvider } from "./sms/provider.js";
import { VoipMsProvider } from "./sms/voipms.js";

export type BuildAppOptions = {
  config?: AppConfig;
  store?: SqliteStore;
  provider?: SmsProvider;
  startWorker?: boolean;
  serveClient?: boolean;
  pushTransport?: PushTransport;
};

export type BuiltApp = {
  app: FastifyInstance;
  store: SqliteStore;
  events: ChatEventBus;
  auth: AuthService;
  chat: ChatService;
  push: PushNotificationService;
  worker: SmsQueueWorker;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const ownsStore = !options.store;
  const store = options.store ?? new SqliteStore(config.databasePath);
  store.ensureDefaultGroup(config.groupName, config.smsDid);
  store.pruneExpiredAuthData();
  mkdirSync(config.uploadsPath, { recursive: true });
  const provider = options.provider ?? (config.smsEnabled
    ? config.smsProvider === "android_gateway" ? new AndroidGatewayProvider(config) : new VoipMsProvider(config)
    : new DisabledSmsProvider());
  const events = new ChatEventBus();
  const auth = new AuthService(store, config, provider);
  const chat = new ChatService(store, config, events, provider.name);
  const push = new PushNotificationService(store, config, options.pushTransport);
  const worker = new SmsQueueWorker(store, config, provider);
  chat.setQueueWakeHandler(worker.wake);

  const app = Fastify({
    logger: config.logLevel === "silent" ? false : {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie", "password", "otp", "code"],
        censor: "[REDACTED]"
      }
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: "same-origin" }
  });
  await app.register(rateLimit, { global: true, max: 240, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.imageUploadMaxBytes, fields: 5 },
    throwFileSizeLimit: false
  });

  registerAuthRoutes(app, auth, config);
  registerChatRoutes(app, auth, chat, store, config);
  registerAttachmentRoutes(app, auth, chat, store, config);
  registerPushRoutes(app, auth, store, config);
  registerAdminRoutes(app, auth, store, config, worker);
  registerWebhookRoutes(app, chat, store, config);

  app.get("/health", async (_request, reply) => {
    const database = store.healthCheck() ? "ok" : "error";
    const gateway = config.smsProvider === "android_gateway" && config.smsEnabled
      ? store.getGatewayHealth("android_gateway")
      : undefined;
    const stale = gateway ? Date.now() - new Date(gateway.lastEventAt).getTime() > config.androidGatewayHealthStaleSeconds * 1000 : true;
    return reply.code(database === "ok" ? 200 : 503).send({
      status: database === "ok" ? "ok" : "error",
      database,
      webPush: { enabled: config.webPushEnabled },
      ...(config.smsProvider === "android_gateway" ? {
        smsGateway: {
          enabled: config.smsEnabled,
          status: !config.smsEnabled ? "disabled" : stale ? "stale" : gateway?.status ?? "unknown",
          lastSeenAt: gateway?.lastEventAt
        }
      } : {})
    });
  });

  const io = new SocketServer(app.server, {
    path: "/socket.io",
    serveClient: false,
    transports: ["websocket", "polling"]
  });
  io.use((socket, next) => {
    const cookies = app.parseCookie(socket.handshake.headers.cookie ?? "");
    const member = auth.authenticate(cookies[SESSION_COOKIE]);
    if (!member) return next(new Error("unauthorized"));
    socket.data.memberId = member.id;
    return next();
  });
  io.on("connection", (socket) => {
    socket.join(store.getDefaultGroup().id);
  });
  events.on("message", (message) => {
    io.to(message.groupId).emit("message:new", message);
    void push.notifyMessage(message).then((result) => {
      if (result.failed > 0) app.log.warn({ failed: result.failed }, "web push delivery failed");
    }).catch(() => app.log.warn("web push notification processing failed"));
  });
  events.on("reaction", (reaction) => io.to(store.getDefaultGroup().id).emit("reaction:added", reaction));
  events.on("message:deleted", (event) => io.to(event.groupId).emit("message:deleted", event));
  events.on("reaction:removed", (event) => io.to(store.getDefaultGroup().id).emit("reaction:removed", event));

  const clientRoot = resolve(process.cwd(), "dist/client");
  if (options.serveClient !== false && existsSync(clientRoot)) {
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/socket.io")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "NOT_FOUND", message: "Route not found" });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong";
    if (error instanceof ZodError) {
      statusCode = 400;
      code = "VALIDATION_ERROR";
      message = error.issues[0]?.message ?? "Invalid request";
    } else if (error instanceof HttpError || error instanceof AuthError) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
    } else if (error instanceof Error && error.message) {
      if (error.message.includes("Reply target") || error.message.includes("Message")) {
        statusCode = 400;
        code = "INVALID_MESSAGE";
        message = error.message;
      }
    }
    if (statusCode >= 500) {
      request.log.error({ error: cleanErrorMessage(error), route: request.routeOptions.url, method: request.method }, "request failed");
    }
    return reply.code(statusCode).send({ error: code, message });
  });

  app.addHook("onClose", async () => {
    worker.stop();
    io.close();
    if (ownsStore) store.close();
  });

  if (options.startWorker !== false) worker.start();
  return { app, store, events, auth, chat, push, worker };
}
