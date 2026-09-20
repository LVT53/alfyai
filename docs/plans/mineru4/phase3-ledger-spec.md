# Phase 3 — Async document-extraction ledger

Implementation spec. Target repo: `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai`.
Base branch: whatever `mineru4/p1` merges into (**Phase 1 is assumed merged**). Integration branch: `mineru4/p3`.
Audience: parallel dev sub-agents in separate worktrees, then an adversarial reviewer.

**Rule of the phase:** extraction stops being a blocking step inside the upload HTTP request and becomes
durable, observable, retryable background work with exactly one status model for every intake route.
Everything a user can see about a document's readiness must be derivable from one ledger row.

**Independence from Phase 2:** the ledger calls a `DocumentExtractor` (§2.1). Phase 3 ships with two
implementations — `directTextExtractor` and `legacyMineru3Extractor` (a thin adapter over today's
`extractDocumentText`). Phase 2 adds `mineru4Extractor` by implementing the same interface and flipping
one entry in `extractors/registry.ts`. **No file in §2.1 may reference MinerU 4 concepts by name.**

**Toolchain (carried over from the Phase 1 orchestrator ruling):** Homebrew `node@22`
(`/opt/homebrew/opt/node@22/bin`) for every `npm` / `vitest` command. Node 26 breaks `better-sqlite3`.
Stage files by explicit path; never `git add -A`.

---

## 0. Decisions, stated once

| # | Decision | Why |
| --- | --- | --- |
| D1 | **New tables**, not rows in `file_production_jobs` | ADR-0005 scopes that ledger to file production; its `conversation_id` is `NOT NULL` and FK-bound to `conversations`, and knowledge-page uploads have no conversation. Patterns are copied, rows are not. |
| D2 | **Two tables**: `document_extraction_jobs` + `document_extraction_job_attempts` | Mirrors file-production. Attempt history is what makes an adversarial review of a flaky MinerU possible; the job row stays small and is the only thing the read path touches. |
| D3 | **Direct-text goes through the same ledger**, but bypasses the concurrency cap and is awaited inline for a bounded budget | One status model. Direct-text is local CPU, not a MinerU seat, so capping it would serialise `.txt` uploads behind a scanned PDF. |
| D4 | **Polling, not SSE** | ADR-0005 already ruled polling for job cards ("visible queued/running job cards update through lightweight polling of persisted job state rather than a dedicated file-production SSE channel"). The chat SSE stream is per-turn and owned by `chat-turn/`; knowledge-page and landing-page uploads have no stream at all. The repo has a working precedent at `src/routes/(app)/chat/[conversationId]/+page.svelte:1584-1599` (2500 ms, armed only while something is active). |
| D5 | **Preflight waits briefly server-side** (`DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS`, default 2500 ms) before returning "still processing" | Direct-text and small PDFs settle in well under a second. Making a user press Send twice for a file that was 300 ms from done is worse than one short wait. The wait is bounded, abortable via `event.request.signal`, and skipped when >5 attachments are pending. |
| D6 | **One job per source artifact** (`UNIQUE(source_artifact_id)`) | Makes the dedupe re-upload bug (§8 B1) structurally impossible: the same artifact can only ever have the one job, already `succeeded`. Retry reuses the row rather than creating a second. |
| D7 | **Legacy artifacts are synthesised read-only, never backfilled** | `file_production/read-model.ts` `ensureLegacyJobs` writes rows because it is bounded by one conversation's chat files. The artifact table is unbounded per user and has no anchor to bound a sweep. A real row is materialised only when the user presses Retry. |
| D8 | **`canceled` (one `l`)** | The brief fixes the vocabulary. File production uses `cancelled`. This divergence is deliberate; §6 has a test that pins both spellings so a reviewer does not "fix" one into the other. |
| D9 | **Legacy multipart route `/api/knowledge/upload` stays** as a thin wrapper | Verified: no caller in `src/` (only `upload.test.ts` and an e2e `page.route("**/api/knowledge/upload**")` glob that also matches the sub-routes). The on-box verify scripts POST multipart `file` + `conversationId` and live outside the repo, so deleting it breaks prod verification silently. It gains a `Deprecation` response header and a `console.warn`. |
| D10 | **Direct-text size cap = 8 MiB**, enforced twice | Phase 1 orchestrator ruling explicitly deferred the cap to Phase 3. 8 MiB of UTF-8 ≈ 2 M tokens ≈ 6 000 chunk rows + 6 000 TEI embedding calls from one upload. Enforced at `/upload/intent` (fail before bytes move) and again in `directTextExtractor` (backstop for the raw/chunk routes, which do not re-run intent). |
| D11 | **Worker is in-process, single scheduler, N concurrent jobs** | `deploy/` runs one `node build/index.js` (`deploy/langflow-chat.service:13` is the template; there is no pm2/cluster config anywhere). The claim transaction is nevertheless multi-process-safe (worker id + `WHERE status='queued'` CAS), so a future second process needs no schema change. |
| D12 | **Indexing is a real ledger phase** | `createArtifact` (`knowledge/store/core.ts:251-298`) synchronously calls `syncArtifactChunks` and queues the embedding refresh. For a 5 MB markdown that is thousands of inserts. It gets its own status so the UI stops saying "parsing" during it. |

---

## 1. Schema

### 1.1 Drizzle — append to `src/lib/server/db/schema.ts`

Place immediately after `fileProductionJobFiles` (ends `schema.ts:1618`) and before `atlasJobs`.

```ts
export const documentExtractionJobs = sqliteTable(
	"document_extraction_jobs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Nullable: Knowledge-page uploads have no conversation.
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "set null",
		}),
		// Exactly one of sourceArtifactId / chatGeneratedFileId is set (CHECK below).
		sourceArtifactId: text("source_artifact_id").references(() => artifacts.id, {
			onDelete: "cascade",
		}),
		chatGeneratedFileId: text("chat_generated_file_id").references(
			() => chatGeneratedFiles.id,
			{ onDelete: "cascade" },
		),
		normalizedArtifactId: text("normalized_artifact_id").references(
			() => artifacts.id,
			{ onDelete: "set null" },
		),
		/** "upload" | "generated_file_readback" */
		origin: text("origin").notNull().default("upload"),
		/** Phase 1 registry verdict, stamped at enqueue: "direct-text" | "mineru". */
		intakeRoute: text("intake_route").notNull(),
		/** Ascending = sooner. 0 = user upload, 10 = generated-file readback. */
		priority: integer("priority").notNull().default(0),
		fileName: text("file_name").notNull(),
		mimeType: text("mime_type"),
		sizeBytes: integer("size_bytes").notNull().default(0),
		/** queued | uploading | parsing | downloading | indexing | succeeded | failed | canceled */
		status: text("status").notNull().default("queued"),
		attemptCount: integer("attempt_count").notNull().default(0),
		currentAttemptId: text("current_attempt_id"),
		/** Opaque resumable handle (ExtractionHandle JSON). Survives attempts. */
		remoteHandleJson: text("remote_handle_json"),
		retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		/** Backoff gate: claim ignores queued rows whose nextAttemptAt is in the future. */
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),
		cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp" }),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		sourceArtifactUniqueIdx: uniqueIndex(
			"document_extraction_jobs_source_artifact_unique_idx",
		)
			.on(table.sourceArtifactId)
			.where(sql`${table.sourceArtifactId} IS NOT NULL`),
		chatFileUniqueIdx: uniqueIndex(
			"document_extraction_jobs_chat_file_unique_idx",
		)
			.on(table.chatGeneratedFileId)
			.where(sql`${table.chatGeneratedFileId} IS NOT NULL`),
		// Claim scan: status + priority + createdAt, in the claim's ORDER BY order.
		claimIdx: index("document_extraction_jobs_claim_idx").on(
			table.status,
			table.priority,
			table.createdAt,
		),
		userStatusIdx: index("document_extraction_jobs_user_status_idx").on(
			table.userId,
			table.status,
		),
		conversationIdx: index("document_extraction_jobs_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
	}),
);

export const documentExtractionJobAttempts = sqliteTable(
	"document_extraction_job_attempts",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => documentExtractionJobs.id, { onDelete: "cascade" }),
		attemptNumber: integer("attempt_number").notNull(),
		/** running | succeeded | failed | canceled */
		status: text("status").notNull().default("running"),
		/** Last observed job status while this attempt owned the job. */
		phase: text("phase"),
		/** DocumentExtractor.name, e.g. "direct-text" | "mineru3" | "mineru4". */
		extractor: text("extractor"),
		/** true when this attempt resumed a handle instead of submitting fresh. */
		resumed: integer("resumed", { mode: "boolean" }).notNull().default(false),
		remoteHandleJson: text("remote_handle_json"),
		workerId: text("worker_id"),
		claimedAt: integer("claimed_at", { mode: "timestamp" }),
		heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
		startedAt: integer("started_at", { mode: "timestamp" }),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
		textLength: integer("text_length"),
		pageCount: integer("page_count"),
		diagnosticsJson: text("diagnostics_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		jobNumberUniqueIdx: uniqueIndex(
			"document_extraction_job_attempts_job_number_unique_idx",
		).on(table.jobId, table.attemptNumber),
		jobIdx: index("document_extraction_job_attempts_job_idx").on(
			table.jobId,
			table.createdAt,
		),
		workerIdx: index("document_extraction_job_attempts_worker_idx").on(
			table.workerId,
			table.status,
			table.heartbeatAt,
		),
	}),
);
```

> `uniqueIndex(...).where(...)` is already used in this file — `file_production_jobs_idempotency_unique_idx`
> (`schema.ts:1533-1538`). Copy that idiom exactly; do not invent a new one.

### 1.2 SQL migration

One file, because the journal is a hot file and must have exactly one owner (slice S1).

**`drizzle/1777140000097_document_extraction_ledger.sql`**

```sql
CREATE TABLE `document_extraction_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`source_artifact_id` text,
	`chat_generated_file_id` text,
	`normalized_artifact_id` text,
	`origin` text DEFAULT 'upload' NOT NULL,
	`intake_route` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`current_attempt_id` text,
	`remote_handle_json` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`next_attempt_at` integer,
	`cancel_requested_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_generated_file_id`) REFERENCES `chat_generated_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`normalized_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_jobs_source_artifact_unique_idx` ON `document_extraction_jobs` (`source_artifact_id`) WHERE `source_artifact_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_jobs_chat_file_unique_idx` ON `document_extraction_jobs` (`chat_generated_file_id`) WHERE `chat_generated_file_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_claim_idx` ON `document_extraction_jobs` (`status`,`priority`,`created_at`);
--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_user_status_idx` ON `document_extraction_jobs` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_conversation_idx` ON `document_extraction_jobs` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `document_extraction_job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text,
	`extractor` text,
	`resumed` integer DEFAULT 0 NOT NULL,
	`remote_handle_json` text,
	`worker_id` text,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`text_length` integer,
	`page_count` integer,
	`diagnostics_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `document_extraction_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_job_attempts_job_number_unique_idx` ON `document_extraction_job_attempts` (`job_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `document_extraction_job_attempts_job_idx` ON `document_extraction_job_attempts` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `document_extraction_job_attempts_worker_idx` ON `document_extraction_job_attempts` (`worker_id`,`status`,`heartbeat_at`);
