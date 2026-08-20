import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { SmsProviderError, type SendOptions, type SendResult, type SmsProvider } from "./provider.js";

type AndroidMessageResponse = {
  id?: string;
  state?: string;
  reason?: string;
  error?: string;
  message?: string;
};

type AndroidHealthResponse = {
  status?: string;
  version?: string;
  releaseId?: string | number;
  checks?: Record<string, unknown>;
};

export const ANDROID_GATEWAY_WEBHOOK_EVENTS = [
  "sms:received",
  "sms:sent",
  "sms:delivered",
  "sms:failed",
  "sms:cancelled",
  "system:ping",
  "app:started"
] as const;

export type AndroidGatewayWebhookEventName = typeof ANDROID_GATEWAY_WEBHOOK_EVENTS[number];

const nullablePhone = z.string().trim().min(1).max(40).nullable().optional();
const nullableSim = z.number().int().min(1).max(3).nullable().optional();
const eventFields = {
  deviceId: z.string().trim().min(1).max(200),
  id: z.string().trim().min(1).max(200),
  webhookId: z.string().trim().min(1).max(200).optional()
};
const statusPayload = {
  messageId: z.string().trim().min(1).max(200),
  sender: nullablePhone,
  recipient: nullablePhone,
  simNumber: nullableSim
};
const healthCheckSchema = z.object({
  description: z.string().max(300).optional(),
  observedUnit: z.string().max(80).optional(),
  observedValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
  status: z.enum(["pass", "warn", "fail"]).optional()
}).passthrough();

