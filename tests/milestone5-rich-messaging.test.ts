import { afterEach, describe, expect, it } from "vitest";
import { markdownToPlainText, renderSmsText } from "../src/server/markdown.js";
import { createTestContext, type TestContext } from "./helpers.js";

let context: TestContext | undefined;
afterEach(async () => { await context?.close(); context = undefined; });

describe("milestone 5 rich messaging", () => {
  it("degrades the safe Markdown subset to readable SMS while preserving full links", () => {
    const plain = markdownToPlainText("**Dinner changed**\n\nPlease bring:\n- *drinks*\n- [`dessert`](https://example.com/menu)");
    expect(plain).toBe("Dinner changed\n\nPlease bring:\n- drinks\n- dessert (https://example.com/menu)");
    expect(plain).not.toContain("**");
  });

  it("formats reply context and truncates long quotes", () => {
    const text = renderSmsText({
      senderName: "Raphael",
      body: "**7:30 now.**",
      replySenderName: "David",
      replyBody: "Are we starting at 7? This is a deliberately long quoted message that should not consume the whole SMS.",
      maxLength: 2048
    });
    expect(text).toBe("Raphael → David “Are we starting at 7? This is a deliberately long quoted message that s…”: 7:30 now.");
  });

  it("never sends reaction noise to SMS members", async () => {
    context = await createTestContext({
      SMS_ENABLED: "true",
      VOIPMS_API_USERNAME: "api@example.com",
      VOIPMS_API_PASSWORD: "test-api-password",
      VOIPMS_SENDSMS_PARAMS_VERIFIED: "true"
    });
    const group = context.built.store.getDefaultGroup();
    const raphael = context.built.store.createMember({
      groupId: group.id, displayName: "Raphael", phoneNumberE164: "+14165550301", role: "ADMIN", deliveryMode: "APP"
    });
    context.built.store.createMember({
      groupId: group.id, displayName: "David", phoneNumberE164: "+14165550302", role: "MEMBER", deliveryMode: "SMS"
    });
    const message = context.built.chat.sendAppMessage(raphael, { body: "React to this" });
    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(1);

    context.built.chat.addReaction(raphael, message.id, "👍");
    expect(await context.built.worker.drainOnce()).toBe(0);
    expect(context.provider.sent).toHaveLength(1);
  });

  it("relays a PWA reply with concise quoted SMS context", async () => {
    context = await createTestContext({
      SMS_ENABLED: "true",
      VOIPMS_API_USERNAME: "api@example.com",
      VOIPMS_API_PASSWORD: "test-api-password",
      VOIPMS_SENDSMS_PARAMS_VERIFIED: "true"
    });
    const group = context.built.store.getDefaultGroup();
    const raphael = context.built.store.createMember({
      groupId: group.id, displayName: "Raphael", phoneNumberE164: "+14165550311", role: "ADMIN", deliveryMode: "APP"
    });
    const david = context.built.store.createMember({
      groupId: group.id, displayName: "David", phoneNumberE164: "+14165550312", role: "MEMBER", deliveryMode: "SMS"
    });
    context.built.store.createMember({
      groupId: group.id, displayName: "Sarah", phoneNumberE164: "+14165550313", role: "MEMBER", deliveryMode: "SMS"
    });
    const question = context.built.chat.receiveSms({
      provider: "voipms", to: "+14165550100", from: david.phoneNumberE164!, message: "Are we starting at 7?", providerMessageId: "reply-source"
    }).message!;
    await context.built.worker.drainOnce();
    context.provider.sent.splice(0);

    context.built.chat.sendAppMessage(raphael, { body: "**7:30 now.**", replyToMessageId: question.id });
    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(2);
    expect(context.provider.sent.every((item) => item.text === "Raphael → David “Are we starting at 7?”: 7:30 now.")).toBe(true);
  });
});