--> statement-breakpoint
CREATE INDEX `artifacts_user_name_idx` ON `artifacts` (`user_id`,`name`);
```

> The trailing `artifacts_user_name_idx` is the §8 B4 fix. It rides in this migration on purpose:
> putting it in a second file would give a second slice a reason to edit `drizzle/meta/_journal.json`.
> Add the matching `userNameIdx: index("artifacts_user_name_idx").on(table.userId, table.name)` to the
> `artifacts` table's index object (`schema.ts:~388`, next to `userBinaryHashIdx`).

### 1.3 Migration registration checklist

| File | Edit |
| --- | --- |
| `drizzle/meta/_journal.json` | append `{ "idx": 110, "version": "7", "when": 1777140000097, "tag": "1777140000097_document_extraction_ledger", "breakpoints": true }` — current last entry is idx 109 / `1777140000096_messages_role_created_idx`. |
| `scripts/prepare-db.ts` | add `"document_extraction_jobs"` and `"document_extraction_job_attempts"` to `requiredExistingTables` (line 32ff). `npm run check:migrations` warns otherwise. |
| `src/lib/server/db/schema.test.ts` | add a `describe("document_extraction_jobs table")` block asserting columns/nullability and the five index names, in the style of the `activity_events` block (`schema.test.ts:782-830`). `beforeAll` already runs `migrate(db, { migrationsFolder: "./drizzle" })`, so a malformed journal entry fails the whole file. |
| `src/lib/server/db/compat.ts` | **no change.** Runtime schema mutation is forbidden there (`AGENTS.md`, "Core Rules"). |

No `drizzle-kit generate` run: the repo's timestamped tags are hand-authored (every file from
`1775157367422_*` onward). Verify with `npm run check:migrations` and
`npx vitest run src/lib/server/db/schema.test.ts`.

---

## 2. TypeScript contracts

All blocks below are **frozen by this spec**. Slices S2–S5 code against them before S1 merges.

### 2.1 `src/lib/server/services/extraction/contracts.ts` — the extractor seam

> Module path is `services/extraction/`, **not** `services/document-extraction/`: the file
> `src/lib/server/services/document-extraction.ts` already exists (it stays, as the MinerU 3 client
> Phase 2 replaces) and a sibling directory of the same name is ambiguous to the resolver.

```ts
import type { ExtractionErrorCode, ExtractionPhase } from "$lib/shared/extraction-status";

/** Opaque, extractor-owned, ledger-persisted. The ledger never inspects `data`. */
export interface ExtractionHandle {
	/** Must equal the producing DocumentExtractor.name. */
	extractor: string;
	/** Bump when the shape changes; a handle with an unknown version is discarded. */
	version: 1;
	remoteJobId?: string | null;
	remoteFileId?: string | null;
	data?: Record<string, unknown>;
}

export interface ExtractionProgress {
	phase: ExtractionPhase; // "uploading" | "parsing" | "downloading"
	/** 0-100, best effort. Persisted nowhere; used only for log lines today. */
	percent?: number | null;
	/** Emit as soon as a remote id exists, BEFORE the first poll. */
	handle?: ExtractionHandle | null;
	detail?: string | null;
}

export interface ExtractDocumentRequest {
	filePathAbsolute: string;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	/** Phase 1 registry verdict. "reject" never reaches an extractor. */
	intakeRoute: "direct-text" | "mineru";
	/** Aborted on user cancel, on stale-claim loss, and on process shutdown. */
	signal: AbortSignal;
	onProgress: (progress: ExtractionProgress) => void;
	/** Set when a previous attempt persisted a handle. Undefined = submit fresh. */
	resumeHandle?: ExtractionHandle | null;
}

export interface ExtractDocumentResult {
	/** Non-empty. An extractor that finds nothing throws `empty_result` instead. */
	text: string;
	normalizedName: string;
	mimeType: string;
	pageCount?: number;
	/** Final handle, for diagnostics. */
	handle?: ExtractionHandle | null;
}

export class DocumentExtractionError extends Error {
	readonly name = "DocumentExtractionError";
	readonly code: ExtractionErrorCode;
	readonly retryable: boolean;
	/** For `rate_limited`: honour this instead of the computed backoff. */
	readonly retryAfterMs?: number;
	/**
	 * The remote no longer recognises the persisted handle (MinerU restarted).
	 * The ledger clears `remote_handle_json` and the next attempt submits fresh.
	 */
	readonly handleUnknown: boolean;
	readonly details?: Record<string, unknown>;

	constructor(init: {
		code: ExtractionErrorCode;
		message: string;
		retryable?: boolean;
		retryAfterMs?: number;
		handleUnknown?: boolean;
		details?: Record<string, unknown>;
		cause?: unknown;
	});
}

export function isDocumentExtractionError(
	error: unknown,
): error is DocumentExtractionError;

/** Maps an unknown throw onto the taxonomy. Never throws. */
export function toDocumentExtractionError(
	error: unknown,
): DocumentExtractionError;

export interface DocumentExtractor {
	/** Stable id persisted on the attempt row. */
	readonly name: string;
	/** false ⇒ the ledger never passes `resumeHandle` and discards stored handles. */
	readonly supportsResume: boolean;
	extract(request: ExtractDocumentRequest): Promise<ExtractDocumentResult>;
	/** Best effort remote cleanup on user cancel. Must not throw. */
	cancel?(handle: ExtractionHandle, signal?: AbortSignal): Promise<void>;
}
```

### 2.2 `src/lib/shared/extraction-status.ts` — client-safe vocabulary

Single file, **zero value imports** (same constraint the Phase 1 registry's `table.ts` carries, enforced
by the same regex assertion — see §6).

```ts
export const DOCUMENT_EXTRACTION_STATUSES = [
	"queued",
	"uploading",
	"parsing",
	"downloading",
	"indexing",
	"succeeded",
	"failed",
	"canceled",
] as const;
export type DocumentExtractionStatus =
	(typeof DOCUMENT_EXTRACTION_STATUSES)[number];

export const DOCUMENT_EXTRACTION_ACTIVE_STATUSES = [
	"uploading",
	"parsing",
	"downloading",
	"indexing",
] as const;
export type DocumentExtractionActiveStatus =
	(typeof DOCUMENT_EXTRACTION_ACTIVE_STATUSES)[number];

export const DOCUMENT_EXTRACTION_TERMINAL_STATUSES = [
	"succeeded",
	"failed",
	"canceled",
] as const;

export type ExtractionPhase = "uploading" | "parsing" | "downloading";

export const EXTRACTION_ERROR_CODES = [
	"unavailable",
	"tier_unavailable",
	"too_large",
	"rate_limited",
	"job_failed",
	"canceled",
	"timeout",
	"protocol",
	"unsupported_type",
	"empty_result",
	// Ledger-side, never thrown by an extractor:
	"stale_worker",
	"max_attempts",
	"internal",
	"legacy_unknown",
] as const;
export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

/** Default retryability. An extractor may override per throw. */
export const RETRYABLE_EXTRACTION_ERROR_CODES: ReadonlySet<ExtractionErrorCode> =
	new Set(["unavailable", "rate_limited", "timeout", "protocol", "job_failed", "stale_worker"]);

export function isTerminalExtractionStatus(
	status: DocumentExtractionStatus,
): boolean;
export function isActiveExtractionStatus(
	status: DocumentExtractionStatus,
): boolean;

/** The DTO every client surface consumes. */
export interface DocumentExtractionJobDTO {
	id: string;
	/** null for a readback job; always set for an upload job. */
	sourceArtifactId: string | null;
	normalizedArtifactId: string | null;
	status: DocumentExtractionStatus;
	intakeRoute: "direct-text" | "mineru";
	fileName: string;
	attemptCount: number;
	maxAttempts: number;
	/** true only when status === "failed" and a retry can plausibly help. */
	retryable: boolean;
	/** true while status is queued/active and the job is not already canceling. */
	cancelable: boolean;
	error: { code: ExtractionErrorCode; message: string } | null;
	createdAt: number;
	updatedAt: number;
	/** Set once the job left `queued`. Drives the elapsed clock. */
	startedAt: number | null;
	/** true when the row is synthesised from a pre-ledger artifact (§4.4). */
	legacy: boolean;
}

export const LEGACY_EXTRACTION_JOB_ID_PREFIX = "legacy-extraction:";
export function isLegacyExtractionJobId(id: string): boolean;
```

### 2.3 `src/lib/server/services/extraction/job-ledger.ts`

```ts
export interface EnqueueExtractionJobInput {
	userId: string;
	conversationId: string | null;
	origin: "upload" | "generated_file_readback";
	intakeRoute: "direct-text" | "mineru";
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	sourceArtifactId?: string | null;
	chatGeneratedFileId?: string | null;
	priority?: number;
	now?: Date;
}
export interface EnqueueExtractionJobResult {
	job: DocumentExtractionJobRow;
	reused: boolean;
}
/** Idempotent on (source_artifact_id) / (chat_generated_file_id). Never throws on a race. */
export async function enqueueExtractionJob(
	input: EnqueueExtractionJobInput,
): Promise<EnqueueExtractionJobResult>;

export interface ClaimExtractionJobInput {
	workerId: string;
	globalLimit: number;
	perUserLimit: number;
	/** true ⇒ only `intake_route = 'direct-text'`, and the caps are ignored. */
	directTextOnly?: boolean;
	/** Restricts the claim to this job id. Used by the inline direct-text path. */
	jobId?: string;
	now?: Date;
}
export interface ClaimedExtractionJob {
	job: DocumentExtractionJobRow;
	attempt: DocumentExtractionAttemptRow;
	resumeHandle: ExtractionHandle | null;
}
export async function claimNextExtractionJob(
	input: ClaimExtractionJobInput,
): Promise<ClaimedExtractionJob | null>;

export interface OwnedAttemptInput {
	jobId: string;
	attemptId: string;
	workerId: string;
	now?: Date;
}

/** Writes heartbeat + status/handle. Returns false if this worker no longer owns the attempt. */
export async function reportExtractionProgress(
	input: OwnedAttemptInput & {
		status: DocumentExtractionActiveStatus;
		handle?: ExtractionHandle | null;
	},
): Promise<boolean>;

