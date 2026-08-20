# Implementation status and assumptions

## Completed gates

### Milestone 1 — local chat

- Canonical SQLite schema and migrations
- Pre-created member administration
- Hashed OTP challenge and durable session login
- Mobile-first PWA, history, replies, reactions, safe Markdown rendering
- Socket.IO notifications with database-backed reconnect/history behavior
- Automated tests and production build

### Milestones 2–3 — text bridge

- Selectable VoIP.ms or Android/SIM provider behind one provider interface
- Secret-protected inbound VoIP.ms callback
- HMAC-signed Android callbacks for inbound SMS, delivery states, startup, and health pings
- DID validation, E.164 normalization, member allow-list
- Provider-ID idempotency within the same transaction as message persistence
- Per-recipient delivery rows created atomically with the canonical message
- PWA-to-SMS and SMS-to-other-SMS fan-out
- Mandatory sender prefixes and no echo to an inbound SMS sender
- Isolated VoIP.ms and Android Local Server request mappings
- Android callback-registration CLI, stable outbound gateway IDs, and ambiguous-request recovery
- Automated known/unknown sender, duplicate callback, wrong DID, kill-switch, and fan-out tests

### Milestones 4–5 — reliability and rich text

- Persistent queue claims, bounded exponential retries, and permanent/transient error handling
- Provider-call accounting and enforced daily cutoff with 80/95/100 percent warnings
- Pending delivery recovery after restart and at-most-once handling for uncertain in-flight jobs
- Safe provider switching: stale queued jobs require explicit administrator review and retry through the new provider
- Admin usage/failure monitoring and deliberate retry control
- Android phone carrier, battery, version, and last-check-in monitoring
- Safe Markdown rendering in the PWA and deterministic plain-text SMS degradation
- Reply context capped to a short quote and reactions retained as app-only events
- Authenticated Socket.IO integration test and isolated VoIP.ms form-mapping tests

## Unresolved production assumptions

1. The full `sendSMS` method parameter reference is only available in the authenticated VoIP.ms account portal. The adapter uses the isolated `did`, `dst`, and `message` mapping and refuses to send until the owner sets `VOIPMS_SENDSMS_PARAMS_VERIFIED=true` after comparing it with the current portal reference.
2. Real provider traffic cannot be validated without the owner's dedicated API credentials, SMS-enabled DID, IP allow-list, and A2P approval. Credentials must be placed directly into the deployment secret environment, never sent in chat or committed.
3. A physical Android phone/SIM cannot be exercised in this build environment. Before production use, the owner must validate inbound, outbound, delivery reports, restart recovery, and Canada/U.S. traffic on the selected phone and carrier.
4. Docker/Podman/Buildah is unavailable in this implementation runner. Compose syntax is validated locally, while the actual image build remains a Docker-enabled GitHub CI and Unraid-host gate.
5. The VoIP.ms callback uses a GET query containing message text. Application logging omits full URLs, but the deployment reverse proxy must also disable or redact query-string access logging for this route.
6. A job that was already marked `SENDING` during an unclean process death has an unknowable provider outcome because VoIP.ms does not expose a client idempotency key in the public material. The worker chooses at-most-once restart behavior: it marks that delivery failed for explicit administrator review instead of silently resending a possible duplicate.
7. Consumer-plan “unlimited texting” may not authorize an automated relay or roughly 900–1,200 outbound deliveries/day. Written carrier confirmation and a deliberately conservative phone-side rate limit remain production gates.
8. MMS remains out of scope until bidirectional text is tested with actual Canadian and U.S. mobile numbers, as required by the build order.

## Local verification snapshot

- 34 automated tests pass.
- TypeScript server and PWA type checks pass.
- The optimized production server/PWA build passes.
- A production-mode runtime smoke test serves the PWA and reports `{"status":"ok","database":"ok"}`.
- The production dependency audit reports zero known vulnerabilities.
- Docker Compose YAML parses successfully; the GitHub CI workflow performs the unavailable local `docker build` gate.
