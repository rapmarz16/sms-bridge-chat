import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { AndroidGatewayProvider } from "../src/server/sms/android-gateway.js";
import { SmsProviderError } from "../src/server/sms/provider.js";

afterEach(() => vi.unstubAllGlobals());

function config() {
  return loadConfig({
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    DATABASE_PATH: ":memory:",
    UPLOADS_PATH: "/tmp/sms-bridge-android-test",
    SMS_PROVIDER: "android_gateway",
    SMS_ENABLED: "true",
    ANDROID_GATEWAY_URL: "http://192.168.50.25:8080",
    ANDROID_GATEWAY_USERNAME: "gateway-user",
    ANDROID_GATEWAY_PASSWORD: "gateway-password",
    ANDROID_GATEWAY_PHONE_NUMBER: "+14165550400",
    ANDROID_GATEWAY_DEVICE_ID: "device-abc123",
    ANDROID_GATEWAY_WEBHOOK_SECRET: "android-webhook-secret-long-enough",
    ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY: "android-signing-key-long-enough",
    ANDROID_GATEWAY_SIM_NUMBER: "1",
    ANDROID_GATEWAY_TTL_SECONDS: "3600",
    LOG_LEVEL: "silent"
  });
}

describe("Android gateway adapter isolation", () => {
  it("submits one recipient with a stable delivery ID and no credentials in the URL", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        deviceId: "device-abc123",
        id: "delivery-123",
        state: "Pending",
        recipients: [{ phoneNumber: "+14165550401", state: "Pending" }]
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const result = await new AndroidGatewayProvider(config()).sendSms(
      "+14165550401",
      "Raphael: Hello",
      { idempotencyKey: "delivery-123" }
    );

    expect(result).toEqual({ accepted: true, providerMessageId: "delivery-123", providerStatus: "PENDING" });
    expect(capturedUrl).toBe("http://192.168.50.25:8080/message");
    expect(capturedUrl).not.toContain("gateway-user");
    expect(capturedUrl).not.toContain("gateway-password");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("gateway-user:gateway-password").toString("base64")}`,
      "content-type": "application/json"
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      id: "delivery-123",
      textMessage: { text: "Raphael: Hello" },
      deviceId: "device-abc123",
      phoneNumbers: ["+14165550401"],
      simNumber: 1,
      ttl: 3600,
      withDeliveryReport: true,
      priority: 0
    });
  });

  it("recovers an ambiguous submission by looking up the same idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "delivery-recovered", state: "Sent" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AndroidGatewayProvider(config()).sendSms(
      "+14165550401",
      "Hello",
      { idempotencyKey: "delivery-recovered" }
    );

    expect(result).toEqual({ accepted: true, providerMessageId: "delivery-recovered", providerStatus: "SENT" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://192.168.50.25:8080/message/delivery-recovered");
  });

  it("configures the write-only webhook signing key without exposing it in the URL", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 204 });
    }));

    await new AndroidGatewayProvider(config()).configureWebhookSigningKey("new-signing-key-that-remains-secret");

    expect(capturedUrl).toBe("http://192.168.50.25:8080/settings");
    expect(capturedUrl).not.toContain("new-signing-key");
    expect(capturedInit?.method).toBe("PATCH");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      webhooks: { signing_key: "new-signing-key-that-remains-secret" }
    });
  });

  it("does not retry a permanent validation rejection indefinitely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Invalid destination" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })));

    await expect(new AndroidGatewayProvider(config()).sendSms(
      "+14165550401",
      "Hello",
      { idempotencyKey: "delivery-invalid" }
    )).rejects.toMatchObject<SmsProviderError>({ code: "HTTP_400", transient: false });
  });

  it("requires every phone-side secret before SMS can be enabled", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      APP_BASE_URL: "http://localhost:3000",
      SESSION_SECRET: "test-session-secret-that-is-long-enough",
      DATABASE_PATH: ":memory:",
      UPLOADS_PATH: "/tmp/sms-bridge-android-test",
      SMS_PROVIDER: "android_gateway",
      SMS_ENABLED: "true"
    })).toThrow(/ANDROID_GATEWAY_URL/);
  });
});
