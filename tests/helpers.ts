import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LightMyRequestResponse } from "fastify";
import { buildApp, type BuiltApp } from "../src/server/app.js";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import type { SendOptions, SendResult, SmsProvider } from "../src/server/sms/provider.js";
import type { PushTransport } from "../src/server/services/push-notification-service.js";
import type { PushSubscription } from "web-push";

export class FakeSmsProvider implements SmsProvider {
  readonly sent: Array<{ to: string; text: string; options?: SendOptions }> = [];
  failure?: Error;

  constructor(readonly name = "fake") {}

  async sendSms(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    this.sent.push({ to, text, options });
    if (this.failure) throw this.failure;
    return { accepted: true, providerMessageId: `fake-${this.sent.length}` };
  }
}

export class FakePushTransport implements PushTransport {
  readonly sent: Array<{ subscription: PushSubscription; payload: string; ttlSeconds: number }> = [];
  failure?: unknown;

  async send(subscription: PushSubscription, payload: string, ttlSeconds: number): Promise<void> {
    this.sent.push({ subscription, payload, ttlSeconds });
    if (this.failure) throw this.failure;
  }
}

export type TestContext = {
  built: BuiltApp;
  config: AppConfig;
  provider: FakeSmsProvider;
  directory: string;
  close: () => Promise<void>;
};

export async function createTestContext(
  overrides: Record<string, string> = {},
  providerName = "fake",
  pushTransport?: PushTransport
): Promise<TestContext> {
  const directory = mkdtempSync(join(tmpdir(), "sms-bridge-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    DATABASE_PATH: join(directory, "chat.db"),
    UPLOADS_PATH: join(directory, "uploads"),
    GROUP_NAME: "Family Chat",
    VOIPMS_DID: "+14165550100",
    VOIPMS_WEBHOOK_SECRET: "test-webhook-secret-123456",
    SMS_ENABLED: "false",
    SMS_DAILY_LIMIT: "100",
    DEV_OTP_BYPASS_CODE: "123456",
    LOG_LEVEL: "silent",
    ...overrides
  });
  const provider = new FakeSmsProvider(providerName);
  const built = await buildApp({ config, provider, pushTransport, startWorker: false, serveClient: false });
  return {
    built,
    config,
    provider,
    directory,
    close: async () => {
      await built.app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function cookieHeader(response: LightMyRequestResponse): { cookie: string; csrf: string } {
  const cookies = response.cookies;
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const csrf = cookies.find((item) => item.name === "sbc_csrf")?.value;
  if (!csrf) throw new Error("CSRF cookie was not returned");
  return { cookie, csrf };
}

export async function login(context: TestContext, memberId?: string): Promise<{ cookie: string; csrf: string }> {
  const group = context.built.store.getDefaultGroup();
  let member = memberId ? context.built.store.getMemberById(memberId) : undefined;
  member ??= context.built.store.createMember({
    groupId: group.id,
    displayName: "Raphael",
    phoneNumberE164: "+14165550101",
    role: "ADMIN",
    deliveryMode: "APP"
  });
  const requested = await context.built.app.inject({
    method: "POST",
    url: "/api/auth/request-otp",
    payload: { phone: member.phoneNumberE164 }
  });
  if (requested.statusCode !== 202) throw new Error(requested.body);
  const challengeId = requested.json<{ challengeId: string }>().challengeId;
  const verified = await context.built.app.inject({
    method: "POST",
    url: "/api/auth/verify-otp",
    payload: { challengeId, code: "123456" }
  });
  if (verified.statusCode !== 200) throw new Error(verified.body);
  return cookieHeader(verified);
}
