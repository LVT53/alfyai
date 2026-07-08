# AlfyAI Connections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan one **Issue** at a time (fresh Sonnet subagent per issue, TDD, two-stage review between issues). Each Issue below is a right-sized unit; at implementation time its subagent expands it into bite-sized red-green-refactor steps. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** PLANNING / not started. This is the decomposition for future implementation, not a spec to build blindly — every Issue ends with "Implementer must verify" notes where a codebase detail needs confirming rather than assuming.

**Goal:** Let each AlfyAI user privately connect their own external accounts (Google, Apple, Nextcloud, Immich, email, Plex, OwnTracks) so the assistant can read from — and, behind an explicit toggle, safely write to — them, without ever corrupting data or leaking one user's data to another.

**Architecture:** A **two-layer** model. *Account connections* are the logins a user makes (one per external account, credentials in a per-user encrypted vault). *Capabilities* are what the AI can do (Calendar, Files, Photos, Email, Location, Media), each backed by one or more connected accounts and individually toggleable. Capability tools are exposed to the model only when enabled for the current user; reads are fetch-on-relevance; writes are explicit-only, allowlist-scoped, confirmed, and reversible-by-default. Everything a connector fetches is processed by whatever chat model the user selected — with a locality guard so sensitive data does not silently leave the box.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, Drizzle ORM + better-sqlite3 (SQLite), Vitest, Playwright, Biome, Vercel AI SDK tool-calling. External protocols: OAuth 2.0 (Google/Microsoft), Nextcloud Login Flow v2, CalDAV (Apple), WebDAV/OCS (Nextcloud), IMAP/SMTP (email), Immich REST, Plex REST, OwnTracks recorder HTTP.

---

## Global Constraints

- **Per-user isolation is absolute.** A connection, its credentials, and its tools resolve *only* to the current AlfyAI user. No cross-user access, ever. Mirror how Memory is already strictly per-user.
- **No owner-managed identity mapping.** Every user self-connects their own accounts. There is no admin impersonation of user accounts.
- **Writes are never autonomous.** A write happens only in direct response to an explicit user instruction/message, never AI-initiated, never as a side effect of a read. AlfyAI is not an autonomous agent.
- **Writes are off by default.** Each connection has a separate `allowWrites` toggle, default `false`. Read access does not imply write access.
- **Write-safety is engineered, not assumed:** allowlist-scoped destination by default, explicit user-named destinations honored, confirm-before-write with a preview, idempotency keys on retryable creates, and platform reversibility (trash/versioning) preferred over hard delete. Hard/irreversible operations (Immich `force:true`, IMAP `EXPUNGE`, recursive `DELETE`) are never issued without an explicit confirm.
- **Secrets at rest are encrypted** using the app's existing AES-GCM secret helper (see `src/lib/server/services/providers.ts`), never stored plaintext. Never logged, never returned to the client after storage, never placed in telemetry/metadata.
- **Local-first privacy (locality guard):** connector-fetched data enters the prompt of the user's selected chat model. Default behavior = **Option C** (warn the user the first time a third-party/cloud model is selected while a connector is active). **Option A** (interim local-Qwen distillation: a local model fetches + extracts, only a summary reaches the cloud model) is a **selectable per-user/per-connection option**, to be live-tested for fidelity and shipped with a measured quality-hit estimate.
- **Incognito = saved-but-untracked** (see Phase 0): full functionality (memory recall, project context, connections all work), but no memory learning and no telemetry/tracking for that conversation.
- **Green gate every issue:** `npx biome check --write <changed>`, `npx tsc --noEmit -p tsconfig.json` (0 errors), and `npx vitest run <relevant>` all green before the issue is done. Migrations follow the repo's hand-authored convention (`drizzle/<epoch>_<name>.sql` + `drizzle/meta/_journal.json` entry + `scripts/prepare-db.ts` `requiredExistingTables` + `npx tsx scripts/verify-migrations.ts`).
- **UI work is done by a design-capable subagent** (Sonnet/Opus), matching existing conventions (CSS tokens, `.settings-card`/`.toggle-btn`, `@lucide/svelte` at `strokeWidth 2.1`), with i18n strings in **both** `en` and `hu`.

