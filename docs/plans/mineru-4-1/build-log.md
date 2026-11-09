# MinerU 4.1 build log

What the build decided, and why, in the order it happened. The spec ([client-spec.md](client-spec.md))
says its decisions S1 to S10 change "only with a reason in the build log"; this is that log. Facts about
the server are in [spike-report.md](spike-report.md); the box and the cutover are in
[deploy/README.md](../../../deploy/README.md#document-extraction-service-mineru); the protocol as built is in
[docs/uploads.md](../../uploads.md). Dates are 2026-11-09 unless stated.

Base of the work: `ed57ce793` (`dev` = `main` that day). Pin: MinerU **4.1.7**, still the newest 4.1.x on PyPI
when the build started (4.1.0 to 4.1.7 came out 29 October to 4 November), so no re-capture was needed.

## The owner's answers (spec §8)

| Question | Answer |
|---|---|
| OK to run one synthetic PDF through production 4.0.12 (spec §3.1)? | Yes, run it. |
| Does Task C ship before the protocol work if §3.1 shows production already loses charts? | No: "ship it with 4.1" (no separate renderer release first). |
| The label for PPTX speaker notes (S10) | "Speaker notes:" |

## Spec §3.1: is S10 a 4.1 change or a production bug today?

One synthetic parse (`paper-en.pdf`, sha256 `75314f7c…`, no user data) through production 4.0.12 on `:8002` with the
4.0 protocol and no tier: completed at tier standard in 10.1 s (parser 4.0.12). Evidence:
`fixtures/check-4012/{structured_content.json, markdown.md, run.txt}`.

**4.0.12 emits exactly the 4.1.7 block sequence for this PDF** (chart 1, equation 1, page_footnote 1, the same keys), and
MinerU's own `markdown.md` fences the equation with `$$` and keeps "Figure 1. Relative throughput by tier.". So S10 is a
production bug that has existed since the 4.x cutover on 2026-09-22, not a 4.1 change: the renderer drops every chart and
its caption and leaves display math unfenced. The owner's ruling above already covered this case; the order did not
change. Documents already extracted keep the lossy text until they are read again (the parser version tells them apart,
R10); whether to read them again is the owner's call after the cutover.

## Spec §3.2: the other callers (what the grep found, and who took each)

`scripts/backfill-extractions.test.ts` and the capabilities consumers (the admin MinerU status route, the system-health
client, `knowledge/format-availability.ts`, the re-extract route, `scripts/backfill-extractions.ts`): Task B.
`scripts/verify-live-extraction-types.ts`, `scripts/images/measure.ts:135` (a hardcoded `127.0.0.1:8002` health probe),
`.env.example`, `docs/configuration.md`, `docs/architecture.md`, `docs/uploads.md`, `deploy/README.md`: Task D.

## Changes to the spec's decisions

| Decision | Change | Why |
|---|---|---|
| S2 (one task per chunk) | Read as one task per extraction attempt. "Per chunk" in the spec is the retrieval chunk plan, which runs after the parse. A later task for the same bytes (a retry, a re-extract) is where the hash cache hands out a receipt with no upload link. | Smallest ledger change; what the old client did (one job per document). |
| S3 (canonical `document.<ext>`) | A registry entry may carry `intake.remoteExtension`, the spelling MinerU reads. TIFF has `tiff`, so both `.tif` and `.tiff` go as `document.tiff`. | 4.1.7 accepts `tiff` and never `tif` (its `mineru/filetypes.py`) and routes by extension, so every TIFF extraction failed for good under the first implementation (review finding I1 of Task B). The registry keeps `tif` canonical for stored names, the picker and three pinned tests. Checked live on the real 4.1.7 on `:8004` (no app on it; a synthetic TIFF, nothing written on the box): `document.tiff` completed at tier standard in 717 ms, `document.tif` failed with `parse_failed`, "Unsupported file type: document.tif". |
| S4 (explicit tier) | Native documents get no tier even for a re-extract hint; with no readable tier list, `auto` sends none; a report that lost its tier list is not cached. | A valid tier is ignored for a native document and `advanced` never runs (D14), so there is nothing to gain; the one place a PDF goes without a tier is the one where a guess would be a permanent 400. |
| S6 ("another protocol" is a plain FastAPI 404) | Replaced by R14: any error body whose `error` object carries `type`, on any path, is the old server. | The source of the installed 4.0.12 shows it mounts `/v1/tasks` itself and answers a 4.1 manifest with HTTP 400 carrying `type`, not a 404. |
| S10 (new block types) | Footnotes on non-slide pages are a bare paragraph (R11); "Speaker notes:" lives only in the prompt renderer (R7). | See R7 and R11. |

## Rulings

| # | Ruling | Why |
|---|---|---|
| R1 | Tasks A and B are one line of work on one branch, in order. A's acceptance is its own tests green, `npm run check` with errors only in B-owned files, biome clean; the full gate runs at the end of B. | Keeping 4.0 and 4.1 compatible code only to keep A green contradicts S1, and B would delete it. |
| R2 | A may make small additive edits to `mineru/config.ts`, each named in its report; the file is otherwise B's. | A and B are sequential, so no conflict. |
| R3 | 4.1 fixtures live at repo-root `fixtures/mineru-v41/` (A owns `protocol/`, C owns `results/`), not under `src/`. | Biome lints and formats `src/**`, and captured JSON would fail it; the repo keeps its fixtures at the root (`fixtures/mineru-v1/`); it lets C run beside A. |
| R4 | C keeps the exported names and signatures of `result.ts` and `bundle.ts`; behaviour (chart figures, new block rendering) changes. | B and the persistence code call them. |
| R5 | D's docs part runs after B lands; D's box unit waits for the owner's go-ahead. | The docs describe the protocol as built. |
| R6 | Caller assignment as in §3.2 above. | A gate failure would show a missed caller. |
| R7 | "Speaker notes:" goes only into the prompt renderer, for `page_footnote` blocks on slide pages; the faithful renderer stays byte-comparable with MinerU's `markdown.md`. MinerU itself already writes "Speaker notes: " into PPTX notes, so the prompt label is normalised and written once. | The faithful renderer's contract is parity with MinerU. |
| R8 | The §3.1 run no longer gates the order; it ran once the owner started Tailscale. | The owner ruled that C ships with 4.1. |
| R9 | A and C run in parallel despite the one-implementer rule. | Their files are disjoint (R3) and each had its own worktree and branch. |
| R10 | `MINERU_PARSER_VERSION` goes `mineru4/1` to `mineru4/2`, in Task B (its base includes C), with the two test literals; `persist.test.ts` keeps its stub. | The stored parser version then tells lossy-renderer documents from new ones, which a selective re-extract needs. |
| R11 | S10's "footnote paragraph" on a non-slide page is the footnote text as its own bare paragraph in the prompt text, with no "Footnote:" marker. | The spec and the owner's answer name a label only for slides, and MinerU's footnote text already starts with its number. |
| R12 | B starts from `mineru41/int`, a merge of A's final head and C's head made with `git merge-tree` and `git commit-tree` (no working tree touched). | B's flow tests then run against the final renderer, and one gate covers A, B and C. A and C share no file. |
| R13 | A's minors M1 to M7 enter A's fix round; M8 (the tier refusal sentence) and the D12 end-to-end check move to B; M9 (file sizes) to the final review; the S7 `Host` requirement goes to D's docs. | B builds directly on A's interface, fake fidelity and error classification. |
| R14 | "Another protocol" means any error body whose `error` carries `type` (4.0.x always sends one, 4.1 never does), on every path and detected before strict parsing; a FastAPI `{detail}` counts only as a 404. It is `unavailable`, retryable, never a forgotten id; B reports it to tool health. | 4.0.12 serves `/v1/tasks` itself and answers a 4.1 manifest with a typed 400 (see S6). If a later 4.1.x adds `type` back, it would be retried as the old server until the outage window ends; the upgrade checklist re-captures the error bodies for that reason. |
| R15 | B's minors M1 (deadline: a queued task is an outage retry, a running one spends an attempt and ends with the timeout sentence), M2 (no caching of a tier-less report), M4 (CSV test against S4), M5 (the backfill's `auto` uses the tier policy) and M6 (result-ZIP errors through the fixed sentences) enter B's fix round; M3 (HEIC and HEIF are routed to MinerU, which has never accepted them) goes to the owner as a decision of its own; M7 (English-only operator diagnostics) stays; M8 (size) goes to the final review. | Cost if wrong: a slightly larger fix round. |
| R16 | `docs/plans/mineru-4-1/` (hand-off, spec, spike report, fixtures with the tools and `check-4012/`) is committed in Task D's branch, with this log. | The spec requires decision changes to be recorded here, the progress ledger is not in git, and the renderer's tests cite the spike report. Precedent: the 4.0 captures in `fixtures/mineru-v1/` are tracked. The captures hold `Bearer <redacted>` and no key. |
| R17 | D's minors from its review (the clean-up step, operator facts repeated in two documents, tense before the cutover, the backfill wording, a spelling, the restart claim, a size-limit remnant, the deadline caveat and the 30-minute window, this log's housekeeping, CHANGELOG style, tests for the live sweep's new logic) enter D's fix round 1, with the two Important findings (the service inventory, the key-on-argv warning). | Docs-only and cheap, and an operator follows these steps. Cost if wrong: a longer docs round. |
| R18 | The independent review-and-fix pass runs as two disjoint slices on the integrated head `229bd08c1` (A, B and C together; D's docs were already reviewed). Slice 1 is the extraction path (the A and B seams, the job engine, cutover and rollback, concurrency, the key, D12, ADR-0069, leftovers, tests, and a triage of A's and B's deferred items): a review, then one fix wave with the full list, then a scoped re-review. Slice 2 is the renderer (C), reviewed and fixed in a branch of its own with failing tests first, which also triages C's six parked minors. | The per-task reviews could not see the seams; slicing keeps each read focused. Cost if wrong: one more fix round. |
| R19 | The fix wave of slice 1 is: M2 (replace the lengthened test timeouts of `276061b83` with a sleep seam), M3 (the racy fake-server timer test), M4 (JSON calls follow cross-origin redirects, with the manifest re-sent and the key stripped by undici; pre-existing), M5 (a stale-tier 400 keeps the capability cache), M8 (no engine test against a 4.0.12 health answer), an explicit tier against an unreadable tier list becoming a retryable `unavailable`, and moving the boot of `integration.test.ts:264` into `beforeAll` if that is clean. M1 (the rollback order stated as mandatory) goes to the docs branch. M6, M7 and M9, the `max_attempts` wording and the file sizes are recorded for the owner and not fixed. | Cheap, in the path, and they remove a forbidden timeout, a flaky test and two avoidable failure windows. Cost if wrong: one fix wave. |
| R20 | One combined scoped re-review (Opus, since slice 1's fix wave touches A's and B's code) over the three fix waves (slice 1's, slice 2's and D's fix round 2), once all were in, then the release merge and the release gate. | The waves were built apart, each against its own brief; the merge and the seams between them (the docs against the code, for one) needed a single read before the gate. |

## Where each task ended

| Task | Branch | Head | Review | State |
|---|---|---|---|---|
| C: the renderer | `mineru41/c-renderer` | `0870b099d` (4 commits) | Sonnet: spec yes, quality approved, 0 Critical, 0 Important, 6 Minor. | Complete. Gate green (check 0/0, vitest 23,801, build clean, Fallow at its 4 known cycles, Playwright 295). |
| A: the wire | `mineru41/a-wire` | `6b35c310e`, then `e9fdf4510` after fix round 1 (11 commits) | Opus: spec no (the fake server's compatibility ruling was broken), 0 Critical, 3 Important (restart options could not be armed, three fixture inputs served other documents, `pollTask` spun on `waiting-file`), 9 Minor. Re-review: all addressed, nothing new. | Complete. |
| (integration) | `mineru41/int` | `182bd62e0` | none | A at `e9fdf4510` plus C at `0870b099d`, no shared file. |
| B: the flow | `mineru41/b-flow` | `01b7f6e93` (9 commits), then `229bd08c1` after fix round 1 (8 commits `01b7f6e93..229bd08c1`) | Opus: spec no on one item, 0 Critical, 1 Important (I1, TIFF sent as `document.tif`), 8 Minor. Re-review of the round: all addressed, no new Critical or Important. | Complete. Gate green on the first run at `01b7f6e93` (check 0/0, vitest 23,988, build clean, Fallow 0 new, Playwright 97), and at `229bd08c1` on its third run (vitest 24,021, Playwright 97, Fallow 0 new; the first run stopped at machine load 20 to 44 with 19 timeouts, the second found a latent race in a restart test). The round: I1 (TIFF through `intake.remoteExtension`), M6, M1, M2, M4, M5, `276061b83` (two engine tests that wait on real polls, given longer timeouts: see "From the independent pass" below) and `229bd08c1` (a latent race in a restart test). |
| D: the box | (on the box) | - | - | `mineru41.service` on `127.0.0.1:8004`, enabled, health 200, 4.1.7, one synthetic parse through it. No app points at it yet. |
| D: the docs | `mineru41/d-docs` | `45d6f081a` (10 commits), then `581e09491` after fix round 1 (5 commits) | Sonnet: Needs fixes: 0 Critical, 2 Important (the service inventory: `mineru-openai-server` is a Docker container, not a unit, and `mineru4-dev.service` was missing; the key-on-argv warning named only `mineru41`), about 10 Minor. Its code claims, B's four fix-round statements included, were verified at `229bd08c1`. Re-review of fix round 1: all addressed, no new Critical or Important. | The plan folder, the 4.1 docs, the live sweep, the picture-server health probe; fix round 1 (R17); fix round 2: the rollback order stated as mandatory (the independent review's M1), no globs in the clean-up, the 30-minute bound on the cutover wait, the sweep's entry guard compared by real paths, and this log. |
| Independent pass | slice 1 `mineru41/ir-flow` and slice 2 `mineru41/ir-render`, both from `229bd08c1` | `71a4e228e` (`ir-flow`, 6 commits) and `2b4f20e8c` (`ir-render`, 7 commits) | Slice 1 (the extraction path), Opus: 0 Critical, 0 Important, the path is ready. Rollback works only in the documented order: URL back to `:8002` first, then the previous release; the reverse fails every document in that window for good, because the old client reads 4.1.7's FastAPI 404 `{detail}` on `/v1/uploads` as `fallback:4xx`, not retryable. Minors M1 to M9, dispositions under R19. Slice 2 (the renderer), Sonnet, reviewed and fixed in one pass: 0 Critical, 1 Important (fixed), 5 Minor or informational left on purpose, each with its reason. Combined re-review of the three fix waves and the merged release (R20), Opus: ready for the release gate after docs-only corrections, made in the docs commit on top of the release candidate. | IR1 (`229bd08c1..71a4e228e`): six of R19's seven items fixed (M2, M3, M4, M5, M8, the explicit tier against an unreadable tier list), the seventh (the boot move) left with a measurement (see Open items); gate green (vitest 24,051, Playwright 97, Fallow 0 new). IR2 (`229bd08c1..2b4f20e8c`): one Important fixed, test first (the prompt text kept only a figure's first caption and dropped the later ones); of C's six minors, the weak chunk-plan test (#3), the vacuous outline test (#4), the triplicated 4.1 loader (#5) and the "added" comment (#6) fixed, the unobserved shapes (#1) commented, `equation_interline` (#2) left; gate green (vitest 24,072, Playwright 295, Fallow 0 new). The combined re-review: all addressed. Release candidate `37ffd3694` (`90fd9006d` joins the two code branches, `37ffd3694` adds D's fix round 2), plus this docs commit. |

Nothing in the client has met a real 4.1.7: the fakes are held to the captures. Two direct calls have met the real
server: the box smoke parse (its `upload.url` and `result_url` come back on `http://127.0.0.1:8004`, the origin the
client is given, S7) and the TIFF probe under S3. Everything else is for the ai.dev run (spec §5), which
`scripts/verify-live-extraction-types.ts` covers except a cancel and a `systemctl restart mineru41` in the middle of a job.

## Open items

- **HEIC and HEIF** are routed to MinerU, which no 4.x release this project ran accepts. Pre-existing; the guard test names
  them as known exceptions and does not change their routing. A separate fix is on its own branch and the owner decides
  whether it ships with 4.1; if it does, the guard's list of known exceptions goes stale and its staleness test fails by
  design, so the guard has to follow the new registry reading.
- **Re-reading old documents.** The backfill skips a document whose recorded tier is at or above the one requested (it
  re-reads only documents recorded below it, or with none), so it will not touch documents read by the 4.0 client
  (`mineru4/1`) at the requested tier; `POST .../reextract` with `{"tier": ..., "force": true}` does, one at a time.
  Whether to do it for the library is the owner's call after the cutover.
- Deferred minors. Resolved by the independent pass: C's unobserved shapes in `result.ts` (kept, each now commented
  "Unobserved"), the weak 4.1 tests in `chunk-plan.test.ts` and `outline.test.ts`, the 4.1 fixture loader that existed three
  times (one helper now, `result-corpus.test-helpers.ts`; the three 4.0 loaders remain) and the comment in `result.ts` that
  said 4.1 "added" three types 4.0.12 also emits (all IR2); A's racy fake-server timer test (IR1, `8bc433b3d`, on a fake
  clock). Still open: C's `equation_interline` is now a known type, so its "first sighting" signal is retired (left by S10,
  which keeps it as an alias). A's: the PUT-400 rules could mark the handle unknown, the fake needs one counted GET before an
  outcome, three large test files. B's: English-only operator diagnostics, `mineru4.ts` grew from 766 to 1,064 lines, no
  report is cached while `/v1/tiers` stays unreadable so every capability read probes again (bounded by the request
  timeout), and a document too slow for the deadline ends as `max_attempts` in the UI's label with the timeout's sentence
  stored.
