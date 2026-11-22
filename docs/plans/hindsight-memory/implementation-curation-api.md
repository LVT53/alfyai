# Curation and Memory API implementation checkpoint

2026-11-18. Implemented by `memory_curation_api`, awaiting independent judge. Not deployment or native semantic acceptance. No real user data was processed.

## Implemented

- `memory-profile/native-read.ts`: authenticated personal/project scope; immutable accepted-generation keyset pagination, current-display-text search, old-page live revocations, generation-aware detail, original authorized chat quotations and explicitly proven manual attribution. Only successful actions tied to the exact surviving native observation identity provide previous wording. `verifiedMemoryHistory` is shared with account export.
- `curation.ts`: frozen bounded deliberate-action planner/apply/check prompts, strict fact-ID coverage, at most one semantic repair. Native extraction is untouched. `curation-actions.ts` records request identity, original affected native facts/source IDs and revocation atomically with an existing-engine job. Remove immediately excludes known supporting fingerprints; it does not remove unrelated facts in the same source.
- `curation-runner.ts`: saved plan and verified proposal survive retries; no model re-planning on a lost PATCH response. Native mutations are read back exactly before the accepted pointer changes. Add retains a native user assertion. Edit additionally retains the qualified dated native before/after event so only changed claims receive a new assertion date. Failed pre-write validation preserves old accepted data and makes no native changes. A failed/partial remote mutation does not publish.
- Source-edit preservation uses the same bounded component: native changed claims are held fixed while the old predecessor is sanitised, unchanged facts retain their original dates, and source-wide exclusion is replaced with precise old-text revocation only inside the successful publication transaction. Source cleanup skips a predecessor only after its sanitised accepted state is durable. Re-extraction reuses saved intent collectively across the known affected source family, with all touched acknowledgements updated atomically; it does not discover arbitrary duplicate families.
- New list/detail/actions/operation/by-request HTTP contracts are wired through the service facade. Inputs and authenticated scopes are validated. Responses are `no-store`. Retired summary/timeline/overview return 410 to cutover users; legacy service actions refuse native-authority users.
- `/remember` routes native users through the same Add operation, deriving project scope from the owned active chat; a landing command without a conversation targets personal memory. Native response is `{operation}` and is not a saved-success acknowledgement.
- Dedicated `HINDSIGHT_CURATION_MODEL` runtime/admin/environment field defaults unset. No silent model1/retiring-judge or paid fallback. Explicitly choose an existing enabled local model binding before enabling curation. Native Hindsight extraction remains separately configured. Missing curation configuration produces an explicit operation error.

## Verification

- TDD: missing read/action/curation APIs first failed, then targeted behavior tests passed. Four bounded curation tests cover complete-ID rejection, a single repair and honest rejection after the limit.
- Five-suite checkpoint: 21 tests passed (`/tmp/memory-curation-checkpoint-tests.log` plus the subsequent source-edit test result). Real SQLite and the real job engine are used in action tests; native HTTP/model responses are synthetic fixtures.
- Includes same-source unrelated-fact preservation on Remove, stale generation and conflicting request reuse, owner-only lost-response reconciliation, pre-write rejected Edit, uncertain PATCH reply/retry with saved intent and preserved accepted view, and source-edit omission preserving original dates.
- Legacy service/notes compatibility: 35 tests passed (`/tmp/memory-legacy-compat-tests.log`).
- `npm run check`: 0 errors / 0 warnings (`/tmp/memory-curation-check4.log`) at the recorded snapshot. Scoped Biome clean. Later small source-count/manual-source presentation edits have focused rerun in `/tmp/memory-curation-last-tests.log`.
- Official Drizzle SELECT and SvelteKit routing/+server docs consulted before code changes.

## Remaining acceptance, not claimed complete

- Independent code review, fresh EN/HU native lifecycle and independent semantic grades after consolidation, forced re-extraction/restart and newer explicit assertions. None of these are replaced by the deterministic fixtures.
- Added family replay regression: 8 curation integration tests pass (`/tmp/memory-curation-family-replay.log`), including forced raw-ID replacement and preservation of an unrelated second-source fact without re-planning intent.
- Integrated browser tests for the actual endpoints and native operations, large/multiple-source action limits and request-lost navigation recovery.
- More real multi-process/restart and in-flight cancellation/privacy cases after foundation fixes; account cleanup service binding and pruned-operation semantics remain foundation/integration ownership.
- Pinned native infrastructure, actual model admission/fanout measurement and migration rehearsal are separate root-owned tasks.
- Native observation split/merge does not receive invented lineage; stale references and difficult/unverifiable edits fail honestly. Known-provenance curation is bounded to 100 raw facts / 100,000 input characters.

## Changed ownership

New internal files: `native-read{,.test}.ts`, `curation{,.test}.ts`, `curation-actions.ts`, `curation-runner.ts`, `curation.integration.test.ts`, `curation-config.test.ts`. Existing changes: service read/actions facade, Memory API routes and tests, notes route, narrow delivery-runner curation hooks, shared optional detail origin, env/config/admin registry and admin model selector/i18n, README/.env.example. Other workers own concurrent delivery cleanup/context, UI and infrastructure; do not overwrite their changes.

## Newly identified integration issue

The integration reviewer requires revoking/rebuilding already-submitted dependent documents whose stored context references a selectively removed source detail. The current selective action implementation sanitizes known affected sources and revokes exact old raw fingerprints; it does not yet rebuild separate dependent documents. The integration worker is defining a shared dependency helper. Blindly deleting these documents would lose unrelated facts, so any follow-up must preserve original assertion dates and independent information through bounded revision/re-extraction plus saved-intent replay. This is explicitly **not accepted** at this checkpoint.

