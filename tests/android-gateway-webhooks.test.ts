import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryMode, Member, Role } from "../src/server/domain.js";
import { createTestContext, login, type TestContext } from "./helpers.js";

const DEVICE_ID = "device-abc123";
const PHONE_NUMBER = "+14165550500";
const WEBHOOK_SECRET = "android-webhook-secret-long-enough";
const SIGNING_KEY = "android-signing-key-long-enough";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

async function androidContext(): Promise<TestContext> {
  return createTestContext({
    SMS_PROVIDER: "android_gateway",
    SMS_ENABLED: "true",
    ANDROID_GATEWAY_URL: "http://192.168.50.25:8080",
    ANDROID_GATEWAY_USERNAME: "gateway-user",
    ANDROID_GATEWAY_PASSWORD: "gateway-password",
    ANDROID_GATEWAY_PHONE_NUMBER: PHONE_NUMBER,
    ANDROID_GATEWAY_DEVICE_ID: DEVICE_ID,
    ANDROID_GATEWAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
    ANDROID_GATEWAY_SIM_NUMBER: "1"
  }, "android_gateway");
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

async function postEvent(ctx: TestContext, event: unknown, input: { signature?: string; timestamp?: string } = {}) {
  const raw = JSON.stringify(event);
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = input.signature ?? createHmac("sha256", SIGNING_KEY).update(raw).update(timestamp).digest("hex");
  return ctx.built.app.inject({
    method: "POST",
    url: `/api/webhooks/android/${WEBHOOK_SECRET}`,
    headers: {
      "content-type": "application/json",
      "x-timestamp": timestamp,
      "x-signature": signature
    },
    payload: raw
  });
}

function baseEvent(event: string, payload: Record<string, unknown>, id = `event-${event}`) {
  return { deviceId: DEVICE_ID, event, id, webhookId: `bridge-${event}`, payload };
}

describe("Android gateway signed webhooks", () => {
  it("creates one canonical inbound message and fans out without sender echo", async () => {
    context = await androidContext();
    const david = addMember(context, "David", "+14165550511", "SMS");
    addMember(context, "Sarah", "+14165550512", "SMS");
    addMember(context, "Raphael", "+14165550513", "APP", "ADMIN");
    const event = baseEvent("sms:received", {
      messageId: "android-inbound-1",
      message: "I'll be there.",
      sender: david.phoneNumberE164,
      recipient: PHONE_NUMBER,
      simNumber: 1,
      receivedAt: "2026-08-20T12:00:00-04:00"
    });

    const first = await postEvent(context, event);
    const duplicate = await postEvent(context, { ...event, id: "retry-event-id" });
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const messages = context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderName: "David", source: "SMS", body: "I'll be there." });
    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(1);
    expect(context.provider.sent[0]).toMatchObject({ to: "+14165550512", text: "David: I'll be there." });
    expect(context.provider.sent[0]?.options?.idempotencyKey).toBeTruthy();
  });

  it("rejects unsigned, stale, wrong-device, wrong-SIM, and wrong-number callbacks", async () => {
    context = await androidContext();
    addMember(context, "David", "+14165550521", "SMS");
    const validPayload = {
      messageId: "blocked-inbound",
      message: "Do not insert",
      sender: "+14165550521",
      recipient: PHONE_NUMBER,
      simNumber: 1
    };

    const badSignature = await postEvent(context, baseEvent("sms:received", validPayload), { signature: "0".repeat(64) });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const stale = await postEvent(context, baseEvent("sms:received", validPayload), { timestamp: staleTimestamp });
    const wrongDevice = await postEvent(context, { ...baseEvent("sms:received", validPayload), deviceId: "another-device" });
    const wrongSim = await postEvent(context, baseEvent("sms:received", { ...validPayload, simNumber: 2 }));
    const wrongNumber = await postEvent(context, baseEvent("sms:received", { ...validPayload, recipient: "+14165550999" }));

    expect(badSignature.statusCode).toBe(404);
    expect(stale.statusCode).toBe(404);
    expect(wrongDevice.statusCode).toBe(200);
    expect(wrongSim.statusCode).toBe(200);
    expect(wrongNumber.statusCode).toBe(200);
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 })).toHaveLength(0);
  });

  it("tracks sent, delivered, and terminal failure status by gateway message ID", async () => {
    context = await androidContext();
    const raphael = addMember(context, "Raphael", "+14165550531", "APP", "ADMIN");
    addMember(context, "David", "+14165550532", "SMS");

    const deliveredMessage = context.built.chat.sendAppMessage(raphael, { body: "Status test" });
    await context.built.worker.drainOnce();
    const deliveredId = context.built.store.listDeliveriesForMessage(deliveredMessage.id)[0]!.providerMessageId!;

    await postEvent(context, baseEvent("sms:sent", {
      messageId: deliveredId,
      sender: PHONE_NUMBER,
      recipient: "+14165550532",
      simNumber: 1,
      partsCount: 2,
      sentAt: "2026-08-20T12:01:00-04:00"
    }, "sent-event"));
    expect(context.built.store.listDeliveriesForMessage(deliveredMessage.id)[0]).toMatchObject({
      status: "ACCEPTED",
      providerStatus: "SENT",
      providerPartsCount: 2
    });

    await postEvent(context, baseEvent("sms:delivered", {
      messageId: deliveredId,
      sender: PHONE_NUMBER,
      recipient: "+14165550532",
      simNumber: 1,
      deliveredAt: "2026-08-20T12:02:00-04:00"
    }, "delivered-event"));
    expect(context.built.store.listDeliveriesForMessage(deliveredMessage.id)[0]?.providerStatus).toBe("DELIVERED");

    await postEvent(context, baseEvent("sms:sent", {
      messageId: deliveredId,
      sender: PHONE_NUMBER,
      recipient: "+14165550532",
      simNumber: 1,
      partsCount: 2
    }, "late-sent-event"));
    expect(context.built.store.listDeliveriesForMessage(deliveredMessage.id)[0]?.providerStatus).toBe("DELIVERED");

    const failedMessage = context.built.chat.sendAppMessage(raphael, { body: "Failure test" });
    await context.built.worker.drainOnce();
    const failedId = context.built.store.listDeliveriesForMessage(failedMessage.id)[0]!.providerMessageId!;
    await postEvent(context, baseEvent("sms:failed", {
      messageId: failedId,
      sender: PHONE_NUMBER,
      recipient: "+14165550532",
      simNumber: 1,
      reason: "Network error for +14165550532",
      failedAt: "2026-08-20T12:03:00-04:00"
    }, "failed-event"));
    expect(context.built.store.listDeliveriesForMessage(failedMessage.id)[0]).toMatchObject({
      status: "FAILED",
      providerStatus: "FAILED",
      lastError: "Network error for [PHONE]"
    });

    await postEvent(context, baseEvent("sms:delivered", {
      messageId: failedId,
      sender: PHONE_NUMBER,
      recipient: "+14165550532",
      simNumber: 1
    }, "late-delivered-event"));
    expect(context.built.store.listDeliveriesForMessage(failedMessage.id)[0]).toMatchObject({
      status: "FAILED",
      providerStatus: "FAILED"
    });
  });

  it("records signed heartbeat health without making phone failure take down canonical chat", async () => {
    context = await androidContext();
    await postEvent(context, baseEvent("system:ping", {
      health: {
        status: "pass",
        version: "1.70.3",
        releaseId: 1703,
        checks: {
          "battery:level": { observedValue: 84, observedUnit: "percent", status: "pass" },
          "battery:charging": { observedValue: 4, observedUnit: "flags", status: "pass" },
          "connection:status": { observedValue: 1, observedUnit: "boolean", status: "pass" },
          "connection:cellular": { observedValue: 4, observedUnit: "index", status: "pass" }
        }
      }
    }, "ping-event"));

    expect(context.built.store.getGatewayHealth("android_gateway")).toMatchObject({
      status: "pass",
      version: "1.70.3",
      batteryLevel: 84,
      charging: true,
      connectionAvailable: true,
      cellularType: 4
    });
    const health = await context.built.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", database: "ok", smsGateway: { enabled: true, status: "pass" } });
  });

  it("surfaces phone heartbeat data to administrators", async () => {
    context = await androidContext();
    const raphael = addMember(context, "Raphael", "+14165550541", "APP", "ADMIN");
    await postEvent(context, baseEvent("app:started", {
      simCards: [{ slotIndex: 0, simNumber: 1, phoneNumber: PHONE_NUMBER, carrierName: "Test Carrier", iccid: "not-stored" }]
    }, "started-event"));
    const auth = await login(context, raphael.id);
    const response = await context.built.app.inject({
      method: "GET",
      url: "/api/admin/sms",
      headers: { cookie: auth.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bridge: { provider: "android_gateway", providerParametersVerified: true },
      gateway: { carrierName: "Test Carrier", stale: false }
    });
  });
});
