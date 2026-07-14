# Parallel Search hardening — implementation issues

Remediation of the design-review findings on the post-migration Parallel web-grounding code (`parallel-search/*`, `web-grounding.ts`, `normal-chat-tools/{index,fetch-url,research-web}.ts`, prefetch in `normal-chat-context.ts`). Discipline: subagent-driven TDD → review/audit → correctness judge → deploy. Commit after every wave (Nextcloud revert hazard). Frozen contract: the top-level `GroundedWebModelPayload` field set + leak-filter (`stream-protocol.ts:302-303`) must not change.

Related: [ADR-0052](adr/0052-replace-searxng-web-research-with-parallel-search.md). YouTube transcript support is intentionally removed here, not revived (see the parked-feature note; revival design = fold into `fetch_url` + a hosted transcript API).

## Wave F1 — contract truth + YouTube removal + interface hygiene  ·  status: DONE (`334884a1`)
- [x] Remove dead `youtubeTranscript` source field + never-populated `youtubeTranscript*` diagnostics counters; grep-verified zero remain.
- [x] Delete the stale "transcript-backed evidence from selected YouTube results" prompt line.
- [x] Fix the diagnostics lie — derive `queries`/`plannedQueryCount` from the resolved query list.
- [x] Rename the duplicate payload-side types → `GroundedWebPayloadSource`/`GroundedWebPayloadEvidence`.
- [x] Parameterize payload `name` (default `research_web`; `fetch_url` stamps its own).
- [x] Hoist the 8/12 caps into `parallel-search/types.ts` (`MAX_PAYLOAD_SOURCES`/`MAX_PAYLOAD_EVIDENCE`), used at all sites.
- [x] Nitpicks: named `RESEARCH_WEB_EXCERPT_MAX_CHARS`; fixed `client.ts` session_id comment; de-puzzled `truncateBody`; origin+verbatim-path URL dedupe; renamed `emptyGroundedWebDiagnostics` → `baseGroundedWebDiagnostics`.

## Wave F2 — prefetch hardening  ·  status: DONE (`4c98b5b6`)
- [x] Bound `maybePrefetchWebSearch` with `PREFETCH_TIMEOUT_MS=12s` + `AbortController` threaded into `deps.signal` (true cancellation → existing graceful-degrade catch).
- [x] Model-aware `maxCharsTotal` via `resolveFetchContentCharCap` (extracted shared `model-context-tokens.ts`, deduped from the `fetch_url` tool).

## Wave F3 — robustness polish  ·  status: DONE (`0d11210d`)
- [x] Surface per-URL Extract failures (which URL + why) in the brief.
- [x] Gate `research_web`/`fetch_url` on `parallelConfigured` (fail closed; no raw 401); prompt already coherent in both states.
- [x] `fetch_url` timeout 30s → 45s with recorded rationale.

## Wave A-audit — review/audit + correctness judge  ·  status: DONE (`96846892`)
- [x] Three parallel reviewers (contract/correctness, regression/integration, test quality). Found one real bug (F3-1: failure note truncated out of large `fetch_url` payloads) + coverage gaps.
- [x] Fix wave: prepend the failure note so it survives truncation; collapse whitespace in reasons; pre-gate prefetch on config; added tests (timeout-fires / overflow / unknown-error).
- [x] Independent scope/completeness/correctness judge: **PASS** — 1411 tests, contract intact, no blocking gaps.

## Wave A-deploy — deploy + verify  ·  status: PENDING (PR open, awaiting merge to main)
- [ ] Merge PR → deploy via `scripts/deploy.sh` on `alfydesign`; health check.
- [ ] Smoke: one detail-heavy search + one pasted-URL fetch; confirm prefetch no longer stalls.
