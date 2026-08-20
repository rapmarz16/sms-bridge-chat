import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  ChatMessage,
  DeliveryMode,
  Group,
  Member,
  MessageSource,
  Reaction,
  Role,
  SmsDelivery,
  SmsDeliveryStatus,
  SmsGatewayHealth
} from "../domain.js";
import { runMigrations } from "./migrations.js";

type MemberRow = {
  id: string;
  display_name: string;
  phone_number_e164: string;
  role: Role;
  delivery_mode: DeliveryMode;
  active: number;
  created_at: number;
  updated_at: number;
};

type GroupRow = {
  id: string;
  name: string;
  sms_did: string | null;
  sms_enabled: number;
  created_at: number;
};

type MessageRow = {
  id: string;
  group_id: string;
  sender_member_id: string | null;
  sender_name: string | null;
  source: MessageSource;
  body: string;
  reply_id: string | null;
  reply_body: string | null;
  reply_sender_name: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
};

type DeliveryRow = {
  id: string;
  message_id: string;
  member_id: string;
  member_name: string;
  phone_number: string;
  provider: string;
  provider_message_id: string | null;
  provider_status: string | null;
  provider_parts_count: number | null;
  provider_status_updated_at: number | null;
  status: SmsDeliveryStatus;
  attempts: number;
  last_error: string | null;
  available_at: number;
  created_at: number;
  updated_at: number;
};

type GatewayHealthRow = {
  provider: string;
  device_id: string;
  status: "pass" | "warn" | "fail" | "unknown";
  version: string | null;
  battery_level: number | null;
  charging: number | null;
  connection_available: number | null;
  cellular_type: number | null;
  carrier_name: string | null;
  last_event_at: number;
  last_ping_at: number | null;
  last_app_started_at: number | null;
  updated_at: number;
};

const iso = (value: number | null): string | undefined => value == null ? undefined : new Date(value).toISOString();

