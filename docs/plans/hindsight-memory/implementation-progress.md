# Full replacement implementation progress

Current checkpoint on 19 November 2026. The frozen product patch, current release and completed dependency update are integrated locally in separate commits. Real inactive-bank processing is blocked by a privacy gap in the serving legacy app. [Integration checklist](integration-readiness.md) · [Predeployment privacy evidence](predeployment-migration-readiness.md)

| Area | Current checkpoint |
|---|---|
| Native foundation, authority and publication | Implemented with focused regression and native acceptance evidence. Revalidate against the integrated release and lock. [Native lifecycle acceptance](native-lifecycle-acceptance/) |
| Curation and lifecycle | Independent review closed the original exact-resend and dependent Remove findings. Independent tests closed the carry-retry findings. The mixed changed-chat example still holds at semantic verification with the selected native model. The hold preserves the last published evidence. [Carry review](review-carry-final-checkpoint.md) · [Exact carry lifecycle](exact-carry-lifecycle-follow-up.md) · [Mixed native fixtures](native-lifecycle-acceptance/mixed-check/README.md) |
| Original-project retention | Independent re-review closed project deletion and repeated Include, with transaction and before-and-after scope controls. Older unlogged history has a provenance gap. [Project review](review-project-retention.md) |
| Native operations | Final independent review closes the bounded operations findings, including ambiguous configuration cleanup and proxy boundaries. The runbook retains operator handling for unresolved configurations. [Operations review](review-native-ops-final.md) |
| Production-built UI | Chromium exercised personal and project lists, keyboard focus, older-source navigation, profile-off in another tab and live native Add/Edit/Remove, in English and Hungarian at desktop and 320px widths. The long project label can clip in the closed 320px selector. [Browser evidence](ui-production-review/README.md) |
| Broad benchmark | Completed settled persona-tool benchmark with fresh synthetic profiles. Its evidence covers that route, with frozen answer prompts and manual grading. The report describes scope, ordering and inference limitations. [Benchmark results](integrated-native-benchmark/README.md) |
| Dependencies | Handoff reports `finished: true` at `b729c68e1` and a passing full release gate at that tip with Playwright 1.59.1. The parked Playwright 1.65 branch is outside its ancestry. [Dependency handoff](</Users/lvt53/Library/Application Support/Claude/side-session-notes/local_00717275-5e9a-4d47-9a05-e89dd0771988/npm-update-session-status.json>) |
| Local integration and final review | Local merges, migration and ADR reconciliation, the focused integration suite and a synthetic upgrade rehearsal passed. Final review found a same-second history-consent defect under repair. Integrated acceptance and the full release gate remain pending. [Integration checklist](integration-readiness.md) |

The earlier conditional authorization for per-user `inspect`, `prepare` and `verify` required full readiness before 05:00 Europe/Dublin on 19 November 2026. The legacy privacy gap independently blocks that sequence. This checkpoint concerns synthetic data and local Git only. [Migration runbook](migration-runbook.md)

## Initial implementation checkpoint

