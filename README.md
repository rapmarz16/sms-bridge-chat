# SMS Bridge Chat

A private, self-hosted group chat where installing an app is optional. The application database is the canonical conversation; the PWA and ordinary SMS are two clients of that same conversation.

> Current build status: the local-chat milestone is implemented. Bidirectional VoIP.ms bridging, queue reliability, usage enforcement, and their automated tests live in the same repository and are completed in later milestones before the bridge should be enabled.

## What is implemented

- Mobile-first installable PWA with safe Markdown, replies, emoji, and reactions
- Pre-created members with `APP`, `SMS`, or `BOTH` delivery modes
- Six-digit SMS OTP flow, hashed challenges, bounded attempts, and durable sessions
- Secure HTTP-only session cookies plus CSRF and same-origin checks
- Canonical SQLite message history with WAL mode and automated migrations
- Socket.IO realtime events; the database remains authoritative after reconnects
- Administrator member management, bridge kill switch, usage display, and delivery failures
- Persistent per-recipient SMS delivery rows and provider attempt accounting
- Provider-neutral `SmsProvider` interface with an isolated VoIP.ms adapter
- Idempotent VoIP.ms callback route and unknown-number allow-list behavior
- Docker/Compose packaging, Unraid-friendly ownership, mounted data, and `/health`

Images/MMS remain intentionally gated until the text bridge has been proven with real Canadian and U.S. phones, as required by the product plan.

## Architecture

```text
React PWA ── HTTPS / Socket.IO ─┐
                               ├── Fastify application ── SQLite /data/chat.db
VoIP.ms callback ── HTTPS ──────┘           │
                                            └── persistent delivery worker ── VoIP.ms API
```

The `SqliteStore` is the only persistence boundary. Chat services do not depend on VoIP.ms-specific request fields, and provider details are confined to `src/server/sms/voipms.ts`.

## Quick start for development

Prerequisites: Node.js 22+ and a compiler toolchain for `better-sqlite3` if a prebuilt binary is unavailable.

```bash
cp .env.example .env
```

For local development only, change these values in `.env`:

```dotenv
APP_BASE_URL=http://localhost:3000
SESSION_SECRET=development-secret-at-least-32-characters
DATABASE_PATH=./data/chat.db
UPLOADS_PATH=./data/uploads
SMS_ENABLED=false
DEV_OTP_BYPASS_CODE=123456
```

Then run:

```bash
npm ci
npm run db:migrate:dev
npm run create-admin:dev -- --name "Raphael" --phone "+14165551234"
npm run dev
```

The PWA development server opens on port `5173` and proxies API/WebSocket traffic to port `3000`. Use the administrator's phone number and the development code from `.env`.

## Docker / Unraid start

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Leave `SMS_ENABLED=false` for the first boot.
3. Set `APPDATA_PATH` in your shell or Compose `.env` to an Unraid path such as `/mnt/user/appdata/sms-bridge-chat`.
4. Build and start the container:

```bash
docker compose up -d --build
docker compose exec sms-bridge-chat node dist/server/cli/create-admin.js --name "Raphael" --phone "+14165551234"
```

5. Confirm `http://UNRAID-IP:3000/health` returns:

```json
{"status":"ok","database":"ok"}
```

6. Put the application behind an HTTPS reverse proxy before using it outside a trusted LAN. Production startup deliberately fails if `APP_BASE_URL` is not HTTPS.

All canonical state and uploads are under `/data`. Back up the mapped app-data folder plus the separately protected `.env` values to restore on another Docker host. For a consistent live SQLite backup, use Unraid Appdata Backup with the container stopped, or SQLite's online backup command rather than copying only `chat.db` while the service is writing.

## Initial administrator

The compiled container command is:

```bash
node dist/server/cli/create-admin.js --name "Name" --phone "+14165551234"
```

It creates the first member, adds the member to the default group, grants administrator access, and uses `BOTH` delivery mode. Running it again for the same normalized phone number safely restores that member as an active administrator.

## Safety defaults

- `SMS_ENABLED=false` prevents accidental provider traffic.
- `VOIPMS_SENDSMS_PARAMS_VERIFIED=false` independently blocks sends until the owner compares `did`, `dst`, and `message` with the current account-portal `sendSMS` method reference.
- Every outbound provider call, including an OTP, consumes one daily-limit unit.
- At 100%, canonical messages continue but SMS deliveries become `SKIPPED_LIMIT`.
- A delivery that was already `SENDING` during an unclean restart is marked failed with an uncertain-provider-state message instead of being silently resent and potentially duplicated.
- Application logs do not include request URLs/query strings, message bodies, codes, tokens, cookies, or credentials.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API and PWA development servers |
| `npm test` | Run automated integration and reliability tests |
| `npm run typecheck` | Type-check server and PWA |
| `npm run build` | Build production server and static PWA |
| `npm run db:migrate:dev` | Apply local database migrations |
| `npm run create-admin:dev -- --name ... --phone ...` | Bootstrap an administrator locally |
| `npm run create-admin -- --name ... --phone ...` | Bootstrap an administrator after production build |

## Environment

The complete, comment-documented list is in `.env.example`. Secrets are server-only and must never be embedded in frontend variables or committed. `SESSION_SECRET` must be at least 32 characters in production. `DEV_OTP_BYPASS_CODE` is rejected in production.

## Milestones

- [x] Milestone 1 — canonical local chat, authentication, administration, PWA, history, realtime
- [x] Milestone 2 — inbound callback, phone mapping, sender allow-list, idempotency
- [x] Milestone 3 — provider adapter, durable per-recipient fan-out queue, sender prefixes
- [x] Milestone 4 — retries, limits, outage handling, monitoring, redacted logs
- [x] Milestone 5 — safe Markdown, replies, reactions, link-preserving SMS rendering
- [ ] Milestone 6 — image uploads/MMS, intentionally waiting for real-phone text validation

Full VoIP.ms configuration, callback, reverse-proxy logging, production verification, and test instructions are documented below as those bridge milestones are finalized.
