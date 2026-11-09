# MinerU 4.0.12 → 4.1.x: client rewrite and cutover spec

Status: written 2026-11-05 after the spike; build after the 2026-11-09 weekly reset (owner's choice: "Spike now, build later").
Read first: [spike-report.md](spike-report.md) (every fact here is backed by a file under `fixtures/`), then the 4.1 docs it cites.
Pin: **mineru 4.1.7**. If a newer 4.1.x exists at build time, read its release notes; take it only if it changes nothing below, and re-run the
spike's capture tools (`fixtures/tools/`) against it before writing code.

## 1. What changes, in one paragraph

Only the way AlfyAI hands a file to MinerU and collects the answer. 4.1 removes `/v1/uploads` and `/v1/parse/jobs` and replaces them with
`POST /v1/tasks` (JSON manifest) → PUT the bytes to `files[].upload.url` (only when an `upload` object is present) → poll `GET /v1/tasks/{id}` →
download one ZIP per file from `files[].result_url`. The result ZIP and `structured_content.json` are what our parser already reads (the spike's
parser check: all 19 captures and 13 ZIPs parse with no key renamed). Errors become `{error:{code,message,param?}}` with no `type`; FastAPI's
`{detail:"..."}` still answers 404/405. Everything the server knows is in memory: a restart forgets every task, file and hash.

## 2. Decisions (made here; change them only with a reason in the build log)

| # | Decision | Why |
|---|---|---|
| S1 | **4.1-only client.** No dual 4.0/4.1 protocol support. | The cutover window is covered by retries (S6); dual support doubles the wire code and its tests for a few seconds of overlap. |
| S2 | **One task per chunk**, one `files[]` entry each, mirroring today's one job per chunk (`chunk-plan`). Send `sha256sum` always: later chunks of the same upload hit the hash cache and skip the PUT. | Smallest ledger change. Two entries with equal hashes in one task were never tested. |
| S3 | **`file_name` sent to MinerU is canonical**: `document.<ext>` with the registry's canonical extension, never the user's name. | 4.1 rejects `/ \ :` and control characters (D18) and sniffs content but routes by extension (D17). A Mac name with a colon would be a 400. The user's name is not MinerU's business. |
| S4 | **Always send an explicit tier for PDFs and images**: today's "auto" (`tier: null`) becomes the best tier `/v1/tiers` lists, in the order standard → basic → flash. **Omit `tier` for native documents** (Office, HTML, CSV, ...). | An omitted tier now silently falls back to Basic or Flash on a server without Standard (D14). `advanced` + `.docx` was accepted and never ran (D14). |
| S5 | **Never send** `include_model_output`, `ocr_mode: null`, `page_range: null`, `client_file_id`, `file_id`, or any `output_formats` other than `["default"]`. | Each is a 400 (D19, D21). |
| S6 | **Map the "server forgot it" answers to the existing recover-by-reupload path** (`MINERU_FORGOTTEN_ID_CODES` in `errors.ts`): 404 `task_not_found`, `file_not_found`, `upload_not_found`, and 410 `upload_expired` → create the task again and upload again (bounded, as today). A plain FastAPI 404 `{detail:"Not Found"}` on `POST /v1/tasks` means "the server speaks another protocol": **retryable with backoff and reported to tool health, not permanent**, so jobs caught in the cutover window succeed once the URL points at 4.1. | Restart amnesia (spike §8) and the cutover window (S9). |
| S7 | **Follow `upload.url` and `result_url` only on the configured MinerU origin** (`isSameMineruOrigin` in `config.ts`) and attach the key only there; use the returned `upload.headers` verbatim. | ADR-0068 spirit and the docs' own rule; the URLs come from MinerU's answer. |
| S8 | **Parse failures**: every cause is `files[].error.code = parse_failed`; only `message` differs. Map known message prefixes to our existing extraction failure reasons (`PDFium: Incorrect password error` → encrypted, `PDFium: Data format error` → corrupt, `Unsupported file type` → unsupported, `Invalid XLSX package` → unreadable), else a generic failure. Never show `message` to users (D12). | D6. Fixtures hold every message seen. |
| S9 | **Cutover by URL flip, two MinerU servers side by side**: 4.1.7 runs as a new unit on a new port while 4.0.12 keeps :8002; each app switches when it runs the new client, through `MINERU_API_URL` in its `admin_config` (live, no restart; set it through the admin
System settings or `PUT /api/admin/config`, since direct production SQL is refused by the permission classifier). 4.0.12 stays up until production has been stable for a week. | Rollback is "flip the URL back and redeploy the previous release". Both servers fit on GPU1 (15.1 of 48.9 GB used; 4.1 needs up to 2.6 GB VRAM and ~6 GB RAM). |
| S10 | **New block types** `equation`, `chart`, `page_footnote` (spike §9.2): render `equation` as a display block fenced with `$$` (keep `\tag`); render `chart` like an image figure (caption into the prompt text, its JPG kept as a bundle figure); render `page_footnote` as a footnote paragraph, and on slide pages (`kind: "slide"`) as "Speaker notes: ..." (owner to confirm the wording). Keep `equation_interline` as an alias. | Today `chart` and its caption vanish from the prompt text and display math arrives unfenced. |

## 3. Before any code: two checks (the build session runs them)

1. **Is S10 a 4.1 change or a production bug today?** Run `fixtures/inputs/` paper PDF (synthetic, no user data) through production 4.0.12 on :8002 once
   with the old protocol (key from `/home/alfydesign/apps/mineru4/mineru4.env`, never printed). If 4.0.12 also emits `equation`/`chart`/`page_footnote`,
   Task C is a live bug: ship it first, on its own, before the protocol work. This uses the production MinerU with a synthetic file: **ask the owner first**.
2. **Other callers.** `grep -rn` `scripts/` and `docs/` for `/v1/uploads`, `parse/jobs`, `mineru4.service`, `:8002`, `MINERU_API_URL` (e.g.
   `scripts/backfill-extractions.ts`, `scripts/verify-live-extraction-types.ts`, deploy docs, `.env.example`, `docs/uploads.md`, README). Each goes into a task below.

## 4. Tasks and file ownership (disjoint, so a task never edits another's files)

Each task: failing test first, small commits, targeted tests while iterating, `scripts/gates.sh agent` once at the end. Fixtures for tests come
from `docs/plans/mineru-4-1/fixtures/`: Task A copies a curated subset (create receipts, PUT receipts, snapshots of every status, cancel receipts,
error bodies, health/tiers/usage, three small ZIPs) into `src/lib/server/services/mineru/testing/fixtures-4.1/`; the others read from there.

**Task A: the wire** (`mineru/schemas.ts`, `mineru/client.ts`, `mineru/errors.ts`, `mineru/testing/fake-server.ts`, their tests, the fixtures folder).
- Schemas for `CreateTaskResponse`, `TaskDetailResponse`, `CancelTaskResponse`, `UploadFileResponse`, the file object (`id`, `file_name`), the
  error body without `type`, and FastAPI `{detail: string | array}`. Health reads `features.task_output_formats` and `sources`. Tolerate extra fields.
- `MineruClient`: replace `createUpload` / `putUploadContent` / `completeUpload` / `createJob` / `getJob` / `pollJob` / `cancelJob` with `createTask`,
  `putTaskFile` (streamed from disk, `Content-Length` set, headers from the receipt), `getTask`, `pollTask`, `cancelTask`; `downloadFile` takes a
  `result_url` (S7). Keep `getHealth` / `getTiers` / `getUsage`, `retryAfterMs`, the secret redaction and body truncation.
- `errors.ts`: the status/code table in spike §9.1 (`upload_size_mismatch` is 400, `job_*` → `task_*`, `quality_tier_unavailable` as 400
  `invalid_request` with `param: "tier"`, `409 task_already_terminal` swallowed on cancel, 503 codes retryable, S6, S8).
- Fake server: the 4.1 protocol including the hash cache, `waiting-file` → `pending` → `running` → `completed|failed|canceled`, `partial` tasks,
  cancel semantics (D24), and a "restart" switch that forgets everything (spike §8).

**Task B: the flow** (`extraction/extractors/mineru4.ts`, `mineru/tier-policy.ts`, `mineru/capabilities.ts`, `mineru/config.ts`, their tests,
`mineru/integration.test.ts`, `mineru/upload-to-citation.e2e.test.ts`). Starts after Task A's client interface is committed.
- Per chunk: create (S2, S3, S4, S5) → PUT if `upload` present → poll → on `completed` download the ZIP into the existing
  `openMineruResultZip` / `writeMineruParseBundle` path → on `failed` S8 → on forgotten ids S6. Store the task id and file id where the job id and
  file ids live today (no migration if the columns are generic; if a migration is needed it is additive only).
- `decideTier`: resolve "auto" to an explicit tier (S4); an explicit tier the server lacks is a 400 with `param: "tier"`, which must not loop.
- `capabilities.ts`: `task_output_formats`; backend version `4.1.x` passes every "≥ 4" check; the upload-format gate stays open for 4.1.
- Poll deadline: the first Standard job after a MinerU start takes ~8 s and the first Basic ~10 s more (spike §5); keep the existing deadline if
  it is above a minute.

**Task C: the renderer** (`mineru/result.ts`, `mineru/bundle.ts`, their tests, `mineru/outline.test.ts`, `mineru/chunk-plan.test.ts`). Independent of A
and B; may ship first (§3.1). S10, plus: `chart` images become bundle figures (today only `image` blocks do), `stats.unknownTypes` is empty for the
whole 4.1 capture corpus, and `renderMineruMarkdown` matches MinerU's own `markdown.md` for the samples that differed only by these blocks (anchors stay
unrendered, as documented).

