import { resolve } from "node:path";
import { z } from "zod";

const booleanValue = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const enabledByDefault = z
  .string()
  .default("true")
  .transform((value) => value === "true" || value === "1");

const optionalText = z.string().trim().optional().transform((value) => value || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.string().trim().default("false"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16).default("development-only-change-this-secret"),
  DATABASE_PATH: z.string().default("/data/chat.db"),
  UPLOADS_PATH: z.string().default("/data/uploads"),
  GROUP_NAME: z.string().trim().min(1).max(80).default("Family Chat"),
  DEFAULT_PHONE_REGION: z.string().length(2).default("CA"),
  SMS_PROVIDER: z.enum(["voipms", "android_gateway"]).default("voipms"),
  VOIPMS_API_USERNAME: optionalText,
  VOIPMS_API_PASSWORD: optionalText,
  VOIPMS_DID: optionalText,
  VOIPMS_WEBHOOK_SECRET: optionalText,
  VOIPMS_API_URL: z.string().url().default("https://voip.ms/api/v1/rest.php"),
  VOIPMS_SENDSMS_PARAMS_VERIFIED: booleanValue,
  ANDROID_GATEWAY_URL: optionalText.pipe(z.string().url().optional()),
  ANDROID_GATEWAY_USERNAME: optionalText,
  ANDROID_GATEWAY_PASSWORD: optionalText,
  ANDROID_GATEWAY_PHONE_NUMBER: optionalText,
  ANDROID_GATEWAY_DEVICE_ID: optionalText,
  ANDROID_GATEWAY_WEBHOOK_SECRET: optionalText,
  ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY: optionalText,
  ANDROID_GATEWAY_SIM_NUMBER: z.coerce.number().int().min(1).max(3).default(1),
  ANDROID_GATEWAY_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  ANDROID_GATEWAY_DELIVERY_REPORTS: enabledByDefault,
  ANDROID_GATEWAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  ANDROID_GATEWAY_WEBHOOK_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  ANDROID_GATEWAY_HEALTH_STALE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(180),
  SMS_DAILY_LIMIT: z.coerce.number().int().min(1).default(100),
  SMS_ENABLED: booleanValue,
  SMS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  SMS_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().min(2).max(30).default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  DEV_OTP_BYPASS_CODE: optionalText,
  MESSAGE_MAX_LENGTH: z.coerce.number().int().min(160).max(10_000).default(4000),
  SMS_TEXT_MAX_LENGTH: z.coerce.number().int().min(160).max(2048).default(2048),
  TZ: z.string().default("America/Toronto"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  trustProxy: boolean | string;
  appBaseUrl: string;
  sessionSecret: string;
  databasePath: string;
  uploadsPath: string;
  groupName: string;
  defaultPhoneRegion: string;
  smsProvider: "voipms" | "android_gateway";
  smsDid?: string;
  voipmsApiUsername?: string;
  voipmsApiPassword?: string;
  voipmsDid?: string;
  voipmsWebhookSecret?: string;
  voipmsApiUrl: string;
  voipmsSendSmsParamsVerified: boolean;
  androidGatewayUrl?: string;
  androidGatewayUsername?: string;
  androidGatewayPassword?: string;
  androidGatewayPhoneNumber?: string;
  androidGatewayDeviceId?: string;
  androidGatewayWebhookSecret?: string;
  androidGatewayWebhookSigningKey?: string;
  androidGatewaySimNumber: number;
  androidGatewayTtlSeconds: number;
  androidGatewayDeliveryReports: boolean;
  androidGatewayRequestTimeoutMs: number;
  androidGatewayWebhookMaxSkewSeconds: number;
  androidGatewayHealthStaleSeconds: number;
  smsEnabled: boolean;
  smsDailyLimit: number;
  smsMaxAttempts: number;
  smsPollIntervalMs: number;
  sessionDays: number;
  otpTtlMinutes: number;
  otpMaxAttempts: number;
  devOtpBypassCode?: string;
  messageMaxLength: number;
  smsTextMaxLength: number;
  timezone: string;
  logLevel: string;
  secureCookies: boolean;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(source);
  const smsDid = env.SMS_PROVIDER === "android_gateway" ? env.ANDROID_GATEWAY_PHONE_NUMBER : env.VOIPMS_DID;
  const config: AppConfig = {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY === "true" ? true : env.TRUST_PROXY === "false" ? false : env.TRUST_PROXY,
    appBaseUrl: env.APP_BASE_URL.replace(/\/$/, ""),
    sessionSecret: env.SESSION_SECRET,
    databasePath: env.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(env.DATABASE_PATH),
    uploadsPath: resolve(env.UPLOADS_PATH),
    groupName: env.GROUP_NAME,
    defaultPhoneRegion: env.DEFAULT_PHONE_REGION.toUpperCase(),
    smsProvider: env.SMS_PROVIDER,
    smsDid,
    voipmsApiUsername: env.VOIPMS_API_USERNAME,
    voipmsApiPassword: env.VOIPMS_API_PASSWORD,
    voipmsDid: env.VOIPMS_DID,
    voipmsWebhookSecret: env.VOIPMS_WEBHOOK_SECRET,
    voipmsApiUrl: env.VOIPMS_API_URL,
    voipmsSendSmsParamsVerified: env.VOIPMS_SENDSMS_PARAMS_VERIFIED,
    androidGatewayUrl: env.ANDROID_GATEWAY_URL?.replace(/\/$/, ""),
    androidGatewayUsername: env.ANDROID_GATEWAY_USERNAME,
    androidGatewayPassword: env.ANDROID_GATEWAY_PASSWORD,
    androidGatewayPhoneNumber: env.ANDROID_GATEWAY_PHONE_NUMBER,
    androidGatewayDeviceId: env.ANDROID_GATEWAY_DEVICE_ID,
    androidGatewayWebhookSecret: env.ANDROID_GATEWAY_WEBHOOK_SECRET,
    androidGatewayWebhookSigningKey: env.ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY,
    androidGatewaySimNumber: env.ANDROID_GATEWAY_SIM_NUMBER,
    androidGatewayTtlSeconds: env.ANDROID_GATEWAY_TTL_SECONDS,
    androidGatewayDeliveryReports: env.ANDROID_GATEWAY_DELIVERY_REPORTS,
    androidGatewayRequestTimeoutMs: env.ANDROID_GATEWAY_REQUEST_TIMEOUT_MS,
    androidGatewayWebhookMaxSkewSeconds: env.ANDROID_GATEWAY_WEBHOOK_MAX_SKEW_SECONDS,
    androidGatewayHealthStaleSeconds: env.ANDROID_GATEWAY_HEALTH_STALE_SECONDS,
    smsEnabled: env.SMS_ENABLED,
    smsDailyLimit: env.SMS_DAILY_LIMIT,
    smsMaxAttempts: env.SMS_MAX_ATTEMPTS,
    smsPollIntervalMs: env.SMS_POLL_INTERVAL_MS,
    sessionDays: env.SESSION_DAYS,
    otpTtlMinutes: env.OTP_TTL_MINUTES,
    otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
    devOtpBypassCode: env.DEV_OTP_BYPASS_CODE,
    messageMaxLength: env.MESSAGE_MAX_LENGTH,
    smsTextMaxLength: env.SMS_TEXT_MAX_LENGTH,
    timezone: env.TZ,
    logLevel: env.LOG_LEVEL,
    secureCookies: env.APP_BASE_URL.startsWith("https://")
  };

  if (config.nodeEnv === "production" && config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  if (config.nodeEnv === "production" && !config.secureCookies) {
    throw new Error("APP_BASE_URL must use HTTPS in production");
  }
  if (config.nodeEnv === "production" && config.devOtpBypassCode) {
    throw new Error("DEV_OTP_BYPASS_CODE cannot be enabled in production");
  }
  if (config.smsEnabled) {
    const required = config.smsProvider === "android_gateway" ? [
      ["ANDROID_GATEWAY_URL", config.androidGatewayUrl],
      ["ANDROID_GATEWAY_USERNAME", config.androidGatewayUsername],
      ["ANDROID_GATEWAY_PASSWORD", config.androidGatewayPassword],
      ["ANDROID_GATEWAY_PHONE_NUMBER", config.androidGatewayPhoneNumber],
      ["ANDROID_GATEWAY_DEVICE_ID", config.androidGatewayDeviceId],
      ["ANDROID_GATEWAY_WEBHOOK_SECRET", config.androidGatewayWebhookSecret],
      ["ANDROID_GATEWAY_WEBHOOK_SIGNING_KEY", config.androidGatewayWebhookSigningKey]
    ] : [
      ["VOIPMS_API_USERNAME", config.voipmsApiUsername],
      ["VOIPMS_API_PASSWORD", config.voipmsApiPassword],
      ["VOIPMS_DID", config.voipmsDid],
      ["VOIPMS_WEBHOOK_SECRET", config.voipmsWebhookSecret]
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) throw new Error(`SMS_ENABLED requires: ${missing.join(", ")}`);
    if (config.smsProvider === "voipms" && !config.voipmsSendSmsParamsVerified) {
      throw new Error("SMS_ENABLED requires VOIPMS_SENDSMS_PARAMS_VERIFIED=true");
    }
  }

  return config;
}
