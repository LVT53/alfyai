# Phase 2 + Phase 4 — MinerU 4.x V1 client and structured results

Implementation spec. Target repo: `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai`.
Audience: parallel dev sub-agents in separate worktrees, then an adversarial reviewer.

**Authority order.** `docs/plans/mineru4/phase0-local-spike.md` (branch `mineru4/p0-fixtures`) and the fixtures
under `fixtures/mineru-v1/` beat every upstream MinerU document. Where this spec and the upstream Draft
schema disagree, the fixture wins. Where this spec and Phase 0 disagree, Phase 0 wins — report it.

**Prerequisites, in order.**

| # | Prerequisite | Why |
| --- | --- | --- |
| 1 | Phase 1 merged (`mineru4/p1`) | `getIntakeRoute` / `getIntakeTierHint` are the tier inputs |
| 2 | Phase 3 merged (`mineru4/p3`) | `DocumentExtractor`, the ledger, `extraction/persist.ts`, `extractors/registry.ts` |
| 3 | **`mineru4/p0-fixtures` merged into the integration branch** | every Phase 2 test is fixture-driven; `fixtures/mineru-v1/` (1.5 MB) must exist in the worktree. Merge it first, alone, before any slice branches. |

Integration branch: `mineru4/p24`. Slice branches `mineru4/p24-s0` … `mineru4/p24-p4c`, one worktree each,
nothing pushed.

**Toolchain.** Homebrew `node@22` (`/opt/homebrew/opt/node@22/bin`) for every `npm` / `vitest` command;
Node 26 breaks `better-sqlite3`. Stage files by explicit path; never `git add -A`.

---

## 0. Decisions, stated once