**Task D: the box and the docs** (orchestrator or one agent with box access; no app code).
- New production unit `mineru41.service`, copied from `mineru4.service`: venv `/home/alfydesign/apps/mineru4/.venv-4.1.7` (already installed),
  a fresh short MINERU_HOME (e.g. `/home/alfydesign/m41p`; seed `telemetry_state=disabled` exactly as spike §2 did, and set
  `MINERU_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `MINERU_MODEL_SMALL_BACKEND=torch`), models via
  `mineru-kit models download --tier standard --small-backend torch` (then delete the unused GGUF VLM weights), its own upload dir (two servers must not
  share one: `.mineru-service.lock`), port **:8004** on 127.0.0.1, `--tier standard --concurrency 4`, `MemoryMax=32G`, CUDA_VISIBLE_DEVICES=1,
  `EnvironmentFile=/home/alfydesign/apps/mineru4/mineru4.env` and `--api-key ${MINERU4_API_KEY}` (the key the apps already hold; `--api-key` has no
  env fallback in 4.1.7). Never run `systemctl status` or `ps` unfiltered on it (argv shows the key).
- Docs: README / `docs/uploads.md` / `.env.example` / deploy docs that name 4.0, `:8002` or `mineru4.service`.
- After a week of stable production: disable `mineru4.service`, then remove the spike leftovers (`/root/mineru41-spike`, `uploads-4.1.7`,
  `/home/alfydesign/m41s`, `mineru41-spike.env`). Keep the 4.0.12 venv until the owner says otherwise.

## 5. Verification

- Unit and contract tests on the captured fixtures (Task A), the fake-server flow tests including restart and cancel (Tasks A and B), the renderer
  corpus test (Task C). Fallow stays at its baseline: removed 4.0 schemas and types must leave no unused export behind.
- `scripts/gates.sh agent` per task; the release gate on the exact merge commit before production. Name the upload-related e2e specs in the gate
  (find them with `grep -ln "upload" tests/e2e/*.spec.ts`).
- Live on ai.dev, through the app, after its URL points at :8004: a text PDF, the scan PNG, DOCX, XLSX, PPTX, HTML, CSV, the Hungarian-named PDF, a corrupt
  PDF (the right failure sentence), a re-extract, a cancel, and **`systemctl restart mineru41` in the middle of a job** (the job must recover by
  re-upload, not fail). Uploads need the `Origin` header (memory: alfyai-staging-verify-harness). Read the app's error journal afterwards.

## 6. Cutover runbook (production only after the owner's own "deploy" in their latest message)

1. Task D's unit up on :8004, health 200, one synthetic parse through it with curl.
2. ai.dev: deploy the merged commit, then set its `MINERU_API_URL` to `http://127.0.0.1:8004`; run §5's live list.
3. Production: release gate green on the exact commit; push that SHA to `main` (never a branch name); fast-forward the production app-root checkout;
   `deploy.sh`; then set production's `MINERU_API_URL` to `http://127.0.0.1:8004` straight away. Extraction jobs that start in the seconds between the
   two steps meet the old server and are retried (S6). Check: release link, service active, health, one real upload by the owner.
4. **Rollback**: set `MINERU_API_URL` back to `http://127.0.0.1:8002` (4.0.12 is still running) and deploy the previous release. Jobs in between retry.
5. A week later: Task D's clean-up.

## 7. Non-goals

URL inputs, `docx`/`html`/`latex` outputs, `middle_json.json` (nothing reads it), the Router, `file-parse-server`, `--preload-models` (optional
experiment only), changing how uploads look in the UI.

## 8. Open items for the owner

- S10's "Speaker notes:" label for PPTX notes. It is prompt text, so English only (ruling 79, `chat-turn/AGENTS.md`).
- §3.1: OK to run one synthetic PDF through production 4.0.12?
- Whether Task C ships before the protocol work if §3.1 shows production already loses charts.
