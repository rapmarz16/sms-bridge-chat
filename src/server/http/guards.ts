import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Member } from "../domain.js";
import type { AuthService } from "../services/auth-service.js";
import { safeEqual } from "../security.js";

export const SESSION_COOKIE = "sbc_session";
export const CSRF_COOKIE = "sbc_csrf";

export class HttpError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "BAD_REQUEST") {
    super(message);
    this.name = "HttpError";
  }
}

export function requireMember(request: FastifyRequest, auth: AuthService): Member {
  const member = auth.authenticate(request.cookies[SESSION_COOKIE]);
  if (!member) throw new HttpError("Sign in to continue", 401, "UNAUTHENTICATED");
  return member;
}

export function requireAdmin(request: FastifyRequest, auth: AuthService): Member {
  const member = requireMember(request, auth);
  if (member.role !== "ADMIN") throw new HttpError("Administrator access required", 403, "FORBIDDEN");
  return member;
}

export function requireCsrf(request: FastifyRequest, config: AppConfig): void {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || !safeEqual(cookie, header)) {
    throw new HttpError("Security token is missing or invalid", 403, "CSRF_INVALID");
  }
  const origin = request.headers.origin;
  if (origin && origin !== config.appBaseUrl) {
    throw new HttpError("Request origin is not allowed", 403, "ORIGIN_INVALID");
  }
}