export class SqliteStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  healthCheck(): boolean {
    return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
  }

  ensureDefaultGroup(name: string, smsDid?: string): Group {
    let row = this.db.prepare("SELECT * FROM groups ORDER BY created_at LIMIT 1").get() as GroupRow | undefined;
    if (!row) {
      const now = Date.now();
      const id = randomUUID();
      this.db.prepare(
        "INSERT INTO groups(id, name, sms_did, sms_enabled, created_at) VALUES (?, ?, ?, 1, ?)"
      ).run(id, name, smsDid ?? null, now);
      row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow;
    } else if (smsDid && row.sms_did !== smsDid) {
      this.db.prepare("UPDATE groups SET sms_did = ? WHERE id = ?").run(smsDid, row.id);
      row = { ...row, sms_did: smsDid };
    }
    return this.mapGroup(row);
  }

  getDefaultGroup(): Group {
    const row = this.db.prepare("SELECT * FROM groups ORDER BY created_at LIMIT 1").get() as GroupRow | undefined;
    if (!row) throw new Error("The default group has not been initialized");
    return this.mapGroup(row);
  }

  setGroupSmsEnabled(groupId: string, enabled: boolean): Group {
    this.db.prepare("UPDATE groups SET sms_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, groupId);
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as GroupRow | undefined;
    if (!row) throw new Error("Group not found");
    return this.mapGroup(row);
  }

  createMember(input: {
    groupId: string;
    displayName: string;
    phoneNumberE164: string;
    role: Role;
    deliveryMode: DeliveryMode;
  }): Member {
    const now = Date.now();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO members(id, display_name, phone_number_e164, role, delivery_mode, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, input.displayName, input.phoneNumberE164, input.role, input.deliveryMode, now, now);
      this.db.prepare(`
        INSERT INTO group_memberships(group_id, member_id, active, joined_at) VALUES (?, ?, 1, ?)
      `).run(input.groupId, id, now);
    })();
    return this.getMemberById(id)!;
  }

  updateMember(id: string, input: Partial<{
    displayName: string;
    phoneNumberE164: string;
    role: Role;
    deliveryMode: DeliveryMode;
    active: boolean;
  }>): Member | undefined {
    const current = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined;
    if (!current) return undefined;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE members SET display_name = ?, phone_number_e164 = ?, role = ?, delivery_mode = ?, active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.displayName ?? current.display_name,
        input.phoneNumberE164 ?? current.phone_number_e164,
        input.role ?? current.role,
        input.deliveryMode ?? current.delivery_mode,
        (input.active ?? Boolean(current.active)) ? 1 : 0,
        Date.now(),
        id
      );
      if (input.active === false) {
        this.db.prepare("UPDATE group_memberships SET active = 0 WHERE member_id = ?").run(id);
        this.db.prepare("DELETE FROM sessions WHERE member_id = ?").run(id);
      } else if (input.active === true) {
        this.db.prepare("UPDATE group_memberships SET active = 1 WHERE member_id = ?").run(id);
      }
      if (input.phoneNumberE164 && input.phoneNumberE164 !== current.phone_number_e164) {
        this.db.prepare("DELETE FROM sessions WHERE member_id = ?").run(id);
      }
    })();
    return this.getMemberById(id);
  }

  listMembers(groupId: string): Member[] {
    const rows = this.db.prepare(`
      SELECT m.* FROM members m
      JOIN group_memberships gm ON gm.member_id = m.id
      WHERE gm.group_id = ?
      ORDER BY m.active DESC, lower(m.display_name)
    `).all(groupId) as MemberRow[];
    return rows.map((row) => this.mapMember(row));
  }

  getMemberById(id: string): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow | undefined;
    return row ? this.mapMember(row) : undefined;
  }

  getMemberByPhone(phoneNumberE164: string): Member | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE phone_number_e164 = ?").get(phoneNumberE164) as MemberRow | undefined;
    return row ? this.mapMember(row) : undefined;
  }

  memberBelongsToGroup(memberId: string, groupId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM group_memberships WHERE member_id = ? AND group_id = ? AND active = 1
    `).get(memberId, groupId));
  }

  createCanonicalMessage(input: {
    groupId: string;
    senderMemberId?: string;
    source: MessageSource;
    body: string;
    replyToMessageId?: string;
    externalProvider?: string;
    externalProviderId?: string;
    smsProviderName: string;
    fanoutEnabled: boolean;
    excludeSenderFromSms: boolean;
  }): { message: ChatMessage; duplicate: boolean; deliveryCount: number } {
    const execute = this.db.transaction(() => {
      if (input.externalProviderId) {
        const existing = this.db.prepare(`
          SELECT id FROM messages WHERE external_provider = ? AND external_provider_id = ?
        `).get(input.externalProvider ?? null, input.externalProviderId) as { id: string } | undefined;
        if (existing) return { messageId: existing.id, duplicate: true, deliveryCount: 0 };
      }
      if (input.replyToMessageId) {
        const reply = this.db.prepare("SELECT group_id FROM messages WHERE id = ?").get(input.replyToMessageId) as { group_id: string } | undefined;
        if (!reply || reply.group_id !== input.groupId) throw new Error("Reply target is not in this group");
      }
      const group = this.db.prepare("SELECT sms_enabled FROM groups WHERE id = ?").get(input.groupId) as { sms_enabled: number } | undefined;
      if (!group) throw new Error("Group not found");
      const now = Date.now();
      const messageId = randomUUID();
      this.db.prepare(`
        INSERT INTO messages(
          id, group_id, sender_member_id, source, body, reply_to_message_id,
          external_provider, external_provider_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        input.groupId,
        input.senderMemberId ?? null,
        input.source,
        input.body,
        input.replyToMessageId ?? null,
        input.externalProvider ?? null,
        input.externalProviderId ?? null,
        now
      );
      const recipients = this.db.prepare(`
        SELECT m.id, m.phone_number_e164 FROM members m
        JOIN group_memberships gm ON gm.member_id = m.id
        WHERE gm.group_id = ? AND gm.active = 1 AND m.active = 1
          AND m.delivery_mode IN ('SMS', 'BOTH')
      `).all(input.groupId) as Array<{ id: string; phone_number_e164: string }>;
      let deliveryCount = 0;
      const status: SmsDeliveryStatus = input.fanoutEnabled && Boolean(group.sms_enabled) ? "PENDING" : "SKIPPED";
      const insertDelivery = this.db.prepare(`
        INSERT INTO sms_deliveries(
          id, message_id, member_id, phone_number, provider, status, attempts,
          available_at, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `);
      for (const recipient of recipients) {
        if (input.excludeSenderFromSms && recipient.id === input.senderMemberId) continue;
        insertDelivery.run(
          randomUUID(), messageId, recipient.id, recipient.phone_number_e164,
          input.smsProviderName, status, now, now, now, status === "SKIPPED" ? "SMS bridge disabled" : null
        );
        deliveryCount += 1;
      }
      return { messageId, duplicate: false, deliveryCount };
    });
    const result = execute();
    return { message: this.getMessage(result.messageId)!, duplicate: result.duplicate, deliveryCount: result.deliveryCount };
  }

  getMessage(id: string): ChatMessage | undefined {
    const row = this.messageSelect("WHERE msg.id = ?").get(id) as MessageRow | undefined;
    return row ? this.mapMessages([row])[0] : undefined;
  }

  listMessages(groupId: string, input: { before?: number; after?: number; limit: number }): ChatMessage[] {
    let clause = "WHERE msg.group_id = ? AND msg.deleted_at IS NULL";
    const parameters: Array<string | number> = [groupId];
    if (input.before) {
      clause += " AND msg.created_at < ?";
      parameters.push(input.before);
    }
    if (input.after) {
      clause += " AND msg.created_at > ?";
      parameters.push(input.after);
    }
    const direction = input.after ? "ASC" : "DESC";
    const rows = this.messageSelect(`${clause} ORDER BY msg.created_at ${direction} LIMIT ?`)
      .all(...parameters, input.limit) as MessageRow[];
    if (!input.after) rows.reverse();
    return this.mapMessages(rows);
  }

  addReaction(messageId: string, memberId: string, emoji: string): Reaction {
    const message = this.db.prepare("SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL").get(messageId);
    if (!message) throw new Error("Message not found");
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO reactions(id, message_id, member_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id, member_id, emoji) DO NOTHING
    `).run(randomUUID(), messageId, memberId, emoji, now);
    const row = this.db.prepare(`
      SELECT r.*, m.display_name AS member_name FROM reactions r
      JOIN members m ON m.id = r.member_id
      WHERE r.message_id = ? AND r.member_id = ? AND r.emoji = ?
    `).get(messageId, memberId, emoji) as {
      id: string; message_id: string; member_id: string; member_name: string; emoji: string; created_at: number;
    };
    return this.mapReaction(row);
  }

  removeReaction(messageId: string, memberId: string, emoji: string): boolean {
    return this.db.prepare("DELETE FROM reactions WHERE message_id = ? AND member_id = ? AND emoji = ?")
      .run(messageId, memberId, emoji).changes > 0;
  }

  createOtpChallenge(input: { memberId: string; codeHash: string; expiresAt: number; maxAttempts: number }): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE otp_challenges SET consumed_at = ? WHERE member_id = ? AND consumed_at IS NULL
      `).run(now, input.memberId);
      this.db.prepare(`
        INSERT INTO otp_challenges(id, member_id, code_hash, expires_at, max_attempts, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, input.memberId, input.codeHash, input.expiresAt, input.maxAttempts, now);
    })();
    return id;
  }

  countRecentOtpChallenges(memberId: string, since: number): number {
    return (this.db.prepare(`
      SELECT count(*) AS count FROM otp_challenges WHERE member_id = ? AND created_at >= ?
    `).get(memberId, since) as { count: number }).count;
  }

  getOtpChallenge(id: string): {
    id: string; memberId: string; codeHash: string; expiresAt: number; attempts: number; maxAttempts: number; consumedAt?: number;
  } | undefined {
    const row = this.db.prepare("SELECT * FROM otp_challenges WHERE id = ?").get(id) as {
      id: string; member_id: string; code_hash: string; expires_at: number; attempts: number; max_attempts: number; consumed_at: number | null;
    } | undefined;
    return row ? {
      id: row.id, memberId: row.member_id, codeHash: row.code_hash, expiresAt: row.expires_at,
      attempts: row.attempts, maxAttempts: row.max_attempts, consumedAt: row.consumed_at ?? undefined
    } : undefined;
  }

  recordFailedOtpAttempt(id: string): void {
    this.db.prepare("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  consumeOtpAndCreateSession(input: { challengeId: string; memberId: string; tokenHash: string; expiresAt: number }): void {
    const now = Date.now();
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND member_id = ? AND consumed_at IS NULL
      `).run(now, input.challengeId, input.memberId);
      if (result.changes !== 1) throw new Error("OTP challenge is no longer valid");
      this.db.prepare(`
        INSERT INTO sessions(token_hash, member_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
      `).run(input.tokenHash, input.memberId, input.expiresAt, now, now);
    })();
  }

  getSessionMember(tokenHash: string): Member | undefined {
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT m.* FROM sessions s
      JOIN members m ON m.id = s.member_id
      JOIN group_memberships gm ON gm.member_id = m.id AND gm.active = 1
      WHERE s.token_hash = ? AND s.expires_at > ? AND m.active = 1
      LIMIT 1
    `).get(tokenHash, now) as MemberRow | undefined;
    if (row) this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
    return row ? this.mapMember(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneExpiredAuthData(now = Date.now()): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM otp_challenges WHERE expires_at < ?").run(now - 86_400_000);
  }

  reserveProviderAttempt(input: {
    referenceType: "DELIVERY" | "OTP";
    referenceId: string;
    provider: string;
    dayKey: string;
    dailyLimit: number;
  }): { allowed: boolean; count: number; attemptId?: string } {
    return this.db.transaction(() => {
      const count = (this.db.prepare(`
        SELECT count(*) AS count FROM sms_provider_attempts WHERE day_key = ?
      `).get(input.dayKey) as { count: number }).count;
      if (count >= input.dailyLimit) return { allowed: false, count };
      const attemptId = randomUUID();
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO sms_provider_attempts(
          id, reference_type, reference_id, provider, day_key, outcome, attempted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'STARTED', ?, ?)
      `).run(attemptId, input.referenceType, input.referenceId, input.provider, input.dayKey, now, now);
      return { allowed: true, count: count + 1, attemptId };
    })();
  }

  finishProviderAttempt(id: string, outcome: "ACCEPTED" | "FAILED", error?: string): void {
    this.db.prepare(`
      UPDATE sms_provider_attempts SET outcome = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(outcome, error ?? null, Date.now(), id);
  }

  getSmsUsage(dayKey: string): number {
    return (this.db.prepare("SELECT count(*) AS count FROM sms_provider_attempts WHERE day_key = ?")
      .get(dayKey) as { count: number }).count;
  }

  claimNextDelivery(now: number): SmsDelivery | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM sms_deliveries WHERE status = 'PENDING' AND available_at <= ?
        ORDER BY available_at, created_at LIMIT 1
      `).get(now) as { id: string } | undefined;
      if (!row) return undefined;
      const result = this.db.prepare(`
        UPDATE sms_deliveries
        SET status = 'SENDING', attempts = attempts + 1, locked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(now, now, row.id);
      return result.changes === 1 ? row.id : undefined;
    });
    const id = claim();
    return id ? this.getDelivery(id) : undefined;
  }

  getDelivery(id: string): SmsDelivery | undefined {
    const row = this.db.prepare(`
      SELECT d.*, m.display_name AS member_name FROM sms_deliveries d
      JOIN members m ON m.id = d.member_id WHERE d.id = ?
    `).get(id) as DeliveryRow | undefined;
    return row ? this.mapDelivery(row) : undefined;
  }

  listDeliveriesForMessage(messageId: string): SmsDelivery[] {
    const rows = this.db.prepare(`
      SELECT d.*, m.display_name AS member_name FROM sms_deliveries d
      JOIN members m ON m.id = d.member_id WHERE d.message_id = ? ORDER BY d.created_at, d.member_id
    `).all(messageId) as DeliveryRow[];
    return rows.map((row) => this.mapDelivery(row));
  }

  markDeliveryAccepted(id: string, providerMessageId?: string, providerStatus?: string): void {
    this.db.prepare(`
      UPDATE sms_deliveries SET
        status = CASE WHEN provider_status IN ('FAILED', 'CANCELLED') THEN 'FAILED' ELSE 'ACCEPTED' END,
        provider_message_id = ?,
        provider_status = COALESCE(provider_status, ?),
        provider_status_updated_at = CASE WHEN provider_status IS NULL AND ? IS NOT NULL THEN ? ELSE provider_status_updated_at END,
        last_error = CASE WHEN provider_status IN ('FAILED', 'CANCELLED') THEN last_error ELSE NULL END,
        locked_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(providerMessageId ?? null, providerStatus ?? null, providerStatus ?? null, Date.now(), Date.now(), id);
  }

  updateDeliveryProviderStatus(input: {
    provider: string;
    providerMessageId: string;
    providerStatus: "SENT" | "DELIVERED" | "FAILED" | "CANCELLED";
    partsCount?: number;
    error?: string;
  }): boolean {
    const now = Date.now();
    const failed = input.providerStatus === "FAILED" || input.providerStatus === "CANCELLED";
    return this.db.prepare(`
      UPDATE sms_deliveries SET
        provider_message_id = COALESCE(provider_message_id, ?),
        provider_status = CASE
          WHEN provider_status IN ('FAILED', 'CANCELLED') THEN provider_status
          WHEN provider_status = 'DELIVERED' AND ? = 'SENT' THEN provider_status
          ELSE ?
        END,
        provider_parts_count = COALESCE(?, provider_parts_count),
        provider_status_updated_at = ?,
        status = CASE
          WHEN provider_status IN ('FAILED', 'CANCELLED') THEN 'FAILED'
          WHEN ? = 1 THEN 'FAILED'
          WHEN ? IN ('SENT', 'DELIVERED') THEN 'ACCEPTED'
          ELSE status
        END,
        last_error = CASE
          WHEN provider_status IN ('FAILED', 'CANCELLED') THEN last_error
          WHEN ? = 1 THEN ?
          ELSE last_error
        END,
        locked_at = NULL,
        updated_at = ?
      WHERE provider = ? AND (provider_message_id = ? OR id = ?)
    `).run(
      input.providerMessageId,
      input.providerStatus,
      input.providerStatus,
      input.partsCount ?? null,
      now,
      failed ? 1 : 0,
      input.providerStatus,
      failed ? 1 : 0,
      input.error ?? `Android gateway reported ${input.providerStatus.toLowerCase()}`,
      now,
      input.provider,
      input.providerMessageId,
      input.providerMessageId
    ).changes > 0;
  }

  markDeliveryRetry(id: string, error: string, availableAt: number): void {
    this.db.prepare(`
      UPDATE sms_deliveries SET status = 'PENDING', last_error = ?, available_at = ?,
        locked_at = NULL, updated_at = ? WHERE id = ?
    `).run(error, availableAt, Date.now(), id);
  }

  markDeliveryFailed(id: string, error: string, status: "FAILED" | "SKIPPED" | "SKIPPED_LIMIT" = "FAILED"): void {
    this.db.prepare(`
      UPDATE sms_deliveries SET status = ?, last_error = ?, locked_at = NULL, updated_at = ? WHERE id = ?
    `).run(status, error, Date.now(), id);
  }

  failUncertainSendingDeliveries(): number {
    return this.db.prepare(`
      UPDATE sms_deliveries SET status = 'FAILED', last_error = 'Uncertain provider state after restart; not auto-retried',
        locked_at = NULL, updated_at = ? WHERE status = 'SENDING'
    `).run(Date.now()).changes;
  }

  failInactiveProviderDeliveries(activeProvider: string): number {
    return this.db.prepare(`
      UPDATE sms_deliveries SET status = 'FAILED',
        last_error = 'SMS provider changed; review and retry with the active provider',
        locked_at = NULL, updated_at = ?
      WHERE status = 'PENDING' AND provider <> ?
    `).run(Date.now(), activeProvider).changes;
  }

  listDeliveryFailures(limit = 50): SmsDelivery[] {
    const rows = this.db.prepare(`
      SELECT d.*, m.display_name AS member_name FROM sms_deliveries d
      JOIN members m ON m.id = d.member_id
      WHERE d.status IN ('FAILED', 'SKIPPED_LIMIT')
      ORDER BY d.updated_at DESC LIMIT ?
    `).all(limit) as DeliveryRow[];
    return rows.map((row) => this.mapDelivery(row));
  }

  retryDelivery(id: string, provider?: string): boolean {
    return this.db.prepare(`
      UPDATE sms_deliveries SET status = 'PENDING', attempts = 0, last_error = NULL,
        provider = COALESCE(?, provider), provider_message_id = NULL,
        provider_status = NULL, provider_parts_count = NULL, provider_status_updated_at = NULL,
        available_at = ?, updated_at = ? WHERE id = ? AND status IN ('FAILED', 'SKIPPED_LIMIT')
    `).run(provider ?? null, Date.now(), Date.now(), id).changes === 1;
  }

  recordSecurityEvent(eventType: string, maskedPhone?: string, details?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO security_events(id, event_type, masked_phone, details_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), eventType, maskedPhone ?? null, details ? JSON.stringify(details) : null, Date.now());
  }

  updateGatewayHealth(input: {
    provider: string;
    deviceId: string;
    status?: "pass" | "warn" | "fail" | "unknown";
    version?: string;
    batteryLevel?: number;
    charging?: boolean;
    connectionAvailable?: boolean;
    cellularType?: number;
    carrierName?: string;
    ping?: boolean;
    appStarted?: boolean;
  }): SmsGatewayHealth {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sms_gateway_health(
        provider, device_id, status, version, battery_level, charging,
        connection_available, cellular_type, carrier_name, last_event_at,
        last_ping_at, last_app_started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        device_id = excluded.device_id,
        status = CASE WHEN ? IS NULL THEN sms_gateway_health.status ELSE excluded.status END,
        version = COALESCE(excluded.version, sms_gateway_health.version),
        battery_level = COALESCE(excluded.battery_level, sms_gateway_health.battery_level),
        charging = COALESCE(excluded.charging, sms_gateway_health.charging),
        connection_available = COALESCE(excluded.connection_available, sms_gateway_health.connection_available),
        cellular_type = COALESCE(excluded.cellular_type, sms_gateway_health.cellular_type),
        carrier_name = COALESCE(excluded.carrier_name, sms_gateway_health.carrier_name),
        last_event_at = excluded.last_event_at,
        last_ping_at = COALESCE(excluded.last_ping_at, sms_gateway_health.last_ping_at),
        last_app_started_at = COALESCE(excluded.last_app_started_at, sms_gateway_health.last_app_started_at),
        updated_at = excluded.updated_at
    `).run(
      input.provider,
      input.deviceId,
      input.status ?? "unknown",
      input.version ?? null,
      input.batteryLevel ?? null,
      input.charging == null ? null : input.charging ? 1 : 0,
      input.connectionAvailable == null ? null : input.connectionAvailable ? 1 : 0,
      input.cellularType ?? null,
      input.carrierName ?? null,
      now,
      input.ping ? now : null,
      input.appStarted ? now : null,
      now,
      input.status ?? null
    );
    return this.getGatewayHealth(input.provider)!;
  }

  getGatewayHealth(provider: string): SmsGatewayHealth | undefined {
    const row = this.db.prepare("SELECT * FROM sms_gateway_health WHERE provider = ?").get(provider) as GatewayHealthRow | undefined;
    if (!row) return undefined;
    return {
      provider: row.provider,
      deviceId: row.device_id,
      status: row.status,
      version: row.version ?? undefined,
      batteryLevel: row.battery_level ?? undefined,
      charging: row.charging == null ? undefined : Boolean(row.charging),
      connectionAvailable: row.connection_available == null ? undefined : Boolean(row.connection_available),
      cellularType: row.cellular_type ?? undefined,
      carrierName: row.carrier_name ?? undefined,
      lastEventAt: new Date(row.last_event_at).toISOString(),
      lastPingAt: iso(row.last_ping_at),
      lastAppStartedAt: iso(row.last_app_started_at),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private messageSelect(suffix: string): Database.Statement {
    return this.db.prepare(`
      SELECT
        msg.id, msg.group_id, msg.sender_member_id, sender.display_name AS sender_name,
        msg.source, msg.body, msg.created_at, msg.edited_at, msg.deleted_at,
        reply.id AS reply_id, reply.body AS reply_body, reply_sender.display_name AS reply_sender_name
      FROM messages msg
      LEFT JOIN members sender ON sender.id = msg.sender_member_id
      LEFT JOIN messages reply ON reply.id = msg.reply_to_message_id
      LEFT JOIN members reply_sender ON reply_sender.id = reply.sender_member_id
      ${suffix}
    `);
  }

  private mapMessages(rows: MessageRow[]): ChatMessage[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const reactionRows = this.db.prepare(`
      SELECT r.*, m.display_name AS member_name FROM reactions r
      JOIN members m ON m.id = r.member_id WHERE r.message_id IN (${placeholders})
      ORDER BY r.created_at
    `).all(...ids) as Array<{
      id: string; message_id: string; member_id: string; member_name: string; emoji: string; created_at: number;
    }>;
    const attachmentRows = this.db.prepare(`
      SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at
    `).all(...ids) as Array<{
      id: string; message_id: string; type: "IMAGE"; storage_path: string; original_filename: string; mime_type: string; size: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      senderMemberId: row.sender_member_id ?? undefined,
      senderName: row.sender_name ?? "System",
      source: row.source,
      body: row.deleted_at ? "Message removed" : row.body,
      replyTo: row.reply_id ? {
        id: row.reply_id,
        senderName: row.reply_sender_name ?? "System",
        body: row.reply_body ?? ""
      } : undefined,
      reactions: reactionRows.filter((reaction) => reaction.message_id === row.id).map((reaction) => this.mapReaction(reaction)),
      attachments: attachmentRows.filter((attachment) => attachment.message_id === row.id).map((attachment) => ({
        id: attachment.id,
        messageId: attachment.message_id,
        type: attachment.type,
        url: `/api/attachments/${attachment.id}`,
        originalFilename: attachment.original_filename,
        mimeType: attachment.mime_type,
        size: attachment.size
      })),
      createdAt: new Date(row.created_at).toISOString(),
      editedAt: iso(row.edited_at),
      deletedAt: iso(row.deleted_at)
    }));
  }

  private mapReaction(row: {
    id: string; message_id: string; member_id: string; member_name: string; emoji: string; created_at: number;
  }): Reaction {
    return {
      id: row.id,
      messageId: row.message_id,
      memberId: row.member_id,
      memberName: row.member_name,
      emoji: row.emoji,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private mapMember(row: MemberRow): Member {
    return {
      id: row.id,
      displayName: row.display_name,
      phoneNumberE164: row.phone_number_e164,
      role: row.role,
      deliveryMode: row.delivery_mode,
      active: Boolean(row.active),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private mapGroup(row: GroupRow): Group {
    return {
      id: row.id,
      name: row.name,
      smsDid: row.sms_did ?? undefined,
      smsEnabled: Boolean(row.sms_enabled),
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private mapDelivery(row: DeliveryRow): SmsDelivery {
    return {
      id: row.id,
      messageId: row.message_id,
      memberId: row.member_id,
      memberName: row.member_name,
      phoneNumber: row.phone_number,
      provider: row.provider,
      providerMessageId: row.provider_message_id ?? undefined,
      providerStatus: row.provider_status ?? undefined,
      providerPartsCount: row.provider_parts_count ?? undefined,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      nextAttemptAt: iso(row.available_at),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
}
