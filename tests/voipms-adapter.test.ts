import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { SmsProviderError } from "../src/server/sms/provider.js";
import { VoipMsProvider } from "../src/server/sms/voipms.js";

afterEach(() => vi.unstubAllGlobals());

function config(verified: boolean) {
  return loadConfig({
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    DATABASE_PATH: ":memory:",
    UPLOADS_PATH: "/tmp/sms-bridge-voipms-test",
    SMS_ENABLED: verified ? "true" : "false",
    VOIPMS_API_USERNAME: "api@example.com",
    VOIPMS_API_PASSWORD: "dedicated-api-password",
    VOIPMS_DID: "+14165550400",
    VOIPMS_WEBHOOK_SECRET: "webhook-secret-long-enough",
    VOIPMS_SENDSMS_PARAMS_VERIFIED: String(verified),
    LOG_LEVEL: "silent"
  });
}

describe("VoIP.ms adapter isolation", () => {
  it("keeps credentials out of the URL and builds the isolated sendSMS form", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ status: "success", id: "provider-42" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const result = await new VoipMsProvider(config(true)).sendSms("+14165550401", "Raphael: Hello");
    expect(result).toEqual({ accepted: true, providerMessageId: "provider-42" });
    expect(capturedUrl).toBe("https://voip.ms/api/v1/rest.php");
    expect(capturedUrl).not.toContain("password");
    expect(capturedInit?.method).toBe("POST");
    const body = new URLSearchParams(String(capturedInit?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      api_username: "api@example.com",
      api_password: "dedicated-api-password",
      method: "sendSMS",
      did: "+14165550400",
      dst: "+14165550401",
      message: "Raphael: Hello",
      content_type: "json"
    });
  });

  it("refuses all traffic until the portal-only parameters are owner-verified", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(new VoipMsProvider(config(false)).sendSms("+14165550401", "Hello"))
      .rejects.toMatchObject<SmsProviderError>({ code: "PARAMETERS_NOT_VERIFIED", transient: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
