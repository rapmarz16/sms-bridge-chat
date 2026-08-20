import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestContext, FakePushTransport, login, type TestContext } from "./helpers.js";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

const pushEnvironment = {
  WEB_PUSH_ENABLED: "true",
  WEB_PUSH_VAPID_PUBLIC_KEY: "test-public-key-that-is-long-enough-for-injected-transport",
  WEB_PUSH_VAPID_PRIVATE_KEY: "test-private-key-that-is-long-enough-for-injected-transport",
  WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.com",
  WEB_PUSH_TTL_SECONDS: "3600"
};

async function subscribe(memberId: string, endpoint: string): Promise<{ cookie: string; csrf: string }> {
  const auth = await login(context!, memberId);
  const response = await context!.built.app.inject({
    method: "POST",
    url: "/api/push/subscriptions",
    headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
    payload: {
      endpoint,
      expirationTime: null,
      keys: {
        p256dh: "test-p256dh-key-material-long-enough",
        auth: "test-auth-key"
      }
    }
  });
  expect(response.statusCode).toBe(201);
  return auth;
}

describe("standard background notifications", () => {
  it("stores a device subscription and pushes committed messages to app recipients but not the sender", async () => {
    const push = new FakePushTransport();
    context = await createTestContext(pushEnvironment, "fake", push);
    const group = context.built.store.getDefaultGroup();
    const sender = context.built.store.createMember({
      groupId: group.id, displayName: "Raphael", phoneNumberE164: "+14165550401", role: "ADMIN", deliveryMode: "APP"
    });
    const recipient = context.built.store.createMember({
      groupId: group.id, displayName: "Sarah", phoneNumberE164: "+14165550402", role: "MEMBER", deliveryMode: "BOTH"
    });
    await subscribe(sender.id, "https://push.example/sender-device");
    await subscribe(recipient.id, "https://push.example/recipient-device");
    const senderAuth = await login(context, sender.id);

    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: senderAuth.cookie, "x-csrf-token": senderAuth.csrf },
      payload: { body: "**Dinner** is at 7:30" }
    });
    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => expect(push.sent).toHaveLength(1));
    expect(push.sent[0]?.subscription.endpoint).toBe("https://push.example/recipient-device");
    expect(push.sent[0]?.ttlSeconds).toBe(3600);
    expect(JSON.parse(push.sent[0]!.payload)).toMatchObject({
      type: "message",
      title: "Raphael",
      body: "Dinner is at 7:30",
      messageId: response.json().message.id
    });
  });

  it("removes an expired browser endpoint after a 410 response", async () => {
    const push = new FakePushTransport();
    push.failure = { statusCode: 410 };
    context = await createTestContext(pushEnvironment, "fake", push);
    const group = context.built.store.getDefaultGroup();
    const sender = context.built.store.createMember({
      groupId: group.id, displayName: "Raphael", phoneNumberE164: "+14165550411", role: "ADMIN", deliveryMode: "APP"
    });
    const recipient = context.built.store.createMember({
      groupId: group.id, displayName: "David", phoneNumberE164: "+14165550412", role: "MEMBER", deliveryMode: "APP"
    });
    await subscribe(recipient.id, "https://push.example/expired-device");

    context.built.chat.sendAppMessage(sender, { body: "Hello" });
    await vi.waitFor(() => expect(push.sent).toHaveLength(1));
    await vi.waitFor(() => expect(context!.built.store.listPushSubscriptionsForGroup(group.id)).toHaveLength(0));
  });

  it("requires authentication and CSRF protection when registering a device", async () => {
    const push = new FakePushTransport();
    context = await createTestContext(pushEnvironment, "fake", push);
    const auth = await login(context);
    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: auth.cookie },
      payload: {
        endpoint: "https://push.example/device",
        keys: { p256dh: "test-p256dh-key-material-long-enough", auth: "test-auth-key" }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("CSRF_INVALID");
  });
});

describe("message deletion", () => {
  it("lets a member soft-delete their own app message and updates reply context", async () => {
    context = await createTestContext();
    const group = context.built.store.getDefaultGroup();
    const member = context.built.store.createMember({
      groupId: group.id, displayName: "Sarah", phoneNumberE164: "+14165550421", role: "MEMBER", deliveryMode: "APP"
    });
    const auth = await login(context, member.id);
    const original = context.built.chat.sendAppMessage(member, { body: "Original private text" });
    const reply = context.built.chat.sendAppMessage(member, { body: "Reply", replyToMessageId: original.id });

    const response = await context.built.app.inject({
      method: "DELETE",
      url: `/api/messages/${original.id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toMatchObject({ body: "Message removed", deletedAt: expect.any(String) });
    expect(context.built.store.getMessage(reply.id)?.replyTo?.body).toBe("Message removed");
  });

  it("prevents a member from deleting someone else's message but allows an administrator", async () => {
    context = await createTestContext();
    const group = context.built.store.getDefaultGroup();
    const admin = context.built.store.createMember({
      groupId: group.id, displayName: "Raphael", phoneNumberE164: "+14165550431", role: "ADMIN", deliveryMode: "APP"
    });
    const member = context.built.store.createMember({
      groupId: group.id, displayName: "David", phoneNumberE164: "+14165550432", role: "MEMBER", deliveryMode: "APP"
    });
    const message = context.built.chat.sendAppMessage(admin, { body: "Administrator message" });
    const memberAuth = await login(context, member.id);
    const forbidden = await context.built.app.inject({
      method: "DELETE",
      url: `/api/messages/${message.id}`,
      headers: { cookie: memberAuth.cookie, "x-csrf-token": memberAuth.csrf }
    });
    expect(forbidden.statusCode).toBe(403);

    const adminAuth = await login(context, admin.id);
    const deleted = await context.built.app.inject({
      method: "DELETE",
      url: `/api/messages/${message.id}`,
      headers: { cookie: adminAuth.cookie, "x-csrf-token": adminAuth.csrf }
    });
    expect(deleted.statusCode).toBe(200);
    expect(context.built.store.getMessage(message.id)?.body).toBe("Message removed");
  });

  it("does not let a member pretend an SMS-originated message was recalled", async () => {
    context = await createTestContext();
    const group = context.built.store.getDefaultGroup();
    const member = context.built.store.createMember({
      groupId: group.id, displayName: "David", phoneNumberE164: "+14165550441", role: "MEMBER", deliveryMode: "BOTH"
    });
    const message = context.built.store.createCanonicalMessage({
      groupId: group.id,
      senderMemberId: member.id,
      source: "SMS",
      body: "Already sent by SMS",
      smsProviderName: "fake",
      fanoutEnabled: false,
      excludeSenderFromSms: true
    }).message;
    const auth = await login(context, member.id);
    const response = await context.built.app.inject({
      method: "DELETE",
      url: `/api/messages/${message.id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }
    });
    expect(response.statusCode).toBe(403);
    expect(context.built.store.getMessage(message.id)?.deletedAt).toBeUndefined();
  });
});
