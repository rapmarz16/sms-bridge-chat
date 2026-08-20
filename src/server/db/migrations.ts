import type Database from "better-sqlite3";

type Migration = { version: number; name: string; sql: string };

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sms_did TEXT,
        sms_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sms_enabled IN (0, 1)),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        phone_number_e164 TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
        delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('APP', 'SMS', 'BOTH')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE group_memberships (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, member_id)
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK (source IN ('APP', 'SMS', 'SYSTEM')),
        body TEXT NOT NULL,
        reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        external_provider TEXT,
        external_provider_id TEXT,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER
      );
      CREATE UNIQUE INDEX messages_external_id_unique
        ON messages(external_provider, external_provider_id)
        WHERE external_provider_id IS NOT NULL;
      CREATE INDEX messages_group_created_idx ON messages(group_id, created_at DESC);

      CREATE TABLE reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(message_id, member_id, emoji)
      );

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('IMAGE')),
        storage_path TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        provider_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sms_deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        phone_number TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','ACCEPTED','FAILED','SKIPPED','SKIPPED_LIMIT')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        available_at INTEGER NOT NULL,
        locked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(message_id, member_id)
      );
      CREATE INDEX sms_deliveries_queue_idx ON sms_deliveries(status, available_at);

      CREATE TABLE sms_provider_attempts (
        id TEXT PRIMARY KEY,
        reference_type TEXT NOT NULL CHECK (reference_type IN ('DELIVERY', 'OTP')),
        reference_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        day_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('STARTED', 'ACCEPTED', 'FAILED')),
        error TEXT,
        attempted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX sms_provider_attempts_day_idx ON sms_provider_attempts(day_key, attempted_at);

      CREATE TABLE otp_challenges (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX otp_member_created_idx ON otp_challenges(member_id, created_at DESC);

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_member_idx ON sessions(member_id);

      CREATE TABLE security_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        masked_phone TEXT,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX security_events_created_idx ON security_events(created_at DESC);
    `
  },
  {
    version: 2,
    name: "one_group_per_sms_did",
    sql: `
      CREATE UNIQUE INDEX groups_sms_did_unique
        ON groups(sms_did)
        WHERE sms_did IS NOT NULL;
    `
  },
  {
    version: 3,
    name: "android_gateway_status_and_health",
    sql: `
      ALTER TABLE sms_deliveries ADD COLUMN provider_status TEXT;
      ALTER TABLE sms_deliveries ADD COLUMN provider_parts_count INTEGER;
      ALTER TABLE sms_deliveries ADD COLUMN provider_status_updated_at INTEGER;
      CREATE INDEX sms_deliveries_provider_message_idx
        ON sms_deliveries(provider, provider_message_id);

      CREATE TABLE sms_gateway_health (
        provider TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'unknown')),
        version TEXT,
        battery_level REAL,
        charging INTEGER CHECK (charging IS NULL OR charging IN (0, 1)),
        connection_available INTEGER CHECK (connection_available IS NULL OR connection_available IN (0, 1)),
        cellular_type INTEGER,
        carrier_name TEXT,
        last_event_at INTEGER NOT NULL,
        last_ping_at INTEGER,
        last_app_started_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 4,
    name: "web_push_subscriptions",
    sql: `
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX push_subscriptions_member_idx
        ON push_subscriptions(member_id);
    `
  }
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version)
  );
  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, Date.now());
  });
  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}
