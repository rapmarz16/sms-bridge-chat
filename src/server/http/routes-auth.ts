import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AuthService } from "../services/auth-service.js";
import { randomToken } from "../security.js";
import { CSRF_COOKIE, SESSION_COOKIE, requireCsrf, requireMember } from "./guards.js";

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, config: AppConfig): void {
  app.post("/api/auth/request-otp", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const input = z.object({ phone: z.string().min(7).max(30) }).parse(request.body);
    const result = await auth.requestOtp(input.phone);
    return reply.code(202).send(result);
  });

  app.post("/api/auth/verify-otp", {
    config: { rateLimit: { max: 12, timeWindow: "15 minutes" } }
  }, async (request, reply) => {
    const input = z.object({
      challengeId: z.string().min(8).max(128),
      code: z.string().regex(/^\d{6}$/)
    }).parse(request.body);
    const result = auth.verifyOtp(input.challengeId, input.code);
    const maxAge = config.sessionDays * 86_400;
    reply.setCookie(SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "strict",
      path: "/",
      maxAge
    });
    const csrf = randomToken(24);
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false,
      secure: config.secureCookies,
      sameSite: "strict",
      path: "/",
      maxAge
    });
    return { member: result.member };
  });

  app.get("/api/auth/me", async (request) => {
    const member = requireMember(request, auth);
    return { member };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    requireMember(request, auth);
    requireCsrf(request, config);
    auth.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
}
