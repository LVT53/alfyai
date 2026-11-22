# Hindsight Memory Full Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after explicit implementation authorization. Use superpowers:subagent-driven-development only if the owner chooses delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AlfyAI's profile-memory engine, API contracts and Memory UI with the approved native Hindsight-backed experience, preserving user intent and privacy through a per-user migration.

**Architecture:** Self-hosted Hindsight owns extraction, facts, embeddings, recall and consolidation. AlfyAI owns authenticated user/project routing, source revisions and explicit user actions, immutable accepted publication, revocation, and resumable delivery/migration through the existing job engine. The published read index copies native observations; it is not another generated profile or truth resolver.

**Tech Stack:** Existing Svelte 5/SvelteKit, TypeScript, Drizzle/SQLite and job engine; self-hosted Hindsight/PostgreSQL with bundled per-user tenant extension; configured local Flash Next model and self-hosted embedding/reranking. Pin the tested engine commit `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f` for initial integration; do not use a floating latest tag.

**Spec:** [Agreed UI](../../plans/hindsight-memory/agreed-ui-design.md), [scope boundary](../../plans/hindsight-memory/scope-boundary.md), [accepted migration policy](../../plans/hindsight-memory/chat-backfill-migration.md#accepted-migration-policy--owner-approved-2026-11-18), [current-list contract](../../plans/hindsight-memory/current-list-followup-results.md), [bounded Edit/Remove](../../plans/hindsight-memory/edit-remove-followup-results.md), [precedence/publication](../../plans/hindsight-memory/correction-recovery-results.md).

**Status:** Finalized plan, 2026-11-18. Documentation only. No implementation, deployment or real-user migration authorized. This is the **full replacement**, not a reduced first version. Task completion below means tested code, not permission to deploy. The phase sequence is an engineering sequence, not incremental removal of approved features.

## Global constraints

- Personal chats read personal memory; project chats read personal plus their own project. Project writes stay in that project, even for personal-sounding preferences. Never read another user's or another project's bank. Global awareness of project names/descriptions comes only from existing authorized project records.
- When a chat moves, its already learned project memories stay in the original project. Subsequent eligible assertions use the current scope. Source deletion, historical-consent withdrawal and scope erasure apply to the retained project sources.
- Keep native extraction and the qualified current-information mission; `consolidation_llm_batch_size: 1`. Keep tested native retain reasoning configuration initially; old thinking-off rules for the retiring judge do not automatically apply. Model aliases are not verified parameter sizes. No paid fallback by default.
- Later deliberate assertions supersede older conflicting statements within authorized scope. Retry, import, unchanged text and unrelated source edits do not renew assertion dates. Preserve uncertainty, attribution, original quotations and independent facts.
- No engine fork, second extractor, property ontology, global semantic canonicalizer, semantic deletion blacklist, custom deduplication engine or whole-history rewrite on each turn. No upstream work.
- Quiet list design, dropdown scope selector, Edit terminology, ordinary Add/Edit for partial removal, direct original-chat navigation, provenance-backed previous versions only. Profile owns on/off/reset and the optional historical-import setting. No Manage page/button.
- Drop portrait/summary editing, inferred expiry/renewal, routine review inbox, permanent endorsement, nightly repair narrative and Undo. Keep native background consolidation. Preserve Documents/artifacts, explicit historical chat access, task/project continuity and account privacy/export in their existing boundaries.
- All new labels, errors, notices and accessibility copy in EN/HU. Every application-authored model request is English; read chat-turn AGENTS before touching prompts. Reuse `ErrorMessage.svelte`, motion tokens and reduced-motion helpers. Approved list hover has real horizontal padding and animation.
- Before implementation, read applicable AGENTS and current official library/framework docs. Update the local-only ADR/engineering map as an intentional replacement, not an accidental parallel subsystem. Config goes through `env.ts`/`config-store.ts`; secrets remain server-only.
- Routes remain adapters. Existing `jobs/` owns claims, status, retries, cancellation, recovery and scheduling; no independent Memory scheduler. Database migrations are expand-only during compatibility/cutover. No network await inside a DB transaction.
- Commit focused tested changes locally only when implementation is authorized. No push, deployment, real-chat processing or cutover without the corresponding owner instruction.

## Review focus

1. Consent withdrawn or reset during an in-flight remote write: late results cannot publish or become recallable; Task 2/6 tests.
2. An old exclusion is recorded only in review resolutions, with indirect/missing provenance: backfill cannot silently restore it or claim completion; Task 7 tests.
3. Concurrent partial edits, a rebuilt observation split/merge, and an old list cursor: no invented lineage or stale success; Task 3/5 tests.
4. Short dependent replies, quoted third-party text, assistant guesses and copied forks: context must not become a fresh user assertion; Task 4/7 tests.
5. A queued model request times out before admission, then finishes after retry: bounded work and revision fencing prevent duplicate publication; Task 2/8 tests.

## Ownership and file map

Keep the public service boundaries `src/lib/server/services/memory.ts`, `knowledge-memory-read.ts`, `knowledge-memory-actions.ts`, `memory-context.ts` and `memory-controls.ts`; replace their internals/contracts instead of preserving legacy payloads indefinitely. Use `src/lib/server/services/memory-profile/` for the new focused adapter modules below, replacing its old projection implementation as cutover completes. Do not add another top-level memory service.

| Files (new unless marked existing) | Responsibility |
|---|---|
| `memory-profile/contracts.ts`, `hindsight-client.ts` | Internal typed native transport, capability/version check, server-derived tenant/bank identifiers |
| `memory-profile/revisions.ts`, `publication.ts`, `presentation.ts` | Source/action revision persistence, atomic accepted-generation switch, live revocation, source-verified native suffix formatting |
| `memory-profile/curation.ts` | Bounded explicit Edit/Remove action plan, apply/check and at most one repair |
| `memory-profile/delivery-job.ts`, `delivery-runner.ts` | One Memory job kind, native operation checkpoints, ingestion/rebuild/cleanup/migration phases using `jobs/` |
| `memory-profile/migration.ts`, `migration-policy.ts` | Manifest, deterministic provenance mapping, permissions/consent and exceptions; no second extractor |
| Existing `memory-profile/read-model.ts`, `scope.ts`, `reset-generation.ts` | Published native list/search/detail, authorized bank routing, reset fencing |
| Existing `memory-context/persona.ts`, `read.ts`, `types.ts` | Bounded admitted native recall, no portrait; preserve separate history/project-continuity modes |
| `src/lib/memory-types.ts` | New shared UI request/result contract, distinct from retiring `memory-profile-types.ts` |
| `src/lib/client/api/memory.ts` | Browser fetch boundary; remove superseded Memory functions from existing `knowledge.ts`/`memory-notes.ts` once consumers move |
| Existing Knowledge route plus `_components/MemoryList.svelte`, `MemoryDetail.svelte`, `MemoryEditor.svelte`, `MemoryRemoveDialog.svelte` | Approved screen hierarchy; `KnowledgeMemoryView.svelte` coordinates only |
| Existing `src/lib/server/db/schema.ts` plus next allocated migration | Bank/generation/source/action/consent/manifest/read-index records and job-engine-built job/attempt tables |

Paths in the first eight rows are relative to `src/lib/server/services/` unless already rooted. Modules are responsibilities, not an instruction to create empty wrappers. Keep data access in the owning module; no per-table repository classes. Reuse `memory-behavior-log.ts` for domain events rather than inventing a parallel general event bus. Job history and source/action state are distinct necessary records, not duplicate schedulers.

### Internal contract to establish in Task 1

Use these names across slices; implement precise serialized DTOs in `src/lib/memory-types.ts` and server-only native types in `memory-profile/contracts.ts`:

- `MemoryScope = {kind: 'personal'} | {kind: 'project'; projectId: string}`. User identity comes from authenticated server context, never a body-supplied tenant.
- `MemoryRef = {scope: MemoryScope; generation: string; rowId: string}`. A reference identifies one accepted snapshot row, not a permanent semantic fact.
- `listMemory(userId, {scope, query, cursor}) -> Promise<MemoryPage>`; page includes accepted generation, current rows, next cursor and truthful update status. Search uses current published display text; no LLM per page open.
- `getMemoryDetail(userId, ref) -> Promise<MemoryDetail>`; returns accepted text, authorized original evidence, verified explicit versions and action availability. Stale/unavailable is explicit.
- `submitMemoryAction(userId, action) -> Promise<MemoryOperation>`; action is Add(scope,text,requestId), Edit(ref,text,requestId), or Remove(ref,requestId). Expected generation is mandatory for Edit/Remove; caller-supplied text is not a native API patch.
- `getMemoryOperation(userId, operationId) -> Promise<MemoryOperation>`; distinguish queued/working/applied/failed/stale and retry eligibility. Removal also distinguishes `exclusionAcknowledged` from pending remote cleanup.
- `recallMemory(userId, {conversationId, query, tokenBudget}) -> Promise<AdmittedMemoryEvidence[]>`; derive allowed scopes and controls from the conversation. Never expose unfiltered native Reflect, chunks or source expansion as a bypass.
- `recordHistoryImportChoice(userId, {choice: 'include' | 'decline', requestId}) -> Promise<HistoryImportStatus>`; server records fixed cutoff, policy version and decision time. No choice is not consent. A later explicit include can replace decline; resets still win.

The facade delegates these methods to the owning modules above. HTTP responses must not expose tenant credentials, raw internal job traces or other users' source titles.

## Task 1 — Native boundary, contracts and deployment definition

**Files:** core transport/contracts above; existing `src/lib/server/env.ts`, `config-store.ts`, `src/routes/api/admin/config/+server.ts`, DB schema/migration/tests, `README.md`, `.env.example`, `deploy/README.md`; new `deploy/hindsight/README.md` and pinned deployment definition. Update `AGENTS.md`, services and memory-profile AGENTS; add next-numbered ADR explicitly superseding the profile-memory portions of ADR-0045.

**Produces:** native client and typed contract; authenticated bank routing; expandable persistence foundation. Infrastructure definition is reviewable code, not authorization to start a production service.

- [ ] Add failing transport/config tests: wrong tenant/user/project cannot read/list/write/delete; API unavailable gives a typed retryable failure; no client-side secret; admin overrides beat env defaults; unsupported engine/format does not silently change behavior.
- [ ] Implement the narrow native calls actually needed: bank/config, retain/check operation, native fact mutation/invalidation, observation capture, recall and deletion. Isolate native wire formats in `hindsight-client.ts`; no broad generic proxy route.
- [ ] Define initial native bank configuration from frozen qualification fixtures, including native retain mission, current observations mission and batch size one. Save effective config/version in diagnostics without credentials/content.
- [ ] Add expand-only schema through the migration process; establish uniqueness for source revision/event ID and operation request ID, scope/reset epoch on every published object, and opaque user-to-tenant routing. Add migration round-trip/old-schema coexistence tests.
- [ ] Verify with the focused tests, `npm run db:prepare`, and a synthetic real-native tenant/config smoke. Record official docs consulted. Commit this slice; no deployment.

## Task 2 — Durable delivery, source revisions and accepted publication

**Files:** `revisions.ts`, `publication.ts`, `delivery-job.ts`, `delivery-runner.ts`, existing `src/hooks.server.ts`, `jobs/` integration seam only, source/reset schema; adjacent `*.test.ts` and a new `publication.integration.test.ts`.

**Consumes:** Task 1 native client/contracts. **Produces:** native operation checkpointing and immutable accepted generations consumed by Tasks 3–7.

- [ ] Write failing tests for duplicate enqueue, cancellation, crash before/after native acknowledgement, abandoned preparation, expired worker lease, out-of-order source changes, two writers and reset during native completion. Assert old accepted state survives failed preparation; revoked state never returns.
- [ ] Register one job kind using `defineJobKind`, engine columns and fenced writes. Persist native operation IDs before polling/retrying; recover the same intent instead of inventing another assertion. Job engine owns lifecycle. Serialize mutations per bank across processes; unrelated banks may progress.
- [ ] Persist immutable source revisions with stable message/fork lineage, source text hash, original assertion time, explicit edit event time when trustworthy, control/reset epoch and acknowledged native IDs/text. No generated property graph.
- [ ] Prepare changes outside active reads; settle native operations and capture all native pages under a bank generation/write fence. Reject candidate rows with unaccepted source fingerprints. Atomically publish the complete candidate and its read index; never expose a partial snapshot as complete. Network work stays outside transactions.
- [ ] Persist live revocations before acknowledging exclusion; filter old cursors, cached detail, source expansions and recall too. Rebuild/cleanup failures keep exclusion active and status honest. Keep previous accepted content during ordinary failed preparation, except content independently revoked.
- [ ] Admit bounded work before native timeouts. Daytime baseline budget is one background model request; explicit idle overnight mode starts with ceiling six, adaptive downshift/pause for active chats. Limit native fan-out as well as job count; use existing engine claimable/limits mechanisms, not a second queue daemon. Measure actual simultaneous requests before accepting these settings.
- [ ] Pass adjacent unit/integration tests through the real job-engine harness, including two processes and an injected remote late response. Commit.

## Task 3 — Add, Edit, partial removal and whole removal

**Files:** `curation.ts`, existing `knowledge-memory-actions.ts`, `src/routes/api/knowledge/memory/actions/+server.ts`, `src/routes/api/memory/notes/+server.ts`; `curation.test.ts`, `curation.integration.test.ts`, updated route tests.

**Consumes:** Tasks 1–2 publication/revisions. **Produces:** `submitMemoryAction`/operation verdicts and explicit history snapshots.

- [ ] Port the four successful EN/HU lifecycle fixtures and validator controls; add the expanded mixed-edit rejection from current-list tests as a required safe failure. Assert independent facts and other people's information survive, omissions stay excluded, originals remain accurate quotations, and failed edits preserve the accepted state/draft.
- [ ] For deliberate edits only, persist one bounded `forget/replace/preserve` intent plan, apply it to known affected native facts/source revisions, check IDs/coverage and collective factual meaning, and allow at most one repair. Publish only validated results through Task 2. No recurring semantic scan or discovery of arbitrary unknown duplicate families.
- [ ] Reuse the saved intent on replay/re-extraction; a newer explicit assertion is eligible under normal rules. Add uses native retain in the selected scope. Whole removal establishes exclusion first; cleanup is retryable. Do not confuse removing a memory with deleting a chat or permanently banning a subject.
- [ ] Exercise stale generation, concurrent Edit/Remove, repeated request ID, unsupported rebuilt split/merge and large affected sets. Return a truthful failed/stale outcome rather than guessing lineage or claiming success. Preserve only verified explicit version chains; do not manufacture history from native observation text.
- [ ] Run deterministic tests plus fresh real-native EN/HU edit → replay → forced re-extraction → restart → newer-assertion sequences. Grade semantics independently from the model checker; record false acceptance separately from honest failure. Commit only after failures are understood and data-loss/privacy regressions resolved.

## Task 4 — Chat ingestion and bounded recall integration

**Files:** existing `memory-context.ts`, `memory-context/{persona,read,types}.ts`, `memory-controls.ts`, `chat-turn/{context-selection,finalize,stream-completion,normal-chat-tool-gating,deliberation-runner}.ts` as applicable, `normal-chat-tools/memory-context.ts`, existing conversation edit/delete/fork owners and memory control/note routes. Tests in owning modules and `tests/e2e/{chat,streaming,conversation}.spec.ts`.

**Consumes:** Tasks 1–3. **Produces:** `recallMemory`, one post-persistence ingestion path and explicit-remember delivery. Preserve existing history/project/task modes as separate capabilities.

- [ ] Write tests proving send/stream/retry share one ingestion boundary; assistant output is context, not a user assertion. Cover quoted biography, product questions, plans, negation, short dependent replies, EN/HU and deliberate edits to old chats. Test no ingestion from unfinished/unpersisted assistant turns and no new assertion from a fork/replay.
- [ ] Replace old judge triggers with durable source delivery after source persistence, including deliberate message edits, deletes, forks, explicit remember and imports. Native extraction remains native. Use bounded context with original roles/IDs/dates; do not flatten a whole chat into a new biography. Store provenance for every accepted source unit.
- [ ] Replace persona-summary injection with bounded admitted memory evidence. Derive personal/project scopes server-side; gate passive injection, explicit recall tool and deliberation through the same controls. Native source/chunk expansion may not reintroduce revoked facts. Explicit navigation to an original chat is still allowed; Remove is not chat erasure.
- [ ] Retain existing token-budget fitting and graceful chat behavior when Hindsight/model is unavailable. Use last accepted admissible data where available; failure to resolve privacy/authorization must not fail open. No chat-response dependency on consolidation finishing.
- [ ] Test personal + project recall, cross-project/user exclusion, project-only writes (including personal preferences), project metadata-only global awareness, project deletion/move and stale queued scope. Preserve artifact/document/task continuity and explicit authorized historical-chat access.
- [ ] Run focused tests and named chat e2e coverage; commit. Do not activate real-user routing yet.

## Task 5 — Full approved Memory UI and new API contracts

**Files:** `src/lib/memory-types.ts`, `src/lib/client/api/memory.ts`, existing Knowledge `+page.svelte`/`+page.server.ts` and coordinator; four focused Memory components from file map. Update `/api/knowledge/memory/+server.ts`, `[itemId]/+server.ts`, actions; add `operations/[operationId]/+server.ts`. Existing `knowledge-memory-read.ts` and `read-model.ts` own data, not routes. Update `src/lib/i18n/{knowledge,settings}.ts`, `tests/e2e/knowledge.spec.ts`; add `tests/e2e/memory-replacement.spec.ts`.

**Consumes:** Tasks 1–4 DTOs/publication/actions. **Produces:** `listMemory`, `getMemoryDetail`, operation status and the entire approved UI.

- [ ] Write API/read-model tests for complete multi-page results, insertion during pagination, revocation on old pages, current-text-only search, generation-aware detail and unauthorized sources. Separate only exact source-verified native date/sentence suffixes; preserve genuine historical text and arbitrary parentheses. Freeze compatibility fixtures for engine upgrades.
- [ ] Implement list/detail/add/edit/remove and their loading/empty/no-match/off/pending/error/stale states. Save succeeds only after accepted publication; keep draft on failure. Original quotations never change when a memory changes. Previous versions show only known explicit history and omit themselves when none is verified.
- [ ] Use the approved dropdown, information hierarchy, padded/animated hover rows, restrained transitions, shared `ErrorMessage.svelte` and reduced-motion helpers. No new Manage screen, settings duplicates, Keep part instead, developer-oriented labels, scores or portrait. Local UI state holds selected scope/query/scroll/focus, not API logic.
- [ ] Source links open the existing chat and load/scroll/highlight the exact authorized message even outside its current page. Deleted/unavailable sources show an honest state; no intermediate Memory chat page.
- [ ] Test EN/HU at desktop and 320px, long/multi-source text, keyboard/focus return, stale open tabs, slow/error operations, retry/dismiss semantics, rapid navigation and reduced motion. Assert dismiss does not cancel exclusion or claim success. Inspect motion against real AlfyAI screens, not merely static screenshots.
- [ ] Retire legacy summary/timeline/overview payload consumers together. Old endpoints must not leak old memory after cutover: remove or return explicit unsupported/version-mismatch responses; do not keep an invisible second read authority. Update guide content/translations/drawings and Show me markers with the actual changed controls. Run focused API/component/e2e tests; commit.

## Task 6 — Privacy lifecycle and one-time historical import choice

**Files:** existing `memory-controls.ts`, `memory-profile/reset-generation.ts`, `account-lifecycle/index.ts`, `account-lifecycle/user-scoped-tables.ts`, `privacy-controls/index.ts`, `user-admin.ts`; settings preferences/clear-memory routes; `SettingsProfileTab.svelte`, existing introduction/notice component; new `src/routes/api/knowledge/memory/history-import/+server.ts`; `migration-policy.ts`; relevant account/privacy/export tests and `tests/e2e/settings-admin.spec.ts`.

**Consumes:** Tasks 1–2 control/epoch persistence and Task 5 status patterns. **Produces:** `recordHistoryImportChoice` and privacy-safe cancellation/revocation/erasure across both stores.

- [ ] Test the eligibility truth table: current on alone does not authorize unknown history; pending/declined choice sends zero uncertain historical text to Hindsight; explicit include authorizes only otherwise permitted sources up to its fixed cutoff. Known off, incognito, pre-reset and excluded sources remain blocked even after include. One user's choice cannot affect another.
- [ ] Record future on/off intervals reliably at the existing preferences boundary. Record versioned per-user include/decline decisions with a cutoff, independent of current memory enablement. Future disabled periods need a separate explicit policy, not silent reuse of this historical permission.
- [ ] Add one optional introduction choice using existing notice/dialog patterns and a later entry in Profile settings. Dismiss/decline preserves normal use and avoids repeat prompting; the owner does not consent for other users. Do not require opening Memory or create a new review inbox.
- [ ] Reset/erase immediately fences reads and stale workers, cancels through the job engine, and schedules verifiable native cleanup. Cover native banks, prepared revisions, published caches/indexes, explicit history, migration checkpoints, old rollback data, exports and retained traces/backups under the app's documented retention policy. Failed remote cleanup remains retryable and visible; do not claim physical deletion before acknowledgement.
- [ ] Test off/incognito before enqueue, after claim, before publish, and during retry; reset during import; account/project deletion while offline; restored backup cannot replay pre-reset sources. Include authenticated export and missing control-store failure. Run privacy/route/e2e tests; commit.

## Task 7 — Real migration tooling, rehearsal and per-user cutover

**Files:** `migration.ts`, `migration-policy.ts`, delivery runner phases; `scripts/memory-backfill.ts` (new); adjacent tests and `migration.integration.test.ts`; `docs/plans/hindsight-memory/migration-runbook.md` (new at implementation).

**Consumes:** Tasks 1–6. **Produces:** resumable inspect/prepare/verify/cutover/rollback modes, all disabled for real execution until authorized. Preparation also requires the particular user's eligibility/consent.

- [ ] Build synthetic migration fixtures containing the actual legacy record shapes: authored standalone edits without provenance; generated endorsed text; deleted/suppressed rows; review-only do-not-remember decisions; indirect IDs; missing sources; unknown action dates; copied forks; uncertain memory-off history; personal/project scopes.
- [ ] Inspect produces a per-user manifest of eligible/uncertain/excluded sources, authored actions and unresolved mappings, with counts/checkpoints and restricted diagnostic access. It must not send uncertain old text to the model. Map explicit IDs and stored evidence first; do not fabricate missing dates or semantic matches. Model-assisted curation may apply a known action after mapping, not invent the mapping.
- [ ] Prepare eligible sources chronologically in inactive replacement banks, original times intact, and process trusted authored corrections/exclusions in trustworthy order. A missing action-time/conflict remains an exception. Never seed generated profiles or summaries. Source packing must pass attribution/dependent-reply fixtures; do not simply concatenate all assistant text.
- [ ] Hold only affected material where bounded; hold the user's historical backfill if an exclusion boundary is unknown. New eligible memory continues independently. Do not claim complete import, omit unrelated facts silently or turn exceptions into routine user review prompts.
- [ ] Rehearse interruption/resume, checkpoint deduplication, edits/deletes/new chats during preparation, consent changes, reset and fork deduplication. Catch up through the same source revision delivery path. At cutover, fence ingestion briefly, drain through the checkpoint and atomically switch the per-user authoritative reader/writer; never blend old/new profile outputs.
- [ ] Rehearse rollback with all post-cutover removals/resets/choices still enforced. If old state cannot safely represent them, keep memory unavailable rather than restore revoked information. Retain permitted legacy data only for a documented bounded rollback window; no automatic destructive purge or unbounded retention.
- [ ] Under separate real-data authorization, run local per-user rehearsal, audit all known manual/exclusion cases and representative EN/HU source/recall samples, measure actual larger-bank throughput and exception counts, and produce a readiness manifest for each user. No user cutover until their acceptance conditions are met. Commit tooling/tests/runbook separately from running it.

## Task 8 — Operational acceptance, legacy retirement and release gate

**Files:** existing `hooks.server.ts`, retired judge/consolidation/recuration/portrait/review modules and tests, admin configuration/metrics UI/routes, deploy docs, `.env.example`, guide files; integration tests above plus targeted job/health tests. Allocate removals only after checking all current consumers with `rg` and Fallow.

**Consumes:** all slices. **Produces:** one complete, releasable replacement with explicit cutover/rollback evidence; no silent dual engine.

- [ ] Exercise deployed-equivalent Hindsight/PostgreSQL restart, DB outage, model outage/slowdown, malformed output, cancellation, retry exhaustion, backup/restore and pinned-version upgrade compatibility. Verify status, backlog age, attempts, native operation latency and failures without logging raw sensitive content by default.
- [ ] Measure daytime foreground latency and overnight sustained throughput with representative growing banks and context sizes. Confirm actual global request admission/fairness across app processes and native workers. Six is a starting ceiling from synthetic tests, not an SLA; tune down on contention. Verify native timeout budget excludes unbounded app queue waiting.
- [ ] Rerun the broad recall benchmark and fresh EN/HU adversarial lifecycle cases on the **integrated** path. Keep storage, attribution, retrieval, answer quality and edit rejection metrics separate. Historical 69/72 vs AlfyAI 37/72 tool/32/72 passive is comparison evidence, not a guaranteed score. No privacy leak, silently accepted collateral loss or resurrection of a known removed statement is acceptable. Imperfect wording/ranking or an honestly rejected hard edit does not require rebuilding the engine.
- [ ] Remove replaced legacy runtime triggers, portrait injection, nightly reconciliation/summary generation, re-curation and review UI/admin controls after per-user migration compatibility is covered. During transition route each user to exactly one authority; once all cutovers pass remove the compatibility path. Preserve task/history/project continuity and Documents/artifacts. Keep required legacy data for rollback only, never as active recall.
- [ ] Update engineering maps, public config/deployment docs and Feature Guide; audit export/erase/backup retention and secret exposure. Run `npm run db:prepare` and verify `/api/health` remains aligned with deployment expectations.
- [ ] Run one final agent gate with all changed specs: `scripts/gates.sh agent "$TMPDIR/alfyai-memory-agent" --port 4300 tests/e2e/memory-replacement.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts` (include any other changed spec, including retired review-notice coverage). Require zero typecheck/build warnings, unchanged-or-justified Fallow baseline and all applicable tests passing. Do not run check/test alongside build manually.
- [ ] Before a release request is executed, run `scripts/gates.sh release "$TMPDIR/alfyai-memory-release" --port 4400`. Complete owner-reviewable release/cutover/rollback evidence, then wait for explicit deployment/migration authorization. No blanket retries or weaker assertions to mask failures.

## Acceptance matrix / completion definition

| Gate | Owning tasks | Required evidence before enabling the full replacement |
|---|---|---|
| A1 Privacy/isolation | 1, 2, 4, 6, 7 | Authenticated endpoints/native tenant routing; all read/write gates; old-page revocation; late-worker/reset/erase/export; no unknown-history ingestion without individual consent |
| A2 Chat/scope | 4, 7 | Shared send/stream/retry path; personal+own-project reads/project-only writes; explicit remember; original dates; preserved independent continuity |
| A3 Complete UI/actions | 3, 5, 6 | All approved screens/states; partial and whole removal; safe stale/failure handling; sources/versions; EN/HU, mobile, keyboard, motion and guide |
| A4 Operations | 1, 2, 8 | Job engine fencing/recovery, request admission, production-equivalent outages/restart/backup/restore and compatibility tests; sustained capacity |
| A5 Migration/cutover | 6, 7, 8 | Every manual/exclusion source class accounted for; unresolved exceptions withheld; individual uncertain-history choice; live catch-up, atomic per-user switch, privacy-safe rollback |

All eight tasks and A1–A5 are required for the full replacement; no “v1” cut that omits partial removal, privacy, migration choices or accepted UI. A user declining uncertain-history import may still receive the complete new system with verified eligible/new memories. A held historical backfill is disclosed, not silently marked migrated.

### Self-review completed at planning time

Checked the approved design, scope, migration decisions, current-list limits and Edit/Remove results against Tasks 1–8. Each Review Focus risk has explicit owning tests. Native observation identity/history and semantic search limitations are retained rather than hidden behind custom services. Reused the existing job engine and public service boundaries; the ADR/AGENTS replacement is explicit. Product acceptance is intentionally unexecuted: this document finalizes the plan, not an implementation or release claim.