- **From the independent pass.** B's `276061b83` lengthened three test timeouts in `integration.test.ts`, which the repo
  forbids; the fix wave (R19, M2; `477f8d45c`) replaced them with a sleep seam, so the two deadline tests end through the
  client's own sleep and wait for nothing, and no timeout is lengthened any more. The "parses to non-empty text through the
  real engine" test took 11 to 12 s at load 20 to 44 against the 5 s default; the triage found CPU starvation and not polls.
  R19's boot move was measured and left as it was: the engine boot is about 8 ms of about 90 ms per case, and what every
  test in the file pays is the migration of a new ledger database (`createLedgerFixture`, in
  `extraction/testing/ledger-fixtures.ts`), which a `beforeAll` for the boot would not remove. The 11 to 12 s was that same
  CPU-bound work (cold imports, migrations) under starvation. No timeout was touched. A template-database fixture (migrate
  once per process, copy the file per test) is the follow-up: it would speed up every test that uses the ledger fixture and
  wants a review of its own. Recorded for the owner and not fixed: errors on the app's own disk (`ENOSPC`, `EACCES`, an
  unsafe path, `ENOENT`) read as an outage (pre-existing); an outage of the VLM server can arrive as an unmatched
  `parse_failed` that spends attempts (no capture); a cosmetic `resumed: true`; the `max_attempts` wording; the file sizes.