/** Heartbeat only, no status change. */
export async function heartbeatExtractionAttempt(
	input: OwnedAttemptInput,
): Promise<boolean>;

export async function completeExtractionAttempt(
	input: OwnedAttemptInput & {
		normalizedArtifactId: string;
		textLength: number;
		pageCount: number | null;
	},
): Promise<boolean>;

export async function failExtractionAttempt(
	input: OwnedAttemptInput & {
		errorCode: ExtractionErrorCode;
		errorMessage: string;
		retryable: boolean;
		retryAfterMs?: number;
		clearHandle: boolean;
		maxAttempts: number;
		retryBaseMs: number;
		retryMaxMs: number;
		diagnostics?: Record<string, unknown>;
	},
): Promise<{ requeued: boolean; nextAttemptAt: Date | null }>;

/** Boot + periodic. Converts orphaned attempts into retryable `stale_worker` failures. */
export async function recoverStaleExtractionAttempts(input: {
	staleBefore: Date;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	now?: Date;
}): Promise<{ recovered: number; requeued: number }>;

/** User action. Only from `failed`. Resets error state, clears `next_attempt_at`. */
export async function retryExtractionJob(input: {
	userId: string;
	jobId: string;
	now?: Date;
}): Promise<DocumentExtractionJobRow | null>;

/** User action. From queued/active. Sets `cancel_requested_at` then `canceled`. */
export async function cancelExtractionJob(input: {
	userId: string;
	jobId: string;
	now?: Date;
}): Promise<DocumentExtractionJobRow | null>;

/** Materialises a real row for a pre-ledger artifact so Retry has something to act on. */
export async function materializeLegacyExtractionJob(input: {
	userId: string;
	sourceArtifactId: string;
	now?: Date;
}): Promise<DocumentExtractionJobRow | null>;

/** True while the worker holds the claim; the worker polls it to honour cancel. */
export async function isCancelRequested(jobId: string): Promise<boolean>;
```

### 2.4 `src/lib/server/services/extraction/read-model.ts`

```ts
/** Batch read for the poll endpoint. Synthesises legacy rows (§4.4); writes nothing. */
export async function getExtractionJobsForArtifacts(input: {
	userId: string;
	artifactIds: string[];
	now?: Date;
}): Promise<DocumentExtractionJobDTO[]>;

export async function getExtractionJobForArtifact(input: {
	userId: string;
	artifactId: string;
	now?: Date;
}): Promise<DocumentExtractionJobDTO | null>;

export async function getExtractionJobById(input: {
	userId: string;
	jobId: string;
}): Promise<DocumentExtractionJobDTO | null>;

/** Grace window before a job-less, normalized-less artifact is called `failed`. */
export const LEGACY_EXTRACTION_GRACE_MS = 5 * 60 * 1000;

export function mapExtractionJobRow(
	row: DocumentExtractionJobRow,
	maxAttempts: number,
): DocumentExtractionJobDTO;
```

### 2.5 `src/lib/server/services/extraction/job-wait.ts`

Structural copy of `file-production/job-wait.ts` (dependency-free; clock, sleep and lookup injected).
It is a **copy, not a shared generic**: ADR-0005 scopes the file-production module, and the two
terminal-status sets differ (`cancelled` vs `canceled`).

```ts
export type ExtractionJobLookup = () => Promise<DocumentExtractionJobDTO | null>;
export type ExtractionJobVerdict =
	| { settled: true; job: DocumentExtractionJobDTO }
	| { settled: false; job: DocumentExtractionJobDTO | null };

export async function waitForExtractionJobVerdict(input: {
	getJob: ExtractionJobLookup;
	timeoutMs: number;
	pollIntervalMs: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}): Promise<ExtractionJobVerdict>;
```

### 2.6 `src/lib/server/services/extraction/worker-runner.ts`

```ts
export interface ExecuteNextExtractionJobInput {
	workerId: string;
	now?: Date;
	/** Test seam. Defaults to `resolveExtractor(intakeRoute)`. */
	resolveExtractor?: (intakeRoute: "direct-text" | "mineru") => DocumentExtractor;
	/** Test seam over `createNormalizedArtifactFromText`. */
	persistResult?: PersistExtractionResultDependency;
	directTextOnly?: boolean;
	jobId?: string;
}
export interface ExecuteNextExtractionJobResult {
	jobId: string;
	status: DocumentExtractionStatus;
}
export async function executeNextExtractionJob(
	input: ExecuteNextExtractionJobInput,
): Promise<ExecuteNextExtractionJobResult | null>;

/** Loops until `claimNextExtractionJob` returns null. Honours the concurrency caps. */
export async function drainExtractionWorker(
	input?: Partial<ExecuteNextExtractionJobInput>,
): Promise<void>;

/** Fire-and-forget wake, deduped by an in-module promise (copy of wakeFileProductionWorker). */
export function wakeExtractionWorker(): void;

/** Once per process, from `src/hooks.server.ts` init. Recovers stale attempts, then wakes. */
export async function ensureExtractionWorker(): Promise<void>;

/**
 * Claims and runs ONE direct-text job to completion in the caller's async context.
 * Returns the terminal DTO, or the non-terminal DTO if the budget elapses first.
 */
export async function runDirectTextExtractionInline(input: {
	jobId: string;
	budgetMs: number;
	signal?: AbortSignal;
}): Promise<DocumentExtractionJobDTO | null>;
```

### 2.7 `src/lib/server/services/extraction/index.ts` — the facade

Mirrors `file-production/index.ts`: lazily `import()`s `worker-runner.ts` so that importing the read
model from a route never drags the extractors (and therefore `node:fs`, the MinerU client and, after
Phase 2, the V1 HTTP client) into a request path that only reads rows.

```ts
export { enqueueExtractionJob, retryExtractionJob, cancelExtractionJob,
	materializeLegacyExtractionJob } from "./job-ledger";
export { getExtractionJobsForArtifacts, getExtractionJobForArtifact,
	getExtractionJobById } from "./read-model";
export { waitForExtractionJobVerdict } from "./job-wait";
export type { DocumentExtractor } from "./contracts";
export function wakeExtractionWorker(): void;               // lazy
export async function ensureExtractionWorker(): Promise<void>; // lazy
export async function runDirectTextExtractionInline(...): Promise<...>; // lazy
```

### 2.8 `src/lib/server/services/extraction/persist.ts`

Extracted from today's `createNormalizedArtifact` (`knowledge/store/documents.ts:304-368`), which
**loses its `extractDocumentText` call** and becomes text-in / artifact-out.

```ts
/**
 * Everything createNormalizedArtifact did AFTER extraction: comfort metadata,
 * createArtifact (which chunks + queues embeddings), the derived_from link, and
 * the source-artifact metadata patch. This is the `indexing` phase.
 */
export async function createNormalizedArtifactFromText(params: {
	userId: string;
	conversationId?: string | null;
	sourceArtifactId: string;
	sourceName: string;
	text: string;
	normalizedName: string;
	mimeType: string;
	pageCount?: number;
}): Promise<Artifact>;

export type PersistExtractionResultDependency =
	typeof createNormalizedArtifactFromText;
```

`knowledge/store/documents.ts` keeps `createNormalizedArtifact` as a **deprecated thin wrapper** that
calls `legacyMineru3Extractor` + `createNormalizedArtifactFromText`, used by nothing in `src/` after
this phase; delete it in the same slice and update `documents.test.ts`. (Confirmed callers:
`upload-intake.ts:129` only.)

### 2.9 `src/lib/server/services/extraction/intake.ts`

```ts
/** The single enqueue entry point for uploads. Called from finishKnowledgeUpload. */
export async function startUploadExtraction(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	/** Already-known normalized artifact (dedupe hit) — short-circuits to `succeeded`. */
	existingNormalizedArtifactId?: string | null;
	inlineBudgetMs?: number;
	signal?: AbortSignal;
}): Promise<DocumentExtractionJobDTO>;

/** The enqueue entry point for generated-file readback. Never waits. */
export async function startGeneratedFileReadback(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	chatGeneratedFileId: string;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
}): Promise<DocumentExtractionJobDTO>;
```

### 2.10 Endpoint shapes

| Method + path | Request | 200 response | Errors |
| --- | --- | --- | --- |
| `GET /api/knowledge/extraction?artifactIds=a,b,c` | ≤50 ids, comma separated | `{ jobs: DocumentExtractionJobDTO[] }` — one entry per **resolvable, owned** id; unknown ids are omitted | 400 `too_many_artifact_ids`, 401 |
| `POST /api/knowledge/extraction/[artifactId]/retry` | — | `{ job: DocumentExtractionJobDTO }` | 404 `extraction_job_not_found` (unknown/unowned/not retryable), 401 |
| `POST /api/knowledge/extraction/[artifactId]/cancel` | — | `{ job: DocumentExtractionJobDTO }` | 404 `extraction_job_not_cancelable`, 401 |

Keyed on **artifactId, not jobId**, so a legacy artifact with a synthetic id can be retried without the
client knowing whether a row exists. `retry` on a legacy synthetic first calls
`materializeLegacyExtractionJob`, then `retryExtractionJob`; it then calls `wakeExtractionWorker()`
(copy of `chat/files/jobs/[id]/retry/+server.ts:28`).

### 2.11 Upload response

```ts
// src/lib/server/services/knowledge/types.ts
export interface KnowledgeUploadResponse {
	artifact: ArtifactSummary;
	normalizedArtifact: ArtifactSummary | null;   // unchanged; null while extracting
	reusedExistingArtifact: boolean;
	promptReady: boolean;                          // unchanged semantics
	promptArtifactId?: string | null;
	readinessError?: string | null;
	renameInfo?: { originalName: string; wasRenamed: boolean };
	/** NEW — always present. */
	extraction: DocumentExtractionJobDTO;
}

