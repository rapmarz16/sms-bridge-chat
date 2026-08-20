import { loadConfig } from "../config.js";
import { AndroidGatewayProvider, ANDROID_GATEWAY_WEBHOOK_EVENTS } from "../sms/android-gateway.js";

const config = loadConfig();

if (config.smsProvider !== "android_gateway") {
  throw new Error("Set SMS_PROVIDER=android_gateway before configuring the phone gateway");
}

const required: Array<[string, string | undefined]> = [
  ["ANDROID_GATEWAY_URL", config.androidGatewayUrl],
  ["ANDROID_GATEWAY_USERNAME", config.androidGatewayUsername],
  ["ANDROID_GATEWAY_PASSWORD", config.androidGatewayPassword],
  ["ANDROID_GATEWAY_PHONE_NUMBER", config.androidGatewayPhoneNumber],
  ["ANDROID_GATEWAY_DEVICE_ID", config.androidGatewayDeviceId],
  ["ANDROID_GATEWAY_WEBHOOK_SECRET", config.androidGatewayWebhookSecret],
  ["ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY", config.androidGatewayWebhookSigningKey]
];
const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length > 0) throw new Error(`Android gateway configuration is missing: ${missing.join(", ")}`);

const provider = new AndroidGatewayProvider(config);
const health = await provider.getHealth();
if (health.status === "fail") throw new Error("The Android gateway reports a failed health state; correct the phone before registering webhooks");

await provider.configureWebhookSigningKey(config.androidGatewayWebhookSigningKey!);
process.stdout.write("Configured the phone webhook signing key\n");

const webhookUrl = `${config.appBaseUrl}/api/webhooks/android/${config.androidGatewayWebhookSecret}`;
for (const event of ANDROID_GATEWAY_WEBHOOK_EVENTS) {
  const id = `sms-bridge-chat-${event.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`;
  await provider.replaceWebhook(id, event, webhookUrl);
  process.stdout.write(`Registered ${event}\n`);
}

process.stdout.write("Android gateway webhooks are registered. Restart the gateway app and send one inbound test SMS.\n");
