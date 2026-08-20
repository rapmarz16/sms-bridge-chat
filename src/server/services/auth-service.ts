import type { AppConfig } from "../config.js";
import type { Member } from "../domain.js";
import { localDayKey } from "../markdown.js";
import { normalizePhone } from "../phone.js";
import { hashOtp, hashToken, randomOtp, randomToken, safeEqual, cleanErrorMessage } from "../security.js";
import type { SqliteStore } from "../db/store.js";
import type { SmsProvider } from "../sms/provider.js";

export class AuthError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthService {
  constructor(
    private readonly store: SqliteStore,
    private readonly config: AppConfig,
    private readonly provider: SmsProvider
  ) {}

  async requestOtp(phoneInput: string): Promise<{ challengeId: string; expiresAt: string }> {
    let phone: string;
    try {
      phone = normalizePhone(phoneInput, this.config.defaultPhoneRegion);
    } catch {
      throw new AuthError("Enter a valid phone number", 400, "INVALID_PHONE");
    }
    const member = this.store.getMemberByPhone(phone);
    if (!member?.active) {
      this.store.recordSecurityEvent("OTP_UNKNOWN_NUMBER");
      return { challengeId: randomToken(18), expiresAt: new Date(Date.now() + this.config.otpTtlMinutes * 60_000).toISOString() };
    }
    const recent = this.store.countRecentOtpChallenges(member.id, Date.now() - 15 * 60_000);
    if (recent >= 3) throw new AuthError("Too many codes requested. Try again in 15 minutes.", 429, "OTP_RATE_LIMIT");
    if (!this.config.devOtpBypassCode && !this.config.smsEnabled) {
      throw new AuthError("SMS login is not configured yet", 503, "SMS_DISABLED");
    }

    const code = this.config.devOtpBypassCode ?? randomOtp();
    if (!/^\d{6}$/.test(code)) throw new Error("DEV_OTP_BYPASS_CODE must be exactly six digits");
    const expiresAt = Date.now() + this.config.otpTtlMinutes * 60_000;
    const challengeId = this.store.createOtpChallenge({
      memberId: member.id,
      codeHash: hashOtp(code, this.config.sessionSecret),
      expiresAt,
      maxAttempts: this.config.otpMaxAttempts
    });

    if (!this.config.devOtpBypassCode) {
      const dayKey = localDayKey(Date.now(), this.config.timezone);
      const reservation = this.store.reserveProviderAttempt({
        referenceType: "OTP",
        referenceId: challengeId,
        provider: this.provider.name,
        dayKey,
        dailyLimit: this.config.smsDailyLimit
      });
      if (!reservation.allowed || !reservation.attemptId) {
        throw new AuthError("The daily SMS limit has been reached", 503, "SMS_LIMIT");
      }
      try {
        await this.provider.sendSms(
          phone,
          `Your SMS Bridge Chat code is ${code}. It expires in ${this.config.otpTtlMinutes} minutes.`,
          { idempotencyKey: challengeId }
        );
        this.store.finishProviderAttempt(reservation.attemptId, "ACCEPTED");
      } catch (error) {
        const safeError = cleanErrorMessage(error);
        this.store.finishProviderAttempt(reservation.attemptId, "FAILED", safeError);
        throw new AuthError("The login code could not be sent. Please try again.", 503, "OTP_SEND_FAILED");
      }
    }
    return { challengeId, expiresAt: new Date(expiresAt).toISOString() };
  }

  verifyOtp(challengeId: string, code: string): { sessionToken: string; member: Member } {
    const challenge = this.store.getOtpChallenge(challengeId);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= Date.now()) {
      throw new AuthError("This code has expired. Request a new one.", 401, "OTP_EXPIRED");
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      throw new AuthError("Too many incorrect attempts. Request a new code.", 429, "OTP_ATTEMPTS");
    }
    const suppliedHash = hashOtp(code, this.config.sessionSecret);
    if (!safeEqual(suppliedHash, challenge.codeHash)) {
      this.store.recordFailedOtpAttempt(challenge.id);
      throw new AuthError("That code is not correct", 401, "OTP_INCORRECT");
    }
    const member = this.store.getMemberById(challenge.memberId);
    if (!member?.active) throw new AuthError("This member is not active", 403, "MEMBER_INACTIVE");
    const sessionToken = randomToken();
    this.store.consumeOtpAndCreateSession({
      challengeId: challenge.id,
      memberId: challenge.memberId,
      tokenHash: hashToken(sessionToken),
      expiresAt: Date.now() + this.config.sessionDays * 86_400_000
    });
    return { sessionToken, member };
  }

  authenticate(sessionToken?: string): Member | undefined {
    return sessionToken ? this.store.getSessionMember(hashToken(sessionToken)) : undefined;
  }

  logout(sessionToken?: string): void {
    if (sessionToken) this.store.deleteSession(hashToken(sessionToken));
  }
}