export interface PendingAttachment {
	artifact: ArtifactSummary;
	promptReady: boolean;
	promptArtifactId?: string | null;
	readinessError?: string | null;
	/** NEW — present for a real upload, absent for a restored draft attachment. */
	extraction?: DocumentExtractionJobDTO;
}
```

### 2.12 Preflight error shape

```ts
// src/lib/server/services/chat-turn/types.ts — ChatTurnRequestError gains:
export interface ChatTurnRequestError {
	status: number;
	error: string;
	code?: string;
	attachmentIds?: string[];
	/** NEW, set when code is attachment_extraction_pending | attachment_extraction_failed. */
	attachmentExtraction?: Array<{
		artifactId: string;
		name: string | null;
		status: DocumentExtractionStatus;
		errorCode: ExtractionErrorCode | null;
		retryable: boolean;
	}>;
}
```

`AttachmentReadinessError` (`knowledge/store/attachments.ts:58`) gains `code:
"attachment_not_ready" | "attachment_extraction_pending" | "attachment_extraction_failed"` and an
`items` field carrying the array above. HTTP status stays **422** for all three — the existing client
error path and `isAttachmentReadinessError` (`attachments.ts:70`, which matches on
`code === "attachment_not_ready"`) must be widened to a set, not replaced.

| Situation | `code` | i18n key (EN + HU, `chat.*`) |
| --- | --- | --- |
| ≥1 attachment queued/active after the server-side wait | `attachment_extraction_pending` | `chat.attachmentStillProcessing` |
| ≥1 attachment `failed`, retryable | `attachment_extraction_failed` | `chat.attachmentExtractionFailedRetryable` |
| ≥1 attachment `failed`, not retryable | `attachment_extraction_failed` | `chat.attachmentExtractionFailed` |
| artifact gone / not a document | `attachment_not_ready` | existing prose (unchanged) |

---

## 3. State machine

`J` = job row, `A` = current attempt row. Every transition is one `db.transaction`, guarded by
`WHERE id = ? AND status = <from>` (and, for attempt-owned transitions, `AND current_attempt_id = ?
AND attempts.worker_id = ?`), exactly as `file-production/job-ledger.ts` does.

| # | From | Event | To | Side effects |
| --- | --- | --- | --- | --- |
| T1 | — | `enqueueExtractionJob` | `queued` | insert J; `wakeExtractionWorker()` |
| T2 | — | `enqueueExtractionJob`, dedupe hit with an existing normalized artifact | `succeeded` | insert J with `normalized_artifact_id`, `attempt_count = 0`, `completed_at = now`; **no attempt row**; no wake |
| T3 | `queued` | `claimNextExtractionJob` wins the CAS | `uploading` | insert A (`attempt_number = attempt_count + 1`, `worker_id`, `claimed_at`, `heartbeat_at`, `started_at`, `resumed = handle != null`); J: `current_attempt_id`, `attempt_count += 1`, `started_at ??= now`, clear `error_*`, clear `next_attempt_at` |
| T4 | `uploading` | `onProgress({phase:"parsing", handle})` | `parsing` | J: `status`, `remote_handle_json = handle`; A: `phase`, `heartbeat_at`, `remote_handle_json` |
| T5 | `parsing` | `onProgress({phase:"downloading"})` | `downloading` | as T4 |
| T6 | any active | `onProgress` with the **same** phase | (no change) | heartbeat only |
| T7 | `uploading`/`parsing`/`downloading` | extractor resolves | `indexing` | J: `status`; A: `phase`, `text_length`, `page_count`. `createNormalizedArtifactFromText` runs **after** this write, outside any transaction |
| T8 | `indexing` | `completeExtractionAttempt` | `succeeded` | J: `normalized_artifact_id`, `completed_at`, `retryable = false`, clear `remote_handle_json`; A: `status = succeeded`, `finished_at` |
| T9 | any active | extractor throws, `retryable && attempt_count < maxAttempts` | `queued` | A: `status = failed`, `error_*`, `finished_at`; J: `current_attempt_id = null`, `error_*` **kept** (so the UI can say "retrying after X"), `next_attempt_at = now + backoff`; handle kept unless `handleUnknown` |
| T10 | any active | extractor throws, not retryable **or** `attempt_count >= maxAttempts` | `failed` | A as T9; J: `status = failed`, `retryable` = (`retryable && attempt_count >= maxAttempts` ? true : false), `error_code` (or `max_attempts` when the cap was the cause), `completed_at`, clear `remote_handle_json` |
| T11 | any active | `recoverStaleExtractionAttempts` (heartbeat older than `staleAttemptMs`) | `queued` or `failed` | same as T9/T10 with `error_code = "stale_worker"`, `retryable = true` |
| T12 | `queued` | `cancelExtractionJob` | `canceled` | J: `cancel_requested_at`, `completed_at`, `status`; no attempt row touched |
| T13 | any active | `cancelExtractionJob` | `canceled` | J as T12; A: `status = canceled`, `finished_at`. Worker's `AbortSignal` fires; `extractor.cancel?(handle)` is called best-effort and its failure is logged, never surfaced |
| T14 | `failed` | `retryExtractionJob` (user, `retryable = true`) | `queued` | J: clear `error_*`, `completed_at`, `next_attempt_at`, `cancel_requested_at`, `current_attempt_id`; `attempt_count` is **NOT** reset (attempt numbers stay unique); `maxAttempts` is re-evaluated against `attempt_count` at claim time — a user retry therefore always gets **one** more attempt (see §3.1) |
| T15 | `canceled` | `retryExtractionJob` | `queued` | as T14 |
| T16 | `succeeded` | anything | — | terminal, immutable. Retry/cancel return `null` → 404 |

**Terminal:** `succeeded`, `failed`, `canceled`.
**Active (claimable/heartbeated):** `uploading`, `parsing`, `downloading`, `indexing`.
**Illegal:** any transition into `queued` from `succeeded`; any active→active backwards move
(`parsing` → `uploading`); any write by a worker that is not `current_attempt_id`'s owner.

### 3.1 Attempts and retry policy

- `maxAttempts` = `DOCUMENT_EXTRACTION_MAX_ATTEMPTS` (default **3**) for automatic retries.
- A **user** retry (T14/T15) sets `J.status = 'queued'` and stores
  `attempt_budget = attempt_count + 1` — implemented without a new column by letting `claimNext…`
  compare against `attempt_count + 1` when `J.error_code IS NULL AND J.next_attempt_at IS NULL`
  (the signature of a user retry). Document this in a comment; it is the one non-obvious rule here.
- Backoff: `delay = min(retryMaxMs, retryBaseMs * 3^(attemptCount-1)) * jitter`, `jitter ∈ [0.8, 1.2]`.
  Defaults → ~2 s, ~6 s. `rate_limited` uses `retryAfterMs` when the extractor supplied it.
- Jitter uses an injectable `random` parameter so the unit test is deterministic.

| Error code | Retryable by default | Note |
| --- | --- | --- |
| `unavailable` | yes | MinerU down / connection refused |
| `rate_limited` | yes | honour `retryAfterMs` |
| `timeout` | yes | |
| `protocol` | yes | includes `handleUnknown` re-submits |
| `job_failed` | yes | remote reported failure; may be transient |
| `stale_worker` | yes | ledger-side |
| `tier_unavailable` | **no** | needs an admin change; retrying cannot help |
| `too_large` | **no** | |
| `unsupported_type` | **no** | should be unreachable — `/upload/intent` already refuses these |
| `empty_result` | **no** | deterministic for the same bytes |
| `canceled` | **no** | user intent |
| `max_attempts` | **no** automatic; **yes** for the user button | surfaces the Retry affordance |
| `internal` | **no** | |
| `legacy_unknown` | n/a (synthetic) | surfaces the Retry affordance |

### 3.2 Claim, heartbeat, recovery, concurrency

- **Claim** (single `db.transaction`, mirroring `atlas/job-ledger.ts:claimNextAtlasJob`):
  1. `SELECT count(*) WHERE status IN (active)` → bail if `>= globalLimit` (skipped when `directTextOnly`).
  2. `SELECT * WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now)
     ORDER BY priority ASC, created_at ASC` (plus `AND intake_route='direct-text'` /
     `AND id = ?` when those inputs are set).
  3. For each candidate: per-user active count `>= perUserLimit` → `continue` (skipped when `directTextOnly`).
  4. CAS `UPDATE … SET status='uploading', current_attempt_id=?, attempt_count=attempt_count+1
     WHERE id=? AND status='queued'`; `changes === 0` → `continue`.
- **Heartbeat**: the worker arms a `setInterval(DOCUMENT_EXTRACTION_HEARTBEAT_MS)` (default 15 s,
  `.unref()`) for the duration of `extractor.extract`, calling `heartbeatExtractionAttempt`. A `false`
  return means the claim was lost → abort the signal and return without writing.
- **Stale recovery**: `ensureExtractionWorker()` runs `recoverStaleExtractionAttempts({ staleBefore:
  now - staleAttemptMs })` once at boot, and the drain loop runs it again whenever a drain finds no
  claimable work and the last recovery was more than `staleAttemptMs / 2` ago.
- **Concurrency**: `globalLimit = DOCUMENT_EXTRACTION_MAX_CONCURRENCY` (3),
  `perUserLimit = DOCUMENT_EXTRACTION_PER_USER_CONCURRENCY` (2).
- **Priority**: `priority = 0` for `origin='upload'`, `priority = 10` for
  `origin='generated_file_readback'`. Ordering is `priority ASC, created_at ASC`, so a readback queued
  an hour ago still yields to an upload queued a second ago. No starvation guard in v1 — readback is
  never user-blocking (see §5, S5, and the open question OQ4).

---

## 4. Client-visible changes

### 4.1 Response shape

`KnowledgeUploadResponse.extraction` is new (§2.11). `normalizedArtifact` is `null` and
`promptReady` is `false` for any `mineru`-route upload that did not finish inside the request — which
is now the normal case. **Every consumer that treats `promptReady === false` as a permanent failure
must be changed**; that is the single biggest behavioural risk of this phase.

### 4.2 Consumers, exhaustively

| File | Change | Slice |
| --- | --- | --- |
| `src/lib/server/services/knowledge/types.ts` | `KnowledgeUploadResponse.extraction`, `PendingAttachment.extraction` (§2.11) | S2 |
| `src/lib/server/services/knowledge/upload-intake.ts` | `createNormalizedArtifactForUpload` deleted; `finishKnowledgeUpload` calls `startUploadExtraction` and puts the DTO on the response; `buildKnowledgeUploadResponse` takes the DTO | S2 |
| `src/lib/server/services/knowledge/store/attachments.ts` | dedupe paths return the existing normalized artifact (B1); `resolveArtifactNameWithAutoRename` prefix query (B4); `resolvePromptAttachmentArtifacts` joins the ledger so `readinessError` can say *pending* vs *failed* | S2 |
| `src/lib/server/services/knowledge/store/documents.ts` | `createNormalizedArtifact` → `createNormalizedArtifactFromText` (moved to `extraction/persist.ts`), wrapper deleted | S2 |
| `src/lib/server/services/knowledge/store/core.ts` | **read-only** — `mapArtifactSummary` is untouched; the DTO travels beside the artifact, not inside it | — |
| `src/lib/server/services/knowledge.ts` | `KnowledgeDocumentItem` gains `extraction?: DocumentExtractionJobDTO`; `getKnowledgeLibraryPage` batch-resolves for the page's documents (one `getExtractionJobsForArtifacts` call, ≤100 ids) | S4 |
| `src/lib/client/api/knowledge.ts` | new `fetchExtractionJobs(artifactIds, fetchImpl?)`, `retryExtraction(artifactId)`, `cancelExtraction(artifactId)`; `uploadKnowledgeAttachment` return type widens automatically | S3 |
| `src/lib/client/extraction-poll.ts` (new) | `createExtractionPoller({ getArtifactIds, onJobs, fetchImpl? })` — pure-ish helper; interval **1000 ms for the first 10 s, then 2500 ms**; disarms when every tracked job is terminal or the list is empty; pauses on `document.visibilityState === "hidden"` | S3 |
| `src/lib/components/chat/MessageInput.svelte` | the 900 ms timer (`:2477-2479`), `uploadState`'s `"preparing"` member and `preparingTimer` are **deleted**; chips are created optimistically at upload start; per-chip status from the poller | S3 |
| `src/lib/components/chat/composer-chip-presentation.ts` | new pure `extractionChipStatus(job, translate)` + `extractionChipDashed(job)`; no new `ComposerChip` prop is needed (`status` and `dashed` already exist) | S3 |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | `uploadSingleFile` copies `result.extraction` into the `PendingAttachment`; mount the poller | S3 |
| `src/routes/(app)/+page.svelte` | same two edits | S3 |
| `src/routes/(app)/knowledge/+page.svelte` | `handleDocumentsUpload` stops `invalidateAll()`-ing per file; mount the poller over the page's documents; re-`invalidateAll()` once when a tracked job turns `succeeded` | S4 |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | Status column renders the extraction state; Retry / Cancel row actions | S4 |
| `src/routes/(app)/knowledge/_components/documents-table.ts` | `deriveDocumentStatus` gains the extraction states **ahead of** version status (a document that is still extracting is not yet "Current") | S4 |
| `src/lib/server/services/chat-turn/preflight.ts` + `types.ts` | the §2.12 split | S4 |
| `src/lib/server/services/chat-files.ts` | `syncGeneratedFilesToMemory` splits into enqueue + `completeGeneratedFileReadback` | S5 |

### 4.3 Composer chip states (replaces the 900 ms lie)

`ComposerChip` already carries `status?: string` ("a short danger clause") and `dashed?: boolean`
("waiting, not attached") and a `queued` kind — no component change is required.

| Job status | chip | `status` text | `dashed` |
| --- | --- | --- | --- |
| (bytes still uploading, no DTO yet) | `queued` kind | `chat.extraction.uploading` | yes |
| `queued` | file/image kind | `chat.extraction.queued` | yes |
| `uploading` / `parsing` / `downloading` | file/image kind | `chat.extraction.parsing` | yes |
| `indexing` | file/image kind | `chat.extraction.indexing` | yes |
| `succeeded` | file/image kind | *(none)* | no |
| `failed`, retryable | file/image kind | `chat.extraction.failedRetry` + Retry affordance | no |
| `failed`, not retryable | file/image kind | `chat.extraction.error.<code>` | no |
| `canceled` | file/image kind | `chat.extraction.canceled` | no |

`sendDisabledHint` keeps its `"preparing"` member but now derives from
`pendingAttachments.some(a => a.extraction && !isTerminal(a.extraction.status))` instead of
`!a.promptReady`. Elapsed time reuses `formatElapsed` / `isStaleJob` from
`src/lib/components/chat/file-production-helpers.ts` — **import them, do not copy them**.

### 4.4 Pre-ledger artifacts (no heavy backfill)

`getExtractionJobsForArtifacts` resolves each requested `source_document` artifact as:

| Condition | Synthesised DTO |
| --- | --- |
| a row exists | the real row, `legacy: false` |
| no row, `getNormalizedArtifactForSource` returns an artifact | `{ id: "legacy-extraction:<artifactId>", status: "succeeded", normalizedArtifactId, retryable: false, cancelable: false, legacy: true, createdAt/updatedAt from the normalized artifact }` |
| no row, no normalized artifact, `artifact.createdAt < now - LEGACY_EXTRACTION_GRACE_MS` | `{ status: "failed", error: { code: "legacy_unknown", … }, retryable: true, legacy: true }` |
| no row, no normalized artifact, inside the grace window | `{ status: "queued", legacy: true, cancelable: false }` — an enqueue is probably in flight in another request |

Nothing is written. The `legacy_unknown` Retry button hits
`POST /api/knowledge/extraction/[artifactId]/retry`, which calls `materializeLegacyExtractionJob`
(inserting a `failed`+`retryable` row with `attempt_count = 0`) and then `retryExtractionJob`. This is
the read-model-synthesis style of `file-production/read-model.ts:343-397`, minus the writes — see D7.

---

## 5. Work slices

Five slices. **S1 must land first and alone**, merged into `mineru4/p3`; S2–S5 then start in parallel
from `mineru4/p3`. Branches `mineru4/p3-a` … `mineru4/p3-e`, one worktree each, nothing pushed.
Every signature in §2 is frozen, so S2–S5 can be written against it before S1 merges — but **no slice
creates a local stub**; they rebase onto `mineru4/p3`.

No file appears in two OWNS lists.

### S1 — Schema, contracts, ledger core, worker *(blocking)*

**Goal:** the ledger exists, is claimable, retries, recovers, and runs against a fake extractor. No
caller changes.

**OWNS (exclusive):**
- `src/lib/server/db/schema.ts`, `drizzle/1777140000097_document_extraction_ledger.sql`,
  `drizzle/meta/_journal.json`, `scripts/prepare-db.ts`, `src/lib/server/db/schema.test.ts`
- `src/lib/shared/extraction-status.ts`
- `src/lib/server/services/extraction/**` (all of §2.1, §2.3–§2.9, plus
  `extractors/direct-text.ts`, `extractors/legacy-mineru3.ts`, `extractors/registry.ts`,
  `config.ts`, `testing/fake-extractor.ts`)
- `src/lib/server/env.ts`, `src/lib/server/config-store.ts`,
  `src/lib/config/admin-config-registry.ts`, `src/lib/config/admin-config-registry.test.ts`,
  `src/lib/i18n/settings.ts`, `.env.example`, `docs/configuration.md`
- `src/hooks.server.ts` (one `ensureExtractionWorker()` call beside `ensureFileProductionWorker()` at `:154`)

**READ-ONLY:** `file-production/{job-ledger,worker-runner,read-model,job-wait}.ts`,
`atlas/job-ledger.ts`, `knowledge/store/{core,documents,attachments}.ts`,
`src/lib/shared/file-types/**`, `document-extraction.ts`.

**Depends on:** nothing (Phase 1 merged).

**Tests to add:** `extraction/job-ledger.test.ts`, `extraction/job-ledger.recovery.test.ts`,
`extraction/retry-policy.test.ts`, `extraction/worker-runner.test.ts`,
`extraction/read-model.legacy.test.ts`, `extraction/job-wait.test.ts`,
`extraction/extractors/direct-text.test.ts`, `extraction/contracts.test.ts`,
`src/lib/shared/extraction-status.test.ts`.
**Tests to update:** `src/lib/server/db/schema.test.ts`, `src/lib/config/admin-config-registry.test.ts`
(the `>= 83` floor becomes `>= 94`), `src/lib/i18n/settings.test.ts` (no edit needed; it must stay green).

**DoD:** `npm run check` clean; `npx vitest run src/lib/server/services/extraction src/lib/server/db
src/lib/config src/lib/i18n src/lib/shared` green; a fake extractor that is slow, throws each error code,
and forgets its handle drives every row of §3; `npm run check:migrations` clean.

### S2 — Upload intake moves onto the ledger *(hot: `attachments.ts`, `upload-intake.ts`)*

**Goal:** uploads return as soon as bytes are stored; §8 bugs B1, B2, B4, B5 fixed; D9 wrapper.

**OWNS (exclusive):**
- `src/lib/server/services/knowledge/upload-intake.ts` (+ `.test.ts`)
- `src/lib/server/services/knowledge/store/attachments.ts` (+ `.test.ts`)
- `src/lib/server/services/knowledge/store/documents.ts` (+ `.test.ts`)
- `src/lib/server/services/knowledge/types.ts`
- `src/routes/api/knowledge/upload/{+server.ts,raw/+server.ts,chunk/+server.ts,intent/+server.ts,shared.ts}`
  and their four test files
- `src/lib/server/services/knowledge/upload-temp-sweep.ts` (new, B2)

**READ-ONLY:** everything under `services/extraction/`, `knowledge/store/core.ts`,
`src/lib/shared/file-types/**`.

**Depends on:** S1 (`startUploadExtraction`, `runDirectTextExtractionInline`, `DocumentExtractionJobDTO`).

**Tests:** update `upload-intake.test.ts` (response now carries `extraction`; no MinerU call inside the
request), `attachments.test.ts` (dedupe returns the normalized artifact; auto-rename issues a prefix
query, asserted by counting `db.select` calls), `raw-upload.test.ts` (temp file unlinked on receive
failure), `upload.test.ts` (legacy wrapper still 200s and now emits `Deprecation`),
`upload-intent.test.ts` (direct-text over cap → 413 `upload_direct_text_too_large`).

**DoD:** a 40 MB PDF upload returns in the time it takes to store bytes; the response `extraction.status`
is `queued`; a `.txt` upload returns `succeeded`; no `extractDocumentText` import remains under
`services/knowledge/`.

### S3 — HTTP surface, client API, composer *(hot: `MessageInput.svelte`, `i18n/chat.ts`)*

**Goal:** real per-file status in the composer; the 900 ms timer is gone.

**OWNS (exclusive):**
- `src/routes/api/knowledge/extraction/+server.ts`,
  `src/routes/api/knowledge/extraction/[artifactId]/retry/+server.ts`,
  `src/routes/api/knowledge/extraction/[artifactId]/cancel/+server.ts` (+ tests)
- `src/lib/client/api/knowledge.ts` (+ `.test.ts`)
- `src/lib/client/extraction-poll.ts` (+ `.test.ts`) — new
- `src/lib/components/chat/MessageInput.svelte` (+ `MessageInput.test.ts`)
- `src/lib/components/chat/composer-chip-presentation.ts` (+ `.test.ts`)
- `src/routes/(app)/chat/[conversationId]/+page.svelte`,
  `src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte`,
  `src/routes/(app)/+page.svelte`
- `src/lib/i18n/chat.ts` (+ `chat.test.ts`)

**READ-ONLY:** `extraction/read-model.ts`, `extraction-status.ts`, `knowledge/types.ts`,
`file-production-helpers.ts`, `ComposerChip.svelte`.

**Depends on:** S1 (DTO, read model, ledger actions); S2 only for `KnowledgeUploadResponse.extraction`
— code against §2.11 and rebase.

**Tests:** new `extraction/+server.test.ts` (batch, ownership, >50 ids), `retry/+server.test.ts`,
`cancel/+server.test.ts`, `extraction-poll.test.ts` (fake timers: arms, backs off at 10 s, disarms on
terminal, pauses when hidden); update `MessageInput.test.ts` (**delete nothing silently** — the
`:2360-2420` hint case stays and is re-pointed at the DTO; add a case proving no timer flips the label
when no job is active), `knowledge.test.ts` (three new client fns), `page-runtime.test.ts`.

**DoD:** uploading a PDF shows a dashed chip that moves `queued → parsing → indexing → attached`
without any `setTimeout` deciding the label; `grep -n "900" MessageInput.svelte` finds nothing;
EN and HU both have every `chat.extraction.*` key.

### S4 — Knowledge page, library DTO, send gate *(hot: `i18n/knowledge.ts`, `DocumentsList.svelte`)*

**Goal:** the Knowledge list tells the truth per document; `preflight` distinguishes pending from failed.

**OWNS (exclusive):**
- `src/routes/(app)/knowledge/_components/DocumentsList.svelte` (+ `.test.ts`)
- `src/routes/(app)/knowledge/_components/documents-table.ts` (+ `.test.ts`)
- `src/routes/(app)/knowledge/+page.svelte`, `src/routes/(app)/knowledge/+page.server.ts`
- `src/lib/server/services/knowledge.ts` (the facade / library page)
- `src/lib/server/services/chat-turn/preflight.ts` (+ `preflight.test.ts`),
  `src/lib/server/services/chat-turn/types.ts`
- `src/lib/i18n/knowledge.ts`, `src/lib/i18n.test-helpers.ts`

**READ-ONLY:** `extraction/**`, `knowledge/store/attachments.ts` (S2 owns the
`AttachmentReadinessError` change — S4 consumes it), `knowledge/types.ts`.

**Depends on:** S1; and on S2 for `AttachmentReadinessError.code`/`items`. **S2 and S4 must agree on
§2.12 verbatim.** If S2 lands first, S4 rebases; otherwise S4 codes against §2.12.

**Tests:** update `DocumentsList.test.ts` (five status renderings + Retry/Cancel buttons),
`documents-table.test.ts` (extraction status wins over version status), `preflight.test.ts`
(pending → 422 `attachment_extraction_pending` after the bounded wait; failed-retryable → 422
`attachment_extraction_failed` with `retryable: true`; ready → no error), and the i18n parity test after
adding `"knowledge.extraction"` and `"chat.extraction"` to `AUDITED_PREFIXES`
(`src/lib/i18n.test-helpers.ts:21-45` — `knowledge.` and `chat.` are **not** audited today, exactly as
Phase 1 §4.1 found).

**DoD:** a document mid-extraction shows a live status in the list and cannot be selected as a
linked source; sending with a pending attachment produces a *wait* message, sending with a failed one
produces a *reason + retry* message; EN and HU parity green.

### S5 — Generated-file readback onto the ledger

**Goal:** `syncGeneratedFilesToMemory` stops blocking the file-production worker on MinerU.

**OWNS (exclusive):**
- `src/lib/server/services/chat-files.ts` (+ `chat-files.test.ts`)
- `src/lib/server/services/file-production/storage-adapter.ts`
- `src/lib/server/services/extraction/readback.ts` (new — `completeGeneratedFileReadback`)

**READ-ONLY:** `extraction/job-ledger.ts`, `extraction/worker-runner.ts`, `file-production/**` (rest).

**Depends on:** S1 (`startGeneratedFileReadback`, the worker's `origin` dispatch).

**Shape:** `syncGeneratedFilesToMemory` keeps its signature and its version/family bookkeeping but its
`extractDocumentText` call (`chat-files.ts:638`) is replaced by `startGeneratedFileReadback(...)`, and
the artifact is created immediately with `contentText: null`. When the readback job succeeds the worker
calls `completeGeneratedFileReadback({ chatGeneratedFileId, text, pageCount })`, which patches the
`generated_output` artifact's `contentText` and re-runs `syncArtifactChunks`. Source-first generated
documents (which already have canonical source text — ADR-0005 "Implementation Status, 2026-05-29")
**skip the ledger entirely**, exactly as they skip extraction today.

**Tests:** `chat-files.test.ts` — the file-production job reaches `succeeded` without waiting on
extraction; a readback job is enqueued at `priority = 10`; a source-first document enqueues nothing.

**DoD:** `extractDocumentText` has **zero** production importers left in `src/` outside
`extraction/extractors/legacy-mineru3.ts`.

### Hot-file ownership summary

| File | Concerns that want it | Sole owner |
| --- | --- | --- |
| `src/lib/server/db/schema.ts`, `drizzle/**`, `drizzle/meta/_journal.json` | new tables + `artifacts` index | **S1** |
| `src/lib/server/env.ts`, `config-store.ts`, `admin-config-registry.ts`, `i18n/settings.ts` | 11 config keys | **S1** |
| `src/hooks.server.ts` | worker bootstrap | **S1** |
| `src/lib/server/services/knowledge/store/attachments.ts` | dedupe, rename, readiness | **S2** |
| `src/lib/server/services/knowledge/upload-intake.ts` | enqueue point | **S2** |
| `src/routes/api/knowledge/upload/**` | temp leak, size cap, legacy wrapper | **S2** |
| `src/lib/components/chat/MessageInput.svelte` | timer removal, chips | **S3** |
| `src/lib/i18n/chat.ts` | composer + error strings | **S3** |
| `src/lib/client/api/knowledge.ts` | three new fns | **S3** |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | status column, actions | **S4** |
| `src/lib/i18n/knowledge.ts`, `src/lib/i18n.test-helpers.ts` | list strings + audit prefixes | **S4** |
| `src/lib/server/services/chat-turn/preflight.ts` / `types.ts` | send gate | **S4** |
| `src/lib/server/services/chat-files.ts` | readback | **S5** |

### Files Phase 1 and Phase 3 both touch (call-outs for the reviewer)

| File | Phase 1 slice | Phase 3 slice | Interaction |
| --- | --- | --- | --- |
| `src/routes/api/knowledge/upload/intent/+server.ts` | C (415 allowlist) | S2 (413 direct-text cap) | **Order matters**: the P1 415 `admitUpload` check runs first; the new size check goes immediately after it, still before `validateKnowledgeUploadConversation`. |
| `src/lib/server/services/knowledge/upload-intake.ts` | (P1 row 48: no change) | S2 | none |
| `src/lib/components/chat/MessageInput.svelte` | C (`$uploadLimits`, `accept`) | S3 | disjoint regions, but both are large edits in one file — S3 rebases onto merged P1 before starting. |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | C (accept, icons, labels) | S4 | disjoint regions; same caveat. |
| `src/lib/i18n/knowledge.ts` | C (5 upload-reject keys) | S4 (extraction status keys) | same `en`/`hu` blocks — S4 must rebase, not merge blind. |
| `src/lib/i18n/chat.ts` | C (drop-zone `{max}`) | S3 | same. |
| `src/lib/i18n.test-helpers.ts` | C (`"knowledge.upload"`) | S4 (`"knowledge.extraction"`, `"chat.extraction"`) | append, do not replace. |
| `src/lib/server/services/document-extraction.ts` | C/D (`getIntakeRoute` switch, `getCanonicalMimeForExtension`) | S1 wraps it, does not edit it | S1's `legacy-mineru3.ts` calls the P1-shaped `extractDocumentText` unchanged. |
| `src/lib/server/services/knowledge/store/attachments.ts:234` | C (`getSupportedExtractionSummary`) | S2 (readiness messages) | same function body — S2 keeps the P1 call and adds the pending/failed branch around it. |

---

## 6. Tests

### 6.1 Unit — `src/lib/server/services/extraction/`

| File | Asserts |
| --- | --- |
| `job-ledger.test.ts` | every row of §3, including that an illegal transition is a no-op returning `false`; `enqueueExtractionJob` is idempotent under a simulated UNIQUE race (`SQLITE_CONSTRAINT_UNIQUE` → re-read, copying `isUniqueConstraintError`, `file-production/job-ledger.ts:118-130`); T2 short-circuit writes no attempt row |
| `retry-policy.test.ts` | pure `computeBackoffMs(attempt, base, max, random)`; `rate_limited` honours `retryAfterMs`; every code's default retryability matches `RETRYABLE_EXTRACTION_ERROR_CODES`; `attempt_count >= maxAttempts` produces `failed` + `error_code: "max_attempts"` + `retryable: true` |
| `job-ledger.recovery.test.ts` | a `parsing` job whose attempt last heartbeat is older than `staleAttemptMs` is requeued with `stale_worker`; a job already at the attempt cap goes to `failed`; a **fresh** attempt from another worker is untouched; the recovered job keeps `remote_handle_json` |
| `claim-priority.test.ts` | upload (`priority 0`) claimed before an older readback (`priority 10`); `globalLimit` and `perUserLimit` both enforced; `next_attempt_at` in the future is skipped; `directTextOnly` ignores both caps and only sees `direct-text` rows |
| `worker-runner.test.ts` | drives the fake extractor through `uploading → parsing → downloading → indexing → succeeded`; a heartbeat that returns `false` aborts the signal and writes nothing; `extractor.cancel` is called on T13 and a throw from it does not fail the job |
| `job-wait.test.ts` | copy of `file-production/job-wait.test.ts` with the `canceled` spelling |
| `read-model.legacy.test.ts` | the four §4.4 rows; **no INSERT is issued** (spy on `db.insert`) |
| `extractors/direct-text.test.ts` | over-cap file throws `too_large` with `retryable: false`; empty file throws `empty_result`; CRLF handling matches `chunk-sync.ts` |
| `contracts.test.ts` | `toDocumentExtractionError` maps `AbortError` → `canceled`, `TypeError: fetch failed` → `unavailable`, anything else → `internal`; never throws |
| `src/lib/shared/extraction-status.test.ts` | the status/terminal/active sets partition correctly; **`expect(source.match(/^import\s(?!type)/gm)).toBeNull()`** (the Phase 1 zero-value-import guard, `file-production/output-types.test.ts:49-53`); the file spells `canceled` and never `cancelled`, while `file-production/types.ts` spells `cancelled` and never `canceled` (D8) |

### 6.2 Integration — `src/lib/server/services/extraction/integration.test.ts`

Uses `createInMemoryDb()` (`src/lib/server/db/in-memory.ts`) and
`extraction/testing/fake-extractor.ts`:

```ts
export interface FakeExtractorScript {
	/** Per-attempt behaviour, consumed in order. */
	steps: Array<
		| { kind: "succeed"; text: string; afterMs?: number; phases?: ExtractionPhase[] }
		| { kind: "throw"; code: ExtractionErrorCode; retryable?: boolean;
		    retryAfterMs?: number; handleUnknown?: boolean; afterMs?: number }
		| { kind: "hang" }            // never resolves until the signal aborts
		| { kind: "forget-handle" }   // throws protocol + handleUnknown on a resume
	>;
	emitHandleAfterPhase?: ExtractionPhase;
}
export function createFakeExtractor(script: FakeExtractorScript): DocumentExtractor & {
	readonly calls: Array<{ resumed: boolean; handle: ExtractionHandle | null }>;
};
```

Required scenarios:
1. slow success → status walks the full ladder; the composer DTO is terminal exactly once.
2. `unavailable` × 2 then success → three attempt rows, `attempt_number` 1..3, backoff respected.
3. `unavailable` × 3 → `failed`, `error_code: "max_attempts"`, `retryable: true`; user retry gives
   exactly one more attempt.
4. every non-retryable code → one attempt, `failed`, `retryable: false`.
5. handle persisted on attempt 1, worker "restart" (`recoverStaleExtractionAttempts` + new worker id)
   → attempt 2 receives `resumeHandle` and `resumed: true`, and does **not** re-submit.
6. `forget-handle` on resume → handle cleared, attempt 3 submits fresh (`resumed: false`).
7. cancel while `parsing` → `canceled`, `extractor.cancel` called with the stored handle, no further writes.
8. two users × 3 jobs each with `globalLimit 2 / perUserLimit 1` → never more than 2 active, never
   more than 1 per user, uploads always ahead of readbacks.
9. `db.transaction` is never held across an `await` on the extractor (assert by making the fake
   extractor issue a competing write while it runs).

### 6.3 Route tests

`src/routes/api/knowledge/extraction/+server.test.ts`,
`.../[artifactId]/retry/+server.test.ts`, `.../[artifactId]/cancel/+server.test.ts` — auth, ownership
(another user's artifact → omitted / 404), legacy synthetic retry materialises a row,
`wakeExtractionWorker` called on retry, `>50` ids → 400.
Updated: `upload.test.ts`, `raw-upload.test.ts`, `chunk-upload.test.ts`, `upload-intent.test.ts`,
`upload-intake.test.ts`.

### 6.4 UI tests

- `MessageInput.test.ts` — chip status per §4.3; no label change without a DTO; Retry callback fires.
- `DocumentsList.test.ts` — all eight statuses render; Retry only when `retryable`; Cancel only when
  `cancelable`.
- `documents-table.test.ts` — extraction status precedence.
- `extraction-poll.test.ts` — fake timers; interval escalation; visibility pause; disarm.
- `composer-chip-presentation.test.ts` — pure mapping, both locales.

### 6.5 Guard tests

- `extraction/boundary.test.ts`: `services/extraction/read-model.ts` and `job-ledger.ts` must not
  (transitively) import `document-extraction.ts`, `chat-files.ts` or any extractor — same idea as
  `file-production/obsolete-surfaces.test.ts`.
- `extraction/no-inline-extraction.test.ts`: no file under `src/lib/server/services/knowledge/**` or
  `src/routes/api/knowledge/**` imports `document-extraction`.

---

## 7. Config keys

All eleven are **path A** (registry-rendered Advanced rows), group `"limits"`, effect `"live"`.
Path A is chosen over the MinerU-style named-page rows because path B keys skip
`validateAdminConfigValue()` entirely (`src/routes/api/admin/config/+server.ts:109-113`) and get no
i18n completeness test.

| Key | Default | Bounds | `control` | Consumer |
| --- | --- | --- | --- | --- |
| `DOCUMENT_EXTRACTION_WORKER_ENABLED` | `true` | — | `{ kind: "bool" }` | `drainExtractionWorker` (checked per claim, so `live`) |
| `DOCUMENT_EXTRACTION_MAX_CONCURRENCY` | `3` | 1–16 | `int(1, 16)` | `claimNextExtractionJob` |
| `DOCUMENT_EXTRACTION_PER_USER_CONCURRENCY` | `2` | 1–16 | `int(1, 16)` | `claimNextExtractionJob` |
| `DOCUMENT_EXTRACTION_MAX_ATTEMPTS` | `3` | 1–10 | `int(1, 10)` | `failExtractionAttempt` |
| `DOCUMENT_EXTRACTION_RETRY_BASE_MS` | `2000` | 100–600000 | `int(100, 600000, "ms")` | backoff |
| `DOCUMENT_EXTRACTION_RETRY_MAX_MS` | `60000` | 1000–3600000 | `int(1000, 3600000, "s", 1000)` | backoff |
| `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` | `900000` | 60000–3600000 | `int(60000, 3600000, "min", 60000)` | `recoverStaleExtractionAttempts` |
| `DOCUMENT_EXTRACTION_HEARTBEAT_MS` | `15000` | 1000–120000 | `int(1000, 120000, "s", 1000)` | worker heartbeat interval |
| `DOCUMENT_EXTRACTION_INLINE_BUDGET_MS` | `1500` | 0–15000 | `int(0, 15000, "ms")` | `runDirectTextExtractionInline` |
| `DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS` | `2500` | 0–30000 | `int(0, 30000, "ms")` | `preflight` bounded wait |
| `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` | `8388608` | 1024–134217728 | `int(1024, 134217728, "mb", MB)` | intent route + `directTextExtractor` |

> `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` default is **15 min**, deliberately longer than
> `MINERU_TIMEOUT_MS`'s 5-minute default: a live attempt must never be reclaimed while its HTTP call is
> still legitimately in flight. If an admin raises `MINERU_TIMEOUT_MS` past 15 min the two will fight —
> noted in OQ5.

### 7.1 Exact touchpoints per key (all owned by S1)

1. **`src/lib/server/env.ts`** — declare in `interface Config` (after
   `fileProductionMaxTotalOutputBytes`, ~`:234`) and parse in `readConfig()` (~`:975`):
   ```ts
   	documentExtractionMaxConcurrency: number;
   	// …
   		documentExtractionMaxConcurrency: Math.max(
   			1,
   			Math.min(16, parseInt(process.env.DOCUMENT_EXTRACTION_MAX_CONCURRENCY || "3", 10) || 3),
   		),
   ```
2. **`src/lib/server/config-store.ts`** — four edits per key:
   `ADMIN_CONFIG_KEYS` (after `:166`), `RuntimeConfig` field (after `:344`), `overrideAppliers`
   (~`:1170`, a total `Record` so omission is a compile error), `getResolvedAdminConfigValues`
   (~`:1745`, also total). **Keep the clamp identical to `env.ts` — nothing checks this.**
3. **`src/lib/config/admin-config-registry.ts`** — one `AdminConfigKeySpec` per key appended to the
   `// --- Resource limits` block (after `:180`). No `SURFACED_ADMIN_CONFIG_KEYS` edit (path A is
   auto-included at `:708`). **Do not use `effect: "restart"`** — `admin-config-registry.test.ts:110`
   asserts the restart set by exact equality. **Do not use `unit: "count"`** — `AdminConfigUnit`
   declares it but `admin.system.unit.count` exists in neither language, so the raw key would render.
4. **`src/lib/i18n/settings.ts`** — `admin.system.keys.<KEY>.label` and `.meaning` in **both** the
   `en` block (~`:1430`) and the `hu` block (~`:3300`), alphabetical among the existing entries.
   `admin-config-registry.test.ts:50-64` fails otherwise.
5. **`src/lib/config/admin-config-registry.test.ts`** — raise the count floor at `:66-70` from `83` to
   `95`. (`ADVANCED_KEY_SPECS` currently holds **84** entries; 84 + 11 = 95.)
6. **`.env.example`** — a commented block in the MinerU style (`:131-136`).
7. **`docs/configuration.md`** — one table row each (columns per `:173-174`).
8. **No edits** to `system/pages.ts`, `AdvancedPage.svelte`, `AdvancedRow.svelte`,
   `SettingsAdminSystemPane.svelte`'s `NAMED_KEY_LABEL`, `api/admin/config/+server.ts`, or
   `settings/+page.server.ts` — path A is auto-rendered and auto-indexed.

Verify: `npx vitest run src/lib/config/admin-config-registry.test.ts src/lib/i18n/settings.test.ts
src/lib/server/services/admin-effective-config.test.ts`.

---

## 8. Known bugs fixed in this phase

| # | Bug | Exact location | Fix | Slice |
| --- | --- | --- | --- | --- |
| B1 | Deduplicated re-upload returns `normalizedArtifact: null`, so extraction re-runs on already-extracted bytes | `knowledge/store/attachments.ts:493-503` (`saveUploadedArtifact`) **and** `:589-605` (`saveUploadedArtifactFromStoredFile`) — both dedupe branches hardcode `normalizedArtifact: null`; `upload-intake.ts:120-136` then sees `null` + a `storagePath` and calls `createNormalizedArtifact` again | Both branches call `getNormalizedArtifactForSource(userId, existingArtifact.id)` (`store/core.ts:356`) and return it. Belt-and-braces: `startUploadExtraction` short-circuits to T2 when a normalized artifact exists, and `UNIQUE(source_artifact_id)` makes a duplicate job impossible. | S2 |
| B2 | Aborted raw upload leaks a temp file | `src/routes/api/knowledge/upload/raw/+server.ts` — the `catch` around `receiveRawUpload` (≈`:258-298`) returns without `unlink`, unlike the `isKnowledgeUploadConversationError` catch at `:328` which does (`unlink` is already imported at `:1`). Nothing ever sweeps `data/knowledge/<user>/.incoming/`. | `await unlink(tempPathAbsolute).catch(() => undefined)` in that catch; plus a new `knowledge/upload-temp-sweep.ts` that deletes `.incoming/*` older than 6 h, called once from `ensureExtractionWorker()`'s boot path. Same sweep covers `chunk/+server.ts`'s `uploadDir`. | S2 |
| B3 | Legacy multipart route may be dead | Verified: **no caller in `src/`**. Only `upload.test.ts` and `tests/e2e/composer-command-v1.spec.ts:124`'s `**/api/knowledge/upload**` glob (which also matches `/raw` and `/chunk`). `docs/adr/0024` and `src/routes/AGENTS.md:63` still document it. | **Keep** (D9): thin wrapper over `completeKnowledgeUploadFromFile`, `Deprecation: true` response header, one `console.warn("[KNOWLEDGE] legacy multipart upload route used")`. Off-repo on-box verify scripts POST multipart `file` + `conversationId`; a 404 there would look like an app failure. Re-evaluate when those scripts are moved into the repo. | S2 |
| B4 | `resolveArtifactNameWithAutoRename` loads **every** artifact name for the user on each collision | `knowledge/store/attachments.ts:421-432` (`getAllArtifactNamesForUser`) called from `:433-461`. There is no `artifacts(user_id, name)` index, so `findExistingArtifactByName` (`:379`) is a scan too. | Add `artifacts_user_name_idx` (§1.2). Replace `getAllArtifactNamesForUser` with a prefix query: `SELECT name FROM artifacts WHERE user_id = ? AND name LIKE ? ESCAPE '\'` where the pattern is `<base>%<.ext>` with `%` `_` `\` escaped in `<base>`. `generateUniqueFilename` keeps its signature and still takes a `Set<string>`. | S2 (index ships in S1's migration) |
| B5 | No size cap on `direct-text`: a 100 MB `.log` is read whole, chunked and embedded | Phase 1 §2.4a widened `direct-text` to 33 more extensions; the orchestrator ruling deferred the cap to Phase 3. | `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` (8 MiB). Enforced (a) in `/api/knowledge/upload/intent/+server.ts`, after the Phase 1 415 check and before the conversation check, as **413** `{ code: "upload_direct_text_too_large", errorKey: "knowledge.uploadDirectTextTooLarge", details: { fileName, fileSize, maxBytes } }`; (b) in `directTextExtractor`, which throws `too_large` (non-retryable) for the raw/chunk routes that never re-run intent. EN + HU key required. | S2 |