- **A check at the flip (no longer needed).** An explicit tier (`MINERU_DEFAULT_TIER` other than `auto`, or a re-extract
  hint) against an unreadable tier list used to throw `tier_unavailable` and was never auto-retried (`tier-policy.ts`). R19's
  fix (`df3af119b`) is in the release: that case is now a retryable `unavailable` (an outage wait, no attempt spent), so no
  check of each app's `MINERU_DEFAULT_TIER` is needed when its URL is flipped. The re-extract route is a separate,
  pre-existing gap: when `/v1/tiers` cannot be read it answers 400 `tier_unavailable` before the job is requeued, so
  nothing is lost, and a 503 `unavailable` would match the rest of the route.
- The live sweep's TIFF inputs (`fixtures/inputs/scan-sample.tif` and `.tiff`) are the v1 PNG sample converted with
  `sips -s format tiff`, then `tiffutil -lzw` for the `.tif` (sha256 `73c8b4ea…`) and `-packbits` for the `.tiff`
  (`6828d555…`), so the two uploads differ in bytes; their expectations are the PNG's and unproven until the live run.
  The expectations for the 4.0.4 samples were read off the 4.0.4 server and are likewise unproven on 4.1.7.
- After a week of stable production, retire the 4.0 side: `mineru4.service`, `mineru4-dev.service`, the spike leftovers
  and, on the owner's word, the 4.0.x installs. The steps, and what must never be removed, are step 5 of the cutover
  runbook in deploy/README.md.