## Independent review fixes — second checkpoint

The initial checkpoint was **not accepted**. `review-curation-api.md` reproduced seven defects and recorded ten findings. The fixes below supersede the initial implementation descriptions where they differ. These are application correctness results with synthetic native/model responses, not a native quality score.

| Finding | Implemented boundary and permanent evidence |
| --- | --- |
| 1 · rejected Edit replay | Only an action with `outcome: accepted` can supply authoritative Edit/source-edit intent. That outcome commits with publication. Remove uses its separate durable exclusion acknowledgement. Failed-edit re-extraction regression passes. |
| 2 · missing Remove plan | Replay must obtain the missing bounded plan or fail before changing acknowledgement; it never skips the exclusion. Model/config transport failures are retryable. The regression forces the old attempt into failed history before reprocessing fresh native IDs and retains the unrelated accepted sibling. |
| 3 · ignored replay PATCH | Each step is read back, the composed final expected result is checked, and unexpected raw IDs in affected documents reject the candidate. Source acknowledgements now commit only in the final publication transaction. Ignored-PATCH and unexpected-new-ID regressions preserve the old independent sibling. |
| 4 · overlapping mutation | A pending bank action prevents admission of a new Edit/Remove before any exclusion acknowledgement. Existing request IDs reconcile before that check. The in-flight competing Remove regression observes a conflict, not a false acknowledged exclusion. |
| 5 · unverified native delta | Manual Edit stages native before/after extraction **before** the one bounded apply/check pair. Fixed native new facts participate collectively, including ownership/omission and unchanged-claim date rules. Saved proposal retries do not rerun an acknowledged retain. Exact final document fact sets must match. Rejected delta cleanup has a durable rejected outcome, retryable cleanup and no re-planning/re-extraction. |
| 6 · invisible Add success | Add requires a relevant consolidated observation before publication; a raw fact alone cannot report applied. Multiple visible results remain successful with no invented single-row identity. |
| 7 · queued `/remember` privacy | Action intent stores the originating chat. Every action fence checks ownership, Incognito and original scope; source revisions also carry the chat ID for existing withdrawal cleanup. The empty-chat Incognito transition sends no native note. Standalone Knowledge Add remains independent. |
| 8 · local model enforcement | Resolved provider preflight and actual HTTP dispatch both enforce the configured local Hindsight inference gateway. Redirects are prohibited. The admin selector offers only gateway-bound models. Recording-transport tests cover local success, cloud rejection, a private endpoint bypass, and endpoint drift between resolution and dispatch. |
| 9 · stale failed page status | Historical failed action attempts do not mark the bank failed unless cleanup remains outstanding. Durable applied status and verified history survive job-row pruning. |
| 10 · repeated list scans | List source associations are indexed once per page. A 1,001-source / 50-row test requires at most three source-table SQL statements across the full read path and zero chat/message quotation queries. Detail retains the original quotation authorization checks. |

The bounded dependency-repair worker supplies known submitted descendants, durable replacement identities and original facts. Remove stores its repair plan with acknowledgement. Explicit edits/removals and edited chats use **one additional final check-only call** when a dependency closure is rebuilt: the same saved intent, original independent facts and final native facts are checked collectively. This cannot re-plan or start another repair loop. A mismatch withholds publication. The owning helper/engine tests and its independent review remain separately reported by `memory_dependency_repair`.

### Verification at this checkpoint

- Seven negative review probes were promoted to permanent inverted safety assertions. They first produced six failing tests. The seventh test initially rejected the old proposal before native delta extraction, so its status assertion alone was insufficient; it now also requires the checker input to contain the newly extracted offending fact, exactly five total model calls, and rejected-delta cleanup.
- **36 tests across five suites passed:** bounded curation, real SQLite/job-engine curation integration, configured model transport, native list/detail and Memory HTTP routes. Log: `/tmp/curation-review-final-tests3.log`.
- Additional cases: durable status/history after job pruning; retried rejected-delta cleanup without model re-planning; unexpected raw facts after validation; final dependency verification is one check-only call; representative list-query counts.
- Scoped Biome clean at `/tmp/curation-biome5.log`. Previous compile checkpoint: 0 errors / 0 warnings (`/tmp/curation-review-check2.log`). Final compile: 0 errors / 0 warnings (`/tmp/curation-review-final-check2.log`). A subsequent narrow acknowledged-Remove off-cleanup guard is coordinated with the dependency worker and its actual off-transition regression.
- Native semantic acceptance, true model fanout/admission measurements, EN/HU lifecycle grading, restart/replay acceptance and browser gates remain required. No deployment, real-user migration or real-user data processing occurred.

### Required release configuration

`HINDSIGHT_CURATION_MODEL` must resolve to an enabled provider/model whose endpoint is `HINDSIGHT_URL/ext/alfyai/inference/v1` (or its chat-completions URL), using the native extension's private inference key. The native service separately owns extraction configuration. Missing or incompatible configuration yields an explicit recoverable operation error; there is no fallback to a foreground or paid model. This binding shares the native background admission limit and does not change foreground chat providers.

Replay-only dependency rebuilds use one final check over the ordered saved accepted intents, so a later deliberate assertion may supersede an earlier one. The existing same-source replay readback remains exact; this additional check cannot re-plan or repair. Acknowledged Remove now checks for Memory off before planning and after interrupted work, delegating only cleanup to the dependency helper; reconstruction/model calls remain paused. The dependency worker owns the final off-transition integration test and any follow-up guard adjustment.