---

## 9. Non-goals, risks, open questions

### 9.1 Non-goals

- **The MinerU HTTP client.** `document-extraction.ts` is wrapped, never edited. Phase 2 owns it.
- **Multi-process workers, Redis, BullMQ.** ADR-0005 rules this out for v1 and the schema does not
  prevent it later.
- **Chunking / embedding strategy.** `syncArtifactChunks` and
  `queueArtifactSemanticEmbeddingRefresh` are called exactly as today, from the same
  `createArtifact`.
- **OCR quality, page counts, outlines.** Comfort metadata moves verbatim into `persist.ts`.
- **A new SSE channel** (D4). **Upload byte progress** — `ChunkUploadResponse.receivedBytes/totalSize`
  already exists unused on the wire (`client/api/knowledge.ts:78-92`); wiring it is a separate, purely
  client-side change and is out of scope.
- **Deleting the legacy multipart route** (D9/B3).
- **Rename in the Knowledge list.** Not present today; not added.

### 9.2 Risks

| Risk | Why it bites here | Mitigation |
| --- | --- | --- |
| **`promptReady: false` now means "not yet"** | Every existing surface treats it as a permanent failure and shows "This file could not be prepared for chat." A user uploading a PDF would see a failure message for the normal case. | §4.2 lists every consumer. `resolvePromptAttachmentArtifacts` must consult the ledger before choosing a `readinessError`. `preflight.test.ts` and `MessageInput.test.ts` both get an explicit "pending is not failure" case. |
| **SQLite write contention** | `sqlite.pragma("busy_timeout = 10000")` + WAL (`db/index.ts:6-8`), one connection, one process. New writers: ≤3 heartbeats per 15 s, ≤3 status writes per job, and the `indexing` phase's chunk inserts. | Heartbeats are single-row updates outside any long transaction. **No `db.transaction` may wrap an `await` on an extractor** — §6.2 scenario 9 asserts this. `createArtifact` + `syncArtifactChunks` run after the `indexing` status write, not inside it. |
| **Single-process assumption** | Everything today assumes one Node process (`ensureFileProductionWorker` uses a module-level `workerInitialized`); nothing enforces it. | The claim CAS and `worker_id` ownership checks make a second process correct, just under-tested. Documented, not relied on. A second process would double the effective `globalLimit` — noted in OQ3. |
| **Worker starvation by readback** | A burst of generated files could occupy every seat at `priority 10`. | Uploads sort ahead of readbacks, but a *running* readback is not preempted. With `globalLimit 3 / perUserLimit 2` a single user's uploads can always claim a seat. OQ4 proposes a reserved upload seat if this proves wrong. |
| **Cancel is best-effort** | `extractor.cancel` may fail or the remote may have no cancel. The job is `canceled` in the ledger regardless. | Documented in T13; `cancel` failures are logged under `[EXTRACTION]` and never surfaced. |
| **Handle resume vs. a rotated remote** | A resumed handle pointing at a restarted MinerU wastes one attempt. | `handleUnknown` clears the handle and the next attempt submits fresh; §6.2 scenario 6. |
| **Poll storm** | Three surfaces (composer, landing, knowledge) each polling. | One poller module, armed only while a tracked job is non-terminal, paused on `visibilitychange`, batch endpoint capped at 50 ids, 1 s → 2.5 s escalation. |
| **Parallel-slice merge conflicts with Phase 1** | Six files are touched by both phases. | The call-out table in §5. S3 and S4 rebase onto merged Phase 1 before their first commit. |
| **`canceled` vs `cancelled`** | Two spellings in one codebase invite a "cleanup" that breaks a status string. | D8 + the §6.1 spelling test. |

