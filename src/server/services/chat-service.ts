import type { AppConfig } from "../config.js";
import type { ChatMessage, Member, Reaction } from "../domain.js";
import type { SqliteStore } from "../db/store.js";
import type { ChatEventBus } from "../events.js";
import { markdownToPlainText } from "../markdown.js";
import { normalizePhone, samePhone } from "../phone.js";
import { maskPhone } from "../security.js";

export class ChatService {
  private wakeQueue?: () => void;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
    private readonly events: ChatEventBus
  ) {}

  setQueueWakeHandler(handler: () => void): void {
    this.wakeQueue = handler;
  }

  sendAppMessage(member: Member, input: { body: string; replyToMessageId?: string }): ChatMessage {
    const group = this.store.getDefaultGroup();
    if (!this.store.memberBelongsToGroup(member.id, group.id)) throw new Error("Member is not in this group");
    const body = input.body.trim();
    if (!body || !markdownToPlainText(body)) throw new Error("Message cannot be empty");
    if (body.length > this.config.messageMaxLength) throw new Error(`Message is limited to ${this.config.messageMaxLength} characters`);
    const result = this.store.createCanonicalMessage({
      groupId: group.id,
      senderMemberId: member.id,
      source: "APP",
      body,
      replyToMessageId: input.replyToMessageId,
      fanoutEnabled: this.config.smsEnabled,
      excludeSenderFromSms: false
    });
    this.events.emit("message", result.message);
    if (result.deliveryCount > 0) this.wakeQueue?.();
    return result.message;
  }

  receiveSms(input: {
    to: string;
    from: string;
    message: string;
    providerMessageId: string;
    timestamp?: string;
    media?: string;
  }): { message?: ChatMessage; duplicate: boolean; ignored: boolean } {
    const group = this.store.getDefaultGroup();
    if (!group.smsDid || !samePhone(input.to, group.smsDid, this.config.defaultPhoneRegion)) {
      this.store.recordSecurityEvent("WEBHOOK_WRONG_DID");
      return { duplicate: false, ignored: true };
    }
    let phone: string;
    try {
      phone = normalizePhone(input.from, this.config.defaultPhoneRegion);
    } catch {
      this.store.recordSecurityEvent("SMS_INVALID_SENDER");
      return { duplicate: false, ignored: true };
    }
    const member = this.store.getMemberByPhone(phone);
    if (!member?.active || !this.store.memberBelongsToGroup(member.id, group.id)) {
      this.store.recordSecurityEvent("SMS_UNKNOWN_NUMBER", maskPhone(phone));
      return { duplicate: false, ignored: true };
    }
    const body = input.message.trim();
    if (!body || body.length > this.config.messageMaxLength) {
      this.store.recordSecurityEvent("SMS_INVALID_MESSAGE", maskPhone(phone), { length: body.length });
      return { duplicate: false, ignored: true };
    }
    const result = this.store.createCanonicalMessage({
      groupId: group.id,
      senderMemberId: member.id,
      source: "SMS",
      body,
      externalProvider: "voipms",
      externalProviderId: input.providerMessageId,
      fanoutEnabled: this.config.smsEnabled,
      excludeSenderFromSms: true
    });
    if (!result.duplicate) {
      this.events.emit("message", result.message);
      if (result.deliveryCount > 0) this.wakeQueue?.();
    }
    return { message: result.message, duplicate: result.duplicate, ignored: false };
  }

  addReaction(member: Member, messageId: string, emoji: string): Reaction {
    if (!["👍", "❤️", "😂", "😮"].includes(emoji)) throw new Error("Unsupported reaction");
    const reaction = this.store.addReaction(messageId, member.id, emoji);
    this.events.emit("reaction", reaction);
    return reaction;
  }

  removeReaction(member: Member, messageId: string, emoji: string): boolean {
    const removed = this.store.removeReaction(messageId, member.id, emoji);
    if (removed) this.events.emit("reaction:removed", { messageId, memberId: member.id, emoji });
    return removed;
  }
}
