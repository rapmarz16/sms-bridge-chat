export type SendResult = {
  accepted: boolean;
  providerMessageId?: string;
};

export type MediaItem = {
  url: string;
  mimeType: string;
};

export interface SmsProvider {
  readonly name: string;
  sendSms(to: string, text: string): Promise<SendResult>;
  sendMms?(to: string, text: string, media: MediaItem[]): Promise<SendResult>;
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
