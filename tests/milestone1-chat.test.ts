import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { io } from "socket.io-client";
import { SqliteStore } from "../src/server/db/store.js";
import { createTestContext, login, type TestContext } from "./helpers.js";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

describe("milestone 1 local chat", () => {
  it("authenticates a pre-created member and creates a persistent session", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const response = await context.built.app.inject({
      method: "GET", url: "/api/auth/me", headers: { cookie: auth.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().member.displayName).toBe("Raphael");
    expect(response.json().member.role).toBe("ADMIN");
  });

  it("rejects state changes without the CSRF token", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const response = await context.built.app.inject({
      method: "POST", url: "/api/messages", headers: { cookie: auth.cookie }, payload: { body: "Hello" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("CSRF_INVALID");
  });

  it("normalizes the configured public origin while rejecting a genuinely different origin", async () => {
    context = await createTestContext({ APP_BASE_URL: "https://chat.example.com:443/" });
    const auth = await login(context);
    const accepted = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, origin: "https://chat.example.com" },
      payload: { body: "Correct public origin" }
    });
    expect(accepted.statusCode).toBe(201);

    const rejected = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, origin: "https://other.example.com" },
      payload: { body: "Wrong origin" }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error).toBe("ORIGIN_INVALID");
  });

  it("stores an app message, emits it, preserves markdown, and supports replies and reactions", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const events: string[] = [];
    context.built.events.on("message", (message) => events.push(message.id));

    const first = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { body: "**Dinner** is at 7:30" }
    });
    expect(first.statusCode).toBe(201);
    const firstMessage = first.json().message;
    expect(firstMessage.body).toBe("**Dinner** is at 7:30");
    expect(events).toEqual([firstMessage.id]);

    const reply = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { body: "Works for me 👍", replyToMessageId: firstMessage.id }
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().message.replyTo.body).toBe("**Dinner** is at 7:30");

    const reaction = await context.built.app.inject({
      method: "POST",
      url: `/api/messages/${firstMessage.id}/reactions`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { emoji: "❤️" }
    });
    expect(reaction.statusCode).toBe(201);

    const history = await context.built.app.inject({
      method: "GET", url: "/api/messages", headers: { cookie: auth.cookie }
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().messages).toHaveLength(2);
    expect(history.json().messages[0].reactions[0].emoji).toBe("❤️");
  });

  it("lets an administrator add, edit, and deactivate a member", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const added = await context.built.app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { displayName: "David", phoneNumber: "416-555-0102", role: "MEMBER", deliveryMode: "SMS" }
    });
    expect(added.statusCode).toBe(201);
    const david = added.json().member;
    expect(david.phoneNumberE164).toBe("+14165550102");

    const deactivated = await context.built.app.inject({
      method: "PATCH",
      url: `/api/admin/members/${david.id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { displayName: "David M.", deliveryMode: "BOTH", active: false }
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().member).toMatchObject({ displayName: "David M.", deliveryMode: "BOTH", active: false });
  });

  it("keeps canonical messages on disk across database restarts", async () => {
    context = await createTestContext();
    const path = context.config.databasePath;
    const group = context.built.store.getDefaultGroup();
    const member = context.built.store.createMember({
      groupId: group.id,
      displayName: "Sarah",
      phoneNumberE164: "+14165550103",
      role: "MEMBER",
      deliveryMode: "APP"
    });
    const created = context.built.store.createCanonicalMessage({
      groupId: group.id,
      senderMemberId: member.id,
      source: "APP",
      body: "Persist me",
      smsProviderName: "fake",
      fanoutEnabled: false,
      excludeSenderFromSms: false
    }).message;
    await context.built.app.close();
    const reopened = new SqliteStore(path);
    expect(reopened.getMessage(created.id)?.body).toBe("Persist me");
    reopened.close();
    rmSync(context.directory, { recursive: true, force: true });
    context = undefined;
  });

  it("pushes a committed message to an authenticated Socket.IO client", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const address = await context.built.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = io(address, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { cookie: auth.cookie }
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("socket connection timed out")), 3000);
      socket.once("connect", () => { clearTimeout(timeout); resolve(); });
      socket.once("connect_error", reject);
    });
    const pushed = new Promise<{ body: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("message event timed out")), 3000);
      socket.once("message:new", (message) => { clearTimeout(timeout); resolve(message); });
    });
    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { body: "Realtime delivery" }
    });
    expect(response.statusCode).toBe(201);
    await expect(pushed).resolves.toMatchObject({ body: "Realtime delivery" });
    socket.close();
  });
});
