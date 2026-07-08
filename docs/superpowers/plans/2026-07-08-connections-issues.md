# Connections — Issue Backlog (`/to-issues`)

Flat, pick-up-able checklist derived from [2026-07-08-connections.md](./2026-07-08-connections.md). Each issue = one Sonnet-subagent TDD cycle. `S`≈½ day, `M`≈1 day, `L`≈2+ days (rough). Not GitHub issues — a local backlog.

Legend: `[ ]` todo · **deps** = must land first.

## Phase 0 — Incognito correction (ship first, standalone)
- [ ] **0.1** Incognito → saved-but-untracked: revert read-side context/tool suppression, keep no-learn, add telemetry/tracking suppression. **M** · deps: —

## Phase 1 — Framework foundation (gates everything)
- [ ] **1.1** Schema + migration `user_connections`. **S** · deps: —
- [ ] **1.2** Per-user credential vault (reuse AES-GCM from `providers.ts`). **S** · deps: 1.1
- [ ] **1.3** Connection store CRUD, strictly user-scoped, secrets via vault. **M** · deps: 1.1, 1.2
- [ ] **1.4** Registry + `ConnectionProvider` interface + capability map. **S** · deps: —
- [ ] **1.5** Resolution + multi-account disambiguation. **S** · deps: 1.3, 1.4
- [ ] **1.6** Health checks + status API. **M** · deps: 1.3, 1.4

## Phase 2 — First connector end-to-end: Nextcloud Files (read-only)
- [ ] **2.1** Nextcloud connect via Login Flow v2. **M** · deps: 1.2, 1.3
- [ ] **2.2** Nextcloud Files WebDAV read adapter. **M** · deps: 2.1
- [ ] **2.3** Files capability tool + registration + per-user capability gating. **M** · deps: 2.2, 1.5
- [ ] **2.4** Source citations for connection results (Sources tab). **S** · deps: 2.3

## Phase 3 — Locality guard
- [ ] **3.1** Option C: first-time cloud-model warning gate. **M** · deps: 2.3
- [ ] **3.2** Option A: local-Qwen distillation path (selectable). **L** · deps: 3.1

## Phase 4 — Write path (guarded; proven on Nextcloud Files)
- [ ] **4.1** Write-guard core (allowlist, confirm-preview, idempotency). **M** · deps: 1.3
- [ ] **4.2** Nextcloud Files write adapter (chunked, If-Match, trash) + refusals. **L** · deps: 4.1, 2.2
- [ ] **4.3** Write confirm/preview surfacing (tool ↔ UI). **M** · deps: 4.2

## Phase 5 — Remaining connect flows + read adapters
- [ ] **5.1** Google OAuth (Calendar; incremental scopes; production/verified). **L** · deps: 1.2, 1.3
- [ ] **5.2** Google Calendar read adapter. **M** · deps: 5.1
- [ ] **5.3** Apple iCloud CalDAV connect (app-specific pw) + read. **L** · deps: 1.2, 1.3
- [ ] **5.4** Email connect (autodiscovery/zero-config) + IMAP read. **L** · deps: 1.2, 1.3
- [ ] **5.5** Immich connect (scoped read key) + photo read. **M** · deps: 1.2, 1.3
- [ ] **5.6** Plex watch-history read (read-only). **M** · deps: 1.2, 1.3
- [ ] **5.7** OwnTracks location read (per-user device isolation). **M** · deps: 1.2, 1.3
- [ ] **5.8** Contacts resolver (CardDAV/Google/Apple). **M** · deps: 5.1/5.3/2.1 (any one)

## Phase 6 — Write adapters (each gated + confirmed, reuse write-guard)
- [ ] **6.1** Google Calendar write (idempotent, recurring guardrails). **L** · deps: 4.1, 5.2
- [ ] **6.2** Apple CalDAV write (If-Match mandatory, fragile). **L** · deps: 4.1, 5.3
- [ ] **6.3** Email write (draft/flags/trash; send on explicit only). **L** · deps: 4.1, 5.4
- [ ] **6.4** Immich write (AlfyAI album, separate write key, never force). **M** · deps: 4.1, 5.5

## Phase 7 — UI (design subagent; en+hu)
- [ ] **7.1** Connections panel in profile. **L** · deps: 1.3, 1.6
- [ ] **7.2** Composer + menu capability toggles + disambiguation. **M** · deps: 2.3
- [ ] **7.3** Connect wizards (OAuth / Login-Flow / app-pw / autodiscovery). **L** · deps: 5.x
- [ ] **7.4** Locality warning + Option A toggle UI (fidelity estimate). **M** · deps: 3.1, 3.2
- [ ] **7.5** Write confirm cards. **M** · deps: 4.3

## Phase 8 — Proactive in-chat context
- [ ] **8.1** Ephemeral calendar/email live context (in-chat only; not memory; incognito-safe; locality-safe; budget-capped). **L** · deps: 5.2, 5.4, 3.1

## Cross-cutting (standing suites, build alongside)
- [ ] **X.1** Per-user isolation test suite (CI). deps: 1.3
- [ ] **X.2** Write-safety 7-point suite (per write adapter). deps: 4.1
- [ ] **X.3** Option-A "raw never leaves box" assertion. deps: 3.2
- [ ] **X.4** Option-A fidelity live-eval harness (pre-release, not CI). deps: 3.2

**Suggested first slice to build:** 0.1 → 1.1–1.6 → 2.1–2.4 → 3.1 → 4.1–4.3. That yields a real, safe, cited, read+write Nextcloud Files connection with the locality warning and the full write firewall — the pattern every other connector then follows.
