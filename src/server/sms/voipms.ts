import type { AppConfig } from "../config.js";
import { SmsProviderError, type SendResult, type SmsProvider } from "./provider.js";

type VoipMsResponse = {
  status?: string;
  id?: string | number;
  sms_id?: string | number;
  message_id?: string | number;
  error?: string;
};

/**
 * All provider-specific field names deliberately live here. VoIP.ms publishes
 * the common authentication fields and method name publicly, while the full
 * sendSMS method reference is currently account-portal-only. Production sends
 * are gated by VOIPMS_SENDSMS_PARAMS_VERIFIED so an owner must compare this
 * adapter's did/dst/message mapping with the current portal reference first.
 */
export class VoipMsProvider implements SmsProvider {
  readonly name = "voipms";

  constructor(private readonly config: AppConfig) {}

  async sendSms(to: string, text: string): Promise<SendResult> {
    if (!this.config.voipmsSendSmsParamsVerified) {
      throw new SmsProviderError(
        "VoIP.ms sendSMS parameters have not been marked verified against the account portal",
        false,
        "PARAMETERS_NOT_VERIFIED"
      );
    }
    if (!this.config.voipmsApiUsername || !this.config.voipmsApiPassword || !this.config.voipmsDid) {
      throw new SmsProviderError("VoIP.ms credentials or DID are incomplete", false, "CONFIGURATION_ERROR");
    }

    const body = new URLSearchParams({
      api_username: this.config.voipmsApiUsername,
      api_password: this.config.voipmsApiPassword,
      method: "sendSMS",
      did: this.config.voipmsDid,
      dst: to,
      message: text,
      content_type: "json"
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.config.voipmsApiUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new SmsProviderError(`VoIP.ms returned HTTP ${response.status}`, response.status >= 500, `HTTP_${response.status}`);
      }
      let payload: VoipMsResponse;
      try {
        payload = await response.json() as VoipMsResponse;
      } catch {
        throw new SmsProviderError("VoIP.ms returned an unreadable response", true, "INVALID_RESPONSE");
      }
      if (payload.status?.toLowerCase() !== "success") {
        const detail = payload.error || payload.status || "unknown provider error";
        const transient = /timeout|temporar|unavailable|rate|try again/i.test(detail);
        throw new SmsProviderError(`VoIP.ms rejected the message: ${detail}`, transient, "REJECTED");
      }
      const id = payload.id ?? payload.sms_id ?? payload.message_id;
      return { accepted: true, providerMessageId: id == null ? undefined : String(id) };
    } catch (error) {
      if (error instanceof SmsProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SmsProviderError("VoIP.ms request timed out", true, "TIMEOUT");
      }
      throw new SmsProviderError("Unable to reach VoIP.ms", true, "NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}