| # | Decision | Why |
| --- | --- | --- |
| D1 | `output_formats: ["markdown","middle_json","structured_content","zip"]`, and the client downloads **only the zip** | Requesting a format costs server-side generation, not transfer. This list is byte-for-byte what every recorded fixture requested, so the fixtures *are* the contract. §2.6 has the byte table. |
| D2 | The prompt text is **built from `structured_content` blocks**, not `markdown.md` | A 40-line renderer reproduces `markdown.md` byte-identically for 7 of 9 fixtures and differs only by `<a id>` anchors for HTML/EPUB. `markdown.md` carries no page boundaries, and Phase 4 needs them. §4.3. |
| D3 | `document-extraction.ts` is **deleted**, not reduced | Phase 3 already owns the direct-text branch in `extraction/extractors/direct-text.ts`. Keeping a second copy of the same 15 lines is the drift this whole plan exists to end. §2.12. |
| D4 | Tier is **always explicit or deliberately omitted**, never `null`, and never sent before `/v1/tiers` has been consulted | `tier: null` is a 400; `tier: "standard"` on a server that lacks it is a 400 `invalid_request`, not a 503; PDF/image with `tier` omitted on a flash-only server is a 503 `quality_tier_unavailable`. Only a capability read makes all three impossible. §2.7. |
| D5 | `ocr_mode` is **omitted** when the configured value is `auto` | `ocr_mode: null` is a 400 despite the docs. Omitting keeps the request body identical to the recorded fixtures. §2.7. |
| D6 | `artifacts.binary_hash` is reused verbatim as `sha256sum` | Verified SHA-256 lowercase hex, matching the server's `^[a-f0-9]{64}$`. §2.8. |
| D7 | Recovery after a MinerU restart is **re-upload by hash**, never id persistence | Every upload/file/job/output id 404s after a restart; bytes survive, so a re-`POST /v1/uploads` with the known sha returns `status: "completed"` instantly with a **new** `file_id`. |
| D8 | The parse bundle lives on disk at `data/knowledge/<userId>/<sourceArtifactId>.parse/`, not in the DB | Same tree as the bytes, same account-deletion `rm -rf`, no BLOB columns. §4.2. |
| D9 | **One slice (S0) owns every hot config and schema file for both phases** | `env.ts`, `config-store.ts`, `admin-config-registry.ts`, `i18n/settings.ts`, `schema.ts`, `drizzle/**` and `drizzle/meta/_journal.json` are each touched by Phase 2 *and* Phase 4. One owner, one journal edit, two migrations in that owner's hands. |
| D10 | MinerU config keys become **dual-registered**: they keep their Integrations page rows *and* gain `AdminConfigKeySpec` entries | Today they are "path B" and skip `validateAdminConfigValue` entirely — `MINERU_TIMEOUT_MS: "abc"` is stored in `admin_config` and silently never applied. `ATLAS_PIPELINE` is the existing precedent for a key that is in `NAMED_PAGE_KEYS` *and* has a spec (`AdvancedPage.svelte:41-43` filters on `pageForKey(spec.key) === "advanced"`, so it renders once). §2.10. |
| D11 | Page citations are emitted only for `page_count_kind ∈ {physical, slide, sheet, spine}` | DOCX reports `page_count: 1, kind: "declared"` for a four-heading document and CSV/HTML report `logical`. Citing "p. 1" there is a lie. §4.7. |
| D12 | No automatic backfill of existing library documents | They stay valid and readable; `metadata.extractionProducer` is absent on every legacy row, which is the identifying marker. A user-initiated "Re-extract" is the only path. §4.10. **Decided (2026-09-22):** an *operator-run* backfill exists after all — `scripts/backfill-extractions.ts`, run once by hand after the production cutover, not automatic and not triggered by anything in the app. It walks every `source_document`, not just the ones a user happens to click "Re-extract" on, through the exact same service path. See [docs/uploads.md](../../uploads.md#backfilling-a-library-after-a-mineru-upgrade). |

---

## 1. Recorded reality — the digest a reviewer can check against

### 1.1 Endpoints actually used by this client

| Method | Path | Used for |
| --- | --- | --- |
| GET | `/v1/health` | version, `features.output_formats`, `features.webhook`, `features.sources` |
| GET | `/v1/tiers` | the tier allowlist (`data[].id`) |
| GET | `/v1/usage` | `limits.max_file_size_bytes`, `max_pages_per_file`, `access_level` (admin card only) |
| POST | `/v1/uploads` | create upload, with `sha256sum` → dedupe hit returns `status: "completed"` |
| PUT | `/v1/uploads/{id}/content` | stream bytes; **200 with an empty body, `content-type` absent** |
| POST | `/v1/uploads/{id}/complete` | finalise; this is where a wrong sha surfaces as 400 `file_hash_mismatch` |
| POST | `/v1/parse/jobs` | 202 + `job_id`; a 202 proves nothing |
| GET | `/v1/parse/jobs/{id}` | poll to terminal, then check `files[0].status` and `files[0].error` |
| DELETE | `/v1/parse/jobs/{id}` | cancel; 200 on a running job, 409 `job_already_terminal` on a finished one |
| GET | `/v1/files/{id}/content` | download the zip. Streams 200, **never 302**, always `application/octet-stream`, no `Content-Disposition` |

Never used: `/v1/models`, `/v1/files` (list), `GET /v1/uploads/{id}`, `POST /v1/uploads/{id}/cancel`,
`DELETE /v1/files/{id}`, `callback`, `page_range`, `url`/`inline`/`local` sources.

### 1.2 Facts the client is built on

1. `output_files` lists **all seven** format keys with `null` for the unrequested ones. Iterating
   `Object.entries` without a null check crashed the spike's own harness.
2. A `202` at job create means nothing. Unknown `file_id` → job fails later with file-level
   `engine_error`/`parse_failed`. Bad `page_range` on a non-PDF → file-level `page_range_invalid`.
3. Two error envelopes: MinerU's `{error:{type,code,message,param}}` and FastAPI's `{detail:[…]}` on 422.
   Branch on `code`, not on HTTP status.
4. `feature_requires_api_key` changes to `unsupported_output_format` when a valid key is present, for the
   same input. It never means "add a key and retry".
5. `PUT .../content` returns **200 even for the wrong bytes**; `413 upload_size_mismatch` only for a byte-count
   mismatch, and a hash mismatch only surfaces at `complete`.
6. Re-uploading a known sha mints a **new** `file_id`. Bytes persist across restarts; identifiers do not.
7. `parse.model_used` is `null` on every completed file. Do not trust it.
8. `tiers[].current_model` does not join to `models[].id` (`hybrid-basic` vs `Hybrid-Basic`).
9. `GET /v1/health` stays public under `--api-key`; everything else is `401 invalid_api_key`.

### 1.3 `structured_content` — the real shape (all 9 inputs)

```
{ pages: [ { page_idx: 0, blocks: [ … ] } ],
  metadata: { file_suffix, producer:{name,version}, document:{…sparse…} },
  extensions: { mineru:{tier,parse_mode}, docvortex_layout?:{version,pages:[{page_idx,width_pt,height_pt}]} },
  is_full_document: true }
```

Block: `type`, `content` (**always a Markdown string**), and optionally `bbox` (flat array of four 0..1
floats; **key absent** for Office/HTML/EPUB/CSV, never `null`), `level`, `anchor`, `captions` (plural,
array of `{bbox?, content}`), `footnotes` (plural), `image_source` (a bare string).

Observed types over 71 blocks / 9 documents:

| type | count | note |
| --- | --- | --- |
| `text` | 23 | |
| `paragraph_title` | 21 | carries `level` |
| `table` | 9 | GFM Markdown string; HTML exists only in `middle_json` |
| `list` | 4 | one string, `- ` lines joined with `\n` |
| `image` | 3 | `content` is `""`; the payload is `image_source` + `captions` |
| `header` / `footer` / `page_number` | 3 each | **PDF only**, and already excluded from `markdown.md` |
| `doc_title` | 2 | HTML/EPUB (and PDF at `flash`) |

No `id`, no `locator`, no `page_number` field, no `page_size`, no `spans`, no `schema` marker.
Page number = array index + 1.

### 1.4 Per-format facts that change behaviour

| input | `extensions.mineru.tier` in a `basic` job | `parse_mode` | `page_count` / kind | `bbox` | headings |
| --- | --- | --- | --- | --- | --- |
| pdf | **basic** | txt | 3 / `physical` | yes | all `paragraph_title` level 2 |
| png / jpg | **basic** | **ocr** | *absent* (`metadata.document` is `{}`) | yes | level 2 |
| csv | **flash** | txt | 1 / `logical` | **absent** | none |
| html | **flash** | txt | 1 / `logical` | absent | `doc_title` 1, `paragraph_title` 2 and 3 — faithful |
| docx | **flash** | txt | 1 / `declared` | absent | **level +1 offset**, titles wrapped in `**…**` |
| xlsx | **flash** | txt | 2 / `sheet` | absent | sheet names → level 2 |
| pptx | **flash** | txt | 2 / `slide` | absent | slide titles → level 2 |
| epub | **flash** | txt | 1 / `spine` | absent | faithful |

Two traps the parser must survive:

- **PNG/JPEG report `metadata.file_suffix: "pdf"`** (the image is wrapped in a PDF internally) and
  `metadata.document` is `{}`. Never derive the input format from `file_suffix`.
- **The same PDF parsed at `flash` has a different block structure than at `basic`**: 26 blocks vs 22,
  a `doc_title` at level 1 that `basic` does not produce, two `header` blocks per page instead of one,
  and the figure caption arrives as a sibling `text` block instead of inside the image's `captions`.
  Tier changes structure, not just quality.

### 1.5 Unverified — treat as unknown, not absent

`standard` and `advanced` (VLM) output was **not captured**. Everything below is unverified and must not
be assumed by any parser branch:

- whether `standard`/`advanced` emit block types never seen here (`equation_interline`, `chart`, `code`,
  `algorithm`, `index`, `page_aside_text`, `page_footnote`);
- whether `content` stays a Markdown string or becomes a richer shape;
- whether `parse.model_used` becomes non-null;
- multi-column layout, rotated pages, scanned/skewed input, equations, code blocks, charts, a table of
  contents — **no fixture exercises any of them**;
- `partial` job status (every recorded job was single-file);
- `429 rate_limit_exceeded` and `413 file_too_large` were never triggered.

**Parser rule that follows:** an unknown `type` is rendered as its `content` string (or skipped when
`content` is empty) and treated as an **atomic, unsplittable** block by the chunker. It is never an error.
A counter of unknown types is written into the bundle manifest and logged once per job so the GPU-box
checklist (§8) has something to read.

---

## 2. Phase 2 — the MinerU V1 client

### 2.1 Module layout

```
src/lib/server/services/mineru/
  schemas.ts        zod schemas mirroring every response we parse          (no I/O)
  errors.ts         MineruApiError + mapMineruError → Phase 3 taxonomy     (no I/O)
  client.ts         MineruClient: uploads, jobs, downloads                 (fetch only)
  capabilities.ts   cached /v1/health + /v1/tiers + /v1/usage              (uses client)
  result.ts         zip reader, renderers, parsed result model             (jszip, node:fs)
  bundle.ts         parse-bundle writer/reader/remover                     (node:fs)     [Phase 4]
  config.ts         resolveMineruConfig() from getConfig()                 (no I/O)
  testing/fake-server.ts   in-process fetch-shaped fake V1 server
src/lib/server/services/extraction/extractors/mineru4.ts   the DocumentExtractor (thin)
```

`extractors/mineru4.ts` is the only file outside `services/mineru/` that Phase 2 adds, and the only place
Phase 3's contracts are imported. This keeps Phase 3's `extraction/boundary.test.ts` green: nothing under
`extraction/read-model.ts` or `job-ledger.ts` can reach `jszip` or `node:fs` through the extractor, because
`extraction/index.ts` already lazy-`import()`s the worker.

`jszip ^3.10.1` is already a dependency; `src/lib/server/services/chatgpt-import/parser.ts:375-396` is the
existing server-side `JSZip.loadAsync` pattern to copy.

### 2.2 `config.ts`

```ts
export interface MineruConfig {
	readonly baseUrl: string;              // MINERU_API_URL, trailing slash stripped
	readonly apiKey: string;               // MINERU_API_KEY, "" = anonymous
	readonly defaultTier: "auto" | "flash" | "basic" | "standard" | "advanced";
	readonly ocrMode: "auto" | "txt" | "ocr";
	readonly jobTimeoutMs: number;         // whole-job deadline
	readonly pollMinMs: number;
	readonly pollMaxMs: number;
	readonly requestTimeoutMs: number;     // control-plane calls
	readonly transferTimeoutMs: number;    // PUT bytes / GET zip
	readonly capabilitiesTtlMs: number;
	readonly bundleMaxBytes: number;       // Phase 4
	readonly structureChunking: boolean;   // Phase 4
}

/** Pure projection of the runtime config. No I/O, no caching. */
export function resolveMineruConfig(config = getConfig()): MineruConfig;

/** `${baseUrl}${path}` with exactly one slash. Throws on a non-absolute baseUrl. */
export function mineruUrl(config: MineruConfig, path: `/v1/${string}`): string;

/**
 * The same-origin rule for the API key. `upload_url` is a server-supplied
 * absolute URL; we must never forward the Authorization header to an origin
 * that is not MINERU_API_URL's. Compares protocol + hostname + port only.
 */
export function isSameMineruOrigin(config: MineruConfig, url: string): boolean;
```

**Same-origin rule, normative.** `MineruClient` attaches `Authorization: Bearer <apiKey>` **only** when the
request URL passes `isSameMineruOrigin`. `putUploadContent` calls it on the server-supplied `upload_url`
before sending a byte; a mismatch throws `MineruApiError { code: "protocol_untrusted_upload_url" }` →
taxonomy `protocol`, and the URL is logged (host only, never the key). Do not reuse
`services/connections/host-locality.ts:assertPublicHttpsUrl` — MinerU is deliberately loopback/private and
that guard rejects exactly the legitimate case.

### 2.3 `schemas.ts` — zod shapes, mirrored from the fixtures

Every schema is `.passthrough()` on objects we do not own, because a minor server upgrade must not turn a
working parse into a `protocol` failure. Every schema is exercised against the recorded fixtures in
`schemas.test.ts`. "A 200 is not automatically valid": every response body in §2.5 goes through one of these
before any field is read.

```ts
import { z } from "zod";

export const mineruSha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const mineruErrorDetailSchema = z.object({
	type: z.string(),                       // invalid_request_error | permission_error
	                                        // | authentication_error | engine_error
	code: z.string().nullish(),
	message: z.string(),
	param: z.string().nullish(),
});
export const mineruErrorResponseSchema = z.object({ error: mineruErrorDetailSchema });

/** FastAPI's own 422 envelope — a different shape entirely. */
export const fastapiValidationErrorSchema = z.object({
	detail: z.array(z.object({
		loc: z.array(z.union([z.string(), z.number()])).optional(),
		msg: z.string().optional(),
		type: z.string().optional(),
	}).passthrough()),
});

export const mineruHealthSchema = z.object({
	status: z.string().default("ok"),
	version: z.string(),
	features: z.object({
		webhook: z.boolean().default(false),
		output_formats: z.array(z.string()).default([]),
		sources: z.array(z.string()).default([]),
	}).passthrough().optional(),
}).passthrough();

export const mineruTierSchema = z.object({
	id: z.enum(["flash", "basic", "standard", "advanced"]),
	description: z.string(),
	current_model: z.string().nullish(),     // DO NOT join this to /v1/models[].id
}).passthrough();
export const mineruTierListSchema = z.object({
	object: z.string().optional(),
	data: z.array(mineruTierSchema),
}).passthrough();

export const mineruUsageSchema = z.object({
	object: z.string().optional(),
	access_level: z.enum(["anonymous", "registered"]).optional(),
	limits: z.object({
		max_pages_per_file: z.number().nullish(),
		max_file_size_bytes: z.number().nullish(),
		max_files_per_job: z.number().nullish(),
		max_concurrent_jobs: z.number().nullish(),
		max_file_retention_days: z.number().nullish(),
	}).passthrough().optional(),
}).passthrough();

export const mineruFileObjectSchema = z.object({
	id: z.string(),
	object: z.literal("file").optional(),
	bytes: z.number(),
	created_at: z.number(),
	expires_at: z.number().nullish(),
	filename: z.string(),
	purpose: z.enum(["parse", "parse_output", "input_image"]),
	sha256sum: z.string().nullish(),
}).passthrough();

export const mineruUploadSchema = z.object({
	id: z.string(),
	object: z.literal("upload").optional(),
	bytes: z.number(),
	created_at: z.number(),
	expires_at: z.number(),
	filename: z.string(),
	purpose: z.string().optional(),
	mime_type: z.string(),
	sha256sum: z.string().nullish(),
	/** NOTE the double-l spelling: the server says "cancelled" here. */
	status: z.enum(["pending", "completed", "cancelled", "expired"]),
	upload_url: z.string().nullish(),
	upload_method: z.literal("PUT").nullish(),
	upload_headers: z.record(z.string(), z.string()).nullish(),
	file: mineruFileObjectSchema.nullish(),
}).passthrough();

export const mineruOutputFileRefSchema = z.object({
	file_id: z.string(),
	bytes: z.number(),
}).passthrough();

/** Every key is present on a terminal job; unrequested formats are null. */
export const mineruOutputFilesSchema = z.object({
	markdown: mineruOutputFileRefSchema.nullish(),
	middle_json: mineruOutputFileRefSchema.nullish(),
	structured_content: mineruOutputFileRefSchema.nullish(),
	html: mineruOutputFileRefSchema.nullish(),
	latex: mineruOutputFileRefSchema.nullish(),
	docx: mineruOutputFileRefSchema.nullish(),
	zip: mineruOutputFileRefSchema.nullish(),
}).passthrough();

export const mineruJobFileResultSchema = z.object({
	file_id: z.string().nullish(),
	name: z.string(),
	/** "" on a queued job — NOT null. Normalises to "1-3" when terminal. */
	page_range: z.string(),
	status: z.enum(["queued", "running", "completed", "failed"]),
	parse: z.object({
		model_used: z.string().nullish(),    // null on every observed completed file
		duration_ms: z.number().nullish(),
		parser_version: z.string().nullish(),
	}).passthrough().nullish(),
	output_files: mineruOutputFilesSchema.nullish(),
	error: mineruErrorDetailSchema.nullish(),
}).passthrough();

export const mineruJobSchema = z.object({
	job_id: z.string(),
	status: z.enum(["queued", "running", "completed", "partial", "failed", "canceled"]),
	created_at: z.string(),
	started_at: z.string().nullish(),
	finished_at: z.string().nullish(),
	/** The JOB tier. Lies about what parsed the file — read extensions.mineru.tier. */
	tier: z.enum(["flash", "basic", "standard", "advanced"]),
	output_formats: z.array(z.string()),
	access_level: z.enum(["anonymous", "registered"]),
	progress: z.object({
		completed: z.number().default(0),
		failed: z.number().default(0),
		total: z.number().default(0),
	}).passthrough().nullish(),
	files: z.array(mineruJobFileResultSchema),
	links: z.object({ self: z.string().optional(), cancel: z.string().optional() })
		.passthrough().optional(),
}).passthrough();

export const mineruJobCancelSchema = z.object({
	job_id: z.string(),
	status: z.literal("canceled").default("canceled"),   // ONE l here
	canceled_at: z.string(),
}).passthrough();
```

> **Spelling trap.** `UploadResponse.status` uses `"cancelled"` (two l) and `JobCancelResponse.status` uses
> `"canceled"` (one l), in the same API. Both spellings are pinned by `schemas.test.ts`. Phase 3's ledger
> vocabulary is `canceled`; do not "fix" the upload enum.

`structured_content` schemas live in `result.ts` (§4.1) because they are the Phase 4 parse model.

### 2.4 `client.ts`

```ts
export interface MineruClientDeps {
	config: MineruConfig;
	/** Injected for tests. Defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Injected for tests. Defaults to node:fs createReadStream + stat. */
	fileReader?: MineruFileReader;
	now?: () => number;
}

export interface MineruFileReader {
	stat(pathAbsolute: string): Promise<{ size: number }>;
	/** A fresh stream per call — the client may retry a PUT. */
	stream(pathAbsolute: string): ReadableStream<Uint8Array>;
	/** Streams the file through a sha256 digest without buffering it. */
	sha256(pathAbsolute: string): Promise<string>;
}

export interface CreateUploadInput {
	filename: string;
	bytes: number;
	mimeType: string;
	sha256sum: string;          // always sent; dedupe is free and is the restart recovery path
	signal: AbortSignal;
}

export interface CreateJobInput {
	fileId: string;
	tier?: "flash" | "basic" | "standard" | "advanced";   // omitted key when undefined
	ocrMode?: "txt" | "ocr";                              // omitted when "auto"
	outputFormats: readonly string[];
	signal: AbortSignal;
}

export class MineruClient {
	constructor(deps: MineruClientDeps);

	getHealth(signal: AbortSignal): Promise<MineruHealth>;
	getTiers(signal: AbortSignal): Promise<MineruTier[]>;
	getUsage(signal: AbortSignal): Promise<MineruUsage>;

	/** POST /v1/uploads. status "completed" ⇒ dedupe hit, `file` is populated. */
	createUpload(input: CreateUploadInput): Promise<MineruUpload>;

	/**
	 * PUT upload.upload_url with the file streamed from disk.
	 * NEVER reads the file into memory: duplex: "half" + a Node Readable →
	 * Web ReadableStream, with Content-Length set from the stat size.
	 * Enforces isSameMineruOrigin before sending.
	 * Returns void — the server answers 200 with an EMPTY body and no content-type.
	 */
	putUploadContent(input: {
		upload: MineruUpload;
		filePathAbsolute: string;
		signal: AbortSignal;
	}): Promise<void>;

	/** POST /v1/uploads/{id}/complete with { sha256sum }. */
	completeUpload(input: { uploadId: string; sha256sum: string; signal: AbortSignal }):
		Promise<MineruUpload>;

	/** POST /v1/parse/jobs. Resolves on 202. A 202 proves nothing (see pollJob). */
	createJob(input: CreateJobInput): Promise<MineruJob>;

	getJob(input: { jobId: string; signal: AbortSignal }): Promise<MineruJob>;

	/** DELETE /v1/parse/jobs/{id}. Swallows 404 and 409 — both mean "nothing to cancel". */
	cancelJob(input: { jobId: string; signal: AbortSignal }): Promise<void>;

	/**
	 * GET /v1/files/{id}/content, streamed to `destinationPathAbsolute`.
	 * Content-Type is ALWAYS application/octet-stream — never sniff, the caller
	 * knows what it asked for. Verifies the byte count against `expectedBytes`.
	 */
	downloadFile(input: {
		fileId: string;
		destinationPathAbsolute: string;
		expectedBytes: number;
		signal: AbortSignal;
	}): Promise<{ bytes: number }>;
}
```

**Normative transport rules.**

1. Every call composes the caller's `signal` with an `AbortSignal.timeout(requestTimeoutMs)` — or
   `transferTimeoutMs` for `putUploadContent` / `downloadFile` — via `AbortSignal.any([...])`.
2. Every JSON response is `await response.json()` inside a `try`, then `schema.parse(...)`. A JSON parse
   failure or a zod failure is `protocol` (retryable), with `details.zodIssues` truncated to 3 issues.
3. A non-2xx response body is read once as text, then tried against `mineruErrorResponseSchema`, then
   `fastapiValidationErrorSchema`, then treated as an opaque string. §2.9 maps the result.
4. No response is ever retried inside the client. Retries are the ledger's job (Phase 3 §3.1). The client's
   only internal loop is the poll loop.
5. Logging prefix stays `[MINERU]`, matching today's `document-extraction.ts`. Never log the API key, never
   log document text, never log more than 300 chars of an error body.

### 2.5 The exact request/response sequence

Values are from `fixtures/mineru-v1/pdf/` and `fixtures/mineru-v1/docx/` unless noted.

| # | Call | Request body (real field names) | Response (real field names) | Client action |
| --- | --- | --- | --- | --- |
| 1 | `GET /v1/health` (cached) | — | `{status:"ok",version:"4.0.4",features:{webhook:false,output_formats:["markdown","middle_json","structured_content","zip"],sources:["file_id","url","inline"]}}` | assert every requested format is in `features.output_formats`, else `tier_unavailable`-class fail-fast (`unsupported_output_format`) |
| 2 | `GET /v1/tiers` (cached) | — | `{object:"list",data:[{id:"flash",…},{id:"basic",…}]}` | resolve the tier (§2.7). Desired tier absent → throw `tier_unavailable` **before** any bytes move |
| 3 | `POST /v1/uploads` | `{filename:"sample.pdf",bytes:6727,mime_type:"application/pdf",purpose:"parse",sha256sum:"5637ad…2bd"}` | **dedupe hit:** `{id:"upload_49ec…",status:"completed",upload_url:null,upload_method:null,file:{id:"file-10c3…",…}}` | `status==="completed"` → take `file.id`, **skip 4 and 5** |
| 3′ | same | `{…,"filename":"sample.docx",…}` | **fresh:** `{id:"upload_7e33…",status:"pending",upload_url:"http://127.0.0.1:8765/v1/uploads/upload_7e33…/content",upload_method:"PUT",upload_headers:{"Content-Type":"application/vnd.…document"},file:null}` | continue to 4 |
| 4 | `PUT {upload_url}` | raw bytes, `Content-Length` = stat size, `Content-Type` from `upload_headers` | **200, empty body, no content-type** | ignore the body; a wrong-byte PUT also returns 200 |
| 5 | `POST /v1/uploads/{id}/complete` | `{"sha256sum":"e77e…602"}` | `{id:"upload_7e33…",status:"completed",file:{id:"file-b842…",…}}` | take `file.id`. 400 `file_hash_mismatch` surfaces **here**, not at 4 |
| 6 | `POST /v1/parse/jobs` | `{"files":[{"source":{"type":"file_id","file_id":"file-10c3…"}}],"output_formats":["markdown","middle_json","structured_content","zip"],"tier":"basic"}` — `ocr_mode` omitted when `auto`; no `page_range`; no `callback` | **202** `{job_id:"job_d14e…",status:"queued",tier:"basic",output_formats:[…],access_level:"anonymous",progress:{completed:0,failed:0,total:1},files:[{file_id:"file-10c3…",name:"sample.pdf",page_range:"",status:"queued",parse:null,output_files:null,error:null}],links:{self,cancel}}` | emit `ExtractionProgress{phase:"parsing", handle}` **before the first poll** |
| 7 | `GET /v1/parse/jobs/{job_id}` × N | — | terminal: `{status:"completed",started_at,finished_at,files:[{status:"completed",page_range:"1-3",parse:{model_used:null,duration_ms:1126,parser_version:"4.0.4"},output_files:{markdown:{file_id,bytes},middle_json:{…},structured_content:{…},html:null,latex:null,docx:null,zip:{file_id:"file-d3aa…",bytes:71547}}}]}` | **check `files[0].status` and `files[0].error` even when `status==="completed"`**; then null-check `output_files.zip` |
| 8 | `GET /v1/files/{zip.file_id}/content` | — | 200, `application/octet-stream`, `content-length: 71547`, no `Content-Disposition` | stream to `<bundleTmp>/result.zip`, assert byte count == `zip.bytes` |
| 9 | *(cancel path only)* `DELETE /v1/parse/jobs/{job_id}` | — | 200 `{job_id,status:"canceled",canceled_at}` / 404 `job_not_found` / 409 `job_already_terminal` | swallow 404 and 409 |

**Restart recovery path.** On a resumed attempt the ledger hands back `ExtractionHandle`. The client
re-validates it before trusting it:

| # | Call | Response after a MinerU restart | Client action |
| --- | --- | --- | --- |
| R1 | `GET /v1/parse/jobs/{handle.remoteJobId}` | `404 {error:{code:"job_not_found"}}` | do **not** fail. Fall through to R2 |
| R2 | `POST /v1/uploads` with the same `sha256sum` | `{status:"completed",file:{id:"file-<NEW>"}}` — bytes survived `--upload-dir`, the id did not | take the **new** `file_id`, re-issue step 6, emit a fresh handle |
| R3 | if R2 returns `status:"pending"` (bytes gone too) | `{status:"pending",upload_url:…}` | run steps 4–6 from the local file |
| R4 | `GET /v1/files/{outputFileId}/content` for a handle that carried one | `404 file_not_found` | same fall-through: R2 |

R1–R4 never surface `handleUnknown: true` to the ledger, because the client recovers in-band and the local
file is still on disk. `handleUnknown: true` is thrown **only** when recovery itself fails in a way that
makes the stored handle poisonous — specifically when R2 succeeds but the subsequent `createJob` fails with
`parse_failed: File … not found` (a server that is dropping ids under us). The ledger then clears the handle
and the next attempt submits fresh. This is exactly Phase 3 §6.2 scenario 6.

### 2.6 `output_formats` — the decision and its evidence

**Decision: request `["markdown","middle_json","structured_content","zip"]`; download only the `zip`.**

Requesting a format costs server-side generation, not transfer. Download bytes, measured
(`fixtures/mineru-v1/_run-summary.json`):

| input | standalone `markdown` + `structured_content` | `zip` (what we actually fetch) | zip entries |
| --- | ---: | ---: | --- |
| csv | 649 | 1 755 | 4 |
| xlsx | 1 432 | 2 533 | 4 |
| epub | 2 470 | 3 430 | 4 |
| html | 3 038 | 3 465 | 4 |
| pptx | 20 226 | **11 619** | 5 |
| docx | 22 259 | **12 879** | 5 |
| png | 44 295 | 44 301 | 4 |
| jpg | 45 455 | 46 321 | 4 |
| **pdf** | **110 286** | **71 547** | 6 |

The zip loses by at most 1 106 bytes on a tiny text document and wins by 38 739 bytes on the PDF. Three
things make the loss irrelevant and the win structural:

1. **Images exist only in the zip.** The standalone `structured_content` inlines them as
   `data:image/jpeg;base64,…` — the PDF's two images are 38 539 and 33 175 characters of base64 inside a
   75 829-byte JSON, against a 7 211-byte zipped copy that references `images/page_2_image_body_3.jpg`.
   That is the 10× bloat the spike measured.
2. **The standalone `middle_json` has no image references at all** — the `image_path` key is simply absent.
   There is no combination of standalone downloads that yields a usable figure.
3. **The zip's relative paths are the bundle's paths.** `image_source: "images/<name>.jpg"` is already
   correct relative to the bundle root; no rewriting, no URL invention.

`middle_json` is requested but not persisted (§4.2). It is free — it rides inside the zip we already fetch —
and it is the only source of HTML tables and `styles:["bold"]` if a later phase wants them. `model_output.json`
appears in the zip unrequested and is discarded.

**Unverified, and handled defensively:** whether `output_formats: ["zip"]` alone still yields a four-artifact
zip was never probed — every recorded job requested all four. Requesting all four is therefore the only
configuration with fixture backing, and the client asserts the zip contains `structured_content.json`,
failing with `protocol` (retryable) if it does not. §8 adds it to the GPU-box checklist.

### 2.7 Tier and `ocr_mode` policy

```ts
export type MineruTierId = "flash" | "basic" | "standard" | "advanced";

export interface TierDecision {
	/** undefined ⇒ omit the `tier` key entirely. NEVER null. */
	tier?: MineruTierId;
	reason: "hint-flash" | "config-explicit" | "auto-quality" | "auto-flash-only" | "hint-override";
}

export function decideTier(input: {
	intakeTierHint: "flash" | undefined;     // getIntakeTierHint(filename, mime)
	configuredTier: MineruConfig["defaultTier"];
	availableTiers: readonly MineruTierId[]; // /v1/tiers data[].id, cached
	hintedTier?: MineruTierId | null;        // the re-extract override (§4.9)
}): TierDecision;
```

Resolution order, first match wins:

| # | Condition | `tier` sent | Justification from the fixtures |
| --- | --- | --- | --- |
| 1 | `hintedTier` set (user pressed "Re-extract at …") and present in `availableTiers` | that tier | explicit user intent |
| 1′ | `hintedTier` set and **not** in `availableTiers` | — | throw `tier_unavailable` before any bytes move; a 400 `"Tier 'standard' not available in this server"` is not a 503 and must not look like an outage |
| 2 | `intakeTierHint === "flash"` (Office/HTML/CSV/EPUB/`rtf`…) | `"flash"` | these run at `flash` anyway — `extensions.mineru.tier` is `flash` for csv/html/docx/xlsx/pptx/epub inside a `basic` job. Sending it explicitly is a recorded 202 on both a `--tier basic` server (`errors/tier_flash.json`) and a `--tier flash` server (`errors/flash_explicit_flash.json`), and it removes any dependence on the server's startup tier |
| 3 | `configuredTier !== "auto"` and present in `availableTiers` | that tier | admin intent |
| 3′ | `configuredTier !== "auto"` and absent | — | throw `tier_unavailable` (same reasoning as 1′) |
| 4 | `configuredTier === "auto"` and `availableTiers` contains any of `basic`/`standard`/`advanced` | **omit the key** | this is what every recorded fixture did (`tier_requested: null`), and it resolves to the server's startup tier |
| 5 | `configuredTier === "auto"` and `availableTiers === ["flash"]` | `"flash"` | omitting on a flash-only server is a **503 `quality_tier_unavailable`** for PDF/image (`errors/flash_pdf_tier_omitted.json`, `errors/flash_image_tier_omitted.json`). Sending `flash` explicitly turns a fail into a parse |

Never send `tier: null` — `errors/flash_pdf_tier_null.json` is the same 503, and `tier: "bogus"` is a 400
with `param: "tier"`.

**`ocr_mode`.** `MINERU_OCR_MODE ∈ {auto, txt, ocr}`, default `auto`.

- `auto` → **omit the key.** `ocr_mode: null` is a 400 `invalid_request` with
  `param: "ocr_mode"` (`errors/ocr_mode_null.json`) despite the docs promising a default, and omitting keeps
  the body byte-identical to the recorded fixtures.
- `txt` / `ocr` → send verbatim.
- Any other stored value → clamp to `auto` at config-parse time and log once. The `AdminConfigKeySpec` uses
  `control: { kind: "select", options: ["auto","txt","ocr"] }`, so `validateAdminConfigValue` rejects the
  rest at the admin route (which is the whole point of D10).

Never send `page_range` (a non-PDF `page_range` is a **202 followed by a file-level failure**, and we have
no page-selection feature) and never send `callback` (`health.features.webhook === false`; it is a hard 400
even with a valid key).

### 2.8 sha256 — verified reusable

`artifacts.binary_hash` is **SHA-256, lowercase hex**, matching the server's `^[a-f0-9]{64}$` exactly.

| Where it is computed | File:line |
| --- | --- |
| Streaming, during upload receive (`createHash("sha256")` … `hash.digest("hex")`) | `src/routes/api/knowledge/upload/shared.ts:118-160` |
| Buffered helper (`hashBinaryBuffer`) | `src/lib/server/services/knowledge/store/core.ts:223-225` |
| Written on insert | `knowledge/store/core.ts:280` (`createArtifact`) |
| Written on update | `knowledge/store/core.ts:301-312` (`updateArtifactBinaryHash`) |
| Set by the two upload paths | `knowledge/store/attachments.ts:481`, `:587`, `:636` |
| Copied on fork | `conversation-forks.ts:840` |

The column is **nullable**, and the generated-file readback path has no artifact hash at all. So:

- `ExtractDocumentRequest` gains an optional `contentSha256` (Phase 3 change Δ1, §5) which the ledger fills
  from `artifacts.binary_hash` when it has one;
- when it is absent, `MineruFileReader.sha256(filePathAbsolute)` streams the file through a digest —
  one extra read pass, never a full buffer.

This is what makes D7 work: the hash is the only durable identifier across a MinerU restart.

### 2.9 Error mapping — observed → taxonomy

Source: `fixtures/mineru-v1/errors/` (77 probes) plus `errors/_202-followups.json` for the deferred
file-level failures. `errors.test.ts` is table-driven over the whole directory and **fails on any probe file
whose `code` is not in this table**, so a future fixture run cannot silently add an unmapped code.

`retryable` is what the extractor sets on `DocumentExtractionError`; it overrides
`RETRYABLE_EXTRACTION_ERROR_CODES` where they differ.

#### Transport-level (no HTTP response)

| Condition | Taxonomy code | Retryable | Note |
| --- | --- | --- | --- |
| `TypeError: fetch failed` / ECONNREFUSED / ENOTFOUND | `unavailable` | yes | MinerU down |
| caller's `AbortSignal` fired | `canceled` | no | user intent |
| our own timeout fired (`requestTimeoutMs` / `transferTimeoutMs`) | `timeout` | yes | |
| whole-job deadline `jobTimeoutMs` elapsed | `timeout` | yes | `DELETE` the remote job first |
| JSON parse failure or zod failure on a 2xx | `protocol` | yes | "a 200 is not automatically valid" |
| `upload_url` fails `isSameMineruOrigin` | `protocol` | **no** | a misconfigured/hostile server; retrying repeats it |
| downloaded zip byte count ≠ `output_files.zip.bytes` | `protocol` | yes | |
| zip lacks `structured_content.json` | `protocol` | yes | |

#### HTTP responses

| HTTP | `error.type` | `error.code` | Probe fixture | Taxonomy | Retryable |
| ---: | --- | --- | --- | --- | --- |
| 401 | `authentication_error` | `invalid_api_key` | `auth_missing_key`, `auth_invalid_key`, `auth_upload_no_key` | **`auth_failed`** (Δ6) | no |
| 403 | `permission_error` | `feature_requires_api_key` | `output_format_docx/html/latex`, `keyed_source_download`, `source_file_content_download` | `protocol` | **no** | 
| 400 | `invalid_request_error` | `unsupported_output_format` | `output_format_json/images/content_list_v2`, `keyed_output_docx/html/latex` | `protocol` | no |
| 400 | `invalid_request_error` | `invalid_request`, `param: "tier"` | `tier_invalid_tier` | `protocol` | no |
| 400 | `invalid_request_error` | `invalid_request`, message `Tier '…' not available` | `tier_standard`, `tier_advanced`, `flash_basic_tier_requested` | `tier_unavailable` | no |
| 503 | `engine_error` | `quality_tier_unavailable` | `flash_pdf_tier_omitted`, `flash_pdf_tier_null`, `flash_image_tier_omitted` | `tier_unavailable` | no |
| 400 | `invalid_request_error` | `invalid_request`, `param: "ocr_mode"` | `ocr_mode_invalid`, `ocr_mode_null` | `protocol` | no |
| 400 | `invalid_request_error` | `invalid_request`, `param: "files"` | `files_empty` | `protocol` | no |
| 400 | `invalid_request_error` | `invalid_request`, `param: "sha256sum"` / `"purpose"` / `"bytes"` | `upload_bad_sha_format`, `upload_bad_purpose`, `upload_missing_fields` | `protocol` | no |
| 400 | `invalid_request_error` | `invalid_request`, webhook message | `callback_unsupported`, `keyed_callback` | `protocol` | no |
| 400 | `invalid_request_error` | `unsupported_source` | `inline_source_too_big`, `url_source_http`, `source_type_local` | `protocol` | no |
| 400 | `invalid_request_error` | `page_range_invalid` | `page_range_malformed` | `protocol` | no |
| 400 | `invalid_request_error` | `file_hash_mismatch` | `upload_wronghash_complete` | `protocol` | **yes** (re-PUT the bytes once) |
| 409 | `invalid_request_error` | `upload_not_ready` | `upload_complete_without_bytes`, `upload_bytes_mismatch_complete` | `protocol` | yes |
| 409 | `invalid_request_error` | `upload_already_terminal` | `upload_cancel_twice` | *(swallowed)* | — |
| 409 | `invalid_request_error` | `job_already_terminal` | `cancel_finished_job` | *(swallowed by `cancelJob`)* | — |
| 413 | `invalid_request_error` | `upload_size_mismatch` | `upload_bytes_mismatch_put` | `protocol` | yes | 
| 413 | *(any)* | `file_too_large` | **unverified** | `too_large` | no |
| 404 | `invalid_request_error` | `job_not_found` | `job_unknown_id`, `cancel_unknown_job`, `probe.restart-after` | *(recovery R1)* | — |
| 404 | `invalid_request_error` | `file_not_found` | `file_unknown_id`, `file_unknown_id_content` | *(recovery R4)* | — |
| 404 | `invalid_request_error` | `upload_not_found` | `upload_unknown_id` | *(recovery R2)* | — |
| 404 | `invalid_request_error` | `model_not_found` | `model_unknown` | `protocol` | no |
| 429 | *(any)* | `rate_limit_exceeded` | **unverified** | `rate_limited` | yes, honour `Retry-After` |
| 422 | *(FastAPI `{detail:[…]}`)* | — | none recorded | `protocol` | no |
| 5xx | *(any other)* | — | none recorded | `unavailable` | yes |

> `413 upload_size_mismatch` is undocumented upstream and only exists here. `feature_requires_api_key` is
> mapped **non-retryable** on purpose: for `docx`/`html`/`latex` and source downloads the local server can
> never satisfy the request, and with a valid key the code silently becomes `unsupported_output_format`.

#### File-level failures (job returns `completed`/`failed` with a per-file error)

Checked after the poll reaches terminal. `files[0].error` shape is the same `ErrorDetail`.

| `files[0].error.type` / `code` | Probe | Taxonomy | Retryable |
| --- | --- | --- | --- |
| `engine_error` / `parse_failed`, message `File … not found` | `job_unknown_file_id.final` | `protocol`, **`handleUnknown: true`** | yes |
| `engine_error` / `parse_failed`, any other message | — | `job_failed` | yes |
| `invalid_request_error` / `page_range_invalid` | `page_range_on_csv.final`, `page_range_on_png.final`, `page_range_out_of_bounds.final` | `protocol` | no (unreachable — we never send `page_range`) |
| job `status: "failed"` with `files[0].error === null` | — | `job_failed` | yes |
| job `status: "partial"` | **unverified** (single-file jobs only) | `job_failed` | yes |
| job `status: "canceled"` while we were not cancelling | `cancel_running_job_after` | `job_failed` | yes |
| terminal `completed` but `output_files.zip == null` | — | `protocol` | yes |
| parsed `structured_content` has zero non-dropped blocks | — | `empty_result` | no |

### 2.10 Config keys

Twelve specs; `MINERU_TIMEOUT_MS` is removed. Per D9 **slice S0 owns every touchpoint**, including the two
Phase 4 keys, so the hot config files have exactly one owner across both phases.

| Key | New? | Default | `control` | Effect | Consumer |
| --- | --- | --- | --- | --- | --- |
| `MINERU_API_URL` | kept | `http://127.0.0.1:8001` | `{kind:"url"}` | live | `mineruUrl` |
| `MINERU_API_KEY` | new, **secret** | `""` | `{kind:"secret"}` | live | `Authorization` header |
| `MINERU_DEFAULT_TIER` | new | `auto` | `{kind:"select",options:["auto","flash","basic","standard","advanced"]}` | live | `decideTier` |
| `MINERU_OCR_MODE` | new | `auto` | `{kind:"select",options:["auto","txt","ocr"]}` | live | `createJob` |
| `MINERU_JOB_TIMEOUT_MS` | **replaces** `MINERU_TIMEOUT_MS` | `300000` | `int(10000, 3600000, "s", 1000)` | live | poll deadline |
| `MINERU_POLL_MIN_MS` | new | `2000` | `int(250, 60000, "ms")` | live | poll backoff floor |
| `MINERU_POLL_MAX_MS` | new | `30000` | `int(1000, 300000, "s", 1000)` | live | poll backoff ceiling |
| `MINERU_REQUEST_TIMEOUT_MS` | new | `30000` | `int(1000, 300000, "s", 1000)` | live | control-plane calls |
| `MINERU_TRANSFER_TIMEOUT_MS` | new | `600000` | `int(10000, 3600000, "s", 1000)` | live | PUT bytes / GET zip |
| `MINERU_CAPABILITIES_TTL_MS` | new | `300000` | `int(0, 3600000, "s", 1000)` | live | `capabilities.ts` |
| `MINERU_BUNDLE_MAX_BYTES` | new *(Phase 4)* | `33554432` | `int(1048576, 536870912, "mb", 1048576)` | live | `bundle.ts` |
| `MINERU_STRUCTURE_CHUNKING_ENABLED` | new *(Phase 4)* | `true` | `{kind:"bool"}` | live | `chunk-sync.ts` |

`effect` is **`live`** for all twelve. Never `restart` — `admin-config-registry.test.ts:110` pins the restart
set by exact equality. Never `unit: "count"` — `admin.system.unit.count` exists in neither language.

#### Exact touchpoints (all owned by S0)

1. **`src/lib/server/env.ts`** — declare beside `mineruApiUrl` (`:134-135`), parse beside `:810-819`.
   Delete `mineruTimeoutMs`. The replacement parse, verbatim shape:
   ```ts
   	mineruJobTimeoutMs: Math.max(
   		10000,
   		parseInt(
   			process.env.MINERU_JOB_TIMEOUT_MS ||
   				process.env.MINERU_TIMEOUT_MS ||          // deprecated, kept for one release
   				process.env.REQUEST_TIMEOUT_MS ||
   				"300000",
   			10,
   		) || 300000,
   	),
   ```
2. **`src/lib/server/config-store.ts`** — four edits per key:
   `ADMIN_CONFIG_KEYS` (beside `:73-74`), `RuntimeConfig` field (beside `:293-294`), `overrideAppliers`
   (beside `:780-788`), `getResolvedAdminConfigValues` (beside `:1612-1613`). Delete the two
   `MINERU_TIMEOUT_MS` entries from all four. **Keep every clamp identical to `env.ts` — nothing checks this.**
   The secret masks like the four existing secrets:
   ```ts
   		MINERU_API_KEY: config.mineruApiKey ? "[set]" : "",
   ```
   (the `PARALLEL_API_KEY` / `BRAVE_SEARCH_API_KEY` pattern at `:1617` / `:1639` returns the key in
   cleartext from `GET /api/admin/config`; do **not** copy it).
3. **`src/lib/config/admin-config-registry.ts`** — twelve `AdminConfigKeySpec` entries, `group: "integrations"`.
   Remove `"MINERU_TIMEOUT_MS"` from `SURFACED_ADMIN_CONFIG_KEYS` (`:753`); the ten remaining MinerU strings
   there become redundant once the specs exist (specs auto-populate the set at `:707-709`) — delete them and
   let the spread supply them.
4. **`src/routes/(app)/settings/_components/system/pages.ts`** — `NAMED_PAGE_KEYS.integrations` (`:80-88`):
   drop `"MINERU_TIMEOUT_MS"`, add the eleven others. They stay on the Integrations page because
   `AdvancedPage.svelte:41-43` filters `pageForKey(spec.key) === "advanced"`; precedent is `ATLAS_PIPELINE`,
   the one key today that is both named-page and spec'd.
5. **`IntegrationsPage.svelte`** — replace the two MinerU `SettingRow`s (`:95-138`) with the new set;
   `SecretField` for `MINERU_API_KEY` with `lastChanged={secretChangedAt.MINERU_API_KEY ?? ''}`;
   `<MineruStatusCard …/>` mounted directly under the `admin.system.integrations.documentExtraction`
   eyebrow (`:93`).
6. **`SettingsAdminSystemPane.svelte`** — `NAMED_KEY_LABEL` (`:942-943`): drop `MINERU_TIMEOUT_MS`, add the
   eleven others.
7. **`src/lib/i18n/settings.ts`** — **EN (`:290-295`) and HU (`:2133-2138`)**:
   - **delete** `admin.mineruDocumentExtraction` from both blocks. Confirmed orphan: the only two hits in the
     repo are the two definitions; the Integrations eyebrow uses
     `admin.system.integrations.documentExtraction` (`:1254` EN / `:3124` HU).
   - **delete** `admin.mineruTimeoutMs` / `admin.mineruTimeoutDescription` from both.
   - **replace the hardcoded docker command** in `admin.mineruApiDescription` with a docs pointer.
     EN: `"MinerU API server endpoint. See docs/uploads.md for how to run the service."`
     HU: `"A MinerU API-szerver végpontja. A szolgáltatás futtatásáról lásd: docs/uploads.md."`
   - add `admin.mineruApiKey`, `admin.mineruApiKeyDescription`, `admin.mineruDefaultTier`(+Description),
     `admin.mineruOcrMode`(+Description), `admin.mineruJobTimeoutMs`(+Description), and one label+description
     pair per remaining key, in **both** blocks — `settings.test.ts:47-51` asserts key-set equality.
   - add `admin.system.keys.<KEY>.label` and `.meaning` for all twelve, in **both** blocks —
     `admin-config-registry.test.ts:50-64` fails otherwise.
   - add the MinerU status card strings (`admin.mineruStatus.*`) in both.
8. **`src/lib/config/admin-config-registry.test.ts`** — raise the floor at `:66-70`.
   `ADVANCED_KEY_SPECS` is **84** today. Phase 2+4 adds 12 → **96**. If Phase 3 merged first it added 11 →
   **107**. The assertion is `toBeGreaterThanOrEqual`, so set it to the count on the branch you are on and
   **re-check after the integration merge**; an adversarial reviewer must verify the final number.
9. **`.env.example`** (`:131-136`) — replace the docker line with `# See docs/uploads.md`, drop
   `MINERU_TIMEOUT_MS`, add the eleven new keys commented out.
10. **`docs/configuration.md`** (`:166-174`) — one table row per key, six columns.
11. **`docs/uploads.md`** — rewrite the MinerU section for 4.x: the V1 endpoints, the tier model, the docker
    command (this is the one place it belongs), and the new key list. `:6` still claims the app POSTs to
    `${MINERU_API_URL}/file_parse`; that becomes `/v1/parse/jobs`.

No edits to `AdvancedPage.svelte`, `AdvancedRow.svelte`, `api/admin/config/+server.ts`, or
`settings/+page.server.ts` — the spec entries are auto-validated and auto-indexed.

Verify: `npx vitest run src/lib/config/admin-config-registry.test.ts src/lib/i18n/settings.test.ts
src/lib/server/services/admin-effective-config.test.ts`.

#### `MINERU_TIMEOUT_MS` override migration

`admin_config` is `key` PK + `value` + `updated_at` + `updated_by` (`schema.ts:1007-1014`). An admin override
is a real row; removing the key from `ADMIN_CONFIG_KEYS` would orphan it silently (the apply loop iterates
`ADMIN_CONFIG_KEYS`, so the row would simply stop having any effect). Migrate it, in the same SQL file as
the Phase 4 DDL (D9, §4.6):

```sql
INSERT OR IGNORE INTO `admin_config` (`key`, `value`, `updated_at`, `updated_by`)
SELECT 'MINERU_JOB_TIMEOUT_MS', `value`, `updated_at`, `updated_by`
FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';
--> statement-breakpoint
DELETE FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';
```

`INSERT OR IGNORE` makes it idempotent and makes an already-set `MINERU_JOB_TIMEOUT_MS` win. The `env.ts`
fallback chain covers the environment-variable half for one release.

### 2.11 Admin "MinerU status" card

**Endpoint:** `src/routes/api/admin/mineru-status/+server.ts`

```ts
export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const refresh = event.url.searchParams.get("refresh") === "1";
	return json({ report: await getMineruStatusReport({ refresh }) });
};
```

**Report shape** (`src/lib/server/services/mineru/capabilities.ts`):

```ts
export interface MineruStatusReport {
	checkedAt: string;              // ISO
	baseUrl: string;                // origin only — never the key, never a path with a token
	reachable: boolean;
	version: string | null;         // /v1/health.version, "4.0.4"
	webhook: boolean | null;        // always false locally
	outputFormats: readonly string[];
	sources: readonly string[];
	tiers: ReadonlyArray<{ id: MineruTierId; description: string; currentModel: string | null }>;
	accessLevel: "anonymous" | "registered" | null;   // /v1/usage
	limits: {
		maxFileSizeBytes: number | null;
		maxPagesPerFile: number | null;
		maxFilesPerJob: number | null;
		maxConcurrentJobs: number | null;
	} | null;
	/** Taxonomy code + message when `reachable` is false. Never a stack. */
	error: { code: ExtractionErrorCode; message: string } | null;
	/** True when the report came from the TTL cache rather than a live probe. */
	cached: boolean;
}

export async function getMineruStatusReport(input?: { refresh?: boolean }):
	Promise<MineruStatusReport>;

/** The hot path. Cached for MINERU_CAPABILITIES_TTL_MS; never throws on a cache hit. */
export async function getMineruCapabilities(signal: AbortSignal):
	Promise<{ version: string; outputFormats: readonly string[]; tiers: readonly MineruTierId[] }>;
```

`capabilities.ts` holds one module-level cache entry (value + `fetchedAt`), refreshed on expiry, with a
single in-flight promise so a burst of extractions issues one probe. A failed refresh **does not** poison a
still-valid entry; it only prevents serving a stale one past `2 × ttl`.

**Component:** `src/routes/(app)/settings/_components/system/MineruStatusCard.svelte`, mounted inside
`IntegrationsPage.svelte` under the document-extraction eyebrow. Modelled on `DiagnosticsPage.svelte`'s
tool-health table (`:125-232`): a `sys-pill-ok` / `sys-pill-warn` / `sys-pill-muted` status pill, a
`formatCheckedAt`-style timestamp, a "Re-check" button that refetches with `refresh=1`, and a two-column
list of version / tiers / output formats / limits. `data-testid="mineru-status-card"`, rows
`data-testid="mineru-status-row-<field>"`.

**Client fetcher:** `fetchAdminMineruStatus({ refresh })` appended to
`src/lib/client/api/admin-system-health.ts` (next to `fetchAdminToolHealth` at `:38`), with the same
defensive `normalize…` treatment.

**Tool-health row (required, small).** MinerU is conspicuously absent from `TOOL_HEALTH_REGISTRY` today.
Add `mineruApiUrl` (and `mineruApiKey`) to the `ToolHealthConfig` `Pick` (`tool-health/types.ts:6-22`) and a
registry entry at `tool-health/registry.ts:306`:

```ts
	{
		id: "document_extraction",
		name: "document_extraction",
		backend: "MinerU",
		configured: (config) => hasValue(config.mineruApiUrl),
		probe: (ctx) =>
			httpProbe(ctx, `${trimBase(ctx.config.mineruApiUrl)}/v1/health`, {}, expectOk),
	},
```

`/v1/health` is public even under `--api-key`, so the probe needs no credential and cannot leak one.

### 2.12 Retiring the 3.x path

`src/lib/server/services/document-extraction.ts` is **deleted**, together with
`src/lib/server/services/document-extraction.test.ts` and Phase 3's
`src/lib/server/services/extraction/extractors/legacy-mineru3.ts`.

| Concern | Where it lives after Phase 2 |
| --- | --- |
| direct-text branch (`isDirectTextExtractionFile` + UTF-8 read) | already `extraction/extractors/direct-text.ts` (Phase 3 S1), with the 8 MiB cap |
| `mimeFromExtension` | already `getCanonicalMimeForExtension` (Phase 1 slice D, checklist row 1) |
| `toNormalizedName` (`<stem>.md`) | moves verbatim into `extractors/mineru4.ts`; unchanged output |
| `extractMdContent` / `extractPageCount` (the five-key guess) | **deleted**; §4.4 replaces it |
| `resetDocumentExtractionExecutableCache` (a documented no-op) | deleted; grep for importers first — it should have none outside the deleted test |

`extraction/extractors/registry.ts` flips its `mineru` entry from `legacyMineru3Extractor` to
`mineru4Extractor`. That is the one-line change Phase 3 §"Independence from Phase 2" promised.

Guard tests (extend Phase 3's `extraction/no-inline-extraction.test.ts`):

- `expect(existsSync("src/lib/server/services/document-extraction.ts")).toBe(false);`
- no file under `src/` imports `"./document-extraction"` or `"$lib/server/services/document-extraction"`;
- `services/mineru/**` is imported only from `extraction/extractors/mineru4.ts`, the admin status route, the
  live-verify script, and its own tests.

**Phase 1 collision.** Phase 1 slice D *rewrites* `document-extraction.ts` (checklist rows 1, 2) and Phase 3
S1 *wraps* it. Phase 2 deletes it. Both earlier phases must land first; the deletion is a clean `git rm`, not
a merge. Flagged again in §6.

### 2.13 Phase 2 tests

| File | Asserts |
| --- | --- |
| `mineru/schemas.test.ts` | every `fixtures/mineru-v1/**/{upload.*,job.*}.json` and `server/*.json` parses; `output_files` with `null` members survives; the `cancelled`/`canceled` spelling split is pinned; an unknown extra key does not fail |
| `mineru/errors.test.ts` | **table-driven over every file in `fixtures/mineru-v1/errors/`** plus `_202-followups.json`; each maps to the §2.9 taxonomy row with the right `retryable`; an unmapped `code` fails the test with the probe name |
| `mineru/client.contract.test.ts` | replays the recorded sequences through an injected `fetchImpl`: the dedupe path (pdf: create→completed, no PUT, no complete), the fresh path (docx: create→PUT→complete), job create→poll→download; asserts the exact request bodies from §2.5, that no `page_range`/`callback`/`ocr_mode:null`/`tier:null` is ever sent, and that `Authorization` is absent for a cross-origin `upload_url` |
| `mineru/client.streaming.test.ts` | `putUploadContent` never materialises the file: a `fileReader` stub asserts `stream()` was used and `readFile` was never called; `Content-Length` equals the stat size |
| `mineru/capabilities.test.ts` | TTL honoured; one in-flight probe for a burst; a failed refresh keeps a fresh entry and rejects a stale one; `tier_unavailable` fast-fail before any upload |
| `mineru/result.test.ts` | opens the real `result.zip` for all 9 inputs + `flash-pdf`; the renderer equivalence proof (§4.3); page offsets; unknown block types tolerated |
| `mineru/tier-policy.test.ts` | every row of the §2.7 table, both server shapes (`server/tiers.json`, `server/flash.tiers.json`) |
| `mineru/testing/fake-server.ts` | *(not a test)* see below |
| `mineru/integration.test.ts` | the extractor end-to-end over the fake server |
| `extraction/extractors/mineru4.test.ts` | progress phases, handle emission before the first poll, abort → `DELETE`, the §2.9 file-level branches |

**The fake V1 server** — `src/lib/server/services/mineru/testing/fake-server.ts`:

```ts
export interface FakeMineruServerOptions {
	/** Tiers the fake advertises. Default ["flash","basic"]. */
	tiers?: readonly MineruTierId[];
	/** ms of simulated parse time; the poll loop must survive it. */
	parseDelayMs?: number;
	/** Fail the Nth request to this path with a recorded error fixture. */
	failures?: ReadonlyArray<{
		path: string; nth?: number; fixture: string;   // a name under fixtures/mineru-v1/errors/
	}>;
	/** Bytes persist, ids do not — exactly the recorded restart semantics. */
	restartAfterMs?: number;
	/** Which input fixture directory to answer zip downloads from. */
	fixtureInput?: "pdf" | "docx" | "csv" | "html" | "epub" | "png" | "xlsx" | "pptx" | "jpg" | "flash-pdf";
	apiKey?: string;
}

export interface FakeMineruServer {
	/** Drop-in for `fetch`. No socket is opened. */
	readonly fetchImpl: typeof fetch;
	/** Forgets every upload/file/job id; keeps the content-addressed blobs. */
	restart(): void;
	readonly requests: ReadonlyArray<{ method: string; path: string; body?: unknown }>;
	readonly jobs: ReadonlyMap<string, { status: string; tier: string }>;
}

export function createFakeMineruServer(options?: FakeMineruServerOptions): FakeMineruServer;
```

Required fake behaviours, each mirroring a recorded fixture: sha dedupe returns `completed` with a **new**
`file_id`; PUT answers 200 with an empty body; a wrong sha only fails at `complete`; job create answers 202
with `files[0].status: "queued"` and `page_range: ""`; the terminal job lists all seven `output_files` keys
with nulls; `/v1/files/{id}/content` streams the real fixture zip with
`content-type: application/octet-stream` and no `Content-Disposition`; `restart()` makes every id 404 with
the right `*_not_found` code while `POST /v1/uploads` with a known sha still returns `completed`.

`document-extraction.test.ts` is deleted. Its 20 cases are re-homed: the MinerU-response cases into
`client.contract.test.ts` / `errors.test.ts`, the direct-text cases into Phase 3's
`extractors/direct-text.test.ts` (already specified there), the normalized-name cases
(`produces normalized .md file name`, `handles filenames with multiple dots`) into
`extractors/mineru4.test.ts`, and the four page-count cases into `result.test.ts` against real fixtures.

---

## 3. The Phase 2 → Phase 4 hand-off

One object crosses the boundary. Phase 2 produces it; Phase 4 consumes it. It is defined in
`services/mineru/result.ts` and is **opaque to the Phase 3 ledger**, which only forwards it.

```ts
export interface MineruExtractionOutcome {
	/** The prompt text. Non-empty, or the extractor throws `empty_result`. */
	text: string;
	/** "<stem>.md", unchanged from the 3.x behaviour. */
	normalizedName: string;
	/** Always "text/markdown". */
	mimeType: string;
	/** metadata.document.page_count ?? pages.length. Never guessed from five keys. */
	pageCount: number;
	structured: StructuredExtractionResult;   // §4.1
}
```

`extractors/mineru4.ts` returns it as `ExtractDocumentResult` + the new optional `structured` field
(Phase 3 change Δ4, §5). Everything under `services/mineru/` is reachable from Phase 4 slices as a
**read-only** dependency except `result.ts` and `bundle.ts`, which slice P4-A owns.

---

## 4. Phase 4 — structured results

### 4.1 The parsed result model

```ts
// src/lib/server/services/mineru/result.ts

/** Exactly the vocabulary observed, plus the escape hatch. Never an error. */
export const KNOWN_BLOCK_TYPES = [
	"text", "paragraph_title", "doc_title", "list", "table", "image",
	"header", "footer", "page_number",
] as const;
export type KnownBlockType = (typeof KNOWN_BLOCK_TYPES)[number];

/** Dropped before the prompt text is built. PDF-only in every fixture. */
export const RUNNING_HEAD_BLOCK_TYPES = ["header", "footer", "page_number"] as const;

/**
 * Blocks a chunk boundary must never fall inside. `table` is the only one
 * observed; the rest are the Draft names that `standard`/`advanced` may emit
 * and that we must not split if they appear. ANY UNKNOWN TYPE IS ALSO ATOMIC.
 */
export const ATOMIC_BLOCK_TYPES = [
	"table", "image", "code", "equation_interline", "chart", "algorithm",
] as const;

export const structuredCaptionSchema = z.object({
	bbox: z.array(z.number()).length(4).optional(),
	content: z.string().default(""),
}).passthrough();

export const structuredBlockSchema = z.object({
	type: z.string(),                                  // NOT an enum — unknown is legal
	content: z.string().default(""),                   // always a Markdown string
	/** Flat array of four 0..1 floats. ABSENT (not null) for Office/HTML/EPUB/CSV. */
	bbox: z.array(z.number()).length(4).optional(),
	level: z.number().int().optional(),                // sibling of content, not inside it
	anchor: z.string().optional(),                     // HTML/EPUB only
	captions: z.array(structuredCaptionSchema).optional(),   // PLURAL
	footnotes: z.array(structuredCaptionSchema).optional(),  // PLURAL
	/** Bare string. "images/<name>.jpg" in the zip copy; a data: URI standalone. */
	image_source: z.string().optional(),
}).passthrough();

export const structuredPageSchema = z.object({
	page_idx: z.number().int(),                        // 0-based; page number = idx + 1
	blocks: z.array(structuredBlockSchema),
}).passthrough();

export const structuredContentSchema = z.object({
	pages: z.array(structuredPageSchema),
	metadata: z.object({
		/** UNRELIABLE: "pdf" for a PNG input. Never derive the format from it. */
		file_suffix: z.string().optional(),
		producer: z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
		/** Sparse and format-dependent. `{}` for PNG/JPEG. Every key optional. */
		document: z.object({
			title: z.string().optional(),
			authors: z.array(z.string()).optional(),
			subject: z.string().optional(),
			description: z.string().optional(),
			languages: z.array(z.string()).optional(),
			identifiers: z.unknown().optional(),
			created_at: z.string().optional(),
			modified_at: z.string().optional(),
			creator_application: z.string().optional(),
			producer_application: z.string().optional(),
			page_count: z.number().int().optional(),
			page_count_kind: z.string().optional(),   // physical|sheet|slide|spine|declared|logical
		}).passthrough().default({}),
	}).passthrough(),
	extensions: z.object({
		/** THE tier to trust. The job's `tier` lies. */
		mineru: z.object({ tier: z.string(), parse_mode: z.string().optional() })
			.passthrough().optional(),
		docvortex_layout: z.object({
			version: z.number().optional(),
			pages: z.array(z.object({
				page_idx: z.number().int(),
				width_pt: z.number(), height_pt: z.number(),
			}).passthrough()),
		}).passthrough().optional(),
	}).passthrough().default({}),
	is_full_document: z.boolean().optional(),
}).passthrough();

export type StructuredContent = z.infer<typeof structuredContentSchema>;

export type PageCountKind =
	| "physical" | "sheet" | "slide" | "spine" | "declared" | "logical" | "unknown";

/** One rendered block, with everything a chunker or a citation needs. */
export interface RenderedBlock {
	/** 1-based. Array index of the page + 1. */
	page: number;
	/** 0-based ordinal within the page, before any filtering. */
	blockIndex: number;
	type: string;
	/** True when `type` is not in KNOWN_BLOCK_TYPES. */
	unknownType: boolean;
	atomic: boolean;
	/** Heading level after per-format normalisation; null for non-headings. */
	headingLevel: number | null;
	/** Heading text with DOCX's `**…**` stripped; null for non-headings. */
	headingTitle: string | null;
	/** Inclusive start / exclusive end offsets into the normalized Markdown. */
	start: number;
	end: number;
	/** The text as it appears in the normalized Markdown (no trailing separator). */
	text: string;
	figure: RenderedFigure | null;
}

export interface RenderedFigure {
	/** 1-based across the document, in reading order. */
	index: number;
	/** The zip-relative path, e.g. "images/page_2_image_body_3.jpg". */
	path: string;
	caption: string | null;
	page: number;
	bbox: readonly [number, number, number, number] | null;
}

export interface StructuredExtractionResult {
	/** Bumped whenever the renderer or the chunk planner changes its output. */
	parserVersion: string;               // MINERU_PARSER_VERSION, §4.4
	/** metadata.producer.version, e.g. "4.0.4". */
	producerVersion: string | null;
	/** files[0].parse.parser_version, e.g. "4.0.4". Usually equal; not guaranteed. */
	serverParserVersion: string | null;
	/** extensions.mineru.tier — the REAL per-file tier. */
	effectiveTier: string | null;
	/** The tier the JOB reported. Kept only for diagnostics; it lies. */
	jobTier: string | null;
	parseMode: string | null;            // "txt" | "ocr"
	pageCount: number;
	pageCountKind: PageCountKind;
	/** normalized.md, byte-identical to the artifact's contentText. */
	markdown: string;
	/** Page → [start, end) offsets into `markdown`. Always pageCount entries. */
	pages: ReadonlyArray<{ page: number; start: number; end: number }>;
	blocks: readonly RenderedBlock[];
	figures: readonly RenderedFigure[];
	outline: readonly DocumentOutlineEntry[];     // §4.5, may be empty
	/** Diagnostics for the GPU-box checklist. */
	stats: {
		blockCount: number;
		droppedRunningHeads: number;
		unknownTypes: Readonly<Record<string, number>>;
		bboxPresent: boolean;
		anchorsPresent: boolean;
	};
}
```

### 4.2 The parse bundle

**Location:** `data/knowledge/<userId>/<sourceArtifactId>.parse/`, a sibling of
`data/knowledge/<userId>/<sourceArtifactId>.<ext>` (`knowledge/store/attachments.ts:514-519`,
`:617-623`; `knowledgeUserDir` at `knowledge/store/core.ts:209-211`). The filename stem already **is** the
artifact UUID, so the directory name is derived, never read from metadata.

```
<sourceArtifactId>.parse/
  manifest.json          the MineruParseBundleManifest below
  normalized.md          === the normalized artifact's contentText, byte for byte
  structured_content.json  the ZIP copy (relative image paths, no data URIs)
  pages.json             [{page,start,end}] — the page index, split out so a
                         read_generated_file?page= lookup never parses the blocks
  images/<name>.jpg      only the files actually referenced by a figure
```

**Not kept:** `middle_json.json` (nothing consumes HTML tables or `styles:["bold"]` yet; it is the second
largest artifact), `model_output.json` (the largest — 83 355 bytes for the 3-page PDF, undocumented, and
useless to us), and the downloaded `result.zip` itself (deleted after extraction).

```ts
export interface MineruParseBundleManifest {
	version: 1;
	sourceArtifactId: string;
	normalizedArtifactId: string | null;   // patched in after persist
	createdAt: string;                      // ISO
	parserVersion: string;
	producerVersion: string | null;
	serverParserVersion: string | null;
	effectiveTier: string | null;
	jobTier: string | null;
	parseMode: string | null;
	pageCount: number;
	pageCountKind: PageCountKind;
	markdownBytes: number;
	/** The sha256 of normalized.md — lets a reader detect a stale bundle. */
	markdownSha256: string;
	figures: readonly RenderedFigure[];
	/** True when the image payload exceeded MINERU_BUNDLE_MAX_BYTES and was dropped. */
	imagesOmitted: boolean;
	totalBytes: number;
	stats: StructuredExtractionResult["stats"];
}
```

**Size budget.** `MINERU_BUNDLE_MAX_BYTES` (32 MiB). JSON and Markdown are always written. Images are
written newest-page-first until the budget is reached; the remainder is skipped and `imagesOmitted: true`.
A single image larger than a quarter of the budget is skipped outright. The budget is checked against the
*uncompressed* sizes read from the zip entries, before any write.

**Write protocol** (`bundle.ts`), crash-safe and idempotent:

1. write into `<sourceArtifactId>.parse.tmp-<pid>-<rand>/`;
2. `rm -rf` any existing `<sourceArtifactId>.parse/`;
3. `rename` the temp directory into place (atomic on the same filesystem);
4. on any failure, `rm -rf` the temp directory and rethrow.

Because Phase 3 guarantees `UNIQUE(source_artifact_id)` on the job row, two attempts for the same artifact
can never run concurrently, so step 2 cannot race a live reader.

```ts
export function mineruBundleDir(userId: string, sourceArtifactId: string): string;
export async function writeMineruParseBundle(input: {
	userId: string; sourceArtifactId: string;
	zipPathAbsolute: string; result: StructuredExtractionResult;
	maxBytes: number;
}): Promise<MineruParseBundleManifest>;
export async function readMineruParseManifest(userId: string, sourceArtifactId: string):
	Promise<MineruParseBundleManifest | null>;
export async function readMineruPageIndex(userId: string, sourceArtifactId: string):
	Promise<ReadonlyArray<{ page: number; start: number; end: number }> | null>;
export async function readMineruFigure(input: {
	userId: string; sourceArtifactId: string; name: string;
}): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number; contentType: string } | null>;
/** Best effort. Never throws. */
export async function removeMineruParseBundle(userId: string, sourceArtifactId: string): Promise<void>;
```

**Cleanup.** `knowledge/store/cleanup.ts:87-103` is the only place artifact bytes are unlinked, and it runs
**after** the DB transaction commits. Add, inside the same loop, next to the `unlink`:

```ts
		await removeMineruParseBundle(userId, row.id).catch(() => undefined);
```

Same best-effort semantics, same `[KNOWLEDGE_DELETE]` warning on failure. It is keyed on the row id, so it
covers both the direct `deleteArtifactForUser` path and the `source_document → normalized_document`
expansion (`cleanup.ts:203-220`). Account erasure is already covered: `account-lifecycle/index.ts:115`
`rm`s `data/knowledge/<userId>` recursively.

**Disk reconciliation.** `src/lib/server/services/disk-reconciliation.ts` walks
`data/knowledge` fully recursively with **no exclusions** (`walkDir`, `:21-38`) and reports every file that
is not an exact `storage_path` match (`:118-129`). Today that already produces false orphans for
`.incoming/` staging files; a bundle directory would add one entry per image and per JSON. Fix it in the
same slice, in `walkDir`:

```ts
const IGNORED_KNOWLEDGE_DIR_NAMES = /^\.incoming$/;
const IGNORED_KNOWLEDGE_DIR_SUFFIXES = [".parse", ".parse.tmp"];
```

Skip a directory whose basename matches either. Update
`src/lib/server/services/disk-reconciliation.test.ts` with a case per rule, plus a regression case proving a
genuine stray file beside a bundle is still reported.

### 4.3 The prompt text: build from blocks — with the evidence

**Decision: build it.** Two renderers ship in `result.ts`.

```ts
/**
 * The FAITHFUL renderer. Exists to prove the block model is complete.
 * Used only by result.test.ts. Never used in production.
 */
export function renderMineruMarkdown(sc: StructuredContent): string;

/** The PRODUCTION renderer. Its output IS the normalized artifact's contentText. */
export function renderPromptMarkdown(sc: StructuredContent): {
	markdown: string;
	pages: ReadonlyArray<{ page: number; start: number; end: number }>;
	blocks: readonly RenderedBlock[];
	figures: readonly RenderedFigure[];
};
```

**Renderer rules** (both), applied per page in `page_idx` order, per block in array order:

| block type | emitted |
| --- | --- |
| `header`, `footer`, `page_number` | **dropped** |
| `doc_title`, `paragraph_title` | `"#".repeat(clamp(level ?? 1, 1, 6)) + " " + content` |
| `table` | each caption's `content`, then `content`, then each footnote's `content` |
| `image` | *(see below — the two renderers differ here, and only here)* |
| anything else, incl. unknown types | `content` |

Empty/whitespace-only results are skipped; the surviving parts are joined with `"\n\n"`.

`renderMineruMarkdown` emits an image as `![](<image_source>)` followed by each caption's `content` —
which is what MinerU does.

**The equivalence proof, run over the real zipped artifacts:**

| fixture | `renderMineruMarkdown(structured_content.json)` vs `markdown.md` |
| --- | --- |
| csv | **identical** (148 B) |
| docx | **identical** (1 053 B) |
| pdf | **identical** (1 306 B) |
| flash-pdf | **identical** (997 B) |
| png | **identical** (401 B) |
| pptx | **identical** (163 B) |
| xlsx | **identical** (353 B) |
| html | differs by 4 lines — only the `<a id="html-…"></a>` anchors MinerU injects from `anchor` |
| epub | differs by 3 lines — same, `<a id="epub-…"></a>` |

Seven of nine are byte-identical; the two exceptions differ **only** by HTML anchor tags that are pure noise
in a prompt. `result.test.ts` pins this table: it asserts byte identity for the seven and asserts that the
two diffs consist exclusively of `<a id="…"></a>` lines.

`renderPromptMarkdown` differs from the faithful renderer in exactly one rule: an `image` block becomes
`[Figure N]` or `[Figure N: <first caption>]` (N = 1-based figure ordinal), and never an `![](…)` link.
Rationale: a prompt-visible `![](images/page_2_image_body_3.jpg)` costs tokens and means nothing to the
model, while `[Figure 1: HOTEL Figure caption text.]` is the same caption text plus a stable handle the
model can ask about. Anchors are never emitted by either renderer.

**Why not just use `markdown.md`, since we download it anyway inside the zip?**

1. **It carries no page boundaries.** Page-aware chunking, `page_start`/`page_end`, page citations and the
   `read_generated_file?page=` parameter all need an offset→page map, and `markdown.md` is a flat string.
   Rendering ourselves yields the map for free, in the same pass.
2. **It carries no block types.** A chunker that must never split a table needs to know where the table is.
3. **The standalone copy is 26× larger** (34 457 B vs 1 312 B for the PDF) because of inlined data URIs —
   so "just fetch the markdown" is not the cheap option it looks like.
4. The equivalence table above removes the only real argument for `markdown.md`, which was fidelity.

The zip's `markdown.md` is still read in tests, as the oracle. It is not persisted.

### 4.4 Artifact metadata

`MINERU_PARSER_VERSION = "mineru4/1"` — a constant in `result.ts`, bumped whenever `renderPromptMarkdown`
or the chunk planner changes its output, so a reviewer can tell which rows were produced by which renderer.

`metadata_json` is a shallow-merged `Record<string, unknown>` (`updateArtifactMetadata`,
`knowledge/store/core.ts:325-352`). The comfort patch already lands on **both** the normalized artifact and
the source artifact (`knowledge/store/documents.ts:325-334`, `:346-350`, `:357-361`). Extend it:

| key | value | notes |
| --- | --- | --- |
| `tokenEstimate` | unchanged | |
| `outline` | unchanged shape, new producer (§4.5) | |
| `pageCount` | `metadata.document.page_count ?? pages.length` | **replaces the five-key guess** |
| `pageCountKind` | `metadata.document.page_count_kind ?? "unknown"` | new; `physical\|sheet\|slide\|spine\|declared\|logical\|unknown` |
| `extractionProducer` | `"mineru"` | **the legacy marker**: absent ⇒ pre-Phase-4 row (D12) |
| `extractionProducerVersion` | `metadata.producer.version` | `"4.0.4"` |
| `extractionServerParserVersion` | `files[0].parse.parser_version` | `"4.0.4"` |
| `extractionParserVersion` | `MINERU_PARSER_VERSION` | ours, not MinerU's |
| `extractionTier` | `extensions.mineru.tier` | **the real per-file tier**, e.g. `flash` inside a `basic` job |
| `extractionJobTier` | the job's `tier` | diagnostics only |
| `extractionParseMode` | `extensions.mineru.parse_mode` | `txt` / `ocr` |
| `extractionBundleBytes` | manifest `totalBytes` | admin reporting |
| `extractionFigureCount` | `figures.length` | |
| `extractionImagesOmitted` | manifest `imagesOmitted` | |
| `extractionUnknownBlockTypes` | `stats.unknownTypes`, omitted when empty | the GPU-box signal (§8) |

Deleted: `document-extraction.ts:73-108` (`page_count` / `total_pages` / `num_pages` / `pages_count` /
`pages.length` over an arbitrary result key). `readStoredPageCount` (`outline.ts:217-221`) is unchanged and
still rejects `0`.

**Do not** store the page index (`pages`) in metadata: a 1000-page PDF would add ~30 KB of JSON to a column
that is read on every `mapArtifactSummary`. It lives in `pages.json` in the bundle.

`chat-files.ts` readback keeps dropping `pageCount` today (`:626-670` consumes only `extraction.text`).
Phase 3 S5 moved that to `completeGeneratedFileReadback`; Phase 4 does **not** extend it — generated files
have no source bytes on the knowledge tree and therefore no bundle. Stated as a non-goal in §9.

### 4.5 Outline

`DocumentOutlineEntry` (`knowledge/types.ts:35-46`) keeps its shape and gains one optional field:

```ts
export interface DocumentOutlineEntry {
	level: number;
	title: string;
	/** Offset into contentText. Unchanged meaning. */
	offset: number;
	preview: string;
	/** NEW, optional. 1-based page the heading sits on. Absent for direct-text. */
	page?: number;
}
```

`readStoredOutline` (`outline.ts:188-211`) must pass `page` through when it is a positive finite integer and
drop it otherwise; everything else about it is unchanged, including the `MAX_OUTLINE_ENTRIES = 200` cap.

**Producer** (`result.ts`), per format, driven by what the fixtures actually show:

| source | rule | evidence |
| --- | --- | --- |
| HTML, EPUB | `level` verbatim (`doc_title` 1, `paragraph_title` 2/3) | faithful in both fixtures |
| DOCX | `level - 1`, and strip a single wrapping `**…**` from the title | Heading1→2, Heading2→3, Heading3→4; titles arrive as `**ALFA Quarterly Overview**` |
| XLSX, PPTX | `level` verbatim (always 2) — sheet and slide names | |
| PDF, PNG, JPEG | `level` verbatim, but **flat by construction**: `basic` reports level 2 for every heading | `flash` on the same PDF produces a `doc_title` at level 1 that `basic` does not — so the outline shape is tier-dependent, and the UI must not depend on depth |
| CSV | no headings at all | the only fixture with zero title blocks |

The format is decided from the **registry entry for the uploaded filename**, never from
`metadata.file_suffix` (which says `"pdf"` for a PNG).

`offset` is the block's `start` in the normalized Markdown, i.e. the `#` of the rendered heading —
matching `extractDocumentOutline`'s meaning exactly, so `read-generated-file.ts:584-595`'s
`sectionTitleAt` keeps working untouched.

**Fallback chain**, in order:

1. block-derived outline (above), when it is non-empty;
2. `extractDocumentOutline(markdown)` — the existing heuristics (`outline.ts:103-171`) — when the
   block-derived outline is empty. This covers CSV, and it covers formats where a heading arrives as bold
   body text rather than a `paragraph_title` (the spike's DOCX `**Bold**` observation applies to
   `paragraph_title` content, but nothing guarantees a producer always types its headings);
3. `extractDocumentOutline` is the **only** producer for the `direct-text` route, unchanged.

`extraction/persist.ts` therefore calls `extractDocumentOutline` exactly as today when `structured` is
absent, and uses `structured.outline` (already falling back internally) when it is present.

### 4.6 Structure-aware chunking

#### DDL

`artifact_chunks` (`schema.ts:362-395`) gains two nullable columns. Append to the column object, before the
index object:

```ts
		/** 1-based inclusive page the chunk starts on. NULL for direct-text and legacy rows. */
		pageStart: integer("page_start"),
		/** 1-based inclusive page the chunk ends on. NULL when pageStart is NULL. */
		pageEnd: integer("page_end"),
```

No new index: every read of these columns already carries `artifact_id` (`artifact_chunks_artifact_idx`).

#### Migration

**One file**, shared with the §2.10 `admin_config` rename, because the journal is a hot file with a single
owner (S0).

`drizzle/1777140000098_mineru4_extraction.sql`:

```sql
ALTER TABLE `artifact_chunks` ADD `page_start` integer;--> statement-breakpoint
ALTER TABLE `artifact_chunks` ADD `page_end` integer;--> statement-breakpoint
INSERT OR IGNORE INTO `admin_config` (`key`, `value`, `updated_at`, `updated_by`)
SELECT 'MINERU_JOB_TIMEOUT_MS', `value`, `updated_at`, `updated_by`
FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';--> statement-breakpoint
DELETE FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';
```

Idiom copied from `drizzle/1777140000091_routing_region_transit.sql` and
`drizzle/1777140000094_user_connections_usage_marks.sql`: backticked identifiers, `ADD` not `ADD COLUMN`,
lowercase SQLite types, `--> statement-breakpoint` between statements, none after the last.

`drizzle/meta/_journal.json` — append after the current last entry:

```json
    {
      "idx": 111,
      "version": "7",
      "when": 1777140000098,
      "tag": "1777140000098_mineru4_extraction",
      "breakpoints": true
    }
```

> The numbers assume Phase 3 landed `idx 110 / when 1777140000097`. If it did not, use `idx 110` /
> `1777140000097` and rename the file. **Re-check at integration-merge time** — two specs cannot both own
> `…097`. No `drizzle-kit generate` run; `drizzle/meta/` holds no per-migration snapshots.

`scripts/prepare-db.ts`: no new table, so `requiredExistingTables` is unchanged. Do **not** add
`["artifact_chunks","page_start"]` to `requiredExistingColumns` — the columns are nullable and an older DB
must still boot. `src/lib/server/db/schema.test.ts` gains a case asserting both columns exist and are
nullable.

#### The chunk planner

```ts
// src/lib/server/services/mineru/result.ts

export interface ChunkPlanEntry {
	chunkIndex: number;
	text: string;
	pageStart: number;
	pageEnd: number;
}

/**
 * Structure-aware packing. Blocks are the atoms; a chunk is a run of blocks.
 * An ATOMIC block is never split, even when it alone exceeds the target.
 */
export function planStructuredChunks(input: {
	blocks: readonly RenderedBlock[];
	/** 1400, from chunk-sync.ts. */
	charTarget: number;
	/** 220, from chunk-sync.ts. */
	charOverlap: number;
}): ChunkPlanEntry[];
```

Rules:

1. Walk `blocks` in order, accumulating into the current chunk until adding the next block would exceed
   `charTarget`.
2. A block whose `atomic` is true is emitted whole: if it fits, it joins the current chunk; if it does not,
   the current chunk is closed and the atomic block becomes its own chunk **however large it is**.
   `atomic` is true for `ATOMIC_BLOCK_TYPES` **and for every unknown type** (§1.5).
3. Overlap is applied only between two consecutive chunks whose boundary is *not* adjacent to an atomic
   block: the last `charOverlap` characters of the previous chunk are prepended, trimmed to the nearest
   preceding `\n`. This keeps today's recall behaviour for prose while guaranteeing a table is never
   duplicated or halved.
4. A heading block is never the last block of a chunk when a following non-heading block could join it —
   a chunk must not end on a bare `## Title`.
5. `pageStart` = min `page` over the chunk's blocks (including the overlap's source block), `pageEnd` = max.
6. Chunk text is joined with `"\n\n"`, matching the renderer, and `.trim()`ed — same as
   `splitIntoChunks`.

#### Threading it through

`syncArtifactChunks` (`task-state/chunk-sync.ts:56-87`) gains one optional parameter:

```ts
export async function syncArtifactChunks(params: {
	artifactId: string;
	userId: string;
	conversationId?: string | null;
	contentText?: string | null;
	/** NEW. When present and MINERU_STRUCTURE_CHUNKING_ENABLED, replaces splitIntoChunks. */
	chunkPlan?: readonly ChunkPlanEntry[] | null;
}): Promise<void>;
```

- The unconditional `DELETE … WHERE artifact_id = ?` (`:60-63`) is unchanged.
- The **small-file bypass is preserved exactly**: `contentText.length < getSmallFileThreshold()`
  (default 5 000 chars, `env.ts:765-768`) still returns before any insert, **including when `chunkPlan` is
  present**. This matters: the entire PDF fixture renders to 1 306 characters, so most real documents have
  zero chunk rows and are served by the pseudo-chunk fallbacks in
  `task-state/artifacts.ts:466-478` and `:245-250`.
- When `chunkPlan` is present and the flag is on, rows come from the plan and carry `pageStart`/`pageEnd`.
- Otherwise `splitIntoChunks` runs exactly as today and both columns are `null`.
- `chunk-sync.ts` must **not** read the bundle from disk. The plan is passed in, so the module keeps its
  current dependency set.

`createArtifact` (`knowledge/store/core.ts:249-298`) gains an optional `chunkPlan` on its params and
forwards it at `:290-295`. `queueArtifactSemanticEmbeddingRefresh` at `:296` is untouched — embeddings are
artifact-level and do not see chunks.

#### Every consumer of `artifact_chunks`, and what it must do

| file:line | Change |
| --- | --- |
| `task-state/chunk-sync.ts:56-87` | the plan parameter above |
| `task-state/mappers.ts:79-93` | map `pageStart` / `pageEnd` onto `ArtifactChunk` |
| `knowledge/types.ts:139-149` | `ArtifactChunk` gains `pageStart: number \| null; pageEnd: number \| null` |
| `task-state/artifacts.ts:68-84` (`listArtifactChunksForArtifacts`) | `SELECT *` — no change needed, but the mapper does |
| `task-state/artifacts.ts:369-382` (`combineSnippetChunks`) | emit the page prefix (§4.7) |
| `task-state/artifacts.ts:388-403` (`DocumentPassage`) | gains `pageStart: number \| null; pageEnd: number \| null`; `selectDocumentPassages` (`:422-489`) populates them, and leaves them `null` for the synthesized pseudo-chunk |
| **`conversation-forks.ts:869-883`** | **MUST copy the two new columns** or a forked conversation silently loses every page citation. This is the single easiest thing to miss in this phase. |
| `knowledge/store/attachments.ts:113-122` | `count(*)` only — no change |
| `memory-maintenance.ts:162-190` (`pruneOrphanArtifactChunks`) | no change |
| `account-lifecycle/user-scoped-tables.ts:267-269` | no change |
| `scripts/prepare-db.ts:41,140` | no change |

Chunk ids are `randomUUID()` on every sync and delete-then-insert is unconditional
(`chunk-sync.ts:60-63`, `:77`) — so nothing may hold a foreign reference to `artifact_chunks.id`, and the
page columns are re-derived on every re-sync rather than migrated.

### 4.7 Page citations in the prompt, and the token budget

**Where.** `combineSnippetChunks` (`task-state/artifacts.ts:369-382`) is the last place that still holds
`chunk.chunkIndex` before the text becomes an opaque string; `serializeWorkingSetArtifacts`
(`prompt-context.ts:363-428`) only sees `Map<artifactId, string>`. Emit the citation in
`combineSnippetChunks` and **change nothing in `prompt-context.ts`**:

```ts
function combineSnippetChunks(chosen, perArtifactCharBudget, pageLabel) {
	return chosen
		.map((entry) => {
			const body = clipText(entry.chunk.contentText,
				Math.floor(perArtifactCharBudget / chosen.length));
			const cite = formatPageCitation(entry.chunk, pageLabel);   // "" when not citable
			return cite ? `${cite}\n${body}` : body;
		})
		.join("\n\n");
}
```

**When.** `formatPageCitation` returns `""` unless `pageStart` is non-null **and** the artifact's
`pageCountKind ∈ {physical, slide, sheet, spine}` **and** `pageCount > 1`. `declared` (DOCX reports
`page_count: 1` for a four-heading document) and `logical` (CSV, HTML) are never cited — D11.

| `pageCountKind` | prefix |
| --- | --- |
| `physical`, `spine` | `[p. 3]` / `[p. 3–4]` |
| `slide` | `[slide 2]` |
| `sheet` | `[sheet 1]` |

The prefix uses an en dash and is ASCII-safe otherwise. The `## Retrieved Evidence` header itself is an
English-only literal (`context-selection.ts:1957`, matched again at `:530`) with no Hungarian variant —
**no i18n change is required or permitted here**.

**Token budget impact — measured against the real estimator** (`src/lib/utils/tokens.ts`, which charges
`ceil(len/4)` per ASCII word-run and one token per punctuation run):

| prefix | tokens |
| --- | ---: |
| `[p. 3]` | 5 |
| `[p. 3–4]` | 7 |
| `[slide 2]` | 4 |

`getPromptArtifactSnippets` selects at most `perArtifactLimit` chunks (2 / 4 / 8 by depth,
`context-budget.ts:237-298`). Worst realistic case at `direct` depth with 8 artifacts × 8 chunks = 64
prefixes ≈ **450 tokens**. Crucially this is **not additive**: the evidence section is clipped to
`retrievedEvidenceBudget` (`context-selection.ts:1948-1954`, floor `WORKING_SET_PROMPT_TOKEN_BUDGET = 3 000`)
by `truncateToTokenBudget` inside `serializeWorkingSetArtifacts`, so the prefixes **displace** body text
rather than growing the prompt. Typical case — 3 artifacts × 2 chunks — is ~30 tokens, ≈1 % of the section.

The evidence section sits in the `support` priority band (`context-selection.ts:834-847`) and is trimmed
before `core`, so the displacement is bounded and already-tested behaviour.

**Prefix-cache impact: none.** The Retrieved Evidence section is per-turn content, far past the cached
system/tool prefix. The prefix cache concern applies only to the tool description (§4.8).

### 4.8 `read_generated_file` gains `page`

**Schema** (`normal-chat-tools/read-generated-file.ts:156-176`) gains one optional field:

```ts
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Start the window at this 1-based page of a parsed document. Ignored when `from` or `query` is set.",
		),
```

**Behaviour.** `page` is resolved before the window is cut: `readMineruPageIndex(userId, sourceArtifactId)`
→ the entry's `start` becomes `from`. Precedence is `query` > `from` > `page`; a `page` beyond the document
returns the existing end-of-content `note` rather than an error; an artifact with no bundle ignores `page`
and returns a one-line note saying the document has no page information. The result object gains
`page: number | null` and `pageCount: number | null`, and each `ReadGeneratedFilePassage`
(`:502-513`) gains `pageStart` / `pageEnd` beside the existing `charOffset` and `section` —
`section` (`sectionTitleAt`, `:584-595`) is the existing citation precedent and keeps working unchanged.

The bundle read happens on a tool call, never on the prompt assembly path, so the added disk I/O is one
small JSON read per `page`-using call.

**Tool description — one deliberate edit, EN and HU.** Descriptions live only in
`src/lib/server/services/normal-chat-tools/index.ts` (`TOOL_I18N`, EN at `:288-292`, HU at `:380-384`);
nothing in `src/lib/i18n/**` references a tool name, and `scripts/validate-i18n.ts` does not cover
`TOOL_I18N`, so **EN/HU parity here is not machine-checked — the reviewer must check it by eye.**

Append exactly one sentence, immediately after the existing `query` sentence:

- EN: `Pass \`page\` to start the window at a page of a parsed document; pages appear as [p. N] in your context.`
- HU: `A \`page\` megadásával az ablak egy feldolgozott dokumentum adott oldalánál kezdődik; az oldalak [p. N] alakban jelennek meg a kontextusodban.`

**Prefix-cache cost, stated honestly.** Tool descriptions sit inside the cached prompt prefix, and the local
model (Flash-Next on the alfyroot GPU) caches in **1600-token blocks**. Editing this description changes
bytes at that offset, so every cached block **from that offset onward** is invalidated once and must be
re-warmed; blocks before it are untouched. Consequences the implementer must honour:

1. Make this the **only** tool-description edit in the release, so there is one invalidation, not several.
2. Keep the addition to one sentence in each language; do not reflow or re-punctuate the surrounding text.
3. After deploy, confirm the re-warm with the vLLM prefix-cache counters exactly as the existing
   prompt-cost runbook does, and record the before/after hit rate in the release notes.

If the owner declines the prefix-cache cost, the fallback is to ship `page` **undocumented** — the parameter
works, the model simply will not discover it. Flagged as OQ5.

### 4.9 Figures: storage and serving

Bytes live in `<sourceArtifactId>.parse/images/<name>.jpg`, named exactly as MinerU named them
(`page_<pageIdx>_<subBlockType>_<index>.jpg`, e.g. `page_2_image_body_3.jpg`) so a name maps straight back
onto `middle_json` if a later phase wants it.

**Endpoint:** `src/routes/api/knowledge/[id]/figure/[name]/+server.ts`, `GET`.

```
1. requireAuth(event); 401 when event.locals.user is null      (copy download/+server.ts)
2. getArtifactForUser(userId, params.id)                        ← THE authorization check
   → 404 when null. NEVER query `artifacts` by id alone.
3. if artifact.type === "normalized_document": hop to the source via
   getSourceArtifactIdForNormalizedArtifact (same hop working-document-file-serving.ts:47-61 does)
4. name must match /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/ and contain no "."-only segment
5. resolve inside mineruBundleDir(userId, sourceArtifactId) and assert the RESOLVED path
   still starts with that directory + path.sep  (a containment check, NOT the deny-list
   `isUnsafeStoredArtifactPath` at working-document-file-serving.ts:234-236)
6. stream with the content type derived from the extension, `Cache-Control: private, max-age=3600`
7. ENOENT → 404
```

**In scope:** the endpoint, the `figures` array in the manifest, `extractionFigureCount` in metadata.
**Out of scope:** any UI. No component renders a figure in this phase; nothing links to the endpoint from
Svelte. It exists so a follow-up (or a model-facing tool) can use it, and so the images are not written to
disk with no way to read them back. Stated again in §9.

### 4.10 Re-extract at a higher tier

**Endpoint:** `src/routes/api/knowledge/extraction/[artifactId]/reextract/+server.ts`, `POST`,
body `{ tier: "flash" | "basic" | "standard" | "advanced" }`.

```
1. requireAuth; getArtifactForUser → 404
2. validate `tier` against getMineruCapabilities().tiers → 400 `tier_unavailable` when absent,
   so the user gets the refusal instantly instead of a failed job
3. persist the hint on the ledger row (Phase 3 change Δ3)
4. retryExtractionJob({ userId, jobId })  — or materializeLegacyExtractionJob first for a
   pre-ledger artifact, exactly as the existing retry route does
5. wakeExtractionWorker()
6. 200 { job: DocumentExtractionJobDTO }
```

It reuses Phase 3's retry machinery wholesale; the only new thing is the tier hint, which reaches the
extractor through `ExtractDocumentRequest.hints.tier` and enters `decideTier` at rule 1 (§2.7).

**Where the button lives:** the Knowledge list row action menu,
`src/routes/(app)/knowledge/_components/DocumentsList.svelte`, beside Phase 3's Retry and Cancel actions —
a submenu listing the tiers `getMineruCapabilities()` reports, with the current
`metadata.extractionTier` marked and lower tiers disabled. Enabled only when
`metadata.extractionProducer === "mineru"` **or** the row is a legacy `source_document` (D12), and only when
the extraction job is terminal. Strings under `knowledge.extraction.reextract.*`, EN + HU —
`i18n.test-helpers.ts` already audits `"knowledge.extraction"` after Phase 3 S4 added it.

A re-extract **replaces** the bundle (the write protocol in §4.2 `rm -rf`s the old directory) and re-runs
`persist.ts`, which re-syncs chunks and re-queues the embedding refresh. The normalized artifact keeps its
id, so nothing that references it dangles.

### 4.11 Existing library documents

No backfill, automatic or batched (D12). A legacy row is any `source_document` whose metadata lacks
`extractionProducer`. It keeps working: `contentText` is still there, chunks are still there,
`pageStart`/`pageEnd` are `null`, `formatPageCitation` returns `""`, `read_generated_file?page=` reports
"no page information", and the Knowledge row offers Re-extract.

`read-model`-side identification, for the reviewer: `metadata.extractionProducer === "mineru"` ⇒ Phase 4
row; `metadata.extractionParserVersion` tells which renderer produced it; absence of both ⇒ legacy.

### 4.12 Phase 4 tests

| File | Asserts |
| --- | --- |
| `mineru/result.test.ts` | the §4.3 equivalence table over all 10 zipped fixtures; page offsets partition the markdown exactly (`pages[i].end === pages[i+1].start`); `pageCount` = `page_count ?? pages.length`, incl. PNG/JPEG where it is absent; `file_suffix: "pdf"` for a PNG does not mislead the format branch; an injected unknown block type is rendered and counted, never thrown |
| `mineru/outline.test.ts` | the §4.5 per-format table; DOCX `**Bold**` stripped and level shifted by −1; PDF at `basic` is flat while the same PDF at `flash` yields a `doc_title`; CSV falls through to `extractDocumentOutline` |
| `mineru/chunk-plan.test.ts` | a table block is never split, at any `charTarget` incl. one smaller than the table; an unknown-type block is atomic; `pageStart`/`pageEnd` are correct across a page boundary; a chunk never ends on a bare heading; overlap is absent around atomic blocks |
| `mineru/bundle.test.ts` | atomic rename; a crash mid-write leaves no `.parse` directory; the budget drops images and sets `imagesOmitted`; `readMineruFigure` refuses `../`, absolute names, and a symlink escape |
| `task-state/chunk-sync.test.ts` | the small-file bypass still wins over a `chunkPlan`; the flag off restores today's output byte-for-byte; page columns null on the legacy path |
| `task-state/artifacts.page-citation.test.ts` | the §4.7 table incl. every `pageCountKind`; no prefix when `pageCount === 1`; prefixes displace body text rather than exceeding the budget |
| `conversation-forks.test.ts` *(update)* | a forked chunk carries `page_start` / `page_end` — the miss in §4.6 |
| `knowledge/store/cleanup.test.ts` *(update)* | deleting a source artifact removes its `.parse` directory; a failure there is warned, not thrown, and does not abort the remaining unlinks |
| `disk-reconciliation.test.ts` *(update)* | `.parse`, `.parse.tmp-*` and `.incoming` are not reported; a stray file beside a bundle still is |
| `normal-chat-tools/read-generated-file.test.ts` *(update)* | `page` resolves to the right offset; precedence `query > from > page`; a bundle-less artifact returns the note; passages carry `pageStart`/`pageEnd` |
| `routes/api/knowledge/[id]/figure/[name]/+server.test.ts` | ownership (another user's artifact → 404), traversal names rejected, normalized→source hop, ENOENT → 404 |
| `routes/api/knowledge/extraction/[artifactId]/reextract/+server.test.ts` | unavailable tier → 400 before any job write; legacy artifact materialises a row; `wakeExtractionWorker` called |
| `db/schema.test.ts` *(update)* | `page_start` / `page_end` exist and are nullable |


---

## 5. Required changes to the Phase 3 `DocumentExtractor` seam

Phase 3 froze `src/lib/server/services/extraction/contracts.ts` (§2.1) and forbade any MinerU 4 concept in
it. Six changes are needed. **All six are additive, none names MinerU, and none changes an existing field's
meaning**, so `directTextExtractor` compiles unchanged and Phase 3's own tests stay green.

| Δ | Change | Why the current interface is insufficient |
| --- | --- | --- |
| **Δ1** | `ExtractDocumentRequest.contentSha256?: string \| null` | The V1 protocol needs the SHA-256 of the bytes at *three* points: upload create (dedupe), upload complete, and restart recovery (§2.5 R2). `artifacts.binary_hash` already holds exactly that digest (verified: `createHash("sha256").digest("hex")`, `knowledge/store/core.ts:223-225` and `routes/api/knowledge/upload/shared.ts:159`). Without this field the extractor must re-stream every byte of a 200 MB PDF to recompute a value the ledger is already holding. The field is optional and the extractor falls back to computing it, so a ledger that does not supply it still works. |
| **Δ2** | `ExtractDocumentRequest.sourceArtifactId?: string \| null` | The parse bundle is written to `data/knowledge/<userId>/<sourceArtifactId>.parse/` (§4.2). The extractor is given `filePathAbsolute` only; the artifact id is *derivable* from that path's basename today, but that is an undocumented coupling to `attachments.ts:514-519`'s naming and would break silently the day the storage layout changes. Pass it explicitly. `userId` is needed for the same reason and is already absent — add `userId: string` alongside it, or pass a single `destination: { userId, sourceArtifactId }`. **Recommended: `sourceArtifactId` + `userId`, both optional; when either is missing the extractor skips the bundle and returns text only.** |
| **Δ3** | `ExtractDocumentRequest.hints?: Readonly<Record<string, unknown>>`, persisted by the ledger in a new nullable `document_extraction_jobs.hints_json` column, accepted by `enqueueExtractionJob` and `retryExtractionJob`, cleared on a successful completion | "Re-extract at a higher tier" (§4.10) is a user action whose only payload is a tier name that must survive the enqueue→claim→attempt round trip. There is no other durable place for it: `remote_handle_json` is extractor-owned output, not input, and is cleared on `handleUnknown`. The ledger never inspects `hints`, exactly as it never inspects `handle.data`. |
| **Δ4** | `ExtractDocumentResult.structured?: unknown` (opaque to the ledger) | Phase 4's entire payload — page index, blocks, figures, outline, real tier, parser versions, chunk plan — has nowhere to travel today. `ExtractDocumentResult` carries `text`, `normalizedName`, `mimeType`, `pageCount`, `handle`. Typing it as `unknown` keeps `contracts.ts` free of MinerU vocabulary; `persist.ts` narrows it with a type guard. |
| **Δ5** | `extraction/persist.ts`: `createNormalizedArtifactFromText` gains `structured?: unknown` and is renamed `createNormalizedArtifactFromExtraction` (keep the old name as a deprecated alias for one release); `worker-runner.ts` forwards `result.structured` from the extractor to `persistResult` | `persist.ts` is where the comfort metadata, `createArtifact` and the source-artifact metadata patch live. Everything in §4.4, §4.5 and §4.6 lands there. Today the worker drops every field of `ExtractDocumentResult` except `text`, `normalizedName`, `mimeType`, `pageCount` on the floor. `PersistExtractionResultDependency` widens with it. |
| **Δ6** | `EXTRACTION_ERROR_CODES` gains **`auth_failed`** (non-retryable; **not** added to `RETRYABLE_EXTRACTION_ERROR_CODES`) | A wrong or missing `MINERU_API_KEY` is a `401 authentication_error / invalid_api_key` on every endpoint except `/v1/health`. None of the ten existing codes fits: `unavailable`/`protocol`/`timeout` are all retryable and would burn three attempts plus backoff on a fault no retry can fix, and `tier_unavailable` would tell the user the wrong thing. `auth_failed` behaves exactly like `tier_unavailable` — non-retryable, admin-fixable — and needs one i18n key pair: `chat.extraction.error.auth_failed` (Phase 3 S3) and `knowledge.extraction.error.auth_failed` (Phase 3 S4), EN + HU. **Fallback if the owner refuses to touch the taxonomy:** map 401 to `tier_unavailable` and accept a misleading message; do *not* map it to a retryable code. |

Nothing else changes. Specifically **unchanged**: `ExtractionHandle` (the `{extractor, version, remoteJobId,
remoteFileId, data}` shape is exactly right — `remoteJobId` holds `job_id`, `remoteFileId` holds the input
`file_id`, and `data` holds `{uploadId, sha256, outputZipFileId, requestedTier}`), `ExtractionProgress`
(`uploading → parsing → downloading` maps cleanly onto upload / poll / zip download), `AbortSignal`
semantics, `DocumentExtractionError`'s `retryable` / `retryAfterMs` / `handleUnknown` / `details`,
`supportsResume`, and `cancel?(handle, signal)` (which becomes `DELETE /v1/parse/jobs/{id}` swallowing 404
and 409).

**Migration note.** Δ3's `hints_json` column rides in the same SQL file as §4.6 (S0 owns the journal):
append `ALTER TABLE \`document_extraction_jobs\` ADD \`hints_json\` text;` as the first statement of
`1777140000098_mineru4_extraction.sql`, and add `hintsJson: text("hints_json")` to the Drizzle table.

---

## 6. Work slices

Six slices. **S0 runs alone first** and merges into `mineru4/p24`; the other five then start in parallel
from it. Branches `mineru4/p24-s0`, `-p2a`, `-p2b`, `-p4a`, `-p4b`, `-p4c`, one worktree each, nothing
pushed. Every contract in §2–§5 is frozen, so P2-A/P2-B/P4-* can be written against it before S0 merges,
but **no slice creates a local stub** — they rebase onto `mineru4/p24`.

No file appears in two OWNS lists.

### S0 — schema, migrations, config, admin surface *(blocking; owns every hot config/DDL file for BOTH phases)*

**Goal:** the twelve config keys exist, are validated, are visible and are localized; the two DDL changes and
the `admin_config` rename have landed; the MinerU status card is live. No extraction behaviour changes.

**OWNS (exclusive):**
- `src/lib/server/db/schema.ts`, `drizzle/1777140000098_mineru4_extraction.sql`,
  `drizzle/meta/_journal.json`, `src/lib/server/db/schema.test.ts`, `scripts/prepare-db.ts`
- `src/lib/server/env.ts`, `src/lib/server/config-store.ts`,
  `src/lib/config/admin-config-registry.ts` (+ `.test.ts`), `src/lib/i18n/settings.ts`
- `src/routes/(app)/settings/_components/system/pages.ts`,
  `.../system/IntegrationsPage.svelte`, `.../system/MineruStatusCard.svelte` *(new)*,
  `.../SettingsAdminSystemPane.svelte`
- `src/routes/api/admin/mineru-status/+server.ts` *(new)* (+ `.test.ts`)
- `src/lib/client/api/admin-system-health.ts`
- `src/lib/server/services/tool-health/types.ts`, `.../tool-health/registry.ts`
- `.env.example`, `docs/configuration.md`, `docs/uploads.md`
- `src/lib/server/services/mineru/config.ts`, `src/lib/server/services/mineru/capabilities.ts`
  (+ their tests) — the status card needs them, and splitting them from the card would give two slices a
  reason to edit the same module

**READ-ONLY:** `services/mineru/{schemas,client}.ts` (P2-A owns; S0 codes `capabilities.ts` against the §2.3
and §2.4 signatures), `extraction/**`, `shared/file-types/**`.

**Depends on:** nothing (Phases 1 and 3 merged, fixtures merged).

**Tests:** new `admin/mineru-status/+server.test.ts`, `mineru/config.test.ts`, `mineru/capabilities.test.ts`,
`SettingsAdminSystemPane.mineru-status.test.ts` (modelled on
`SettingsAdminSystemPane.system-health.test.ts`). Updated: `admin-config-registry.test.ts` (the count floor —
compute it on your branch, §2.10 step 8), `schema.test.ts`, `i18n/settings.test.ts` (must stay green after
the three key deletions), `admin-effective-config.test.ts`, `disk-reconciliation` **not** here (P4-A).

**DoD:** `npm run check` clean; `npm run check:migrations` clean; `npx vitest run src/lib/config src/lib/i18n
src/lib/server/db src/routes/api/admin src/lib/server/services/mineru` green; `grep -rn "MINERU_TIMEOUT_MS"
src/ docs/ .env.example` returns only the deprecation note in `env.ts` and `docs/configuration.md`;
`grep -rn "opendatalab/mineru" src/` returns nothing; `grep -rn "mineruDocumentExtraction" src/` returns
nothing; a fresh DB and a DB with a `MINERU_TIMEOUT_MS` override both migrate.

### P2-A — MinerU V1 protocol core *(no repo-wide surface)*

**Goal:** a fully fixture-verified client. Nothing in the app calls it yet.

**OWNS (exclusive):**
- `src/lib/server/services/mineru/schemas.ts`, `errors.ts`, `client.ts`
- `src/lib/server/services/mineru/testing/fake-server.ts`
- tests: `schemas.test.ts`, `errors.test.ts`, `client.contract.test.ts`, `client.streaming.test.ts`,
  `tier-policy.test.ts`
- `src/lib/server/services/mineru/tier-policy.ts` *(`decideTier`)*

**READ-ONLY:** `fixtures/mineru-v1/**`, `services/mineru/config.ts` (S0), `extraction/contracts.ts`,
`shared/extraction-status.ts`.

**Depends on:** S0 only for `MineruConfig`'s field names, which §2.2 freezes. May start immediately.

**Tests by file name:** as listed in §2.13 rows 1–5, 7–8.

**DoD:** every file under `fixtures/mineru-v1/` is read by at least one assertion; `errors.test.ts` fails if a
probe fixture maps to no taxonomy row; `client.streaming.test.ts` proves no `readFile` of the upload; a
`grep` shows no `page_range`, `callback`, `"ocr_mode": null` or `"tier": null` can be emitted.

### P2-B — the extractor, the registry flip, and the 3.x retirement

**Goal:** `intake.route === "mineru"` runs MinerU 4; `document-extraction.ts` is gone.

**OWNS (exclusive):**
- `src/lib/server/services/extraction/extractors/mineru4.ts` (+ `.test.ts`)
- `src/lib/server/services/extraction/extractors/registry.ts`
- deletions: `src/lib/server/services/document-extraction.ts`,
  `src/lib/server/services/document-extraction.test.ts`,
  `src/lib/server/services/extraction/extractors/legacy-mineru3.ts` (+ its test)
- `src/lib/server/services/extraction/contracts.ts` and `src/lib/shared/extraction-status.ts`
  — **the §5 Δ1/Δ2/Δ3/Δ4/Δ6 edits only**
- `src/lib/server/services/extraction/worker-runner.ts`, `.../job-ledger.ts` — **the Δ3/Δ5 pass-through only**
- `src/lib/server/services/mineru/integration.test.ts`
- `src/lib/server/services/extraction/no-inline-extraction.test.ts`,
  `.../boundary.test.ts` (the new guard assertions)

**READ-ONLY:** everything under `services/mineru/` except `integration.test.ts`; `extraction/persist.ts`
(P4-B owns the Δ5 body; P2-B only widens the *type*, and the two must agree on §5 Δ5 verbatim);
`knowledge/**`.

**Depends on:** P2-A (the client), S0 (`hints_json` DDL).

**Tests:** `extractors/mineru4.test.ts`, `mineru/integration.test.ts` (Phase 3 §6.2 scenarios 1, 5, 6 and 7
re-run against the fake V1 server: slow success, handle resume without re-submit, forget-handle → fresh
submit, cancel while parsing → `DELETE`), `no-inline-extraction.test.ts`, `boundary.test.ts`.

**DoD:** `grep -rn "document-extraction" src/` returns nothing; `extractDocumentText` has zero importers;
uploading each of the nine fixture inputs through the fake server yields a non-empty normalized artifact;
`npm run check` clean.

### P4-A — result model, renderers, parse bundle, figures

**Goal:** a `result.zip` becomes a `StructuredExtractionResult` and a bundle on disk, and the disk is kept
tidy.

**OWNS (exclusive):**
- `src/lib/server/services/mineru/result.ts` (+ `result.test.ts`, `outline.test.ts`, `chunk-plan.test.ts`)
- `src/lib/server/services/mineru/bundle.ts` (+ `bundle.test.ts`)
- `src/lib/server/services/knowledge/store/cleanup.ts` (+ `cleanup.test.ts`)
- `src/lib/server/services/disk-reconciliation.ts` (+ `.test.ts`)
- `src/routes/api/knowledge/[id]/figure/[name]/+server.ts` (+ `.test.ts`)

**READ-ONLY:** `services/mineru/{schemas,client,config}.ts`, `knowledge/store/core.ts`,
`knowledge/store/working-document-file-serving.ts` (the auth pattern to copy),
`knowledge/outline.ts` (P4-B owns the `page` field).

**Depends on:** P2-A (`schemas.ts`); S0 (`MINERU_BUNDLE_MAX_BYTES`).

**Tests by file name:** `mineru/result.test.ts`, `mineru/outline.test.ts`, `mineru/chunk-plan.test.ts`,
`mineru/bundle.test.ts`, `knowledge/store/cleanup.test.ts`, `disk-reconciliation.test.ts`,
`routes/api/knowledge/[id]/figure/[name]/+server.test.ts`.

**DoD:** the §4.3 equivalence table is asserted and green for all ten zipped fixtures; deleting an artifact
removes its bundle; `findOrphanFiles` reports zero orphans for a tree containing a bundle and an `.incoming`
directory; a traversal figure name is refused.

### P4-B — persistence: metadata, outline, re-extract

**Goal:** the structured payload reaches the database; the five-key page-count guess is gone; a user can ask
for a higher tier.

**OWNS (exclusive):**
- `src/lib/server/services/extraction/persist.ts` (+ `persist.test.ts`) — the Δ5 body
- `src/lib/server/services/knowledge/store/documents.ts` (+ `.test.ts`,
  `document-comfort-metadata.test.ts`)
- `src/lib/server/services/knowledge/outline.ts` (+ `outline.test.ts`) — the optional `page` field and
  `readStoredOutline` pass-through
- `src/lib/server/services/knowledge/types.ts`
- `src/routes/api/knowledge/extraction/[artifactId]/reextract/+server.ts` (+ `.test.ts`)
- `src/routes/(app)/knowledge/_components/DocumentsList.svelte` (+ `.test.ts`),
  `src/lib/i18n/knowledge.ts`
- `src/lib/client/api/knowledge.ts`

**READ-ONLY:** `services/mineru/**`, `extraction/{contracts,worker-runner,job-ledger}.ts`,
`knowledge/store/core.ts` (P4-C owns the `chunkPlan` parameter).

**Depends on:** P4-A (`StructuredExtractionResult`), P2-B (Δ4/Δ5 type), S0 (capabilities for the tier list).

**Tests:** `persist.test.ts` (metadata keys per §4.4; legacy rows unaffected; the outline fallback chain),
`document-comfort-metadata.test.ts` (updated — `pageCount` now comes from `page_count ?? pages.length`),
`outline.test.ts` (updated — `page` survives a JSON round trip, a non-integer `page` is dropped),
`reextract/+server.test.ts`, `DocumentsList.test.ts` (updated — the Re-extract submenu, EN + HU).

**DoD:** a fixture upload produces an artifact whose metadata carries `extractionProducer`, `extractionTier`
(`flash` for the DOCX inside a `basic` job), `pageCountKind` and a non-guessed `pageCount`;
`grep -rn "total_pages\|num_pages\|pages_count" src/` returns nothing; EN/HU parity green.

### P4-C — structure-aware chunking, page citations, `read_generated_file`

**Goal:** chunks know their pages, the prompt says so, and the model can ask for a page.

**OWNS (exclusive):**
- `src/lib/server/services/task-state/chunk-sync.ts` (+ `chunk-sync.test.ts`)
- `src/lib/server/services/task-state/artifacts.ts` (+ `artifacts.test.ts`,
  `artifacts.page-citation.test.ts`), `src/lib/server/services/task-state/mappers.ts`
- `src/lib/server/services/knowledge/store/core.ts` — **the `chunkPlan` parameter on `createArtifact` only**
- `src/lib/server/services/conversation-forks.ts` (+ `conversation-forks.test.ts`) — the chunk-copy columns
- `src/lib/server/services/normal-chat-tools/read-generated-file.ts` (+ `.test.ts`)
- **`src/lib/server/services/normal-chat-tools/index.ts`** — HOT, sole owner, the EN + HU description edit

**READ-ONLY:** `services/mineru/result.ts` (`ChunkPlanEntry`, `planStructuredChunks`),
`extraction/persist.ts` (P4-B calls `createArtifact` with the plan — the two must agree on the parameter
name verbatim), `chat-turn/context-selection.ts`, `utils/prompt-context.ts` (**neither is edited** — §4.7
keeps the change inside `combineSnippetChunks`).

**Depends on:** S0 (the `page_start`/`page_end` DDL), P4-A (`planStructuredChunks`).

**Tests by file name:** `task-state/chunk-sync.test.ts`, `task-state/artifacts.page-citation.test.ts`,
`mineru/chunk-plan.test.ts` *(P4-A owns the file; P4-C must not edit it)*, `conversation-forks.test.ts`,
`normal-chat-tools/read-generated-file.test.ts`, `normal-chat-tools/index.test.ts` (EN and HU both contain
the new sentence and nothing else changed).

**DoD:** a chunked PDF never has a chunk that splits a GFM table; a forked conversation keeps
`page_start`/`page_end`; `[p. N]` appears in the Retrieved Evidence body for a `physical` document and never
for a `declared` or `logical` one; the small-file bypass is byte-identical to today; the two tool-description
strings differ from their previous value by exactly one appended sentence each.

### Hot-file ownership summary (both phases)

| File | Concerns that want it | Sole owner |
| --- | --- | --- |
| `src/lib/server/db/schema.ts`, `drizzle/**`, `drizzle/meta/_journal.json`, `scripts/prepare-db.ts` | `page_start`/`page_end`, `hints_json`, the `admin_config` rename | **S0** |
| `src/lib/server/env.ts`, `config-store.ts`, `admin-config-registry.ts`, `i18n/settings.ts` | 12 config keys, the secret, the docker-text removal, the orphan key | **S0** |
| `settings/_components/system/{pages.ts,IntegrationsPage.svelte}`, `SettingsAdminSystemPane.svelte` | key rows + status card | **S0** |
| `services/tool-health/{types,registry}.ts` | the MinerU probe | **S0** |
| `services/mineru/{config,capabilities}.ts` | status card + tier fast-fail | **S0** |
| `services/mineru/{schemas,errors,client,tier-policy}.ts`, `testing/fake-server.ts` | the protocol | **P2-A** |
| `extraction/contracts.ts`, `shared/extraction-status.ts`, `extraction/{worker-runner,job-ledger}.ts` | the §5 deltas | **P2-B** |
| `extraction/extractors/registry.ts` + the 3.x deletions | the flip | **P2-B** |
| `services/mineru/{result,bundle}.ts` | parse model + bundle | **P4-A** |
| `knowledge/store/cleanup.ts`, `disk-reconciliation.ts` | bundle lifecycle | **P4-A** |
| `extraction/persist.ts`, `knowledge/store/documents.ts`, `knowledge/outline.ts`, `knowledge/types.ts` | metadata + outline | **P4-B** |
| `src/lib/i18n/knowledge.ts`, `DocumentsList.svelte`, `client/api/knowledge.ts` | re-extract UI | **P4-B** |
| `task-state/{chunk-sync,artifacts,mappers}.ts`, `knowledge/store/core.ts`, `conversation-forks.ts` | chunking + citations | **P4-C** |
| **`normal-chat-tools/index.ts`** | the EN + HU tool description | **P4-C** |
| `normal-chat-tools/read-generated-file.ts` | the `page` parameter | **P4-C** |

### Files the Phase 1 or Phase 3 specs also touch

| File | Phase 1 slice | Phase 3 slice | Phase 2/4 slice | Interaction |
| --- | --- | --- | --- | --- |
| `src/lib/server/services/document-extraction.ts` | **D** (rows 1, 2 — `getIntakeRoute` switch, `getCanonicalMimeForExtension`) | S1 wraps it in `legacy-mineru3.ts`, does not edit it | **P2-B deletes it** | Both earlier phases must be merged first; the deletion is a `git rm`, not a merge. A reviewer must confirm nothing Phase 1 moved *into* it is lost — it is not: rows 1 and 2 moved logic *out*. |
| `src/lib/server/env.ts`, `config-store.ts`, `admin-config-registry.ts` (+ test), `i18n/settings.ts` | *(P1: read-only, "nobody owns them")* | **S1** (11 `DOCUMENT_EXTRACTION_*` keys) | **S0** (12 `MINERU_*` keys) | Same blocks, same four config-store idioms. **S0 must rebase onto merged Phase 3, never merge blind.** The `ADVANCED_KEY_SPECS` floor is the collision point: 84 → 95 (P3) → **107** (P3+P2/P4). Recompute, do not copy a number from either spec. |
| `src/lib/i18n/knowledge.ts` | **C** (5 upload-reject keys) | **S4** (extraction status keys) | **P4-B** (`knowledge.extraction.reextract.*`) | Same `en`/`hu` blocks, three phases deep. P4-B rebases last. `i18n.test-helpers.ts` already audits `"knowledge.extraction"` after P3 S4 — the new keys are covered automatically. |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | **C** (accept, icons, labels) | **S4** (status column, Retry/Cancel) | **P4-B** (Re-extract submenu) | Disjoint regions, three large edits. P4-B adds to the P3 action menu rather than creating a second one. |
| `src/lib/client/api/knowledge.ts` | **C** | **S3** (`fetchExtractionJobs`/`retryExtraction`/`cancelExtraction`) | **P4-B** (`reextractDocument`) | Append only. |
| `src/lib/server/services/knowledge/store/documents.ts` | — | **S2** (`createNormalizedArtifact` → moved to `persist.ts`, wrapper deleted) | **P4-B** | P3 empties this file of extraction logic; P4-B then edits `persist.ts`, not this one — if S2's deletion did not happen, P4-B must do it before starting. |
| `src/lib/server/services/extraction/persist.ts` | — | **S1** (created) | **P4-B** (Δ5 body) | Frozen signature in §5 Δ5; P2-B widens the type, P4-B writes the body. They must agree verbatim. |
| `src/lib/server/services/extraction/contracts.ts`, `shared/extraction-status.ts` | — | **S1** (created, "no MinerU concepts by name") | **P2-B** (Δ1–Δ4, Δ6) | Every delta is additive and MinerU-free, so the rule survives. Phase 3's `extraction-status.test.ts` zero-value-import and `canceled`-spelling assertions must stay green after Δ6. |
| `src/lib/server/services/normal-chat-tools/index.ts` | **E** (HOT, tool description prose "byte-identical") | — | **P4-C** (one appended sentence, EN + HU) | Phase 1 slice E's DoD explicitly demands byte-identical tool descriptions for prefix-cache preservation. **P4-C deliberately breaks that**, once, with the §4.8 rationale and measurement. The reviewer must confirm P1's byte-identity test (if it exists as an assertion) is updated rather than deleted. |
| `src/lib/server/services/normal-chat-tools/read-generated-file.ts` | **D** | — | **P4-C** | Disjoint. |
| `src/lib/server/services/conversation-forks.ts` | **D** (`getFileExtension` only) | — | **P4-C** (chunk copy columns) | Disjoint regions. |
| `src/lib/server/services/knowledge/store/core.ts` | **C** (`fileExtension` becomes a re-export) | read-only | **P4-C** (`chunkPlan` param) | Disjoint. |
| `src/lib/server/services/knowledge/store/attachments.ts` | **E** (`getSupportedExtractionSummary`) | **S2** (dedupe, rename, readiness) | read-only | No Phase 2/4 edit. |
| `scripts/verify-live-file-production-types.ts` | **D** (row 64) | — | read-only | §7's new script is a sibling, not an edit. |
| `docs/uploads.md`, `docs/configuration.md`, `.env.example` | — | **S1** (`DOCUMENT_EXTRACTION_*` rows) | **S0** | Append; S0 rebases. |

---

## 7. `scripts/verify-live-extraction-types.ts`

Modelled on `scripts/verify-live-file-production-types.ts` (534 lines). Owned by **P4-B**. A standalone
`tsx` script: top-level `main().catch(...)`, no `src/` imports, every type re-declared locally, no `.test.ts`
beside it. Playwright holds the session cookie; a plain `fetch` does the work.

### Configuration — env only, no CLI args

| Env var | Default | Purpose |
| --- | --- | --- |
| `LIVE_AI_BASE_URL` | `https://ai.alfydesign.com` | |
| `LIVE_AI_EMAIL` / `LIVE_AI_PASSWORD` | *(required, via `requireEnv` inside `login`)* | |
| `LIVE_AI_HEADLESS` | headless unless `"false"` | |
| `LIVE_AI_KEEP_CONVERSATION` | delete unless `"true"` | |
| `LIVE_AI_TIMEOUT_MS` | `600000` | raised from 240 s: a cold `basic` PDF is ~18.6 s and a `standard` PDF is unmeasured |
| `LIVE_AI_OUTPUT_DIR` | `test-results/live-extraction-types-<ISO with : and . → ->` | |
| `LIVE_EXTRACTION_FIXTURE_DIR` | `fixtures/mineru-v1` | the nine `<name>/sample.*` inputs |
| `LIVE_EXTRACTION_CASES` | all | comma-separated case ids, for a narrow smoke |
| `LIVE_EXTRACTION_TIER` | *(unset)* | when set, each case is additionally re-extracted at this tier |

### Invocation

```
LIVE_AI_BASE_URL=https://ai.alfydesign.com LIVE_AI_EMAIL=… LIVE_AI_PASSWORD=… \
  npx tsx scripts/verify-live-extraction-types.ts
```

Documented in `docs/uploads.md` next to the MinerU section, the same way
`docs/archive/file-production-job-ledger-deepening-slices.md:130` documents its sibling.

### Case table

Nine cases, one per fixture input, each declaring what the recorded spike says must come back:

```ts
interface ExtractionCase {
	id: "pdf" | "docx" | "xlsx" | "pptx" | "html" | "csv" | "epub" | "png" | "jpg";
	file: string;                       // <fixtureDir>/<id>/sample.<ext>
	mimeType: string;
	expect: {
		/** extensions.mineru.tier, as recorded on a `basic` server. */
		effectiveTier: "flash" | "basic";
		pageCount: number;
		pageCountKind: "physical" | "sheet" | "slide" | "spine" | "declared" | "logical" | "unknown";
		minTextLength: number;          // the zipped markdown.md byte count, minus slack
		/** Substrings that MUST appear in contentText — the NATO words from the fixtures. */
		mustContain: readonly string[]; // e.g. ["ALFA Quarterly Overview", "Northland"]
		/** Substrings that MUST NOT appear — the running heads. */
		mustNotContain: readonly string[]; // pdf: ["INDIA Confidential", "JULIET Document Footer", "Page 1"]
		figureCount: number;
		outlineMin: number;
	};
}
```

Expected values are transcribed from §1.4 and the fixture markdown, so the script is the live counterpart of
`result.test.ts`. `png`/`jpg` expect `pageCountKind: "unknown"` and `pageCount: 1`; `csv` expects an empty
outline; `pdf` and `docx` expect one figure each.

### Flow

1. `mkdir -p` the output dir; `chromium.launch({ headless })`; `login()` → `POST /api/auth/login`, throw on
   `!response.ok()`.
2. `GET /api/admin/mineru-status` once. Record `version`, `tiers`, `outputFormats`, `reachable`. **Abort the
   whole run with a clear message when `reachable` is false** — every case would fail identically.
3. Create ONE conversation, reused by every case (`POST /api/conversations`, title
   `Live extraction sweep <ISO>`).
4. Per case, sequentially (never in parallel — `max_concurrent_jobs` is 1):
   a. `POST /api/knowledge/upload/intent` → `POST /api/knowledge/upload/raw` with the fixture bytes and the
      `x-alfyai-upload-conversation` header, exactly as the app does. Record `artifact.id`.
   b. Poll `GET /api/knowledge/extraction?artifactIds=<id>` every 1 500 ms until
      `status ∈ {succeeded, failed, canceled}` or `LIVE_AI_TIMEOUT_MS`. Record every distinct status seen,
      so the run proves the ladder (`queued → uploading → parsing → downloading → indexing → succeeded`)
      rather than just the end state.
   c. `GET /api/knowledge/<normalizedArtifactId>/download` for the text, and the Knowledge library read model
      for the metadata.
   d. Assert every `expect` field. On a mismatch record it and continue — one bad type must not abort the
      sweep (the `postProduceFile` "missing-job" trick in the sibling script).
   e. When `LIVE_EXTRACTION_TIER` is set: `POST /api/knowledge/extraction/<artifactId>/reextract`
      `{ tier }`, poll again, and record the new `extractionTier`, `pageCount`, text length and
      `unknownBlockTypes` **as a diff against the first pass**. This is the §8 checklist's data collector.
5. `finally`: delete the conversation unless `LIVE_AI_KEEP_CONVERSATION=true`; close the browser.

### Output

One `summary` object, pretty-printed to stdout **and** written to `<outputDir>/summary.json`:

```ts
{
	baseUrl, conversationId, keptConversation, createdAt,
	server: { version, tiers, outputFormats, reachable },
	tierUnderTest: string | null,
	results: Array<{
		id, ok, artifactId, normalizedArtifactId,
		statusesSeen: string[], elapsedMs,
		actual: { effectiveTier, pageCount, pageCountKind, textLength, figureCount, outlineLength,
		          unknownBlockTypes: Record<string, number>, parserVersion, producerVersion },
		mismatches: string[],
		reextract: { tier, ok, elapsedMs, deltas: Record<string, [unknown, unknown]> } | null,
	}>,
	ok: boolean,
}
```

`process.exitCode = 1` when `!summary.ok` (soft, so the summary still flushes); an unhandled throw hits
`main().catch` → `console.error` + `process.exit(1)`.

**Safety.** The script only uploads, reads and deletes its own conversation. It never writes config, never
touches another user's artifacts, and never runs on the box itself — it drives the deployed app over HTTPS
from a workstation, which is what keeps it clear of the prod-ssh-write classifier.

---

## 8. GPU-box re-verification checklist (`standard` tier, before cutover)

Everything in §1.5 is unverified. This is the list that must be walked on the GPU box with a server started
at `--tier standard` (and, if available, `--tier advanced`) **before** MinerU 4 carries production traffic.
Run `LIVE_EXTRACTION_TIER=standard npx tsx scripts/verify-live-extraction-types.ts` first; it collects most
of the data mechanically.

**Protocol**

- [ ] `GET /v1/health` still reports `features.output_formats` containing all four of
      `markdown`, `middle_json`, `structured_content`, `zip`.
- [ ] `GET /v1/tiers` lists `standard` (and `advanced`), and `decideTier` rule 3 sends it without a 400.
- [ ] `POST /v1/parse/jobs` with `tier: "standard"` returns **202**, and the terminal job's `tier` field
      echoes `standard`.
- [ ] A `standard` job still returns all seven `output_files` keys with `null` for the unrequested ones.
- [ ] `output_files.zip` still contains `markdown.md`, `middle_json.json`, `structured_content.json`,
      `model_output.json` and `images/`. **Also probe `output_formats: ["zip"]` alone** and record whether the
      zip still contains all four — the one unverified assumption behind D1 (§2.6).
- [ ] `GET /v1/files/{id}/content` still streams 200 with `application/octet-stream` and no 302.
- [ ] `parse.model_used` — record whether it becomes non-null at `standard`. If it does, add it to
      `extractionServerModel` in §4.4 metadata.
- [ ] `parse.parser_version` still `"4.0.4"` (or record the new value).
- [ ] Re-run the whole `errors/` probe set against the `standard` server and diff against
      `fixtures/mineru-v1/errors/`; any code that changed breaks the §2.9 table.
- [ ] Confirm `max_concurrent_jobs` in `/v1/usage` on the GPU box — if it is >1, Phase 3's
      `DOCUMENT_EXTRACTION_MAX_CONCURRENCY` (3) may need raising, and if it is still 1 the ledger's global
      cap should be lowered to 1 to stop queueing at the wrong layer.
- [ ] Trigger `429 rate_limit_exceeded` and `413 file_too_large` at least once each (a 250 MB file against
      the 200 MB `max_file_size_bytes`), and confirm the taxonomy mapping and `Retry-After` handling.
- [ ] Time a cold and a warm `standard` PDF; confirm `MINERU_JOB_TIMEOUT_MS` (300 s) and Phase 3's
      `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` (900 s) still bracket it with room (Phase 3 OQ5's
      `Math.max(stale, timeout * 2)` coupling).

**`structured_content` shape**

- [ ] `pages[].blocks[]` is still the container — not `items`, not a Draft-shaped envelope.
- [ ] `content` is still a **Markdown string** for every block type at `standard`. **If it becomes an object
      or an array, `renderPromptMarkdown` must be re-specified before cutover** — this is the single biggest
      shape risk in the plan.
- [ ] Record `extractionUnknownBlockTypes` from the sweep. Expect new members of
      {`equation_interline`, `code`, `chart`, `algorithm`, `index`}. For each one that appears:
      confirm the atomic-block rule holds (§4.6 rule 2), confirm it renders sensibly, and decide whether it
      needs a dedicated renderer branch.
- [ ] `bbox` is still a flat array of four 0..1 floats where present, and still **absent** (not null) for
      Office/HTML.
- [ ] `extensions.mineru.tier` reports `standard` for PDF/image, and **still reports `flash` for
      Office/HTML/CSV/EPUB** inside a `standard` job (the effective-tier trap).
- [ ] `metadata.document.page_count` / `page_count_kind` unchanged for the seven formats that carry them,
      still absent for PNG/JPEG.
- [ ] `metadata.file_suffix` for a PNG — still `"pdf"`, or fixed? Either way the parser ignores it.
- [ ] `level` on headings at `standard`: is a PDF still flat at level 2, or does the VLM infer depth? If it
      infers depth, §4.5's PDF row and the outline tests change.
- [ ] `header` / `footer` / `page_number` still emitted separately for PDF and still excluded from
      `markdown.md`.
- [ ] Re-run the §4.3 equivalence check live: `renderMineruMarkdown(structured_content)` vs the zip's
      `markdown.md` for a `standard` PDF. **A mismatch beyond the known anchor lines blocks cutover.**

**Real-document coverage (none of this exists in any fixture)**

- [ ] A multi-column academic PDF.
- [ ] A PDF with display equations — confirm the block type and that the chunker treats it as atomic.
- [ ] A PDF with fenced code.
- [ ] A PDF with a chart/figure that MinerU classifies as `chart`.
- [ ] A scanned / skewed / rotated page (forces `parse_mode: "ocr"`).
- [ ] A document with a table of contents.
- [ ] A ≥100-page PDF: check `pages.length`, the bundle size against `MINERU_BUNDLE_MAX_BYTES`, the chunk
      count, and the wall-clock against the job deadline.
- [ ] A **multi-file** job is never issued by this client, but confirm `status: "partial"` cannot reach us.

**End-to-end in the app**

- [ ] Upload each of the nine types through the real UI; each reaches `succeeded` and the composer chip
      settles without a manual refresh.
- [ ] Kill the app process mid-`parsing` and restart: the attempt resumes the same remote job (Phase 3 DoD).
- [ ] Restart **MinerU** mid-`parsing`: the next attempt re-uploads by hash and succeeds (§2.5 R1–R3).
- [ ] `[p. N]` citations appear in a real turn's prompt for a `physical` document and nowhere else —
      verify against a captured prompt, not by reading code.
- [ ] `read_generated_file` with `page` returns the right window for a ≥10-page PDF.
- [ ] The figure endpoint serves a real image and refuses another user's artifact.
- [ ] Re-extract at `standard` from the Knowledge list replaces the bundle, keeps the normalized artifact id,
      and re-chunks.
- [ ] Prefix-cache re-warm after the tool-description change: record the vLLM cache hit rate before and after,
      per the existing prompt-cost runbook.

---

## 9. Non-goals, risks, open questions

### 9.1 Non-goals

- **The ledger, the worker, concurrency, retries, backoff, cancellation bookkeeping.** All Phase 3. This
  spec adds one optional field to a request, one to a result, one column, and one error code.
- **The registry.** Phase 1 owns `intake.route` / `intake.tierHint`. Enabling `rtf`/`ods`/`odp`/`epub`/`ofd`/
  `tsv` stays the one-line-per-entry edit Phase 1 §2.5 describes; this spec does not enable any of them.
- **Figure UI.** The endpoint and the manifest ship; no component renders an image (§4.9).
- **Images or page counts for generated-file readback.** `chat-files.ts` has no knowledge-tree bytes and
  therefore no bundle; it keeps consuming `text` only (§4.4).
- **`middle_json` consumers.** HTML tables and `styles:["bold"]` are downloaded (free, inside the zip) and
  discarded. No feature reads them.
- **Backfilling existing documents** (D12 — decided, and shipped, after this spec: see the D12 note above), and **any change to the small-file chunking bypass**, the
  embedding substrate, `syncArtifactChunks`'s delete-then-insert contract, or the
  `WORKING_SET_*_TOKEN_BUDGET` values.
- **A second HTTP protocol.** There is no dual-mode client and no 3.x fallback (D3). If MinerU 4 is
  unreachable, extraction fails and retries — it does not silently degrade.
- **`page_range`, `callback`, `url`/`inline`/`local` sources, `/v1/models`, file listing, output formats
  `html`/`latex`/`docx`.**
- **Localizing the `## Retrieved Evidence` section.** It is an English-only prompt literal today and stays
  one (§4.7).

### 9.2 Risks

| Risk | Why it bites here | Mitigation |
| --- | --- | --- |
| **`standard`/`advanced` output is completely unverified** | The whole parser is built on `flash`/`basic` fixtures. If `content` stops being a Markdown string at `standard`, `renderPromptMarkdown` is wrong for exactly the tier the GPU box will run. | §8 is a hard gate, not a suggestion. The unknown-type counter is persisted per artifact so a surprise is visible in the data, not only in a log. The atomic-block default means an unknown block is never mangled, only under-chunked. |
| **The effective-tier trap** | A `standard` job silently runs Office/HTML/CSV/EPUB at `flash`. An admin who sets `MINERU_DEFAULT_TIER=standard` and sees `extractionTier: "flash"` on a DOCX will think it is broken. | `extensions.mineru.tier` is what is persisted and displayed, never the job tier; `extractionJobTier` is kept beside it for diagnostics; the admin card lists the tiers the server actually serves. |
| **Deleting `document-extraction.ts` across three phases** | Phase 1 rewrites it, Phase 3 wraps it, Phase 2 deletes it. A mis-ordered merge silently resurrects the 3.x client. | The `no-inline-extraction.test.ts` guard asserts the file does not exist and that `extractDocumentText` has zero importers. Both are cheap and fail loudly. |
| **`conversation-forks.ts` chunk copier** | It hand-lists nine columns (`:869-883`). Forgetting the two new ones loses every page citation in a forked conversation, with no type error and no test failure unless one is added. | Named as a required test in §4.12 and in P4-C's DoD. The adversarial reviewer should grep for the copier and count columns. |
| **`ADVANCED_KEY_SPECS` floor collision** | Three specs (P1 implicitly, P3 explicitly, this one) each state a number. Whoever merges last is wrong. | §2.10 step 8 refuses to state a single number and requires recomputation on-branch and at integration-merge time. |
| **Tool-description prefix-cache invalidation** | Phase 1 slice E's DoD demands byte-identical tool descriptions; P4-C breaks that deliberately. | §4.8: one sentence, one release, measured. OQ5 offers the undocumented-parameter fallback. |
| **Disk growth** | A bundle per source artifact, images included. A 100-page image-heavy PDF could approach the 32 MiB cap. | `MINERU_BUNDLE_MAX_BYTES`, image-dropping with `imagesOmitted`, `extractionBundleBytes` in metadata for reporting, deletion wired into `cleanup.ts`, and the `.parse` exclusion in `findOrphanFiles` so the report stays readable. |
| **`findOrphanFiles` false positives** | It walks recursively with no exclusions and already mis-reports `.incoming`. A bundle would swamp it. | Fixed in the same slice (P4-A), including the pre-existing `.incoming` bug. |
| **The zip is the only download** | If a future MinerU stops putting `structured_content.json` in the zip, every extraction fails at once. | Explicit assertion with a `protocol` (retryable) failure and a distinct message, plus the §8 probe of `output_formats: ["zip"]`. |
| **Small documents have no chunks at all** | The whole 3-page PDF fixture renders to 1 306 characters, well under the 5 000-char bypass. Page citations only exist on chunk rows, so most documents will show none. | Deliberate and documented: `selectDocumentPassages`'s synthesized pseudo-chunk carries `pageStart: null` and simply omits the citation. Lowering the threshold is out of scope (OQ6). |
| **API key handling** | A key in `admin_config` is read by `getResolvedAdminConfigValues` and returned by `GET /api/admin/config`. | `MINERU_API_KEY` masks to `"[set]"` like the four existing masked secrets — explicitly **not** like `PARALLEL_API_KEY`/`BRAVE_SEARCH_API_KEY`, which leak in cleartext today (a pre-existing bug this spec does not fix; see OQ8). The same-origin rule stops the key following a server-supplied `upload_url`. |

### 9.3 Open questions

| # | Question | Recommended answer |
| --- | --- | --- |
| OQ1 | Does `output_formats: ["zip"]` alone still produce a four-artifact zip? If so, should we stop requesting the other three? | **Keep requesting all four** until §8 proves otherwise. Requesting a format costs generation, not transfer, and the four-format request is the only configuration with fixture backing. Revisit with data. |
| OQ2 | `MINERU_DEFAULT_TIER` default: `auto` (omit, inherit the server's startup tier) or a hard `basic`? | **`auto`.** It reproduces every recorded fixture exactly, it lets the GPU box's `--tier` flag be the single source of truth, and rule 5 already rescues the flash-only case. A hard default would have to be changed in two places whenever the box changes. |
| OQ3 | Add `auth_failed` to the taxonomy (Δ6), or map 401 onto an existing code? | **Add it.** Three wasted attempts plus backoff on a wrong API key is a worse outcome than two i18n key pairs. If the owner refuses, map to `tier_unavailable` (non-retryable) and accept the misleading message — never to a retryable code. |
| OQ4 | Should the MinerU status live on the Integrations page as a card, in the Diagnostics tool-health table, or both? | **Both**, as specified. The tool-health row is ten lines and fixes a real gap (MinerU is the only major backend missing from that table); the card is where an admin editing `MINERU_*` keys actually is. |
| OQ5 | Is the one-time prefix-cache invalidation worth documenting the `page` parameter to the model? | **Yes, once, measured** (§4.8). A parameter the model never discovers is dead weight; the cache re-warms in normal traffic. Fallback if the owner disagrees: ship `page` undocumented and revisit at the next unavoidable tool-description change. |
| OQ6 | `SMALL_FILE_THRESHOLD_CHARS` is 5 000, so most documents have zero chunks and therefore no page citations. Lower it for `mineru`-route artifacts? | **No, not in this phase.** It changes retrieval behaviour for every existing document and is orthogonal to MinerU. Ship page citations for the documents that are chunked, measure how many real uploads fall under the threshold, and raise it as a separate change if the answer is "most". |
| OQ7 | Keep `middle_json` in the parse bundle for a future HTML-table or bold-run consumer? | **No.** It is the second-largest artifact and nothing reads it. It stays inside the downloaded zip (free) and is discarded. Re-extract regenerates it in seconds if a consumer ever appears. |
| OQ8 | `PARALLEL_API_KEY` and `BRAVE_SEARCH_API_KEY` are returned in cleartext by `GET /api/admin/config` while being rendered with `SecretField`. Fix them in this phase? | **No — out of scope, but file it.** `MINERU_API_KEY` is masked correctly from day one. Fixing the other two is a two-line change in `config-store.ts:1617,1639` plus a check that no admin UI depends on reading the value back; it deserves its own review, not a ride-along in a 6-slice migration. |
| OQ9 | Should `metadata.document.title` (present for PDF/HTML/EPUB) become the artifact `summary` or `name`? | **No.** `guessSummary` is unchanged and renaming an artifact from document metadata would surprise users who named their file deliberately. Store nothing extra; the title is already the first outline entry for HTML/EPUB. |
| OQ10 | One SQL migration for both phases (as specified), or one per phase? | **One**, per D9. Two files mean two slices editing `drizzle/meta/_journal.json`, which is precisely the conflict Phase 3 §1.2 avoided. The migration is three ALTERs and two `admin_config` statements — small enough to review as one unit. |
| OQ11 | `page_range` support (extract only pages 5–20 of a 400-page PDF) — worth adding while we are here? | **No.** The server defers non-PDF `page_range` errors to a file-level failure, there is no UI for selecting pages, and partial extraction would make `pageCount` and the page index lie about the source document. Revisit only with a real user request. |
| OQ12 | Should a failed `standard` re-extract fall back to the previous successful `basic` result? | **No.** Phase 3's ledger keeps the job `failed` with a Retry affordance, and the previous normalized artifact and bundle are only replaced on success (the bundle write is atomic, §4.2). The user sees the old, working document plus an error — which is the correct outcome and needs no new machinery. |

---

## 10. Definition of done for Phases 2 and 4

- [ ] `document-extraction.ts` does not exist; `extractDocumentText` has zero importers.
- [ ] Every file under `fixtures/mineru-v1/` is read by at least one test; `errors.test.ts` fails on an
      unmapped probe.
- [ ] Uploading each of the nine fixture types through the app yields a normalized artifact whose metadata
      carries `extractionProducer`, `extractionTier`, `pageCountKind` and a non-guessed `pageCount`.
- [ ] A killed app process mid-`parsing` resumes the remote job; a restarted **MinerU** is recovered by
      re-upload-by-hash without a user-visible failure.
- [ ] A chunked PDF never splits a table; a forked conversation keeps `page_start` / `page_end`.
- [ ] `[p. N]` appears in a captured Retrieved Evidence section for a `physical` document and never for a
      `declared` or `logical` one.
- [ ] The admin Integrations page shows MinerU's version, tiers and output formats, and says
      "unreachable" when the service is down.
- [ ] `grep -rn "opendatalab/mineru" src/` and `grep -rn "mineruDocumentExtraction" src/` both return
      nothing; `MINERU_TIMEOUT_MS` survives only as a deprecated env fallback.
- [ ] `npm run check` clean; `npm run lint` clean; `npm run check:migrations` clean; `npx vitest run` green.
- [ ] Fallow reports no new findings (`AGENTS.md` Fallow Audit Gate).
- [ ] EN/HU parity green; the two `read_generated_file` descriptions differ from their previous value by
      exactly one appended sentence each.
- [ ] §8's GPU-box checklist is walked and its results recorded before cutover.

---

## Orchestrator rulings (2026-09-20) — these override anything above that conflicts

- **Order of phases.** Phase 3 (ledger) is built and merged first. This spec's slices then start from the merged Phase 3 code, and their file-ownership lists must be re-checked against it. The six additive `DocumentExtractor` changes (Δ1–Δ6) are accepted and are folded INTO Phase 3 slice S1, so the seam is right from the start and Phase 2 does not have to reopen it.
- **Open questions.** Every recommended answer is adopted. OQ1: request all four output formats until the GPU box proves `zip` alone is enough. OQ2: `MINERU_DEFAULT_TIER` defaults to `auto`. OQ3: add `auth_failed`. OQ6: leave `SMALL_FILE_THRESHOLD_CHARS` alone. OQ8: out of scope, listed in the migration doc for the owner. OQ10: one SQL migration per phase branch; the migration `idx`/`when` pair and the `ADVANCED_KEY_SPECS` floor are recomputed at merge time, never copied from a spec.
- **OQ5 (prompt prefix cache).** Accepted once: all model-facing prose changes of this migration (the `page` parameter on `read_generated_file`, the missing `area` / `stackedBar` chart types, any format-list change from Phases 5 and 6) ship together in ONE release so the prefix-cache eviction is paid a single time. Until that release the `page` parameter ships undocumented. The Phase 1 byte-identity tests are updated in that same change, deliberately.
- **Branches.** Integration branch `mineru4/p24`, slices `mineru4/p24-s0`, `-p2a`, `-p2b`, `-p4a`, `-p4b`, `-p4c`. S0 runs alone first. Nothing is pushed.
- **Worktrees.** Agent worktrees do not start from the integration branch; the first command of every slice is `git checkout -b <slice-branch> <integration-branch>`.
- **Toolchain and commits.** Homebrew `node@22`. Stage by explicit path; never `git add -A`.

---

## Slice S0 outcome (merged into `mineru4/p24`) — the frozen contract for P2-A, P2-B, P4-A, P4-B, P4-C

The merged code is the contract. Where this section or the code disagrees with the body of the spec, the code wins. Read `src/lib/server/services/mineru/{config,capabilities}.ts` and `src/lib/server/services/extraction/` before writing anything.

**Worktree base.** Agent worktrees do NOT start from `mineru4/p24`. First command: `git checkout -b mineru4/p24-<slice> mineru4/p24`. Then `mkdir -p data`.

**Already landed before this phase (do not add again).** The ledger migration `…097` (journal idx 110) with `hints_json`; `auth_failed` in `EXTRACTION_ERROR_CODES`; seam changes Δ1–Δ6 in `extraction/contracts.ts`, `persist.ts` (`createNormalizedArtifactFromExtraction(…, structured?)`), `worker-runner.ts`; `job.normalized_artifact_id` is `ON DELETE CASCADE`; re-extraction rewrites the existing normalized artifact in place (one normalized document per source, id preserved); `task-state/chunk-sync.ts` has a batched insert, a windowed boundary search and `MAX_ARTIFACT_CHUNKS = 12000` with a `truncated` indication; fixtures are in `fixtures/mineru-v1/` on this branch.

**Migration.** `drizzle/1777140000098_mineru4_extraction.sql`, journal idx 111. `artifact_chunks.page_start` / `page_end` (Drizzle `artifactChunks.pageStart` / `.pageEnd`), nullable, no index. It also renames an `admin_config` override of `MINERU_TIMEOUT_MS` to `MINERU_JOB_TIMEOUT_MS`. No other slice adds a migration. P4-C: the chunk copy in `conversation-forks.ts` must carry both columns.

**Config.** Twelve keys, group `integrations`, live: `MINERU_API_URL`, `MINERU_API_KEY` (masked `[set]`), `MINERU_DEFAULT_TIER` (`auto`), `MINERU_OCR_MODE` (`auto`), `MINERU_JOB_TIMEOUT_MS` (300000), `MINERU_POLL_MIN_MS` (2000), `MINERU_POLL_MAX_MS` (30000), `MINERU_REQUEST_TIMEOUT_MS` (30000), `MINERU_TRANSFER_TIMEOUT_MS` (600000), `MINERU_CAPABILITIES_TTL_MS` (300000), `MINERU_BUNDLE_MAX_BYTES` (33554432), `MINERU_STRUCTURE_CHUNKING_ENABLED` (true). Never read `getConfig()` fields directly: use `resolveMineruConfig()` from `$lib/server/services/mineru/config`, which also exports `MINERU_TIER_IDS` / `MineruTierId` (P2-A re-exports these, never redeclares), `MINERU_OUTPUT_FORMATS`, `MineruConfig`, `mineruUrl(config, "/v1/…")`, `isSameMineruOrigin`, `isMineruConfigured`, `mineruDisplayOrigin`. The `ADVANCED_KEY_SPECS` floor is 107.

**Capabilities** (`services/mineru/capabilities.ts`, S0-owned, nobody else edits it): `getMineruCapabilities(signal?, opts?)` → `{version, outputFormats, tiers: readonly MineruTierId[]}` (throws `MineruProbeError` with an `ExtractionErrorCode`), `getMineruStatusReport()` (never throws), `setMineruProbeClientFactory(factory | null)`, `resetMineruCapabilitiesCacheForTests()`. It ships its own minimal fetch probe, so the admin card works without P2-A. To route it through the real client, P2-A's `MineruClient` exposes `getHealth(signal)`, `getTiers(signal)`, `getUsage(signal)` returning the server's snake_case shapes, and **P2-B** calls `setMineruProbeClientFactory((config) => new MineruClient({ config }))` from the module init of `extractors/mineru4.ts`.

**Status endpoint.** `GET /api/admin/mineru-status[?refresh=1]` → `{ report: MineruStatusReport }`, admin-gated, always 200. Client: `fetchAdminMineruStatus` in `$lib/client/api/admin-system-health`; any test that mocks that module by export list must include it. Tool-health row id `document_extraction` probes `/v1/health`.

**Owed by P2-B.** `RuntimeConfig.mineruTimeoutMs` survives only as a deprecated mirror of `mineruJobTimeoutMs` because `extraction/config.ts:42` and `document-extraction.ts` still read it. When P2-B deletes `document-extraction.ts` it also switches `extraction/config.ts` to `mineruJobTimeoutMs` and drops the mirror from `env.ts` / `config-store.ts` (these two hot files are otherwise S0's and frozen; this one removal is P2-B's). P2-B also fixes `docs/architecture.md`, which still describes `POST /file_parse`.

---

## Wave 1 outcome (merged into `mineru4/p24`) — the frozen contract for P2-B, P4-B, P4-C

The merged code is the contract; read the modules named here before writing anything. Wave 1 = P2-A, P4-A and a worker liveness fix.

### P2-A — `$lib/server/services/mineru/{schemas,errors,tier-policy,client}.ts`, `testing/fake-server.ts`
- **Client.** `new MineruClient({config, fetchImpl?, fileReader?, now?, sleepImpl?})` with `getHealth|getTiers|getUsage(signal)`, `createUpload({filename,bytes,mimeType,sha256sum,signal})`, `putUploadContent({upload,filePathAbsolute,signal})`, `completeUpload({uploadId,sha256sum,signal})`, `createJob({fileId,tier?,ocrMode?,outputFormats,signal})`, `getJob({jobId,signal})`, `pollJob({jobId,signal,deadlineMs?,onPoll?})`, `cancelJob({jobId,signal})` (swallows 404/409), `downloadFile({fileId,destinationPathAbsolute,expectedBytes,signal,maxBytes?})`, `sha256(path)`, `statFile(path)`. Use the spec names (`createJob` …), not the `*ParseJob` aliases. `getTiers` drops unknown tier ids.
- **Errors.** `mapMineruError(unknown)` → `{taxonomy, retryable, handleUnknown, disposition: "fail"|"swallow"|"recover-by-reupload", retryAfterMs, …}`; `mapMineruJobFailure(job, {canceledByUs?, requiredOutput?})` → mapping or `null` when the job is usable (default `requiredOutput` is `zip`); `mineruErrorToExtractionError(error, {context?, details?})` bridges to `DocumentExtractionError`; `isMineruForgottenIdError`.
- **Tier policy.** `decideTier({intakeTierHint?, configuredTier, availableTiers, hintedTier?})` → `{tier?, reason, explanation}` (throws `tier_unavailable`); `decideOcrMode(mode)` → `"txt"|"ocr"|undefined`; `assertMineruOutputFormatsSupported(requested, available)`.
- **Restart recovery, in order.** `getJob` → 404 `job_not_found` ⇒ do not fail; `createUpload` with the same sha ⇒ `status:"completed"` with a NEW `file_id` ⇒ re-`createJob` and emit a fresh handle; if the upload comes back `pending`, PUT + complete from the local file; a download 404 `file_not_found` takes the same path. "The server forgot this id" = `job_not_found`, `file_not_found`, `upload_not_found` (`disposition === "recover-by-reupload"`). `handleUnknown: true` is raised only by a file-level `parse_failed` whose message says the file was not found; only then must the ledger clear the stored handle.
- **Fake server.** `await createFakeMineruServer({tiers?, parseDelayMs?, neverFinish?, failures?, restartAfterMs?, fixtureInput?, apiKey?, jobOutcome?, redirectDownloads?})` → `{baseUrl, crossOriginBaseUrl, fetchImpl, requests, jobs, blobs, restart(), setOptions(), resetLog(), close()}`. Real HTTP on an ephemeral port.
- **Flagged.** `extraction/contracts.ts` `isAbortLike` uses `instanceof`, which misreads an abort under jsdom; P2-B fixes it structurally (read `.name`).

### P4-A — `$lib/server/services/mineru/{result,bundle}.ts`, `GET /api/knowledge/[id]/figure/[name]`
- **Parse.** `parseMineruResultZip({zipPathAbsolute, jobTier?, serverParserVersion?, sourceFilename?, sourceMimeType?, limits?})` → `{result: StructuredExtractionResult, structuredContentJson, mineruMarkdown}`. `renderPromptMarkdown(sc, options?)` builds the prompt Markdown from blocks (byte-identical to MinerU's `markdown.md` for 8 of 10 fixtures; HTML and EPUB differ only by dropped anchor tags). `buildMineruOutline({markdown, blocks, pages})` → `MineruOutlineEntry {level,title,offset,preview,page?}`. `pageForOffset(pages, offset)`. Typed failures: `MineruResultError` (`zip_unreadable | zip_entry_rejected | zip_too_large | structured_content_missing | structured_content_invalid | empty_result`) carrying a taxonomy code and `retryable`.
- **Chunk planner (pure).** `planStructuredChunks({blocks, charTarget, charOverlap})` → `ChunkPlanEntry {chunkIndex, text, pageStart, pageEnd}`; tables, images and unknown block types are atomic. P4-C wires it into `task-state/chunk-sync.ts`.
- **Bundle.** `writeMineruParseBundle({userId, sourceArtifactId, zipPathAbsolute, result, maxBytes, normalizedArtifactId?})` writes `data/knowledge/<userId>/<sourceArtifactId>.parse/` atomically (`manifest.json`, `normalized.md`, `structured_content.json`, `pages.json`, `images/`); `readMineruParseManifest`, `readMineruPageIndex`, `readMineruNormalizedMarkdown`, `readMineruFigure`, `setMineruParseBundleNormalizedArtifactId`, `removeMineruParseBundle` (never throws). Deleting a source artifact already removes its bundle; disk reconciliation already ignores live bundles and temp dirs and reports orphaned bundles.
- **Figures** are `image` blocks only. Block types outside `KNOWN_BLOCK_TYPES` (equations, code, charts, algorithms were never captured) are kept as atomic text and counted in `stats.unknownTypes`.
- **P2-B's import guard** for `services/mineru/**` must also allow `routes/api/knowledge/[id]/figure/[name]/+server.ts` and `knowledge/store/cleanup.ts`.

### Worker liveness fix (`extraction/{worker-runner,config,intake}.ts`)
The worker now keeps itself alive: an idle tick, one backoff timer for the earliest `next_attempt_at`, a boot follow-up sweep, all `unref()`'d and inert in tests/build. `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` defaults to 120000 and is no longer derived from the MinerU timeout, so P2-B's task in `extraction/config.ts` is only to stop reading the deprecated `mineruTimeoutMs` mirror wherever it still appears and drop the mirror. Every enqueue wakes the worker. Structured `[EXTRACTION]` log lines exist for start, sweep, attempt failure, success, max attempts and cancel; add lines in the same style, never file names or text.
