import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { DeliveryMode, Member, Role } from "../src/server/domain.js";
import { localDayKey } from "../src/server/markdown.js";
import { SmsProviderError } from "../src/server/sms/provider.js";
import { createTestContext, FakeSmsProvider, login, type TestContext } from "./helpers.js";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

async function reliableContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  return createTestContext({
    SMS_ENABLED: "true",
    VOIPMS_API_USERNAME: "api@example.com",
    VOIPMS_API_PASSWORD: "test-api-password",
    VOIPMS_SENDSMS_PARAMS_VERIFIED: "true",
    ...overrides
  });
}

function addMember(ctx: TestContext, name: string, phone: string, mode: DeliveryMode, role: Role = "MEMBER"): Member {
  return ctx.built.store.createMember({
    groupId: ctx.built.store.getDefaultGroup().id,
    displayName: name,
    phoneNumberE164: phone,
    role,
    deliveryMode: mode
  });
}

describe("milestone 4 reliability", () => {
  it("keeps the canonical message usable while a transient provider outage is queued for retry", async () => {
    context = await reliableContext();
    const raphael = addMember(context, "Raphael", "+14165550201", "APP", "ADMIN");
    addMember(context, "David", "+14165550202", "SMS");
    context.provider.failure = new SmsProviderError("temporary provider outage", true, "OUTAGE");

    const message = context.built.chat.sendAppMessage(raphael, { body: "Canonical first" });
    await context.built.worker.drainOnce();
    expect(context.built.store.getMessage(message.id)?.body).toBe("Canonical first");
    expect(context.built.store.listDeliveriesForMessage(message.id)[0]).toMatchObject({
      status: "PENDING", attempts: 1, lastError: "temporary provider outage"
    });
    expect(context.built.store.getSmsUsage(localDayKey(Date.now(), context.config.timezone))).toBe(1);
    const health = await context.built.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });

  it("bounds exponential retries and leaves a final visible failure", async () => {
    context = await reliableContext({ SMS_MAX_ATTEMPTS: "3" });
    const raphael = addMember(context, "Raphael", "+14165550211", "APP", "ADMIN");
    addMember(context, "David", "+14165550212", "SMS");
    context.provider.failure = new SmsProviderError("still unavailable", true, "OUTAGE");
    const message = context.built.chat.sendAppMessage(raphael, { body: "Retry safely" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await context.built.worker.drainOnce();
      context.built.store.db.prepare("UPDATE sms_deliveries SET available_at = 0 WHERE status = 'PENDING'").run();
    }
    const delivery = context.built.store.listDeliveriesForMessage(message.id)[0]!;
    expect(delivery.status).toBe("FAILED");
    expect(delivery.attempts).toBe(3);
    expect(context.provider.sent).toHaveLength(3);
    expect(context.built.store.listDeliveryFailures()[0]?.id).toBe(delivery.id);
  });

  it("does not repeatedly retry a permanent provider validation error", async () => {
    context = await reliableContext();
    const raphael = addMember(context, "Raphael", "+14165550221", "APP", "ADMIN");
    addMember(context, "David", "+14165550222", "SMS");
    context.provider.failure = new SmsProviderError("invalid destination", false, "VALIDATION");
    const message = context.built.chat.sendAppMessage(raphael, { body: "One attempt" });
    await context.built.worker.drainOnce();
    expect(context.built.store.listDeliveriesForMessage(message.id)[0]).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(context.provider.sent).toHaveLength(1);
  });

  it("stops fan-out at the daily limit but never discards the group message", async () => {
    context = await reliableContext({ SMS_DAILY_LIMIT: "2" });
    const raphael = addMember(context, "Raphael", "+14165550231", "APP", "ADMIN");
    addMember(context, "David", "+14165550232", "SMS");
    addMember(context, "Sarah", "+14165550233", "SMS");
    addMember(context, "Rachel", "+14165550234", "BOTH");
    const message = context.built.chat.sendAppMessage(raphael, { body: "All web users still see this" });
    await context.built.worker.drainOnce();

    expect(context.built.store.getMessage(message.id)).toBeTruthy();
    expect(context.provider.sent).toHaveLength(2);
    const statuses = context.built.store.listDeliveriesForMessage(message.id).map((item) => item.status).sort();
    expect(statuses).toEqual(["ACCEPTED", "ACCEPTED", "SKIPPED_LIMIT"]);
    expect(context.built.store.getSmsUsage(localDayKey(Date.now(), context.config.timezone))).toBe(2);

    const auth = await login(context, raphael.id);
    const bootstrap = await context.built.app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie: auth.cookie } });
    expect(bootstrap.json().smsUsage).toMatchObject({ used: 2, limit: 2, percentage: 100, warning: "STOPPED" });
  });

  it("resumes genuinely pending deliveries after an application restart", async () => {
    context = await reliableContext();
    const raphael = addMember(context, "Raphael", "+14165550241", "APP", "ADMIN");
    addMember(context, "David", "+14165550242", "SMS");
    const message = context.built.chat.sendAppMessage(raphael, { body: "Survive the restart" });
    expect(context.built.store.listDeliveriesForMessage(message.id)[0]?.status).toBe("PENDING");

    await context.built.app.close();
    const nextProvider = new FakeSmsProvider();
    const rebuilt = await buildApp({ config: context.config, provider: nextProvider, startWorker: false, serveClient: false });
    context.built = rebuilt;
    context.provider = nextProvider;
    await rebuilt.worker.drainOnce();
    expect(nextProvider.sent).toHaveLength(1);
    expect(rebuilt.store.listDeliveriesForMessage(message.id)[0]?.status).toBe("ACCEPTED");
  });

  it("does not blindly resend a delivery with an uncertain in-flight state after restart", async () => {
    context = await reliableContext();
    const raphael = addMember(context, "Raphael", "+14165550251", "APP", "ADMIN");
    addMember(context, "David", "+14165550252", "SMS");
    const message = context.built.chat.sendAppMessage(raphael, { body: "At-most-once restart safety" });
    expect(context.built.store.claimNextDelivery(Date.now())?.status).toBe("SENDING");

    await context.built.app.close();
    const nextProvider = new FakeSmsProvider();
    const rebuilt = await buildApp({ config: context.config, provider: nextProvider, startWorker: false, serveClient: false });
    context.built = rebuilt;
    context.provider = nextProvider;
    rebuilt.worker.start();
    rebuilt.worker.stop();
    expect(nextProvider.sent).toHaveLength(0);
    expect(rebuilt.store.listDeliveriesForMessage(message.id)[0]).toMatchObject({
      status: "FAILED",
      lastError: "Uncertain provider state after restart; not auto-retried"
    });
  });

  it("reports the 80 percent warning threshold to administrators", async () => {
    context = await reliableContext({ SMS_DAILY_LIMIT: "5" });
    const raphael = addMember(context, "Raphael", "+14165550261", "APP", "ADMIN");
    const dayKey = localDayKey(Date.now(), context.config.timezone);
    for (let index = 0; index < 4; index += 1) {
      context.built.store.reserveProviderAttempt({
        referenceType: "OTP", referenceId: `test-${index}`, provider: "fake", dayKey, dailyLimit: 5
      });
    }
    const auth = await login(context, raphael.id);
    const bootstrap = await context.built.app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie: auth.cookie } });
    expect(bootstrap.json().smsUsage).toMatchObject({ used: 4, limit: 5, percentage: 80, warning: "WARNING" });
  });
});
