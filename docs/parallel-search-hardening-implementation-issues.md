# Parallel Search hardening — implementation issues

Remediation of the design-review findings on the post-migration Parallel web-grounding code (`parallel-search/*`, `web-grounding.ts`, `normal-chat-tools/{index,fetch-url,research-web}.ts`, prefetch in `normal-chat-context.ts`). Discipline: subagent-driven TDD → review/audit → correctness judge → deploy. Commit after every wave (Nextcloud revert hazard). Frozen contract: the top-level `GroundedWebModelPayload` field set + leak-filter (`stream-protocol.ts:302-303`) must not change.

Related: [ADR-0052](adr/0052-replace-searxng-web-research-with-parallel-search.md). YouTube transcript support is intentionally removed here, not revived (see the parked-feature note; revival design = fold into `fetch_url` + a hosted transcript API).

## Wave F1 — contract truth + YouTube removal + interface hygiene  ·  status: IN PROGRESS
- [ ] Remove dead `youtubeTranscript` source field (`parallel-search/types.ts:22`, `web-grounding.ts:14/125`) + never-populated `youtubeTranscript*` diagnostics counters; grep-verify zero remain.
- [ ] Delete the stale "transcript-backed evidence from selected YouTube results" prompt line (`normal-chat-context.ts:699`; check `prompts.ts` sibling).
- [ ] Fix the diagnostics lie — derive `queries`/`plannedQueryCount` from the resolved query list, not hardcoded `[query]`/`1` (`research.ts`).
- [ ] Rename the duplicate payload-side `GroundedWebSource`/`GroundedWebEvidence` → `GroundedWebPayloadSource`/`GroundedWebPayloadEvidence` (`web-grounding.ts:4,25`).
- [ ] Parameterize payload `name` (default `research_web`; `fetch_url` stamps its own) — `buildGroundedWebModelPayload`.
- [ ] Hoist the 8/12 caps into `parallel-search/types.ts` as named consts, used at all sites.
- [ ] Nitpicks: named `excerptMaxChars` const; fix `client.ts` session_id comment drift; de-puzzle `truncateBody`; dedupe URLs on origin + verbatim path (`normal-chat-tools/fetch-url.ts:18`); rename `emptyGroundedWebDiagnostics` → `baseGroundedWebDiagnostics`.
- Acceptance: contract-guard test green; leak-filter untouched; zero `youtubeTranscript` in repo; typecheck + affected tests green.

## Wave F2 — prefetch hardening  ·  status: pending (blocked by F1)
- [ ] Wrap `maybePrefetchWebSearch` Parallel calls in `withTimeout` (~10–15s) + `AbortController` (closes the 25–42s stall path).
- [ ] Pass a model-aware `maxCharsTotal` via `resolveFetchContentCharCap` (stop the flat-60k brief on small-context models).
- Acceptance: prefetch cancels on timeout and degrades (existing catch path); brief sized to `ctx.modelId`; tests cover both.

## Wave F3 — robustness polish  ·  status: pending (blocked by F2)
- [ ] Surface per-URL Extract failures (which URL, why: 404 vs paywall) in the brief instead of a silent aggregate count.
- [ ] Gate `research_web`/`fetch_url` registration + the "if not available" prompt line on `parallelConfigured` (stability snapshot already computes it).
- [ ] Reconcile the `fetch_url` 30s timeout vs the documented 42s uncached tail (bump ~45s or accept, with rationale).
- Acceptance: unconfigured Parallel → tools absent / prompt consistent; per-URL failures visible; timeout decision recorded.

## Wave A-audit — review/audit + correctness judge  ·  status: pending (blocked by F1–F3)
- [ ] Parallel review subagents over the F1–F3 diff (correctness/contract-preservation, dead code, test coverage, prompt coherence); fix confirmed findings.
- [ ] Separate scope/completeness/correctness judge; loop if fail.

## Wave A-deploy — deploy + verify  ·  status: pending (blocked by A-audit)
- [ ] test + typecheck green; commit; deploy via `scripts/deploy.sh` on `alfydesign`; health check.
- [ ] Smoke: one detail-heavy search + one pasted-URL fetch; confirm no `youtubeTranscript` refs; prefetch no longer stalls.