| Scope | Owner | Status | Dependencies / evidence |
|---|---|---|---|
| Tasks 1–2 native foundation | memory_foundation | corrective checkpoint under independent review | 28 focused corrective tests; native/capacity acceptance still pending |
| Task 5 approved UI | memory_ui | 14 initial + 9 re-review findings; fixes active | shared memory-types.ts |
| Task 5 manual UI review | memory_ui_live_review | five source findings recorded and native-backed dev read probe passed; interactive walkthrough blocked by unavailable browser connections | [Development review and isolated fixture](ui-live-review/README.md). Production UI acceptance remains open. |
| Task 5 live-review UI fixes | memory_ui_review_fixes | five changes implemented, 109 focused tests pass, typecheck 0/0, scoped Biome clean | [UI fix checkpoint](implementation-ui-review-fixes.md). Production Playwright and interactive walkthrough remain open. |
| Tasks 4/6 integration/privacy | memory_integration_audit | corrective checkpoint; fresh review needed; submitted dependency repair remains | 12 suites/444 tests; check 0/0; migration verifier pass; F3 pre-submit leak fixed, transitive native repair explicitly not accepted |
| Task 3 + server Task 5 curation/read/API | memory_curation_api | 10 review findings addressed; 36 focused tests pass; compile 0/0; fresh joint judge pending | accepted intent, atomic replay readback, native delta validation, dependency final check |
| Task 7 migration | project move policy | Original-project retention implemented. The independent findings for project deletion and repeated Include after a round trip have corrective changes and permanent regressions. | 293 tests in 32 suites, scoped Biome clean. Independent re-review, fresh native revalidation and full gates remain pending. [Repair checkpoint](implementation-migration-fixes.md#independent-project-retention-review-fixes), [scope decision](scope-boundary.md) |
| Task 8 infrastructure/capacity | memory_native_operations_fixes (Sol) | security/operations fixes and native acceptance active; not accepted | integrated load/restart/restore still required |
| Tasks 2–4 and 6 lifecycle follow-up | memory_lifecycle_fixes (Sol) | two additional re-review defects addressed, 273 focused tests pass, fresh judge and native acceptance pending | [Accepted-empty replay and combined withdrawal](implementation-lifecycle-fixes.md#accepted-empty-replay-and-combined-withdrawal) |

Independent fresh judge at each major checkpoint and at final whole-plan review; all findings must be fixed. Root owns orchestration/review; workers implement only assigned scopes.

## Foundation decisions

- Durable per-user authority defaults legacy; replacement cannot activate by configuration alone.
- Native tenant credentials are server-only environment JSON keyed by opaque tenant ID. No user/body-supplied tenant routing.
- Source rows retain original text, lineage, assertion date and explicit-edit date separately. Published generation is immutable native text; revocations remain live.
- Engine owns all job lifecycle writes. No separate scheduler.
- Official Drizzle schema docs and Vitest guide checked 2026-11-18. Native wire formats checked against pinned local source API.
- Use Node22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`): default Node24 ABI does not match installed better-sqlite3.

## Foundation checkpoint (not acceptance sign-off)

Implemented shared DTO, native transport, qualified missions, expand-only schema/migration, per-user authority and opaque credential binding, source revision persistence, live revocations, atomic native snapshots, job engine delivery/cleanup and hooks registration. Native recall requests observations and callers must match exact published native ID/text. Explicit edits use explicitEditAt for precedence while retaining original assertedAt.

Focused verification: transport 4, publication 5, real-job delivery 3 tests pass (12). Publication includes second DB connection stale writer; delivery includes cancellation with late remote response and account erasure while native unavailable. Migration verification passes via Node22 `node --import tsx scripts/verify-migrations.ts`. First full typecheck found only concurrently unfinished integration/UI diagnostics (13 errors/1 warning at that snapshot), no foundation diagnostics; final check pending.

Remaining before Tasks1–2 acceptance: independent review; exhaustive config override/isolation fixtures; native synthetic smoke/version attestation; multi-process engine bank claim tests; crash/unknown-ack reconciliation fixtures; native fanout/admission cap measurement, foreground adaptive pause, sustained load; cancel/late native mutation across subsequent bank jobs; source-cleanup/reset races; infrastructure and ADR/docs owned later. Unknown retain acknowledgements reconcile paginated operations by stable document ID/task payload; missing native operation is bounded retry then honest failure, not blind resubmission. Native source acknowledgements stage durably before full snapshot acceptance so failed candidates can recover without re-extraction. Complete candidate contamination aborts publication rather than silently omitting rows.

No deployment, real-user migration, commits or pushes performed.

## Foundation independent review follow-up

`review-foundation.md` requested changes (10 findings). Root remains orchestrator only.

Implemented corrections:
- F1: decode native recall `type` separately from list `fact_type`; actual wire-shape regression.
- F2: paginated total/offset validation, duplicate rejection, chained pending native operations drain, identical complete captures, pending/failed raw consolidation rejection; only explicit staged source IDs promoted.
- F3: application UUID stored on immutable source, passed as native retain operation_id; terminal retries reuse it without scanning history/re-extraction. Regression loses acknowledgements through terminal failure then retries same UUID.
- F4: post-configuration source/control fence verifies original message ownership/text/scope at last submit boundary; cleanup remains eligible while off/project gone; outstanding native IDs drained before deletion.
- F5: added engine-owned enqueueAtomic: epoch and opaque retired-bank cleanup jobs commit together, rollback test. Cleanup binds original endpoint and credential fingerprint; changed credential fails closed. Cleanup records native-operation settlement durably before deletion, verifies bank absence. Unknown accepted-network outcome remains pending rather than claiming physical erase.
- F6: full qualified changed-only mission and structured before/after envelope, immutable predecessor. Publication intentionally holds source edits pending Task3 shared bounded curation; this is not feature acceptance.
- F7: immutable endpoint/credential binding implemented; actual deployed engine/extension attestation, provisioning and synthetic native tenant tests remain infrastructure slice, not self-certified by compile-time SHA.
- F8: job limits remain explicitly job limits. Actual inference admission/fanout/adaptive foreground control remains separate operations slice; not claimed done.
- F9: suffix source lookup indexed before write transaction; only current+previous generations retained, stale cursor explicit. Larger-bank writer-latency measurement remains.
- F10: immutable request/event reuse validated; monotonic controlRevision replaces second-resolution inference (integration owns toggles).

Latest full typecheck (20:18): 0 errors/0 warnings. Focused new capture/config/publication checks pass. No release or native real-user checks claimed.

### Native operations checkpoint (2026-11-18, pending fresh judge)

See [implementation-native-operations.md](implementation-native-operations.md) for exact proof and remaining gaps. Native HMAC tenant provisioning, observed pinned capability checks, private bounded inference transport and graceful shared foreground leases are implemented. Python8/8, focused app13/13 and opt-in actual app→native delivery/publication/recall smoke passed; check0errors/0warnings. Actual two-tenant native isolation and local-model admission bursts passed, but full lifecycle quality, foreground latency, bigger-bank writer performance and deployment-equivalent restore are **not** accepted yet. No real-user migration/deployment. Scratch18890/18891 retained for subsequent acceptance per root instruction.

## Submitted dependency repair checkpoint — 2026-11-18 21:11 UTC

Finite exact-source dependency repair is implemented inside existing parent jobs, with immediate withholding, durable replacement/native operation identities, original dates, sanitized prior-memory context, shared curation replay/final checking and strict final publication. Source cleanup and acknowledged Remove have cleanup-only off behavior and guarded existing-job enable resumption; cancelled learning/Edit is not resumed. Preflight overflow rejects atomically; post-mutation overflow fences the bank without deleting independent data. See `implementation-dependency-repair.md` for interfaces, footprint and limitations.

Focused verification: **6 suites / 61 tests passed**, including **11 repair tests** through migrated synthetic SQLite and the actual job engine (`/tmp/memory-dependency-final-tests.log`); scoped Biome clean. The actual Remove-kind off-mid-replacement fixture preserves the independent sister fact, performs no further off-period model call, keeps exclusion acknowledged/cleanup pending and resumes its saved intent on enable. Synthetic native transport results are not actual native/model semantic acceptance. Fresh independent review, native EN/HU dependent-reply/lifecycle probes and whole-plan gates remain required. No deployment or real-user/data operation occurred.

Checkpoint typecheck completed: `npm run check` **0 errors / 0 warnings** (`/tmp/memory-dependency-typecheck.log`).

## Historical execution and acceptance checkpoint

Owner requests Sol agents for subsequent work except genuinely very hard cases, to conserve the weekly allowance. Other slices are checkpoints, not acceptance sign-offs. Remaining: independent Sol re-reviews, integrated benchmark/lifecycle/load/restore evidence, UI browser verification, Fallow and full agent gate, then final fresh review. A conversational overall estimate near 55% is not an accepted completion percentage. No real migration, deployment, or push authorization.

The owner is holding the dependency update and merge until the dependency session reports `finished: true` and the final branch and target commits are verified. The latest observed status is `finished: false`, working on the final audit. It names `claude/musing-kepler-83f297` from `origin/main` at `dea9d0e08` and target commits `29ed544d1`, `fab25cd80`, `f446646da`, and `b729c68e1`. Playwright 1.65 remains parked. The root agent polls the owner's status file during the implementation. [Dependency session status](</Users/lvt53/Library/Application Support/Claude/side-session-notes/local_00717275-5e9a-4d47-9a05-e89dd0771988/npm-update-session-status.json>)

The owner conditionally authorized the root agent to begin per-user `inspect`, `prepare`, and `verify` for real inactive banks. All implementation, acceptance tests, and final independent review must finish before **05:00 Europe/Dublin on 19 November 2026**. If readiness misses that deadline, defer real preparation. Authorization ends at inactive-bank verification. Existing Do Not Remember choices, history consent, and exclusions remain in force. Unknown history requires the user's own explicit opt-in. Individual workers continue with synthetic data unless the root agent explicitly assigns eligible work. [Migration runbook](migration-runbook.md)

Integration and migration reconciliation are prerequisites for real preparation. The dependency branch starts from upstream `main` at `dea9d0e08`, 543 changed files from the original implementation base. That upstream already uses migration numbers 0130 through 0133 for read-aloud voices, take ETA, analytics uniqueness and user picture/video controls. The native Memory migrations numbered 0130 and 0131 collide. The root agent will assign reconciliation after the dependency session finishes and the workers reach a stable checkpoint. The reconciled baseline needs its own migration verifier and acceptance runs before any real inactive-bank work.

### Native operations review follow-up

The seven operations findings have corrective changes and scoped regressions, pending fresh independent review. The pinned image build and container method matrix, real app development-server foreground overlap, retained v1/new v2 bank routing, native outage reset and matched post-erasure restore are recorded in [native-operations-fixes.md](native-operations-fixes.md). This checkpoint leaves the broader model fault, sustained capacity, full integrated lifecycle benchmark, production build and repository gates open.

### Architecture checkpoint

The job worker no longer imports job admission through curation intent, dependency repair, migration progress or shared prompt rendering. The engine owns atomic checkpoint updates. The focused run passed 930 tests, with live-native acceptance disabled. The pinned audit found the one remaining baseline application cycle. The shared-checkout gate remains red on untracked evidence scripts, while the diagnostic copy of the candidate code reports zero new findings. [Module ownership and verification](implementation-architecture-cleanup.md)

The subsequent operations review's ambient-proxy and late-bank findings have corrective changes and matching regressions in [the follow-up evidence](native-operations-fixes.md#follow-up-on-ambient-proxies-and-late-configuration), pending fresh review. The admitted-source smoke passed and SQLite publication contention was measured up to 2,048 observations. The integrated semantic lifecycle and broad benchmark remain scheduled after corrections to the latest lifecycle findings.

The lifecycle follow-up now resumes cancelled Edit recovery when a checkpointed dependent is deliberately withdrawn while Memory is off. Permanent job-engine regressions cover all sources withdrawn and a surviving reply with independent evidence. Targeted independent closure and native acceptance remain open. [Withdrawal recovery evidence](implementation-lifecycle-fixes.md#withdrawal-of-a-checkpointed-dependent)

Live synthetic testing identified two additional cases. Cancelled Edit now admits a held direct target into verified dependency recovery when a shared observation also depended on a deleted root. Curation can act on verified facts carried across edited chat messages, and deleting the current message withdraws its carried predecessors. Permanent regressions pass. The native reruns and independent verification are tracked separately. [Shared Edit and carry evidence](implementation-lifecycle-fixes.md#shared-edit-targets-and-carried-chat-facts)

The composed resend and Remove checkpoints passed 248 focused tests. A frozen native stamp case completed both exact resends with zero extra retains, rebuilt the dependent once and preserved its independent assertion in recall after Remove. The earlier writing-desk control held, and mixed changed-chat repair remains a separate acceptance case. Fresh independent re-review is pending. [Composed lifecycle evidence](exact-carry-lifecycle-follow-up.md#rapid-exact-resends-and-an-exactly-resent-dependent)

Exact resends now reuse the authorized native documents at their verified fingerprints and dates. The resend consumes its edit transition, and later current-source changes and dependent replies use the carried owners. The reasoned withdrawal checker passed the paired four-case local-model diagnostic and six additional synthetic English and Hungarian cases. The focused application tests and independent native verification are tracked in the implementation evidence. [Lifecycle evidence](implementation-lifecycle-fixes.md#durable-retry-and-native-checker-evidence)