---

## Locked Design Decisions (from ideation)

1. **Scope in:** Immich (photos), Nextcloud Files, Email (IMAP/SMTP), Google Calendar, Apple Calendar, Plex (watch-history/analytics only), OwnTracks (location). **Out:** Bitwarden, Minecraft.
2. **Two connection tiers:** *proactive-capable* (Calendar, Email — may feed in-chat live context/suggestions when their toggle is on) and *explicit* (Immich, Files, Plex, Location — off by default, flipped on per need).
3. **Surfaces:** a **Connections panel in the profile** sets what's default-on in chats; the same toggles are in the composer **+ menu**, always one click away.
4. **Connect UX spectrum:** redirect OAuth (Google, Microsoft, Nextcloud Login Flow v2 — confirmed live on the server); one-form connect (Immich email+password → mint scoped API key; own-domain email near-zero-config); paste app-specific password (Apple, arbitrary IMAP).
5. **Multiple accounts per provider** are allowed; when ambiguous the AI **asks which account**, and Memory learns the default from habit over time.
6. **Per-connection health status + one-tap reconnect.** Google's 7-day refresh-token expiry is avoided by moving the OAuth app to **Production + verification** (Calendar = light "sensitive" verification; for Gmail's "restricted" scopes prefer **IMAP + app-specific password** to sidestep the heavy security assessment).
7. **Files capability = union** of connected file backends (Nextcloud + Google Drive if enabled); connections are separate, the in-chat experience is unified. **One Google login → multiple Google capabilities** via incremental authorization.
8. **Proactivity is in-chat only** (no push notifications in v1).
9. **Locality:** Option C default + Option A selectable (see Global Constraints).
10. **Connection data is live context, never written to persistent Memory.** Contacts (CardDAV/Google/Apple) is a supporting resolver capability. Answers cite sources via the existing Sources tab.

---

## Module / File Structure (target)

New backend service area `src/lib/server/services/connections/`:
- `vault.ts` — per-user encrypted credential storage (wraps the existing AES-GCM helper).
- `registry.ts` — connection + capability metadata (which providers exist, which capabilities each powers, tier, connect method).
- `store.ts` — Drizzle CRUD for `user_connections` (+ health, tokens, write-toggle, allowlist).
- `health.ts` — connection health checks + status.
- `resolve.ts` — "for user U + capability C, which connection(s)?" resolution, incl. multi-account disambiguation hook.
- `locality.ts` — Option C warning gate + Option A distillation orchestration.
- `providers/<name>.ts` — one adapter per provider (nextcloud-files, immich, imap, google, apple-caldav, plex, owntracks, contacts), each implementing a common `ConnectionProvider` interface: `connectStart/connectFinish`, `checkHealth`, `read` capability methods, `write` capability methods (guarded), `disconnect`.
- `write-guard.ts` — allowlist scoping, confirm-preview construction, idempotency-key helpers.