export const androidGatewayWebhookSchema = z.discriminatedUnion("event", [
  z.object({
    ...eventFields,
    event: z.literal("sms:received"),
    payload: z.object({
      messageId: z.string().trim().min(1).max(200),
      message: z.string().max(10_000),
      sender: nullablePhone,
      recipient: nullablePhone,
      simNumber: nullableSim,
      receivedAt: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("sms:sent"),
    payload: z.object({
      ...statusPayload,
      partsCount: z.number().int().min(1).max(100).optional(),
      sentAt: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("sms:delivered"),
    payload: z.object({
      ...statusPayload,
      deliveredAt: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("sms:failed"),
    payload: z.object({
      ...statusPayload,
      reason: z.string().trim().min(1).max(500).optional(),
      failedAt: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("sms:cancelled"),
    payload: z.object({
      ...statusPayload,
      cancelledAt: z.string().max(100).optional()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("system:ping"),
    payload: z.object({
      health: z.object({
        status: z.enum(["pass", "warn", "fail"]),
        version: z.string().max(80).optional(),
        releaseId: z.union([z.string(), z.number()]).optional(),
        checks: z.record(z.string(), healthCheckSchema).default({})
      }).passthrough()
    }).passthrough()
  }).passthrough(),
  z.object({
    ...eventFields,
    event: z.literal("app:started"),
    payload: z.object({
      simCards: z.array(z.object({
        slotIndex: z.number().int().min(0).max(3),
        simNumber: z.number().int().min(1).max(3),
        phoneNumber: nullablePhone,
        carrierName: z.string().trim().max(120).nullable().optional()
      }).passthrough()).max(3)
    }).passthrough()
  }).passthrough()
]);

export type AndroidGatewayWebhookEvent = z.infer<typeof androidGatewayWebhookSchema>;

function safeProviderDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/\+?\d[\d() .-]{6,}\d/g, "[PHONE]").slice(0, 160);
}

function stateResult(payload: AndroidMessageResponse, fallbackId?: string): SendResult {
  const id = payload.id ?? fallbackId;
  if (!id) throw new SmsProviderError("Android gateway response did not contain a message ID", true, "INVALID_RESPONSE");
  const state = payload.state?.trim() || "Pending";
  if (/failed|cancelled/i.test(state)) {
    const detail = safeProviderDetail(payload.reason ?? payload.error ?? payload.message);
    throw new SmsProviderError(
      `Android gateway rejected the message${detail ? `: ${detail}` : ""}`,
      false,
      "REJECTED"
    );
  }
  return { accepted: true, providerMessageId: id, providerStatus: state.toUpperCase() };
}

export function verifyAndroidGatewaySignature(input: {
  signingKey: string;
  rawBody: Buffer;
  timestamp: string;
  signature: string;
}): boolean {
  const signature = input.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", input.signingKey)
    .update(input.rawBody)
    .update(input.timestamp)
    .digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class AndroidGatewayProvider implements SmsProvider {
  readonly name = "android_gateway";

  constructor(private readonly config: AppConfig) {}

  async sendSms(to: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertConfigured();
    const id = options.idempotencyKey;
    const body = {
      ...(id ? { id } : {}),
      textMessage: { text },
      deviceId: this.config.androidGatewayDeviceId,
      phoneNumbers: [to],
      simNumber: this.config.androidGatewaySimNumber,
      ttl: this.config.androidGatewayTtlSeconds,
      withDeliveryReport: this.config.androidGatewayDeliveryReports,
      priority: 0
    };

    try {
      const response = await this.request("message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        if (id && (response.status === 409 || response.status >= 500)) {
          const recovered = await this.findMessage(id);
          if (recovered) return recovered;
        }
        const detail = safeProviderDetail((await this.readJson<AndroidMessageResponse>(response))?.error);
        const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new SmsProviderError(
          `Android gateway returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          transient,
          `HTTP_${response.status}`
        );
      }
      const payload = await this.readJson<AndroidMessageResponse>(response);
      return stateResult(payload, id);
    } catch (error) {
      if (error instanceof SmsProviderError) throw error;
      if (id) {
        const recovered = await this.findMessage(id);
        if (recovered) return recovered;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new SmsProviderError("Android gateway request timed out", true, "TIMEOUT");
      }
      throw new SmsProviderError("Unable to reach the Android gateway", true, "NETWORK_ERROR");
    }
  }

  async getHealth(): Promise<AndroidHealthResponse> {
    this.assertConfigured();
    const response = await this.request("health", { method: "GET" });
    if (!response.ok) {
      throw new SmsProviderError(`Android gateway health check returned HTTP ${response.status}`, response.status >= 500, `HTTP_${response.status}`);
    }
    return this.readJson<AndroidHealthResponse>(response);
  }

  async replaceWebhook(id: string, event: AndroidGatewayWebhookEventName, url: string): Promise<void> {
    this.assertConfigured();
    const existing = await this.request(`webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!existing.ok && existing.status !== 404) {
      throw new SmsProviderError(`Android gateway could not replace webhook ${id}`, existing.status >= 500, `HTTP_${existing.status}`);
    }
    const response = await this.request("webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, url, event })
    });
    if (!response.ok) {
      throw new SmsProviderError(`Android gateway could not register webhook ${id} (HTTP ${response.status})`, response.status >= 500, `HTTP_${response.status}`);
    }
  }

  private assertConfigured(): void {
    if (!this.config.androidGatewayUrl || !this.config.androidGatewayUsername || !this.config.androidGatewayPassword) {
      throw new SmsProviderError("Android gateway URL or credentials are incomplete", false, "CONFIGURATION_ERROR");
    }
  }

  private endpoint(path: string): string {
    return new URL(path.replace(/^\//, ""), `${this.config.androidGatewayUrl}/`).toString();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.androidGatewayRequestTimeoutMs);
    try {
      return await fetch(this.endpoint(path), {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.androidGatewayUsername}:${this.config.androidGatewayPassword}`).toString("base64")}`,
          accept: "application/json",
          ...init.headers
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson<T extends object>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new SmsProviderError("Android gateway returned an unreadable response", response.status >= 500, "INVALID_RESPONSE");
    }
  }

  private async findMessage(id: string): Promise<SendResult | undefined> {
    try {
      const response = await this.request(`message/${encodeURIComponent(id)}`, { method: "GET" });
      if (response.status === 404) return undefined;
      if (!response.ok) return undefined;
      return stateResult(await this.readJson<AndroidMessageResponse>(response), id);
    } catch (error) {
      if (error instanceof SmsProviderError && !error.transient) throw error;
      return undefined;
    }
  }
}
