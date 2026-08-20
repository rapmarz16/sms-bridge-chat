export type SendResult = {
  accepted: boolean;
  providerMessageId?: string;
  providerStatus?: string;
};

export type SendOptions = {
  /** Stable per-delivery identifier used when the provider supports idempotent submission. */
  idempotencyKey?: string;
};

export type MediaItem = {
  url: string;
  mimeType: string;
};

export type InboundMediaReference = {
  messageId: string;
  partId: string | number;
};

export interface SmsProvider {
  readonly name: string;
  sendSms(to: string, text: string, options?: SendOptions): Promise<SendResult>;
  sendMms?(to: string, text: string, media: MediaItem[]): Promise<SendResult>;
  fetchInboundMedia?(reference: InboundMediaReference): Promise<Buffer>;
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly code = "PROVIDER_ERROR"
  ) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export class DisabledSmsProvider implements SmsProvider {
  readonly name = "disabled";

  async sendSms(): Promise<SendResult> {
    throw new SmsProviderError("SMS provider is not configured", false, "PROVIDER_DISABLED");
  }
}