New capability tools under `src/lib/server/services/normal-chat-tools/connections/` (one file per capability), registered in `normal-chat-tools/index.ts`, exposed via `normal-chat-tool-gating.ts` (extended to filter by the current user's enabled capabilities).

API routes under `src/routes/api/connections/` (list/connect/callback/disconnect/reconnect/health/toggle) and `src/routes/api/oauth/<provider>/callback`.

UI: `src/routes/(app)/settings/_components/` Connections panel; composer `+` menu entries in `MessageInput.svelte`/`ChatComposerPanel.svelte`; a `ConnectionChip`/health component under `src/lib/components/ui/`.

Schema: `user_connections`, `user_connection_secrets` (or secret columns on the former), optionally `connection_write_audit`.

---

## Phased Issue Breakdown (`/to-issues`)

Each Issue: **Goal · Depends · Files/areas · Interfaces · Tests (TDD) · Safety gates · Acceptance · Size.** Issues within a phase are mostly sequential; phases gate on the prior phase's foundation.

### Phase 0 — Prerequisite: correct Incognito (independent, ship first)

**Issue 0.1 — Incognito becomes "saved-but-untracked"**
- **Goal:** Revert the over-aggressive read-side incognito behavior. Incognito must keep full functionality (memory recall, project context, memory tools) while suppressing memory learning + telemetry/tracking. Conversation stays saved & visible.
- **Depends:** none.
- **Files:** `src/lib/server/services/chat-turn/context-selection.ts` (remove the `memoryIncognito` short-circuits that null out persona/memory + project context at the shallow ~1026 and deep ~1501 sites); `normal-chat-context.ts` (stop threading `memoryIncognito` into context builders for *read suppression*); `chat-turn/normal-chat-tool-gating.ts` (remove the `memory_context` withholding — the `withoutMemory` branch); `plain-`/`streaming-normal-chat-model-run.ts`, `deliberation-runner.ts` (drop the read-side incognito threading). **Keep** the write-side guards: `finalize.ts` intake skip, `memory-judge/index.ts` chokepoint, sweep skip, consolidation guard.
- **Add:** telemetry/tracking suppression for incognito turns — audit `recordMemoryReworkTelemetry`, `recordMessageAnalytics`/`usageEvents` call sites in `finalize.ts`; when the conversation is incognito, skip the memory/usage telemetry writes (keep the assistant message itself saved). Decide with a test what "tracking" covers: memory telemetry (yes) + usage/cost analytics (yes — it's per-conversation tracking) but the conversation row + messages persist.
- **Interfaces:** `isConversationIncognito(conversationId)` already exists — reused for the *write/telemetry* suppression only, not read suppression.
- **Tests (TDD):** (a) incognito conversation still receives persona-memory + project context in the constructed prompt (assert present — inverse of the current test); (b) `memory_context` tool IS exposed in incognito; (c) incognito turn writes **no** `memory_rework_telemetry` and **no** `usage_events` row, but the assistant message row **is** persisted; (d) non-incognito path unchanged.
- **Safety:** confirm no memory *writes* happen in incognito (existing behavior preserved).
- **Acceptance:** incognito chat is functionally identical to a normal chat minus persistence-of-learning + telemetry; the previously-added read-suppression tests are updated/removed to reflect the corrected intent.
- **Size:** M. **Ship + deploy independently of the rest.**

### Phase 1 — Connection framework foundation

**Issue 1.1 — Schema + migration for `user_connections`**
- **Goal:** Persist per-user connections with health, tier, capability set, write-toggle, and allowlist — secrets encrypted.
- **Depends:** 0.x optional.
- **Files:** `src/lib/server/db/schema.ts` (+ migration + journal + `prepare-db.ts`). Columns (draft): `id`, `user_id` (FK cascade), `provider` (enum: nextcloud|immich|imap|google|apple|plex|owntracks|contacts), `label`, `account_identifier` (e.g. email/username for multi-account disambiguation), `status` (connected|needs_reauth|error|disconnected), `status_detail`, `default_on` (bool), `allow_writes` (bool default false), `write_allowlist_json` (default destinations), `capabilities_json` (which capabilities enabled), `secret_ciphertext`, `secret_iv`, `secret_auth_tag`, `oauth_scopes_json`, `token_expires_at`, `created_at`, `updated_at`. Unique index `(user_id, provider, account_identifier)`.
- **Tests (TDD):** migration applies; verify-migrations passes; round-trip insert/select of a connection row.
- **Safety:** secret columns are non-null-or-null but never plaintext; no secret in any index.
- **Acceptance:** table exists on a fresh + migrated DB; `requiredExistingTables` updated.
- **Size:** S. **Implementer must verify** the exact enum/text convention used elsewhere in schema.

**Issue 1.2 — Per-user credential vault (`vault.ts`)**
- **Goal:** Encrypt/decrypt connection secrets reusing the app's AES-GCM helper.
- **Files:** `connections/vault.ts`. **Implementer must verify** the exact exported encrypt/decrypt signature in `src/lib/server/services/providers.ts` and reuse it (do not hand-roll crypto).
- **Interfaces:** `encryptConnectionSecret(plaintext: string): {ciphertext, iv, authTag}`, `decryptConnectionSecret({ciphertext, iv, authTag}): string`.
- **Tests (TDD):** encrypt→decrypt round-trips; ciphertext ≠ plaintext; wrong-key/tamper fails closed (throws, never returns garbage); a decrypt failure never logs the secret.
- **Safety:** secrets never appear in error messages/logs.
- **Acceptance:** vault is the only path that touches secret columns.
- **Size:** S.

**Issue 1.3 — Connection store CRUD (`store.ts`)**
- **Goal:** Create/list/get/update/delete connections, always scoped by `user_id`; secrets flow through the vault.
- **Files:** `connections/store.ts`.
- **Interfaces:** `createConnection`, `listConnectionsForUser(userId)`, `getConnection(userId, id)`, `updateConnection`, `setConnectionSecret`, `deleteConnection`, `setAllowWrites`, `setDefaultOn`, `setEnabledCapabilities`. All take `userId` and filter on it.
- **Tests (TDD):** user A cannot read/update/delete user B's connection (returns null / no-op); list is user-scoped; delete removes the secret; public serialization **never** includes secret material.
- **Safety:** every query has `eq(user_id)`; a serializer strips secrets.
- **Acceptance:** the public connection DTO has no secret fields (type-enforced).
- **Size:** M.

**Issue 1.4 — Connection registry + `ConnectionProvider` interface (`registry.ts`)**
- **Goal:** Static metadata for providers/capabilities/tiers/connect-methods + the adapter interface everything implements.
- **Files:** `connections/registry.ts`.
- **Interfaces:** `ConnectionProvider` = `{ provider, capabilities, tier, connectMethod: 'oauth'|'login-flow-v2'|'password-key'|'app-password', connectStart(userId, opts), connectFinish(userId, cb), checkHealth(conn), disconnect(conn) }`; `CAPABILITIES` map (calendar/files/photos/email/location/media/contacts → which providers power them).
- **Tests (TDD):** registry is internally consistent (every capability has ≥1 provider; every provider lists valid capabilities); tier assignments match the spec.
- **Safety:** none new.
- **Acceptance:** other modules import capability/provider truth only from here.
- **Size:** S.

**Issue 1.5 — Connection resolution + multi-account disambiguation (`resolve.ts`)**
- **Goal:** Given `(userId, capability)`, return the connected account(s); expose a disambiguation signal when >1.
- **Files:** `connections/resolve.ts`.
- **Interfaces:** `resolveConnectionsForCapability(userId, capability): Connection[]`; `needsDisambiguation(connections): boolean`.
- **Tests (TDD):** 0 → empty; 1 → that one; 2 Google accounts → both + `needsDisambiguation` true; disabled capability excluded.
- **Acceptance:** used by every capability tool.
- **Size:** S.

**Issue 1.6 — Health checks (`health.ts`) + status API**
- **Goal:** Per-connection health probe + persisted status; API to read it.
- **Files:** `connections/health.ts`; `src/routes/api/connections/health/+server.ts` (or fold into list).
- **Interfaces:** `checkConnectionHealth(conn): {status, detail}` (delegates to the provider adapter); writes status back via store.
- **Tests (TDD):** healthy → connected; expired token → needs_reauth; unreachable → error; status persists.
- **Safety:** health checks are read-only, cheap, timeout-bounded.
- **Acceptance:** UI can show live status.
- **Size:** M.

### Phase 2 — First connector end-to-end (pattern-prover): Nextcloud Files (read-only)

Chosen first because it's on-box (fast, low-risk), has strong reversibility semantics, and exercises the whole stack (connect flow, vault, capability tool, tool-gating, citations) without cloud-OAuth complexity.

**Issue 2.1 — Nextcloud connect via Login Flow v2 (`providers/nextcloud-files.ts` connect)**
- **Goal:** Redirect-based connect that yields an app password, stored via vault.
- **Files:** `connections/providers/nextcloud-files.ts` (connectStart/connectFinish); `src/routes/api/connections/nextcloud/start/+server.ts` + `.../poll/+server.ts`.
- **Interfaces:** `connectStart` → `{loginUrl, pollToken, pollEndpoint}` (POST `index.php/login/v2`, confirmed live); `connectFinish` polls until the user authorizes, stores returned `appPassword` + `server`+`loginName`.
- **Tests (TDD):** with a mocked Nextcloud responding the Login-Flow-v2 shape, connectStart returns the login URL + poll token; connectFinish stores an encrypted secret + sets status connected; a poll-timeout leaves status unchanged and surfaces a retriable error.
- **Safety:** app password encrypted immediately; never returned to client.
- **Acceptance:** a Nextcloud connection row exists with a decryptable secret.
- **Size:** M. **Implementer must verify** the exact poll response fields (`appPassword`, `loginName`, `server`).

**Issue 2.2 — Nextcloud Files read adapter (WebDAV)**
- **Goal:** List/search/read files via WebDAV, safely and with pagination.
- **Files:** `providers/nextcloud-files.ts` (read methods).
- **Interfaces:** `listFolder(conn, path)`, `search(conn, query)` (WebDAV `SEARCH`/`PROPFIND`), `readFile(conn, path): {bytes|text, meta}`, `stat(conn, path)`.
- **Tests (TDD):** against a mocked WebDAV: PROPFIND parse → file list; search → results; read returns bytes + etag; large-folder PROPFIND is depth-1 + paginated; auth failure → needs_reauth surfaced.
- **Safety:** reads only; path normalization prevents traversal outside the user's `files/{user}` root; timeouts.
- **Acceptance:** returns real file metadata from the user's Nextcloud (manual smoke on-box).
- **Size:** M.

**Issue 2.3 — Files capability tool + registration + gating**
- **Goal:** Expose a `files_search`/`files_read` tool to the model **only** when the user has an enabled Files connection.
- **Files:** `normal-chat-tools/connections/files.ts`; register in `normal-chat-tools/index.ts`; extend `normal-chat-tool-gating.ts` to filter connection tools by the current user's enabled capabilities (add `enabledCapabilities: Set<Capability>` to its params, threaded from the turn like `memoryIncognito` is — see the plain/streaming runners).
- **Interfaces:** tool (zod schema `{query, path?}`) → returns results + **source citations** (file name, path, link) in the Sources-tab shape.
- **Tests (TDD):** tool exposed when Files enabled, absent when not; tool result includes citations; disambiguation prompt when 2 file backends; incognito does **not** hide it (per Phase 0 — connections work in incognito).
- **Safety:** read-only tool; no write surface here.
- **Acceptance:** in a chat with Files on, "find my X" returns cited results.
- **Size:** M. **Implementer must verify** the exact `NormalChatToolSet` registration + how per-user capability set is available at the turn (thread from `normal-chat-context`/finalize like other per-user flags).

**Issue 2.4 — Sources/citations for connection results**
- **Goal:** Connection-sourced answers cite via the existing Sources tab.
- **Files:** wherever the Sources tab consumes `contextSources` (verify in `chat-turn/context-sources.ts` + the Sources UI).
- **Tests (TDD):** a files result surfaces a source chip with a working link/label.
- **Acceptance:** citations render.
- **Size:** S. **Implementer must verify** the Sources data contract.

### Phase 3 — Locality guard (Option C now, Option A scaffolding)

**Issue 3.1 — Option C: cloud-model warning gate (`locality.ts`)**
- **Goal:** The first time a user selects a third-party/cloud model while any connector is active in that chat, warn that connector data will be sent to that provider; remember the acknowledgement.
- **Files:** `connections/locality.ts`; a per-user `connection_cloud_ack` flag (small table or user column); a hook at the turn where the model + active connectors are known.
- **Interfaces:** `shouldWarnCloudConnector({userId, modelId, activeCapabilities}): boolean`; `recordCloudAck(userId)`.
- **Tests (TDD):** local model → never warns; cloud model + active connector + no prior ack → warn; after ack → no warn; no active connector → no warn.
- **Safety:** the warning is informational; it does not itself send data.
- **Acceptance:** warning fires once per user as specified.
- **Size:** M. **Implementer must verify** how "model is local vs cloud" is determined (provider baseUrl / a capability flag on the provider row).

**Issue 3.2 — Option A: local-Qwen distillation path (selectable)**
- **Goal:** When enabled (per-user or per-connection), route connector payloads through a local model that extracts only what's relevant before the cloud model sees them.
- **Files:** `connections/locality.ts` (distill orchestration reusing `sendJsonControlMessage` with a local model id); a setting for the toggle.
- **Interfaces:** `distillConnectorPayload({userId, capability, rawData, userQuestion}): string` (local-model summary) — used only when Option A is on and the chat model is cloud.
- **Tests (TDD):** Option A off → raw passes through (Option C governs); Option A on + cloud model → cloud model receives only the distilled summary, never the raw payload (assert raw is absent from the outgoing prompt); Option A on + local model → no extra hop (raw used directly).
- **Safety:** the raw payload must never reach the cloud model when Option A is on — assert this explicitly in a test.
- **Fidelity:** ship behind the toggle; add a live-eval harness note (see Cross-cutting) to measure quality delta and surface an estimate in the UI copy.
- **Acceptance:** toggle works; raw never leaks under Option A.
- **Size:** L.

### Phase 4 — Write path (guarded, heavily tested) — applied first to Nextcloud Files

**Issue 4.1 — Write-guard core (`write-guard.ts`)**
- **Goal:** The safety spine every write goes through: allowlist scoping, confirm-preview, idempotency.
- **Files:** `connections/write-guard.ts`.
- **Interfaces:** `resolveWriteTarget({conn, requestedPath, allowlist}): {path, withinAllowlist}` (explicit user-named path honored; otherwise default allowlist area); `buildWritePreview(op): Preview`; `idempotencyKey(op): string`.
- **Tests (TDD):** unspecified destination → allowlist default; explicit user path → honored even outside allowlist (but flagged `withinAllowlist=false` so UI can warn); traversal/escape attempts rejected; idempotency key stable for identical ops.
- **Safety:** this module is the single chokepoint; no provider writes bypass it.
- **Acceptance:** every write adapter consumes it.
- **Size:** M.

**Issue 4.2 — Nextcloud Files write adapter (upload/save) + confirm**
- **Goal:** Create/overwrite files safely: chunked upload for large files, `If-Match` on overwrite, versioning/trash as the safety net; explicit confirm before executing.
- **Files:** `providers/nextcloud-files.ts` (write methods); the Files tool gains a write action gated by `allow_writes`.
- **Interfaces:** `putFile(conn, path, bytes, {ifMatch?, chunked?})`, `moveFile`, `deleteFile` (to trash; never bypass trash without confirm).
- **Tests (TDD):** small PUT writes; large file uses chunked-upload assembly (MKCOL→PUT chunks→MOVE); overwrite without `If-Match` on a changed etag is refused (412) not clobbered; delete goes to trash; write refused entirely when `allow_writes=false`; a write with no explicit confirm token is refused.
- **Safety:** no `allow_writes` → hard refusal; recursive delete / overwrite requires confirm; chunked upload prevents partial-file corruption; assert versioning/trash reachable.
- **Acceptance:** cannot corrupt or delete outside the flow; confirmed writes land where asked.
- **Size:** L.

**Issue 4.3 — Write confirm/preview surfacing (tool ↔ UI)**
- **Goal:** The model proposes a write; the user sees a preview and explicitly confirms before execution.
- **Files:** the write tool returns a "pending write" the composer renders as a confirm card; a confirm endpoint executes it.
- **Tests (TDD):** tool call yields a pending-write (no execution); confirm executes exactly once (idempotent on double-confirm); cancel discards.
- **Safety:** execution is impossible without the explicit confirm step.
- **Acceptance:** end-to-end confirmed write; no silent writes.
- **Size:** M (UI portion → design subagent).

### Phase 5 — Connect flows for the remaining providers

**Issue 5.1 — Google OAuth (Calendar; incremental scopes; Production/verified)**
- Files: `providers/google.ts`; `src/routes/api/oauth/google/callback/+server.ts`; a per-user refresh-token store (vault). Interfaces: `connectStart` (auth URL w/ `access_type=offline`, `include_granted_scopes=true`, minimal scope for the capability being enabled), `connectFinish` (code→tokens), `refresh(conn)`. Tests: state/PKCE validated; code→token stored; refresh on expiry; incremental scope add reuses the same account. Safety: tokens encrypted; `state` CSRF-checked. **Implementer must verify** the OAuth client is registered + the callback URL is on the app's public origin; document the Production-verification requirement to avoid the 7-day expiry. Size: L.

**Issue 5.2 — Google Calendar read adapter** — list calendars, `events.list` (time range, `singleEvents`), `freebusy.query`, sync tokens. Tests against mocked API; `410` → full resync. Size: M.

**Issue 5.3 — Apple iCloud CalDAV connect (app-specific password) + read** — `providers/apple-caldav.ts`: paste app-specific password; discovery (`.well-known/caldav` → principal → calendar-home, following iCloud partition redirects); `REPORT` calendar-query read. Tests against a mocked CalDAV incl. a partition redirect; ETag capture. Safety: read-first; document fragility. Size: L.

**Issue 5.4 — Email connect + IMAP read** — `providers/imap.ts`: connect via (a) own-domain near-zero-config, (b) autodiscovery from address (ISPDB/SRV), (c) manual; SMTP submission config captured for later send. Read: SELECT/EXAMINE, SEARCH, `FETCH BODY.PEEK` (never sets `\Seen`), IDLE optional. Tests against a mocked IMAP: search by date/flag; peek doesn't set Seen; large-mailbox content search flagged to require FTS. Size: L. **Implementer must verify** the on-box Dovecot host/ports for zero-config.

**Issue 5.5 — Immich connect (email+password → scoped API key) + photo read** — `providers/immich.ts`: exchange login for a **scoped, read-only** API key (no delete permission) and store it; read via `POST /search/smart` + `/assets/{id}/thumbnail|original`. Tests against mocked Immich: smart search → cited photo results; key is created without delete scope. Safety: read key structurally cannot delete. Size: M.

**Issue 5.6 — Plex (watch-history/analytics read only)** — `providers/plex.ts`: connect via Plex token; read `/status/sessions/history/all`, `/library/sections`. Tests: "how many seasons of X", "what did we watch this week" queries map to history. Read-only; no writes ever. Size: M.

**Issue 5.7 — OwnTracks (location read only)** — `providers/owntracks.ts`: read the on-box recorder HTTP API (`/api/0/list`, `/api/0/locations`), mapped to the current user's device. Tests: last-location + history queries; strict per-user device mapping (a user only sees their own device). Safety: read-only; **critical** per-user device isolation test. Size: M. **Implementer must verify** device↔AlfyAI-user mapping (self-select which OwnTracks device is "me").

**Issue 5.8 — Contacts resolver (CardDAV / Google / Apple)** — `providers/contacts.ts`: name→address/identity resolution used by Calendar/Email tools. Tests: "Zsombor" → address; ambiguous name → disambiguation. Size: M.

### Phase 6 — Write adapters for remaining providers (each gated + confirmed, reusing write-guard)

Each is its own Issue, all consuming `write-guard.ts` + the confirm flow, `allow_writes`-gated, TDD with an explicit "refused when writes off" + "refused without confirm" + "reversible/allowlist" test:
- **6.1 Google Calendar write** — insert/patch/delete events; `iCalUID` idempotency; recurring-edit guardrails (single vs this-and-following, never silently clobber later exceptions); confirm previews. Size: L.
- **6.2 Apple CalDAV write** — `PUT`/`DELETE` `.ics` with mandatory `If-Match`; RRULE edits behind confirm; treat as fragile. Size: L.
- **6.3 Email write** — APPEND draft (idempotency-guarded against dup), STORE flags, MOVE to Trash (never raw EXPUNGE), SMTP send only on explicit user "send". Size: L.
- **6.4 Immich write (optional, later)** — upload to an "AlfyAI" album via a separate write-scoped key; never `force:true`; metadata edits are DB-only. Size: M.

### Phase 7 — UI (design subagent)

- **7.1 Connections panel in profile** — list connections, per-connection: status chip, connect/reconnect/disconnect, `default_on`, `allow_writes` (off by default, with a warning), enabled capabilities, write-allowlist editor. Size: L.
- **7.2 Composer + menu integration** — capability toggles one click away; reflect default-on; disambiguation UI when multiple accounts. Size: M.
- **7.3 Connect wizards** — OAuth redirect handoff, Login-Flow-v2 handoff, app-specific-password paste with provider-specific help, autodiscovery for email. Size: L.
- **7.4 Locality warning + Option A toggle UI** — the Option-C first-time warning; per-user/per-connection Option-A switch with the measured fidelity estimate copy. Size: M.
- **7.5 Write confirm cards** — preview + confirm/cancel in the composer. Size: M.
- All with `en`+`hu` i18n and existing-token styling.

### Phase 8 — Proactive in-chat context (Calendar + Email, tier-1)

- **8.1** — When a proactive-capable connection is on, inject *fresh, ephemeral* context (today/upcoming events; important-unread summary) fetch-on-relevance into the turn — **never** into persistent Memory, **respecting incognito** (works in incognito, just untracked), **respecting the locality guard**, and **budget-bounded** (short-TTL cache, capped size). Tests: context present when relevant + toggle on; absent when off; not written to memory facts; excluded from cost is N/A but counted toward token budget with a cap. Size: L.

---

## Cross-Cutting Testing & Safety Strategy

- **Every provider adapter is unit-tested against a mocked protocol** (no live creds in CI). Live smoke tests run on-box, manually, per connector.
- **Isolation test suite:** a standing set asserting user A can never reach user B's connections/data through store, resolve, tools, or health — run in CI.
- **Write-safety suite (the corruption firewall):** for every write adapter — (1) refused when `allow_writes=false`; (2) refused without an explicit confirm token; (3) unspecified destination lands in the allowlist area; (4) explicit path honored but flagged if outside allowlist; (5) overwrite requires `If-Match`/etag and refuses on mismatch; (6) delete is reversible (trash/versioning) and hard-delete needs confirm; (7) idempotent under retry. No write adapter merges without all seven.
- **Locality test:** under Option A, assert raw connector payloads are provably absent from any cloud-model-bound prompt.
- **Fidelity eval (Option A):** a small live harness comparing local-distilled vs raw answers on representative connector questions, producing the quality-hit % surfaced in the UI. Not in CI; run pre-release.
- **Green gate per issue** (biome + tsc + vitest) as in Global Constraints.

## Sequencing / Dependency Graph

Phase 0 ships independently and first. Phase 1 (foundation) gates everything. Phase 2 proves the full stack on the safest provider. Phase 3 (locality) should land before any cloud-model connector data flows (i.e., before Phase 5's Google/Apple reads are used with cloud models). Phase 4 (write path) gates all of Phase 6. Phases 5/7/8 can interleave once 1–4 are in. UI (Phase 7) trails each backend capability it surfaces.

## Risks & Open Items (resolve during implementation, not now)

- Google OAuth **Production verification** timeline/requirements (privacy policy, domain verification) — start early; until then, dev uses Testing mode (accept 7-day re-consent).
- Apple CalDAV fragility — keep it read-first; heavy write testing; treat unexplained 403/401 as expected and surface reconnect.
- IMAP content-search performance — confirm whether Dovecot FTS (Xapian) is enabled on-box; if not, scope search to header/date or recommend enabling FTS.
- Exact per-turn threading of "current user's enabled capabilities" into tool-gating — mirror the `memoryIncognito` threading path already in `plain-`/`streaming-normal-chat-model-run.ts`.
- Multi-account default-learning via Memory — depends on the Memory system; can start with "always ask" and add learned-default later.

---

## Self-Review (author checklist, done)

- **Spec coverage:** every locked decision (1–10) maps to a phase/issue (two-layer model → 1.4/1.5; per-user isolation → 1.3 + isolation suite; connect spectrum → 2.1/5.x; multi-account → 1.5/5.1; health/reconnect → 1.6; locality C+A → 3.1/3.2; write-safety → 4.x/6.x; proactive in-chat → 8.1; incognito correction → 0.1; citations → 2.4).
- **No fabricated code:** this plan is at decomposition altitude — each Issue names files, interfaces, and exact test cases, and flags "Implementer must verify" wherever a codebase detail must be confirmed rather than assumed. Bite-sized red-green-refactor steps are produced per-issue by its implementing subagent (subagent-driven-development), which is the correct granularity for a system this size.
- **Type/name consistency:** capability names (calendar/files/photos/email/location/media/contacts), `allow_writes`, `default_on`, `ConnectionProvider`, and `write-guard` are used consistently across issues.
