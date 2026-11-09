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
| S3 (canonical `document.<ext>`) | A registry entry may carry `intake.remoteExtension`, the spelling MinerU reads. TIFF has `tiff`, so both `.tif` and `.tiff` go as `document.tiff`. | 4.1.7 accepts `tiff` and never `tif` (its `mineru/filetypes.py`) and routes by extension, so every TIFF extraction failed for good under the first implementation (review finding I1 of Task B). The registry keeps `tif` canonical for stored names, the picker and three pinned tests. |
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
| R15 | B's minors M1 (deadline: a queued task is an outage retry, a running one spends an attempt and ends with the timeout sentence), M2 (no caching of a tier-less report), M4 (CSV test against S4), M5 (the backfill's `auto` uses the tier policy) and M6 (result-ZIP errors through the fixed sentences) enter B's fix round; M3 (HEIC and HEIF are routed to MinerU, which has never accepted them) goes to the owner as a decision of its own; M7 (English-only operator diagnostics) stays; M8 (size) goes to the final review. | They are cheap, in B's files, and three of them touch extraction correctness. M3 is pre-existing: 4.0.12's extension list is the same. |
| R16 | `docs/plans/mineru-4-1/` (hand-off, spec, spike report, fixtures with the tools and `check-4012/`) is committed in Task D's branch, with this log. | The spec requires decision changes to be recorded here, the progress ledger is not in git, and the renderer's tests cite the spike report. Precedent: the 4.0 captures in `fixtures/mineru-v1/` are tracked. The captures hold `Bearer <redacted>` and no key. |

## Where each task ended

| Task | Branch | Head | Review | State |
|---|---|---|---|---|
| C: the renderer | `mineru41/c-renderer` | `0870b099d` (4 commits) | Sonnet: spec yes, quality approved, 0 Critical, 0 Important, 6 Minor. | Complete. Gate green (check 0/0, vitest 23,801, build clean, Fallow at its 4 known cycles, Playwright 295). |
| A: the wire | `mineru41/a-wire` | `6b35c310e`, then `e9fdf4510` after fix round 1 (11 commits) | Opus: spec no (the fake server's compatibility ruling was broken), 0 Critical, 3 Important (restart options could not be armed, three fixture inputs served other documents, `pollTask` spun on `waiting-file`), 9 Minor. Re-review: all addressed, nothing new. | Complete. |
| (integration) | `mineru41/int` | `182bd62e0` | none | A at `e9fdf4510` plus C at `0870b099d`, no shared file. |
| B: the flow | `mineru41/b-flow` | `01b7f6e93` (9 commits) | Opus: spec no on one item, 0 Critical, 1 Important (I1, TIFF sent as `document.tif`), 8 Minor. | Gate green on the first run (check 0/0, vitest 23,988, build clean, Fallow 0 new, Playwright 97). Fix round 1 (I1, M1, M2, M4, M5, M6) was under way when this was written; its head belongs here when it is merged. |
| D: the box | (on the box) | - | - | `mineru41.service` on `127.0.0.1:8004`, enabled, health 200, 4.1.7, one synthetic parse through it. No app points at it yet. |
| D: the docs | `mineru41/d-docs` | this branch | - | This commit series: the plan folder, the 4.1 docs, the live sweep, the picture-server health probe. |

Nothing in the client has met a real 4.1.7: the fakes are held to the captures. The one live fact so far is that the
box's `upload.url` and `result_url` come back on `http://127.0.0.1:8004`, the origin the client is given (S7), seen
in the box smoke parse. Everything else is for the ai.dev run (spec §5), which `scripts/verify-live-extraction-types.ts`
covers except a cancel and a `systemctl restart mineru41` in the middle of a job.

## Open items

- **HEIC and HEIF** are routed to MinerU, which no 4.x release this project ran accepts. Pre-existing; the guard test names
  them as known exceptions and does not change their routing. Another session owns the decision.
- **Re-reading old documents.** The backfill skips a document already at the requested tier, so it will not touch
  documents read by the 4.0 client (`mineru4/1`); `POST .../reextract` with `{"tier": ..., "force": true}` does, one at a
  time. Whether to do it for the library is the owner's call after the cutover.
- Deferred minors: C's unobserved shapes in `result.ts` (comment or drop), `equation_interline` is now a known type so its
  "first sighting" signal is retired, `chunk-plan.test.ts` and `outline.test.ts` assert less than their 4.0 siblings,
  the 4.1 fixture loader exists three times, a comment in `result.ts` says 4.1 "added" three types that 4.0.12 also emits.
  A's: the PUT-400 rules could mark the handle unknown, the fake needs one counted GET before an outcome, a fake-server
  timer test can race under load, three large test files. B's: English-only operator diagnostics, `mineru4.ts` grew from 766
  to 977 lines.
- The live sweep's TIFF inputs (`fixtures/inputs/scan-sample.tif` and `.tiff`, the same bytes) are the v1 PNG sample
  converted with `sips -s format tiff` and `tiffutil -lzw` (sha256 of the `.tif`: `73c8b4ea…`); their expectations are the
  PNG's and unproven until the live run. The expectations for the 4.0.4 samples were read off the 4.0.4 server and are
  likewise unproven on 4.1.7.
- After a week of stable production: disable `mineru4.service` and remove the spike leftovers (the steps are in
  deploy/README.md). Keep the 4.0.12 venv until the owner says otherwise.
