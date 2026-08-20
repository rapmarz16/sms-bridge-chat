import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryMode, Member, Role } from "../src/server/domain.js";
import { createTestContext, login, type TestContext } from "./helpers.js";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

async function bridgeContext(): Promise<TestContext> {
  return createTestContext({
    SMS_ENABLED: "true",
    VOIPMS_API_USERNAME: "api@example.com",
    VOIPMS_API_PASSWORD: "test-api-password",
    VOIPMS_SENDSMS_PARAMS_VERIFIED: "true"
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

function webhookUrl(input: { from: string; message: string; id: string; to?: string }): string {
  const query = new URLSearchParams({
    to: input.to ?? "+14165550100",
    from: input.from,
    message: input.message,
    id: input.id,
    timestamp: "2026-08-20T12:00:00Z",
    media: ""
  });
  return `/api/webhooks/voipms/test-webhook-secret-123456?${query.toString()}`;
}

describe("milestones 2 and 3 SMS bridge", () => {
  it("turns a known inbound SMS into one canonical message and fans out without sender echo", async () => {
    context = await bridgeContext();
    const david = addMember(context, "David", "+14165550111", "SMS");
    addMember(context, "Sarah", "+14165550112", "SMS");
    addMember(context, "Rachel", "+16465550113", "BOTH");
    addMember(context, "Raphael", "+14165550114", "APP", "ADMIN");
    const emitted: string[] = [];
    context.built.events.on("message", (message) => emitted.push(message.id));

    const response = await context.built.app.inject({
      method: "GET",
      url: webhookUrl({ from: david.phoneNumberE164!, message: "I'll be there.", id: "provider-in-1" })
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("ok");

    const messages = context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderName: "David", source: "SMS", body: "I'll be there." });
    expect(emitted).toEqual([messages[0]!.id]);

    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(2);
    expect(context.provider.sent.map((item) => item.to).sort()).toEqual(["+14165550112", "+16465550113"].sort());
    expect(context.provider.sent.every((item) => item.text === "David: I'll be there.")).toBe(true);
    expect(context.provider.sent.some((item) => item.to === david.phoneNumberE164)).toBe(false);
  });

  it("fans a PWA message out to every active SMS and BOTH member", async () => {
    context = await bridgeContext();
    const raphael = addMember(context, "Raphael", "+14165550121", "APP", "ADMIN");
    addMember(context, "David", "+14165550122", "SMS");
    addMember(context, "Sarah", "+14165550123", "SMS");
    addMember(context, "Rachel", "+16465550124", "BOTH");
    addMember(context, "App Only", "+14165550125", "APP");
    const auth = await login(context, raphael.id);

    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { body: "Dinner is at **7:30**." }
    });
    expect(response.statusCode).toBe(201);
    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(3);
    expect(context.provider.sent.every((item) => item.text === "Raphael: Dinner is at 7:30.")).toBe(true);
  });

  it("deduplicates retried callbacks before creating deliveries", async () => {
    context = await bridgeContext();
    addMember(context, "David", "+14165550131", "SMS");
    addMember(context, "Sarah", "+14165550132", "SMS");
    addMember(context, "Rachel", "+14165550133", "BOTH");
    const url = webhookUrl({ from: "+14165550131", message: "Only once", id: "same-provider-id" });

    const first = await context.built.app.inject({ method: "GET", url });
    const second = await context.built.app.inject({ method: "GET", url });
    expect(first.body).toBe("ok");
    expect(second.body).toBe("ok");
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 })).toHaveLength(1);

    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(2);
  });

  it("does not inject or relay messages from unknown numbers", async () => {
    context = await bridgeContext();
    addMember(context, "Sarah", "+14165550142", "SMS");
    const response = await context.built.app.inject({
      method: "GET",
      url: webhookUrl({ from: "+14165550999", message: "Let me in", id: "unknown-1" })
    });
    expect(response.body).toBe("ok");
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 })).toHaveLength(0);
    expect(await context.built.worker.drainOnce()).toBe(0);
    expect(context.provider.sent).toHaveLength(0);
  });

  it("rejects a bad webhook secret and ignores a callback for another DID", async () => {
    context = await bridgeContext();
    addMember(context, "David", "+14165550151", "SMS");
    const badSecret = await context.built.app.inject({
      method: "GET",
      url: "/api/webhooks/voipms/not-the-real-secret?to=14165550100&from=14165550151&message=Hi&id=bad"
    });
    expect(badSecret.statusCode).toBe(404);

    const wrongDid = await context.built.app.inject({
      method: "GET",
      url: webhookUrl({ to: "+14165550998", from: "+14165550151", message: "Wrong DID", id: "wrong-did" })
    });
    expect(wrongDid.body).toBe("ok");
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 })).toHaveLength(0);
  });

  it("stops accepting inbound bridge messages as soon as the admin kill switch is off", async () => {
    context = await bridgeContext();
    addMember(context, "David", "+14165550161", "SMS");
    context.built.store.setGroupSmsEnabled(context.built.store.getDefaultGroup().id, false);
    const response = await context.built.app.inject({
      method: "GET",
      url: webhookUrl({ from: "+14165550161", message: "Should be ignored", id: "disabled-1" })
    });
    expect(response.body).toBe("ok");
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 })).toHaveLength(0);
  });
});
