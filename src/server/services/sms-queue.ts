import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import { localDayKey, renderSmsText } from "../markdown.js";
import { cleanErrorMessage } from "../security.js";
import { SmsProviderError, type SmsProvider } from "../sms/provider.js";

export class SmsQueueWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
    private readonly provider: SmsProvider
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.failUncertainSendingDeliveries();
    this.store.failInactiveProviderDeliveries(this.config.smsProvider);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  wake = (): void => {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  };

  async drainOnce(maxItems = 25): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let handled = 0;
    try {
      while (handled < maxItems) {
        const delivery = this.store.claimNextDelivery(Date.now());
        if (!delivery) break;
        handled += 1;
        await this.processDelivery(delivery.id);
      }
      return handled;
    } finally {
      this.running = false;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      try {
        await this.drainOnce();
      } finally {
        if (!this.stopped) this.schedule(this.config.smsPollIntervalMs);
      }
    }, delay);
    this.timer.unref();
  }

  private async processDelivery(id: string): Promise<void> {
    const delivery = this.store.getDelivery(id);
    if (!delivery) return;
    const group = this.store.getDefaultGroup();
    if (!this.config.smsEnabled || !group.smsEnabled) {
      this.store.markDeliveryFailed(id, "SMS bridge disabled", "SKIPPED");
      return;
    }
    const message = this.store.getMessage(delivery.messageId);
    if (!message) {
      this.store.markDeliveryFailed(id, "Canonical message not found");
      return;
    }
    const smsBody = [
      message.body,
      message.attachments.length > 0 ? "[Photo — view in app]" : ""
    ].filter(Boolean).join("\n");
    const text = renderSmsText({
      senderName: message.senderName,
      body: smsBody,
      replySenderName: message.replyTo?.senderName,
      replyBody: message.replyTo?.body,
      maxLength: this.config.smsTextMaxLength
    });
    const dayKey = localDayKey(Date.now(), this.config.timezone);
    const reservation = this.store.reserveProviderAttempt({
      referenceType: "DELIVERY",
      referenceId: id,
      provider: this.provider.name,
      dayKey,
      dailyLimit: this.config.smsDailyLimit
    });
    if (!reservation.allowed || !reservation.attemptId) {
      this.store.markDeliveryFailed(id, "Daily SMS limit reached", "SKIPPED_LIMIT");
      return;
    }
    try {
      const result = await this.provider.sendSms(delivery.phoneNumber, text, { idempotencyKey: delivery.id });
      if (!result.accepted) throw new SmsProviderError("Provider did not accept message", true);
      this.store.finishProviderAttempt(reservation.attemptId, "ACCEPTED");
      this.store.markDeliveryAccepted(id, result.providerMessageId, result.providerStatus);
    } catch (error) {
      const safeError = cleanErrorMessage(error);
      this.store.finishProviderAttempt(reservation.attemptId, "FAILED", safeError);
      const transient = error instanceof SmsProviderError ? error.transient : true;
      if (transient && delivery.attempts < this.config.smsMaxAttempts) {
        const delay = Math.min(300_000, 5_000 * 2 ** Math.max(0, delivery.attempts - 1));
        this.store.markDeliveryRetry(id, safeError, Date.now() + delay);
      } else {
        this.store.markDeliveryFailed(id, safeError);
      }
    }
  }
}