### 9.3 Open questions

| # | Question | Recommended answer |
| --- | --- | --- |
| OQ1 | Should `preflight` wait server-side at all, or always tell the client to wait? | **Wait, bounded at 2500 ms** (D5). Justification: the p50 direct-text and small-PDF job settles well inside it, so the common case keeps its one-click send. Cap it; never wait for a `mineru` job that has not yet left `queued`. |
| OQ2 | Should the send gate keep HTTP 422, or move "still processing" to 409/425? | **Keep 422** for all three codes. `isAttachmentReadinessError` and both client handlers key on the 422 path today; changing the status buys nothing a distinct `code` does not, and risks a silent regression in the retry route. |
| OQ3 | `globalLimit` is per-process. If a second Node process is ever started, the effective cap doubles. Store a lease table instead? | **No.** The cap is enforced by counting *rows* in active statuses, not by counting local promises — so it is already global across processes. The only per-process thing is the scheduler. No change needed; the risk table entry is informational. |
| OQ4 | Reserve one worker seat for `priority 0` so a readback burst cannot delay an upload? | **Not in v1.** `perUserLimit 2` of `globalLimit 3` already guarantees an upload seat for the interactive user in the single-user-at-a-time reality of this deployment. Revisit with a `DOCUMENT_EXTRACTION_RESERVED_UPLOAD_SLOTS` key if measurements say otherwise. |
| OQ5 | `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` (15 min) must exceed `MINERU_TIMEOUT_MS` (5 min default, admin-editable to anything). Enforce the relation? | **Yes, softly**: `recoverStaleExtractionAttempts` uses `Math.max(staleAttemptMs, mineruTimeoutMs * 2)`. A hard validation across two keys has nowhere to live in the registry (specs validate one key in isolation). |
| OQ6 | Should the composer chip appear before the upload POST resolves (optimistic, no artifact id yet)? | **Yes.** `ComposerChip` already has `dashed` and a `queued` kind, and today there is *no* chip at all until the whole round trip finishes. Key the optimistic chip on a client-generated id and swap it for the artifact id when the response lands — the same trick `buildPendingFileProductionJobPlaceholder` (`chat/[conversationId]/_helpers.ts:280`) already plays. |
| OQ7 | Should `empty_result` be retryable? | **No.** Same bytes, same backend, same answer. It is a user-facing "we could not read this", not an infrastructure fault. A user Retry is still offered for `legacy_unknown` and `max_attempts` only. |
| OQ8 | 8 MiB for `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` — right number? | **Yes for v1.** 8 MiB ≈ 2 M tokens ≈ ~6 000 chunk rows and ~6 000 TEI calls from one upload, already an order of magnitude past any useful attachment. It is admin-raisable. Needs an owner ruling because it is a **user-visible refusal** for a file that uploads fine today. |
| OQ9 | Does `chat_generated_files` cascade-delete correctly for readback jobs when a conversation is forked? | `conversation-forks.ts:859-880` copies `artifact_chunks` rows directly. A forked conversation's generated files get **new** ids, so the `UNIQUE(chat_generated_file_id)` index cannot collide. **No change needed**, but the reviewer should confirm against `conversation-forks.test.ts`. |
| OQ10 | Should the Knowledge list poll, or just refresh on tab focus? | **Poll**, reusing the same module as the composer, but only while ≥1 listed document is non-terminal. The page already does a full `invalidateAll()` per uploaded file today (`knowledge/+page.svelte:445`) — the poller is strictly cheaper. |

