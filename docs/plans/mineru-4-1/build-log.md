# MinerU 4.1 build log

What the build decided, and why, in the order it happened. The spec ([client-spec.md](client-spec.md))
says its decisions S1 to S10 change "only with a reason in the build log"; this is that log. Facts about
the server are in [spike-report.md](spike-report.md); the box and the cutover are in
[deploy/README.md](../../../deploy/README.md#document-extraction-service-mineru); the protocol as built is in
[docs/uploads.md](../../uploads.md). Dates are 2026-11-09 unless stated. The last section, "Shipped and
retired", records the cutover and the retirement of the 4.0 side, and says which open items it closed.

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
| S3 (canonical `document.<ext>`) | A registry entry may carry `intake.remoteExtension`, the spelling MinerU reads. TIFF has `tiff`, so both `.tif` and `.tiff` go as `document.tiff`. | 4.1.7 accepts `tiff` and never `tif` (its `mineru/filetypes.py`) and routes by extension, so every TIFF extraction failed for good under the first implementation (review finding I1 of Task B). The registry keeps `tif` canonical for stored names, the picker and three pinned tests. Checked live on the real 4.1.7 on `:8004` (no app on it; a synthetic TIFF, nothing written on the box): `document.tiff` completed at tier standard in 717 ms, `document.tif` failed with `parse_failed`, "Unsupported file type: document.tif". A HEIC or HEIF photo is told as `document.png`: its entry carries `intake.readAs` and the extractor is handed the PNG the handler made of it (R21). |
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
| R21 | The owner decided that the HEIC and HEIF fix (R15's M3) ships in the same release as 4.1. It is three commits of `claude/reverent-bardeen-95b1cf`, cherry-picked with `-x` onto the release candidate `02a2ebbaf` as `mineru41/rc-heic` (`c3018ed57`, `15945f0c0` and `41b55375a` are `961b97d80`, `db8f7d612` and `5745cbf23` there); the branch itself is not merged, since it also holds another session's unshipped plan. The registry gives `heic` and `heif` `intake.readAs: "png"`, and the extraction handler hands the extractor a PNG of the photo (`extraction/reader-input.ts`), so what MinerU is told is `document.png` at an explicit tier (S3, S4). The only conflict was in `registry.test.ts`, adjacent insertions of this release's `remoteExtension` test and the fix's `readAs` tests (twice, in the first and the third commit); both were kept. The guard "the registry against what MinerU 4.1.7 accepts" now asks for the name the way the handler does (`readerFileFor`, then `canonicalTaskFileName`), so `heic` and `heif` leave its known exceptions. The list is empty and stays as the place for the next type MinerU will not take, and a test shows the guard still catches a HEIC photo sent without its conversion. `mineru/heic.integration.test.ts` runs HEIC and HEIF photos through the engine against the fake server. The live sweep has no HEIC row, since the repo holds no HEIC photo with text in it: the cutover runbook asks for one by hand. | The owner's call. The fix was finished and gated apart, and 4.1 would otherwise ship with two types routed to a server that has never accepted them. Cost if wrong: a PNG made in the app's own process for each HEIC or HEIF photo. |

## Where each task ended

| Task | Branch | Head | Review | State |
|---|---|---|---|---|
| C: the renderer | `mineru41/c-renderer` | `0870b099d` (4 commits) | Sonnet: spec yes, quality approved, 0 Critical, 0 Important, 6 Minor. | Complete. Gate green (check 0/0, vitest 23,801, build clean, Fallow at its 4 known cycles, Playwright 295). |
| A: the wire | `mineru41/a-wire` | `6b35c310e`, then `e9fdf4510` after fix round 1 (11 commits) | Opus: spec no (the fake server's compatibility ruling was broken), 0 Critical, 3 Important (restart options could not be armed, three fixture inputs served other documents, `pollTask` spun on `waiting-file`), 9 Minor. Re-review: all addressed, nothing new. | Complete. |
| (integration) | `mineru41/int` | `182bd62e0` | none | A at `e9fdf4510` plus C at `0870b099d`, no shared file. |
| B: the flow | `mineru41/b-flow` | `01b7f6e93` (9 commits), then `229bd08c1` after fix round 1 (8 commits `01b7f6e93..229bd08c1`) | Opus: spec no on one item, 0 Critical, 1 Important (I1, TIFF sent as `document.tif`), 8 Minor. Re-review of the round: all addressed, no new Critical or Important. | Complete. Gate green on the first run at `01b7f6e93` (check 0/0, vitest 23,988, build clean, Fallow 0 new, Playwright 97), and at `229bd08c1` on its third run (vitest 24,021, Playwright 97, Fallow 0 new; the first run stopped at machine load 20 to 44 with 19 timeouts, the second found a latent race in a restart test). The round: I1 (TIFF through `intake.remoteExtension`), M6, M1, M2, M4, M5, `276061b83` (two engine tests that wait on real polls, given longer timeouts: see "From the independent pass" below) and `229bd08c1` (a latent race in a restart test). |
| D: the box | (on the box) | - | - | `mineru41.service` on `127.0.0.1:8004`, enabled, health 200, 4.1.7, one synthetic parse through it. No app pointed at it yet; both do since the evening of 2026-11-09 (see "Shipped and retired"). |
| D: the docs | `mineru41/d-docs` | `45d6f081a` (10 commits), then `581e09491` after fix round 1 (5 commits) | Sonnet: Needs fixes: 0 Critical, 2 Important (the service inventory: `mineru-openai-server` is a Docker container, not a unit, and `mineru4-dev.service` was missing; the key-on-argv warning named only `mineru41`), about 10 Minor. Its code claims, B's four fix-round statements included, were verified at `229bd08c1`. Re-review of fix round 1: all addressed, no new Critical or Important. | The plan folder, the 4.1 docs, the live sweep, the picture-server health probe; fix round 1 (R17); fix round 2: the rollback order stated as mandatory (the independent review's M1), no globs in the clean-up, the 30-minute bound on the cutover wait, the sweep's entry guard compared by real paths, and this log. |
| Independent pass | slice 1 `mineru41/ir-flow` and slice 2 `mineru41/ir-render`, both from `229bd08c1` | `71a4e228e` (`ir-flow`, 6 commits) and `2b4f20e8c` (`ir-render`, 7 commits) | Slice 1 (the extraction path), Opus: 0 Critical, 0 Important, the path is ready. Rollback works only in the documented order: URL back to `:8002` first, then the previous release; the reverse fails every document in that window for good, because the old client reads 4.1.7's FastAPI 404 `{detail}` on `/v1/uploads` as `fallback:4xx`, not retryable. Minors M1 to M9, dispositions under R19. Slice 2 (the renderer), Sonnet, reviewed and fixed in one pass: 0 Critical, 1 Important (fixed), 5 Minor or informational left on purpose, each with its reason. Combined re-review of the three fix waves and the merged release (R20), Opus: ready for the release gate after docs-only corrections, made in the docs commit on top of the release candidate. | IR1 (`229bd08c1..71a4e228e`): six of R19's seven items fixed (M2, M3, M4, M5, M8, the explicit tier against an unreadable tier list), the seventh (the boot move) left with a measurement (see Open items); gate green (vitest 24,051, Playwright 97, Fallow 0 new). IR2 (`229bd08c1..2b4f20e8c`): one Important fixed, test first (the prompt text kept only a figure's first caption and dropped the later ones); of C's six minors, the weak chunk-plan test (#3), the vacuous outline test (#4), the triplicated 4.1 loader (#5) and the "added" comment (#6) fixed, the unobserved shapes (#1) commented, `equation_interline` (#2) left; gate green (vitest 24,072, Playwright 295, Fallow 0 new). The combined re-review: all addressed. Release candidate `37ffd3694` (`90fd9006d` joins the two code branches, `37ffd3694` adds D's fix round 2), plus this docs commit. |

Nothing in the client has met a real 4.1.7: the fakes are held to the captures. Two direct calls have met the real
server: the box smoke parse (its `upload.url` and `result_url` come back on `http://127.0.0.1:8004`, the origin the
client is given, S7) and the TIFF probe under S3. Everything else is for the ai.dev run (spec §5), which
`scripts/verify-live-extraction-types.ts` covers except a cancel and a `systemctl restart mineru41` in the middle of a job.
That was the state when the build ended; the ai.dev run and the production uploads came the same day and are recorded in
"Shipped and retired".

## Open items

- **HEIC and HEIF** were routed to MinerU, which no 4.x release this project ran accepts. Decided: the fix ships with
  4.1 (R21), the guard follows the new registry reading and its list of known exceptions is empty. It has met a real
  4.1.7 since (2026-11-09, see "Shipped and retired"): a HEIC file of a page was read on ai.dev, and a HEIC photo the
  owner uploaded on production. The fake server is still held to the captures, as for everything else, and the sweep
  still has no HEIC row. The conversion runs in the app's own process, on the server's main thread as vision's does
  (WebAssembly). It costs more than `prepare-image.ts` once said (about 0.8 s for a 12 MP photo): measured in the
  independent review of the fix, 1.2 to 1.8 s for a 12 MP photo, half of it heic-convert's pure-JS JPEG step, and about
  6 s with a memory peak of 1.6 GB for a 48 MP one. It happens again on every retry and every resume, since nothing of
  the PNG outlives its attempt, so a backfill of many HEIC photos costs the app that decode as well as MinerU's time. A
  worker-thread decode is the follow-up (with it: the decode after the capability read, without the JPEG step, a pixel
  cap read from the file before it is decoded, and a picture with transparency flattened onto white: today it decodes to
  a black page and reads as empty with no error, which phone photos, having no alpha, do not meet).
- **Re-reading old documents.** The backfill skips a document whose recorded tier is at or above the one requested (it
  re-reads only documents recorded below it, or with none), so it will not touch documents read by the 4.0 client
  (`mineru4/1`) at the requested tier; `POST .../reextract` with `{"tier": ..., "force": true}` does, one at a time.
  The cutover is done; whether to do it for the library is still the owner's call.
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
  (`6828d555…`), so the two uploads differ in bytes; their expectations are the PNG's.
  The expectations for the 4.0.4 samples were read off the 4.0.4 server. Both held on the real 4.1.7 in the ai.dev run of
  2026-11-09: the only misses there were the csv and tsv rows, a wrong expectation in the script, fixed in `e8d576596`.
- **The owner's real upload check on production (done, 2026-11-09).** After the flip the owner uploaded a PDF and a
  HEIC photo, and both came back right (see "Shipped and retired").
- **The week-later clean-up (done early, 2026-11-09).** The plan was to retire the 4.0 side after a week of stable
  production: `mineru4.service`, `mineru4-dev.service`, the spike leftovers and, on the owner's word, the 4.0.x installs.
  The owner called it that evening and all of it is gone (see "Shipped and retired"). The record, and what must never be
  removed, are step 5 of the cutover runbook in deploy/README.md.

## Shipped and retired (2026-11-09)

What shipped, how the apps were moved and what was retired, in the order it happened. Times are UTC and
approximate. The box as it is now is in
[deploy/README.md](../../../deploy/README.md#document-extraction-service-mineru); its section "Cutting over
to 4.1 and rolling back" is the operator's record of the same evening.

**The release is `e5a4db61a`** (`mineru41/release-final`), 92 commits on `ed57ce793`: the candidate
`02a2ebbaf` (4.1 only), the HEIC and HEIF fix of R21 (three cherry-picks and their integration, up to
`95905365f`), and four final fixes. Three came out of the Opus review of the HEIC integration (ready for
production: 0 Critical, 0 Important, 7 Minor): `67d271bad` (no file path in the message a photo's job
stores), `279286a47` (the temp sweep also removes the converted photo a killed process leaves behind) and
`e5a4db61a` (the docs say what the conversion costs). The fourth, `e8d576596`, came out of the ai.dev run
below: the live sweep holds csv and tsv to their route, not to the statuses a poll sees.

**Rulings made after R21**

- R22: the URL flip is a SQL `UPDATE` of the site's `admin_config` row plus a restart, after that site's
  deploy (production drained first, as `deploy.sh` does). `PUT /api/admin/config` needs an admin session (a
  bearer token is not one), and the app reads its config once at startup or on an admin save.
- R23: the live checks run on the box, as scripts that call the app's own endpoints with the sweep's
  expectations transcribed. The sweep itself needs a browser, a password in the workstation's environment
  and an admin account, and the box's harness account is an ordinary user. The restart-in-the-middle check
  restarts `mineru41`, which no production app was using yet.
- R24: one full release gate, on the final commit, phased and with the machine quiet. Run 1, on
  `95905365f`, had been starved of CPU by work running beside it (load averages of 6 to 14; 9 vitest timeouts, all in
  files the release does not touch, and 8 Playwright failures), so it said nothing about the release. No
  timeout is lengthened.

**The gates.** The release gate on `e5a4db61a`, all green: check 0/0 (8,995 files), biome, migrations,
vitest 24,181 passed, build with no warnings, chunks, Fallow at its 4 known cycles and 0 new, Playwright
1,529 passed, 75 skipped, 0 failed, 0 flaky (19 minutes). The baseline run on `02a2ebbaf` had one failure,
`project-panel-over-dialog.spec.ts:471`, a load-timing flake in a spec this release does not touch (51
passed on a re-run alone, same build).

**ai.dev.** `02a2ebbaf` was deployed with `deploy-dev.sh` and its `MINERU_API_URL` flipped to `:8004`.

- Round 1 of the live checks passed 28 of 30. The two misses were the sweep's csv and tsv rows: "no
  `parsing` status seen" was a wrong expectation (the direct-text extractor reports a `parsing` phase of
  its own, and a poll catches it on some runs), and MinerU's log held no request for either, so the route
  was right.
- All 21 MinerU-parsed documents showed server 4.1.7, app parser `mineru4/2`, the right tier (standard for
  PDFs and images, flash for native documents) and no unknown block types. A corrupt PDF ended
  `document_unreadable` with the app's own sentence and no Retry.
- A re-extract answered 400 `tier_not_higher` without `force` and 200 with it. A cancel ended `canceled`,
  with one cancel call in MinerU's log. `systemctl restart mineru41` in the middle of a job made the app
  log `MinerU forgot an id, recovering`, MinerU answer a 404 for the old task and take a new
  `POST /v1/tasks`, and the job succeed.
- Then `e5a4db61a` was deployed (the URL stayed) and round 2 passed 9 of 9. A HEIC file of a page (opaque,
  made from a page image) was read at the standard tier, with the title, the `$$`-fenced formula with its
  `\tag{1}` and the footnote in the text; the stored original stayed byte-identical, and the converted PNG
  was seen in the temp directory during the attempt and gone after. Five smoke uploads passed (the paper
  PDF, a PNG, a TIFF, a corrupt PDF, a CSV on the direct-text route), so did csv and tsv under the fixed
  expectation, and the journals were clean.

**Production.** `e5a4db61a` was pushed to `main` (a fast-forward of `ed57ce793`) and deployed with
`scripts/deploy.sh` at about 22:32: backup verified, 0 replies to drain, `current` to
`releases/e5a4db61a`, health OK. About 22:36 the URL was flipped (R22): `admin_config` `MINERU_API_URL`
`:8002` to `:8004`, written as `alfydesign` with `updated_by` `mineru41-cutover`, then a drain (0 replies
running) and a restart of `langflow-chat`; health OK after 3 s. The flip script's first run wrote the row
and stopped at the drain, because it sourced `shared/.env` from a root shell outside the checkout and that
file runs git commands that fail there. The second run read only the `ALFYAI_API_SIGNING_KEY` line. No
extraction job was queued or running in the 90 minutes around the switch, so no document waited in the
window. About 22:40 the owner uploaded a PDF and a HEIC photo on production and said: "PDF and HEIC came
back correctly just now on prod." That closes the owner's real upload check.

**Retired, a week early.** In the same message the owner said: "We can actually retire MinerU 4.0 right now."

- Checks first: both apps' `admin_config` named `:8004`, no `MINERU_API_URL` in either `shared/.env`, no
  open connection to `:8002` or `:8003`, no request to `mineru4` since the flip and none to `mineru4-dev`
  in two hours.
- Then `systemctl disable --now mineru4.service mineru4-dev.service`: both inactive and disabled, no
  listener on either port, `mineru41` health 200, both apps healthy (available RAM 60 to 62 GB, GPU 1
  31,331 to 30,154 MiB used). Until the deletion, the way back was `systemctl enable --now mineru4` and the
  URL flip.
- About 22:55 the owner: "Delete A, B and C." The groups were the spike leftovers (A, about 2.0 GB), 4.0.6
  with the dev server (B, about 8.0 GB) and 4.0.12 (C, about 7.4 GB): about 17.4 GB. Every path was typed
  in full, with both units inactive and no path to delete being or containing a path that stays; then
  `systemctl daemon-reload` and `reset-failed`, and systemd knows neither unit. The paths are in step 5 of
  the runbook.
- Kept, and checked present: `mineru41.service` with `.venv-4.1.7`, `m41p`, `uploads-41` and `mineru4.env`,
  and the `mineru-openai-server` container, unchanged. The on-box `mineru41.service` header comment still
  says "beside 4.0.12": a unit-file edit was not asked for.

**Rollback now.** There is no 4.0 server. Rolling the app back to `ed57ce793` would need MinerU 4.0.12
rebuilt first (a new venv with `mineru[torch]==4.0.12`, its models, the 4.0 telemetry pre-seed, a unit on
`:8002` with the `mineru4.env` key), then `MINERU_API_URL` back to `:8002`, then the previous release, in
that order. In practice: fix forward on 4.1. R14's "old server" handling stays in the client; without an
old server it is harmless.

**Image uploads, old against new,** measured the same evening on synthetic images (no user data; 22
sequential jobs on production's 4.0.12 for the old side, nothing written on the box). The report is outside
git: `.superpowers/sdd/client-spec/image-comparison-report.md` in the main checkout. Better, and the gain is
in the app, not in MinerU.

- HEIC and `.tif` went from refused (`parse_failed`, "Unsupported file type", 0 of 2) to read with 0 % CER.
  Both fixes are in the client: 4.1.7 itself also refuses `document.tif` and `document.heic`.
- A page with a chart went from 7.9 % to 0.6 % CER (WER 9.9 % to 3.3 %, figures 0 to 1), because the old
  renderer dropped the chart and its caption.
- The engine is the same: 0 text edits over 11 image pairs, and a warm median of 537 ms on 4.0.12 against
  530 ms on 4.1.7. The result download is half the size (208,059 against 412,894 bytes over 8 images).
- One edge: a HEIC whose picture has transparency decodes to a black page and reads as empty with no error.
  Phone photos have no alpha. Flattening onto white belongs to the decode follow-up below.

**Closed by this:** the owner's real upload check (passed), the week-later clean-up (done early), the HEIC
photo of a page by hand at the ai.dev run (done, round 2) and the live sweep's unproven expectations
(held).

**Still open, for the owner or a later session:**

- The HEIC decode rework: off the main thread, after the capability read, without heic-convert's JPEG step,
  with a pixel cap read from the file, and with transparency flattened onto white.
- Whether to re-read the documents the 4.0 client read before charts were kept. The backfill skips
  same-tier documents, so it is `force`, one at a time.
- The other Minors of the HEIC review: an undecodable valid photo is called "damaged or password-protected",
  which needs an English and Hungarian photo sentence, and the runner-level test gaps (a HEIC cancel, a lost
  lease, a resume with a stored handle).
- The `project-panel-over-dialog` flake above.
- Code and tests that still name the old server: `scripts/images/measure.ts` lists `mineru4` on `:8002` (it
  probes it only while the unit is active, and its comment says it is kept for a week), and some tests and
  comments use `:8002` as a sample address. None of it runs in production; it can go with the next change to
  those files.
