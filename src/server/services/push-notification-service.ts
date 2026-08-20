import webPush, { type PushSubscription } from "web-push";
import type { AppConfig } from "../config.js";
import type { ChatMessage } from "../domain.js";
import type { SqliteStore } from "../db/store.js";
import { markdownToPlainText } from "../markdown.js";

export interface PushTransport {
  send(subscription: PushSubscription, payload: string, ttlSeconds: number): Promise<void>;
}

export class StandardWebPushTransport implements PushTransport {
  constructor(private readonly config: AppConfig) {
    webPush.setVapidDetails(
      config.webPushVapidSubject,
      config.webPushVapidPublicKey!,
      config.webPushVapidPrivateKey!
    );
  }

  async send(subscription: PushSubscription, payload: string, ttlSeconds: number): Promise<void> {
    await webPush.sendNotification(subscription, payload, {
      TTL: ttlSeconds,
      urgency: "high"
    });
  }
}

export type PushNotificationResult = {
  sent: number;
  failed: number;
  removed: number;
};

function pushStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function notificationBody(message: ChatMessage): string {
  const plain = markdownToPlainText(message.body).replace(/\s+/g, " ").trim();
  if (!plain && message.attachments.length > 0) return "📷 Photo";
  return plain.length > 180 ? `${plain.slice(0, 179)}…` : plain;
}

export class PushNotificationService {
  private readonly transport?: PushTransport;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
    transport?: PushTransport
  ) {
    this.transport = transport ?? (config.webPushEnabled ? new StandardWebPushTransport(config) : undefined);
  }

  async notifyMessage(message: ChatMessage): Promise<PushNotificationResult> {
    if (!this.config.webPushEnabled || !this.transport) return { sent: 0, failed: 0, removed: 0 };
    const subscriptions = this.store.listPushSubscriptionsForGroup(message.groupId, message.senderMemberId);
    const payload = JSON.stringify({
      type: "message",
      title: message.senderName,
      body: notificationBody(message),
      tag: `message-${message.id}`,
      url: "/",
      messageId: message.id
    });
    const result: PushNotificationResult = { sent: 0, failed: 0, removed: 0 };

    await Promise.all(subscriptions.map(async (record) => {
      try {
        await this.transport!.send({
          endpoint: record.endpoint,
          expirationTime: record.expirationTime ?? null,
          keys: { p256dh: record.p256dh, auth: record.auth }
        }, payload, this.config.webPushTtlSeconds);
        this.store.markPushSubscriptionSuccess(record.endpoint);
        result.sent += 1;
      } catch (error) {
        const statusCode = pushStatusCode(error);
        if (statusCode === 404 || statusCode === 410) {
          this.store.deletePushSubscriptionByEndpoint(record.endpoint);
          result.removed += 1;
        } else {
          this.store.markPushSubscriptionFailure(record.endpoint);
          result.failed += 1;
        }
      }
    }));

    return result;
  }
}
