# SMS Bridge Chat

A private, self-hosted group chat where installing an app is optional. The application database is the canonical conversation; the PWA and ordinary SMS are two clients of that same conversation.

> Current build status: the complete text MVP is implemented and covered by 25 automated tests. The remaining production gate is owner-supplied VoIP.ms configuration plus real Canadian/U.S. phone validation. Images/MMS remain deliberately deferred.

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

## VoIP.ms callback route

The inbound route is:

```text
GET /api/webhooks/voipms/:secret
```

Configure the DID callback with URL-encoded substitutions:

```text
https://chat.example.com/api/webhooks/voipms/LONG_RANDOM_SECRET?to={TO}&from={FROM}&message={MESSAGE}&id={ID}&timestamp={TIMESTAMP}&media={MEDIA}
```

The handler checks the secret and destination DID, normalizes the sender, applies the active-member allow-list, and uses the VoIP.ms ID as an idempotency key. It returns the exact text `ok` only after the canonical message and all delivery jobs have committed. Slow outbound calls never run in the callback request.

`src/server/sms/voipms.ts` is the only code that knows the VoIP.ms outbound field names. The publicly documented common authentication fields and `sendSMS` method are implemented, but the owner must compare `did`, `dst`, and `message` against the current method reference inside Main Menu → SOAP & REST/JSON API. Set `VOIPMS_SENDSMS_PARAMS_VERIFIED=true` only after that comparison.

## Owner's VoIP.ms setup checklist

Use the current [VoIP.ms SMS/MMS instructions](https://wiki.voip.ms/article/SMS-MMS) and [API overview](https://wiki.voip.ms/article/API_Overview) as the source of truth while completing these steps:

1. Confirm the existing DID shows SMS/MMS support.
2. Enable Message Service/SMS/MMS on that DID.
3. Open Main Menu → SOAP and REST/JSON API and enable API access.
4. Create a dedicated API password. Do not reuse or paste the portal password.
5. Add the Unraid/public egress IP or approved DNS/CIDR to the API allow-list. The `getIP` method can show the address VoIP.ms sees.
6. Select E.164 dialing mode for SMS/API and store the DID as `+1...` in `.env`.
7. Create a long random `VOIPMS_WEBHOOK_SECRET` and configure this callback, retaining every substitution variable:

   ```text
   https://chat.example.com/api/webhooks/voipms/SECRET?to={TO}&from={FROM}&message={MESSAGE}&id={ID}&timestamp={TIMESTAMP}&media={MEDIA}
   ```

8. Ensure the proxy/provider safely URL-encodes substituted values.
9. Enable URL Callback Retry. The application returns exact lowercase `ok` after durable persistence, so duplicate retries are safe.
10. Send a real inbound SMS and confirm one canonical PWA message appears.
11. Send a PWA message and confirm each intended SMS/BOTH member receives one sender-prefixed SMS.
12. Complete any messaging/A2P verification VoIP.ms requires for API traffic and confirm that this private conversational bridge is acceptable for the account.
13. VoIP.ms documents a default API-originated limit of 100 messages/day. Request a higher limit if appropriate, then change `SMS_DAILY_LIMIT` to the approved value.
14. Compare the current portal-only `sendSMS` fields with the isolated adapter, then set `VOIPMS_SENDSMS_PARAMS_VERIFIED=true`.
15. Only after all prior checks, set `SMS_ENABLED=true` and restart the container.

Do not send credentials through chat or commit them. Put them directly in the deployment's protected `.env`/secret configuration.

## Reverse proxy and query-string privacy

VoIP.ms's standard callback puts private message text in a GET query. The application disables automatic request logging and only records route templates, never full URLs. The reverse proxy must follow the same rule. For Nginx, use a dedicated callback location with access logging disabled, while retaining normal logs elsewhere:

```nginx
location ^~ /api/webhooks/voipms/ {
    access_log off;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

In Nginx Proxy Manager, create a custom location for `/api/webhooks/voipms/` and add `access_log off;` to that location rather than adding a second nested `location` block to a generated server. Check upstream CDN/tunnel logging too. The secret itself is part of the path, so this route should not appear in access logs at all.

Keep `TRUST_PROXY=false` if the app port is directly reachable. When only a reverse proxy can reach it, set `TRUST_PROXY` to that proxy's exact IP/CIDR so forwarded client addresses can be used safely for rate limiting. Avoid a blanket `true` unless the entire network path is controlled.

## Required real-phone validation

Before calling the deployment production-ready, test this matrix with actual phones:

- Canadian PWA → Canadian SMS
- Canadian SMS → PWA and another SMS member, with no sender echo
- U.S. PWA/SMS member in both directions
- One message containing emoji and one containing a full HTTPS link
- A deliberate duplicate callback using the same provider ID
- Provider credentials temporarily disabled while a PWA message is sent, followed by retry recovery
- Bridge kill switch while ordinary PWA chat continues
- Usage warnings at configured 80%, 95%, and 100% thresholds

Do not enable images/MMS until this text matrix passes.

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
| `npm run security:audit` | Check production dependencies for published vulnerabilities |
| `npm run typecheck` | Type-check server and PWA |
| `npm run build` | Build production server and static PWA |
| `npm run db:migrate:dev` | Apply local database migrations |
| `npm run create-admin:dev -- --name ... --phone ...` | Bootstrap an administrator locally |
| `npm run create-admin -- --name ... --phone ...` | Bootstrap an administrator after production build |

The GitHub CI workflow repeats tests, the production build, and a real `docker build`. A separate manual/tag workflow publishes an `linux/amd64` image to `ghcr.io/<owner>/sms-bridge-chat` without embedding `.env` values.

## Automated coverage

`npm test` currently runs 25 tests covering:

- OTP sessions, CSRF, member administration, persistence, and authenticated Socket.IO delivery
- Known/unknown inbound numbers, wrong DID, bad secret, duplicate provider IDs, and bridge shutdown
- PWA fan-out, SMS fan-out, and the no-sender-echo rule
- Provider outage, permanent errors, bounded transient retries, restart recovery, and uncertain in-flight safety
- Daily-limit enforcement and warning thresholds while canonical chat continues
- Markdown-to-SMS degradation, full-link preservation, reply quoting, and reaction suppression
- Isolated VoIP.ms request mapping and the mandatory owner-verification gate

## Environment

The complete, comment-documented list is in `.env.example`. Secrets are server-only and must never be embedded in frontend variables or committed. `SESSION_SECRET` must be at least 32 characters in production. `DEV_OTP_BYPASS_CODE` is rejected in production.

## Milestones

- [x] Milestone 1 — canonical local chat, authentication, administration, PWA, history, realtime
- [x] Milestone 2 — inbound callback, phone mapping, sender allow-list, idempotency
- [x] Milestone 3 — provider adapter, durable per-recipient fan-out queue, sender prefixes
- [x] Milestone 4 — retries, limits, outage handling, monitoring, redacted logs
- [x] Milestone 5 — safe Markdown, replies, reactions, link-preserving SMS rendering
- [ ] Milestone 6 — image uploads/MMS, intentionally waiting for real-phone text validation

See `docs/IMPLEMENTATION_STATUS.md` for the remaining production assumptions and intentionally deferred work.
