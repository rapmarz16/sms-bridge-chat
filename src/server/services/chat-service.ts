import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { AttachmentInput, ChatMessage, Group, Member, Reaction } from "../domain.js";
import type { SqliteStore } from "../db/store.js";
import type { ChatEventBus } from "../events.js";
import { markdownToPlainText } from "../markdown.js";
import { normalizePhone, samePhone } from "../phone.js";
import { maskPhone } from "../security.js";
import {
  isAcceptedImageMimeType,
  normalizeUploadedImage,
  safeImageFilename
} from "./image-service.js";

type InboundTransportAddress = {
  to: string;
  from: string;
};

type InboundImage = {
  contentType: string;
  filename?: string;
  declaredSize?: number;
  load: () => Promise<Buffer>;
};

export class ChatService {
  private wakeQueue?: () => void;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
    private readonly events: ChatEventBus,
    private readonly smsProviderName: string
  ) {}

  setQueueWakeHandler(handler: () => void): void {
    this.wakeQueue = handler;
  }

  sendAppMessage(member: Member, input: {
    body?: string;
    replyToMessageId?: string;
    attachments?: AttachmentInput[];
  }): ChatMessage {
    const group = this.store.getDefaultGroup();
    if (!this.store.memberBelongsToGroup(member.id, group.id)) throw new Error("Member is not in this group");
    const body = input.body?.trim() ?? "";
    if ((!body || !markdownToPlainText(body)) && !input.attachments?.length) throw new Error("Message cannot be empty");
    if (body.length > this.config.messageMaxLength) throw new Error(`Message is limited to ${this.config.messageMaxLength} characters`);
    const result = this.store.createCanonicalMessage({
      groupId: group.id,
      senderMemberId: member.id,
      source: "APP",
      body,
      replyToMessageId: input.replyToMessageId,
      smsProviderName: this.smsProviderName,
      fanoutEnabled: this.config.smsEnabled,
      excludeSenderFromSms: false,
      attachments: input.attachments
    });
    this.events.emit("message", result.message);
    if (result.deliveryCount > 0) this.wakeQueue?.();
    return result.message;
  }

  receiveSms(input: {
    provider: string;
    to: string;
    from: string;
    message: string;
    providerMessageId: string;
    timestamp?: string;
    media?: string;
  }): { message?: ChatMessage; duplicate: boolean; ignored: boolean } {
    const participant = this.resolveInboundParticipant(input);
    if (!participant) return { duplicate: false, ignored: true };
    const { group, member, phone } = participant;
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
      externalProvider: input.provider,
      externalProviderId: input.providerMessageId,
      smsProviderName: this.smsProviderName,
      fanoutEnabled: this.config.smsEnabled,
      excludeSenderFromSms: true
    });
    if (!result.duplicate) {
      this.events.emit("message", result.message);
      if (result.deliveryCount > 0) this.wakeQueue?.();
    }
    return { message: result.message, duplicate: result.duplicate, ignored: false };
  }

  async receiveMms(input: {
    provider: string;
    to: string;
    from: string;
    message: string;
    subject?: string;
    providerMessageId: string;
    timestamp?: string;
    attachments: InboundImage[];
  }): Promise<{ message?: ChatMessage; duplicate: boolean; ignored: boolean }> {
    const participant = this.resolveInboundParticipant(input);
    if (!participant) return { duplicate: false, ignored: true };
    const { group, member, phone } = participant;
    const message = input.message.trim();
    const subject = input.subject?.trim() ?? "";
    const body = [subject && subject !== message ? subject : "", message].filter(Boolean).join("\n");
    if (body.length > this.config.messageMaxLength) {
      this.store.recordSecurityEvent("MMS_INVALID_MESSAGE", maskPhone(phone), { length: body.length });
      return { duplicate: false, ignored: true };
    }

    const supported = input.attachments
      .filter((attachment) => isAcceptedImageMimeType(attachment.contentType))
      .slice(0, 3);
    if (supported.length < input.attachments.length) {
      this.store.recordSecurityEvent("MMS_UNSUPPORTED_ATTACHMENTS", maskPhone(phone), {
        received: input.attachments.length,
        acceptedCandidates: supported.length
      });
    }

    const stored: AttachmentInput[] = [];
    try {
      for (const attachment of supported) {
        if (attachment.declaredSize && attachment.declaredSize > this.config.imageUploadMaxBytes) {
          this.store.recordSecurityEvent("MMS_ATTACHMENT_TOO_LARGE", maskPhone(phone), {
            size: attachment.declaredSize
          });
          continue;
        }
        const source = await attachment.load();
        if (source.length === 0 || source.length > this.config.imageUploadMaxBytes) {
          this.store.recordSecurityEvent("MMS_ATTACHMENT_TOO_LARGE", maskPhone(phone), { size: source.length });
          continue;
        }
        let normalized: Buffer;
        try {
          normalized = await normalizeUploadedImage(source, {
            maxDimension: this.config.imageMaxDimension,
            quality: this.config.imageWebpQuality,
            maxOutputBytes: this.config.imageUploadMaxBytes
          });
        } catch {
          this.store.recordSecurityEvent("MMS_INVALID_ATTACHMENT", maskPhone(phone));
          continue;
        }
        const id = randomUUID();
        const storagePath = `${id}.webp`;
        await writeFile(resolve(this.config.uploadsPath, storagePath), normalized, { flag: "wx", mode: 0o600 });
        stored.push({
          id,
          type: "IMAGE",
          storagePath,
          originalFilename: safeImageFilename(attachment.filename),
          mimeType: "image/webp",
          size: normalized.length
        });
      }

      if (!body && stored.length === 0) {
        this.store.recordSecurityEvent("MMS_NO_SUPPORTED_CONTENT", maskPhone(phone));
        return { duplicate: false, ignored: true };
      }
      const result = this.store.createCanonicalMessage({
        groupId: group.id,
        senderMemberId: member.id,
        source: "SMS",
        body,
        externalProvider: input.provider,
        externalProviderId: input.providerMessageId,
        smsProviderName: this.smsProviderName,
        fanoutEnabled: this.config.smsEnabled,
        excludeSenderFromSms: true,
        attachments: stored
      });
      if (result.duplicate) {
        await this.removeStoredFiles(stored);
      } else {
        this.events.emit("message", result.message);
        if (result.deliveryCount > 0) this.wakeQueue?.();
      }
      return { message: result.message, duplicate: result.duplicate, ignored: false };
    } catch (error) {
      await this.removeStoredFiles(stored);
      throw error;
    }
  }

  private resolveInboundParticipant(input: InboundTransportAddress):
    | { group: Group; member: Member; phone: string }
    | undefined {
    const group = this.store.getDefaultGroup();
    if (!this.config.smsEnabled || !group.smsEnabled) {
      this.store.recordSecurityEvent("SMS_BRIDGE_DISABLED");
      return undefined;
    }
    if (!group.smsDid || !samePhone(input.to, group.smsDid, this.config.defaultPhoneRegion)) {
      this.store.recordSecurityEvent("WEBHOOK_WRONG_DID");
      return undefined;
    }
    let phone: string;
    try {
      phone = normalizePhone(input.from, this.config.defaultPhoneRegion);
    } catch {
      this.store.recordSecurityEvent("SMS_INVALID_SENDER");
      return undefined;
    }
    const member = this.store.getMemberByPhone(phone);
    if (!member?.active || !this.store.memberBelongsToGroup(member.id, group.id)) {
      this.store.recordSecurityEvent("SMS_UNKNOWN_NUMBER", maskPhone(phone));
      return undefined;
    }
    return { group, member, phone };
  }

  private async removeStoredFiles(attachments: AttachmentInput[]): Promise<void> {
    await Promise.all(attachments.map((attachment) =>
      unlink(resolve(this.config.uploadsPath, attachment.storagePath)).catch(() => undefined)
    ));
  }

  addReaction(member: Member, messageId: string, emoji: string): Reaction {
    if (!["👍", "❤️", "😂", "😮"].includes(emoji)) throw new Error("Unsupported reaction");
    const message = this.store.getMessage(messageId);
    if (!message || !this.store.memberBelongsToGroup(member.id, message.groupId)) throw new Error("Message not found");
    const reaction = this.store.addReaction(messageId, member.id, emoji);
    this.events.emit("reaction", reaction);
    return reaction;
  }

  removeReaction(member: Member, messageId: string, emoji: string): boolean {
    const message = this.store.getMessage(messageId);
    if (!message || !this.store.memberBelongsToGroup(member.id, message.groupId)) throw new Error("Message not found");
    const removed = this.store.removeReaction(messageId, member.id, emoji);
    if (removed) this.events.emit("reaction:removed", { messageId, memberId: member.id, emoji });
    return removed;
  }

  deleteMessage(member: Member, messageId: string):
    | { status: "NOT_FOUND" }
    | { status: "FORBIDDEN" }
    | { status: "DELETED"; message: ChatMessage } {
    const message = this.store.getMessage(messageId);
    if (!message || !this.store.memberBelongsToGroup(member.id, message.groupId)) return { status: "NOT_FOUND" };
    const canDelete = member.role === "ADMIN" || (message.senderMemberId === member.id && message.source === "APP");
    if (!canDelete) return { status: "FORBIDDEN" };
    if (message.deletedAt) return { status: "DELETED", message };
    const deleted = this.store.softDeleteMessage(messageId)!;
    this.events.emit("message:deleted", {
      messageId: deleted.id,
      groupId: deleted.groupId,
      deletedAt: deleted.deletedAt!
    });
    return { status: "DELETED", message: deleted };
  }
}