---

## 10. Definition of done for the phase

- [ ] A 40 MB scanned PDF upload returns an HTTP response in storage time, not extraction time.
- [ ] Composer, landing page and Knowledge page all render the same eight statuses from the same DTO.
- [ ] `grep -rn "setTimeout" src/lib/components/chat/MessageInput.svelte` shows nothing related to upload state.
- [ ] `extractDocumentText` has exactly one production importer: `extraction/extractors/legacy-mineru3.ts`.
- [ ] Killing the process mid-`parsing` and restarting it resumes the same attempt's remote job rather than re-submitting.
- [ ] `npm run check` clean; `npm run lint` clean; `npm run check:migrations` clean; `npx vitest run` green.
- [ ] Fallow reports no new findings (`AGENTS.md` Fallow Audit Gate).
- [ ] EN/HU parity green with `"chat.extraction"` and `"knowledge.extraction"` in `AUDITED_PREFIXES`.

---

## Orchestrator rulings (2026-09-20) — these override anything above that conflicts

- **Status.** Draft, written against the state of the code before Phase 1 merged. Before Phase 3 development starts, the file-ownership lists must be re-checked against the merged Phase 1 code.
- **Open questions.** Every recommended answer is adopted: OQ1 (preflight waits at most 2500 ms, never for a `mineru` job still `queued`), OQ4 (no reserved worker seat in v1), OQ5 (soft `Math.max` coupling), OQ6 (optimistic composer chip).
- **OQ8.** The direct-text cap is 8 MiB and admin-raisable. This is a user-visible refusal of files that upload today; it is listed in the migration doc for the owner to review before cutover.
- **OQ9.** The reviewer of slice S5 must confirm against `conversation-forks.test.ts` that forking cannot collide on `UNIQUE(chat_generated_file_id)`.
- **Order.** S1 runs alone first and merges into the integration branch `mineru4/p3`; S2 to S5 then run in parallel from it. Branches `mineru4/p3-s1` … `mineru4/p3-s5`. Nothing is pushed.
- **Toolchain and commits.** Homebrew `node@22`. Stage by explicit path; never `git add -A`.
