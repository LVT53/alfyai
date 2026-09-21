// The document-extraction ledger: every legal state change of a job row, and
// nothing else. No file system, no HTTP, no extractor — those live behind the
// seam in `contracts.ts`, which is what lets a route import this module (and
// the read model beside it) without dragging a backend client into a request
// that only reads rows.
//
// Every transition is one `db.transaction` guarded by `WHERE id = ? AND status
// = <from>`, plus, for anything an attempt owns, `AND current_attempt_id = ?
// AND attempts.worker_id = ?`. A worker that lost its claim to the stale-attempt
// recovery therefore cannot write over the worker that took it: its update
// matches zero rows and the function returns `false`, which the worker treats
// as "abort, write nothing".
//
// No transaction here wraps an `await` on an extractor. The extractor runs
// between transactions, never inside one; better-sqlite3 transactions are
// synchronous and one held across a network call would block every other writer
// in the process for the length of that call.

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	documentExtractionJobAttempts,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type {
	DocumentExtractionActiveStatus,
	DocumentExtractionStatus,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import {
	DOCUMENT_EXTRACTION_ACTIVE_STATUSES,
	isTerminalExtractionStatus,
} from "$lib/shared/extraction-status";
import { getIntakeRoute } from "$lib/shared/file-types";
import {
	isProcessAlive,
	type ParsedWorkerId,
	parseWorkerId,
} from "../worker-identity";
import { getExtractionConfig } from "./config";
import {
	type ExtractionHandle,
	parseExtractionHandle,
	serializeExtractionHandle,
} from "./contracts";
import {
	decideExtractionRetry,
	EXTRACTION_OUTAGE_HINT_KEY,
	type ExtractionOutageState,
	extractionAttemptCeiling,
	extractionDocumentAttempts,
	readExtractionOutageState,
} from "./retry-policy";
import { canReportExtractionPhase } from "./state-machine";
import type {
	DocumentExtractionAttemptRow,
	DocumentExtractionIntakeRoute,
	DocumentExtractionJobRow,
	DocumentExtractionOrigin,
} from "./types";
import { EXTRACTION_PRIORITY_UPLOAD } from "./types";

export type {
	DocumentExtractionAttemptRow,
	DocumentExtractionJobRow,
} from "./types";

const ACTIVE_STATUSES: readonly string[] = DOCUMENT_EXTRACTION_ACTIVE_STATUSES;

function isUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const code =
		"code" in error && typeof error.code === "string" ? error.code : null;
	return (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		error.message.includes("UNIQUE constraint failed")
	);
}

function serializeHints(
	hints: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
	if (!hints) return null;
	const keys = Object.keys(hints);
	return keys.length === 0 ? null : JSON.stringify(hints);
}

/**
 * The one key inside `hints_json` the LEDGER owns.
 *
 * `hints_json` is the only job-level JSON column, and the outage counter has to
 * live somewhere durable: it is what separates "attempts spent on this
 * document" from "attempts spent waiting for a backend that was down", and
 * without it a half-hour outage silently eats the user's Retry budget. A
 * reserved, `$`-prefixed key costs no migration and is stripped before the
 * hints ever reach an extractor, so the seam's "opaque, caller-supplied" rule
 * still holds from the extractor's side.
 */
const LEDGER_HINT_PREFIX = "$";

function parseHintObject(
	json: string | null | undefined,
): Record<string, unknown> | null {
	if (!json) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// A hint blob we cannot read is a hint we do not apply. It is advisory
		// input, never required for correctness, so dropping it is safe.
	}
	return null;
}

export function parseExtractionHints(
	json: string | null | undefined,
): Record<string, unknown> | null {
	const parsed = parseHintObject(json);
	if (!parsed) return null;
	const caller = Object.fromEntries(
		Object.entries(parsed).filter(
			([key]) => !key.startsWith(LEDGER_HINT_PREFIX),
		),
	);
	return Object.keys(caller).length === 0 ? null : caller;
}

/** Writes the outage state back beside whatever hints the caller supplied. */
/**
 * Rewrites the reserved `$outage` key inside a job's `hints_json`, leaving
 * every caller-owned key alone.
 *
 * Exported because `reextract.ts` requeues a job too and must carry the
 * cumulative `waits` across, exactly as `retryExtractionJob` does. It writes
 * the whole column, so without this it would destroy the one record of which
 * attempts were not the document's fault.
 */
export function withOutageState(
	hintsJson: string | null | undefined,
	state: ExtractionOutageState,
): string | null {
	const base = parseHintObject(hintsJson) ?? {};
	const next: Record<string, unknown> = { ...base };
	if (state.since === null && state.waits === 0) {
		delete next[EXTRACTION_OUTAGE_HINT_KEY];
	} else {
		next[EXTRACTION_OUTAGE_HINT_KEY] = {
			since: state.since,
			waits: state.waits,
		};
	}
	return Object.keys(next).length === 0 ? null : JSON.stringify(next);
}

export interface EnqueueExtractionJobInput {
	userId: string;
	conversationId: string | null;
	origin: DocumentExtractionOrigin;
	intakeRoute: DocumentExtractionIntakeRoute;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	sourceArtifactId?: string | null;
	chatGeneratedFileId?: string | null;
	priority?: number;
	/** Opaque, durable extraction hints. The ledger stores and forwards them. */
	hints?: Readonly<Record<string, unknown>> | null;
	/**
	 * A dedupe hit whose normalized artifact already exists. The job is born
	 * `succeeded` with no attempt row and the worker never sees it.
	 */
	normalizedArtifactId?: string | null;
	/** Born-failed, for a file no extractor can be asked to read. */
	failure?: {
		errorCode: ExtractionErrorCode;
		errorMessage: string;
		retryable?: boolean;
	} | null;
	now?: Date;
}

export interface EnqueueExtractionJobResult {
	job: DocumentExtractionJobRow;
	reused: boolean;
}

async function findExistingJob(input: {
	sourceArtifactId?: string | null;
	chatGeneratedFileId?: string | null;
}): Promise<DocumentExtractionJobRow | null> {
	if (input.sourceArtifactId) {
		const [row] = await db
			.select()
			.from(documentExtractionJobs)
			.where(
				eq(documentExtractionJobs.sourceArtifactId, input.sourceArtifactId),
			)
			.limit(1);
		return row ?? null;
	}
	if (input.chatGeneratedFileId) {
		const [row] = await db
			.select()
			.from(documentExtractionJobs)
			.where(
				eq(
					documentExtractionJobs.chatGeneratedFileId,
					input.chatGeneratedFileId,
				),
			)
			.limit(1);
		return row ?? null;
	}
	return null;
}

/**
 * Idempotent on `(source_artifact_id)` / `(chat_generated_file_id)`, both of
 * which carry a partial UNIQUE index. Two concurrent uploads of the same
 * artifact therefore cannot produce two jobs: the loser of the insert race
 * re-reads the winner's row rather than throwing, exactly as
 * `file-production/job-ledger.ts` does for its idempotency key.
 */
export async function enqueueExtractionJob(
	input: EnqueueExtractionJobInput,
): Promise<EnqueueExtractionJobResult> {
	if (!input.sourceArtifactId && !input.chatGeneratedFileId) {
		throw new Error(
			"enqueueExtractionJob requires a sourceArtifactId or a chatGeneratedFileId",
		);
	}

	const existing = await findExistingJob(input);
	if (existing) {
		return { job: existing, reused: true };
	}

	const now = input.now ?? new Date();
	const id = randomUUID();
	const succeededAtBirth = Boolean(input.normalizedArtifactId);
	const failedAtBirth = !succeededAtBirth && Boolean(input.failure);
	const status: DocumentExtractionStatus = succeededAtBirth
		? "succeeded"
		: failedAtBirth
			? "failed"
			: "queued";

	const values = {
		id,
		userId: input.userId,
		conversationId: input.conversationId,
		sourceArtifactId: input.sourceArtifactId ?? null,
		chatGeneratedFileId: input.chatGeneratedFileId ?? null,
		normalizedArtifactId: input.normalizedArtifactId ?? null,
		origin: input.origin,
		intakeRoute: input.intakeRoute,
		priority: input.priority ?? EXTRACTION_PRIORITY_UPLOAD,
		fileName: input.fileName,
		mimeType: input.mimeType,
		sizeBytes: input.sizeBytes,
		status,
		attemptCount: 0,
		currentAttemptId: null,
		remoteHandleJson: null,
		hintsJson: serializeHints(input.hints),
		retryable: failedAtBirth ? (input.failure?.retryable ?? false) : false,
		errorCode: failedAtBirth ? (input.failure?.errorCode ?? null) : null,
		errorMessage: failedAtBirth ? (input.failure?.errorMessage ?? null) : null,
		nextAttemptAt: null,
		cancelRequestedAt: null,
		startedAt: status === "queued" ? null : now,
		completedAt: status === "queued" ? null : now,
		createdAt: now,
		updatedAt: now,
	};

	try {
		await db.insert(documentExtractionJobs).values(values);
	} catch (error) {
		if (!isUniqueConstraintError(error)) {
			throw error;
		}
		const winner = await findExistingJob(input);
		if (!winner) {
			throw error;
		}
		return { job: winner, reused: true };
	}

	const [inserted] = await db
		.select()
		.from(documentExtractionJobs)
		.where(eq(documentExtractionJobs.id, id))
		.limit(1);
	if (!inserted) {
		throw new Error(`Enqueued extraction job ${id} disappeared immediately`);
	}

	return { job: inserted, reused: false };
}

/**
 * How many per-user HEADS the claim looks at before giving up for this tick.
 *
 * It used to be 32 rows chosen by `ORDER BY priority, created_at` over the
 * whole queue, which is the starvation bug: one user who queues a folder of
 * 100 documents fills the entire window with their own rows, and the per-user
 * cap then rejects all 32 of them. Another user's single upload, queued a
 * second later, is not in the window at all and cannot be claimed until the
 * first user's backlog drains below the window — potentially for as long as
 * they keep uploading.
 *
 * The window now holds at most ONE row per user, so it is 32 DISTINCT users
 * deep. The ordering across users is unchanged (priority first — uploads
 * before readbacks — then age), so a fair claim is still a prioritised one.
 */
const CLAIM_CANDIDATE_LIMIT = 32;

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

/**
 * Atomic claim.
 *
 * The whole body runs inside one better-sqlite3 transaction, so the count that
 * enforces the caps and the CAS that takes the row cannot be separated by
 * another writer. The final `UPDATE … WHERE id = ? AND status = 'queued'` is
 * the CAS: a second process that read the same candidate first sees
 * `changes === 0` and moves to the next one, which is why a second Node process
 * would be correct rather than merely unlikely to collide.
 *
 * On the attempt cap: this function deliberately does NOT know `maxAttempts`.
 * The cap is applied on FAILURE (`failExtractionAttempt`), which means a job a
 * user re-queued through `retryExtractionJob` — already at or past the cap —
 * gets claimed once more, and that single extra attempt is exactly the
 * behaviour T14 asks for. Moving the cap here would make a user's Retry button
 * a no-op the moment the automatic attempts ran out, i.e. precisely when it is
 * the only thing left to press.
 */
export async function claimNextExtractionJob(
	input: ClaimExtractionJobInput,
): Promise<ClaimedExtractionJob | null> {
	const now = input.now ?? new Date();
	const directTextOnly = input.directTextOnly === true;

	const claimed = db.transaction((tx) => {
		if (!directTextOnly) {
			const [activeCount] = tx
				.select({ count: sql<number>`count(*)` })
				.from(documentExtractionJobs)
				.where(inArray(documentExtractionJobs.status, ACTIVE_STATUSES))
				.all();
			if (Number(activeCount?.count ?? 0) >= input.globalLimit) {
				return null;
			}
		}

		const gate = and(
			eq(documentExtractionJobs.status, "queued"),
			or(
				isNull(documentExtractionJobs.nextAttemptAt),
				lte(documentExtractionJobs.nextAttemptAt, now),
			),
			directTextOnly
				? eq(documentExtractionJobs.intakeRoute, "direct-text")
				: undefined,
			input.jobId ? eq(documentExtractionJobs.id, input.jobId) : undefined,
		);

		// One row PER USER — that user's oldest claimable job — and only then
		// ordered by priority and age. See CLAIM_CANDIDATE_LIMIT for why the
		// previous "oldest 32 rows overall" was unfair.
		const headIds = tx
			.all<{ id: string }>(
				sql`
					select id from (
						select
							id,
							priority,
							created_at,
							row_number() over (
								partition by user_id
								order by priority asc, created_at asc, id asc
							) as user_rank
						from ${documentExtractionJobs}
						where ${gate}
					)
					where user_rank = 1
					order by priority asc, created_at asc, id asc
					limit ${CLAIM_CANDIDATE_LIMIT}
				`,
			)
			.map((row) => row.id);

		if (headIds.length === 0) return null;

		const candidatesById = new Map(
			tx
				.select()
				.from(documentExtractionJobs)
				.where(inArray(documentExtractionJobs.id, headIds))
				.all()
				.map((row) => [row.id, row] as const),
		);
		const candidates = headIds.flatMap((id) => {
			const row = candidatesById.get(id);
			return row ? [row] : [];
		});

		for (const candidate of candidates) {
			if (!directTextOnly) {
				const [perUser] = tx
					.select({ count: sql<number>`count(*)` })
					.from(documentExtractionJobs)
					.where(
						and(
							eq(documentExtractionJobs.userId, candidate.userId),
							inArray(documentExtractionJobs.status, ACTIVE_STATUSES),
						),
					)
					.all();
				if (Number(perUser?.count ?? 0) >= input.perUserLimit) {
					continue;
				}
			}

			const attemptNumber = candidate.attemptCount + 1;
			const attemptId = randomUUID();
			const resumeHandle = parseExtractionHandle(candidate.remoteHandleJson);

			const updated = tx
				.update(documentExtractionJobs)
				.set({
					status: "uploading",
					currentAttemptId: attemptId,
					attemptCount: attemptNumber,
					startedAt: candidate.startedAt ?? now,
					retryable: false,
					errorCode: null,
					errorMessage: null,
					nextAttemptAt: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(documentExtractionJobs.id, candidate.id),
						eq(documentExtractionJobs.status, "queued"),
					),
				)
				.run();

			if (updated.changes === 0) {
				continue;
			}

			const attempt = {
				id: attemptId,
				jobId: candidate.id,
				attemptNumber,
				status: "running",
				phase: "uploading",
				extractor: null,
				resumed: resumeHandle !== null,
				remoteHandleJson: candidate.remoteHandleJson,
				workerId: input.workerId,
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				finishedAt: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
				textLength: null,
				pageCount: null,
				diagnosticsJson: null,
				createdAt: now,
				updatedAt: now,
			} satisfies DocumentExtractionAttemptRow;

			tx.insert(documentExtractionJobAttempts).values(attempt).run();

			const [job] = tx
				.select()
				.from(documentExtractionJobs)
				.where(eq(documentExtractionJobs.id, candidate.id))
				.limit(1)
				.all();

			if (!job || job.currentAttemptId !== attemptId) {
				return null;
			}

			return { job, attempt, resumeHandle };
		}

		return null;
	});

	return claimed ?? null;
}

export interface OwnedAttemptInput {
	jobId: string;
	attemptId: string;
	workerId: string;
	now?: Date;
}

/**
 * The ownership predicate every attempt-owned write shares: the job must still
 * be active, still point at this attempt, and the attempt must still be running
 * under this worker id.
 */
function ownedActiveJob(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	input: OwnedAttemptInput,
): DocumentExtractionJobRow | null {
	const [job] = tx
		.select()
		.from(documentExtractionJobs)
		.where(
			and(
				eq(documentExtractionJobs.id, input.jobId),
				inArray(documentExtractionJobs.status, ACTIVE_STATUSES),
				eq(documentExtractionJobs.currentAttemptId, input.attemptId),
			),
		)
		.limit(1)
		.all();
	if (!job) return null;

	const [attempt] = tx
		.select({ id: documentExtractionJobAttempts.id })
		.from(documentExtractionJobAttempts)
		.where(
			and(
				eq(documentExtractionJobAttempts.id, input.attemptId),
				eq(documentExtractionJobAttempts.jobId, input.jobId),
				eq(documentExtractionJobAttempts.workerId, input.workerId),
				eq(documentExtractionJobAttempts.status, "running"),
			),
		)
		.limit(1)
		.all();

	return attempt ? job : null;
}

export interface ReportExtractionProgressInput extends OwnedAttemptInput {
	status: DocumentExtractionActiveStatus;
	handle?: ExtractionHandle | null;
	/** Persisted on the attempt row for diagnostics. */
	extractor?: string | null;
}

/**
 * Writes heartbeat + status + handle. Returns false when this worker no longer
 * owns the attempt, or when the reported phase would move the job backwards.
 *
 * Reporting the SAME phase again is legal and is a pure heartbeat — an
 * extractor that polls a remote every two seconds should not have to remember
 * whether it has already announced `parsing`.
 */
export async function reportExtractionProgress(
	input: ReportExtractionProgressInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const job = ownedActiveJob(tx, input);
		if (!job) return false;

		const from = job.status as DocumentExtractionStatus;
		if (!canReportExtractionPhase(from, input.status)) {
			return false;
		}

		const handleJson =
			input.handle === undefined
				? undefined
				: serializeExtractionHandle(input.handle);

		tx.update(documentExtractionJobs)
			.set({
				status: input.status,
				...(handleJson === undefined ? {} : { remoteHandleJson: handleJson }),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.status, from),
					eq(documentExtractionJobs.currentAttemptId, input.attemptId),
				),
			)
			.run();

		tx.update(documentExtractionJobAttempts)
			.set({
				phase: input.status,
				heartbeatAt: now,
				...(handleJson === undefined ? {} : { remoteHandleJson: handleJson }),
				...(input.extractor ? { extractor: input.extractor } : {}),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobAttempts.id, input.attemptId),
					eq(documentExtractionJobAttempts.jobId, input.jobId),
					eq(documentExtractionJobAttempts.workerId, input.workerId),
					eq(documentExtractionJobAttempts.status, "running"),
				),
			)
			.run();

		return true;
	});
}

/** Heartbeat only, no status change. */
export async function heartbeatExtractionAttempt(
	input: OwnedAttemptInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		if (!ownedActiveJob(tx, input)) return false;

		const result = tx
			.update(documentExtractionJobAttempts)
			.set({ heartbeatAt: now, updatedAt: now })
			.where(
				and(
					eq(documentExtractionJobAttempts.id, input.attemptId),
					eq(documentExtractionJobAttempts.jobId, input.jobId),
					eq(documentExtractionJobAttempts.workerId, input.workerId),
					eq(documentExtractionJobAttempts.status, "running"),
				),
			)
			.run();

		return result.changes > 0;
	});
}

export interface CompleteExtractionAttemptInput extends OwnedAttemptInput {
	normalizedArtifactId: string;
	textLength: number;
	pageCount: number | null;
	/**
	 * Facts about a SUCCESSFUL attempt worth keeping — today, whether the chunk
	 * ceiling truncated retrieval for this document. A success that is partial
	 * in a way nobody recorded is the kind of thing an operator later cannot
	 * explain.
	 */
	diagnostics?: Record<string, unknown>;
}

/**
 * `indexing → succeeded`. The normalized artifact already exists by the time
 * this runs: `createNormalizedArtifactFromExtraction` is awaited BEFORE this
 * call, outside any transaction, because it inserts an artifact plus every
 * chunk row and queues an embedding refresh.
 */
export async function completeExtractionAttempt(
	input: CompleteExtractionAttemptInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const job = ownedActiveJob(tx, input);
		if (!job || job.status !== "indexing") return false;

		const updated = tx
			.update(documentExtractionJobs)
			.set({
				status: "succeeded",
				normalizedArtifactId: input.normalizedArtifactId,
				completedAt: now,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				remoteHandleJson: null,
				// A hint has done its job once the extraction it steered succeeded;
				// leaving it would silently re-apply to a later user retry. The
				// reserved `$outage` bookkeeping is NOT a hint and must survive:
				// `attempt_count` is never reset, so a document that waited out an
				// outage before succeeding carries those attempts forever, and
				// `waits` is the only thing that keeps the ceiling (and the
				// Re-extract button) from charging them to the document.
				hintsJson: withOutageState(null, {
					since: null,
					waits: readExtractionOutageState(job.hintsJson).waits,
				}),
				currentAttemptId: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.status, "indexing"),
					eq(documentExtractionJobs.currentAttemptId, input.attemptId),
				),
			)
			.run();

		if (updated.changes === 0) return false;

		tx.update(documentExtractionJobAttempts)
			.set({
				status: "succeeded",
				finishedAt: now,
				textLength: input.textLength,
				pageCount: input.pageCount,
				...(input.diagnostics
					? { diagnosticsJson: JSON.stringify(input.diagnostics) }
					: {}),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobAttempts.id, input.attemptId),
					eq(documentExtractionJobAttempts.jobId, input.jobId),
					eq(documentExtractionJobAttempts.workerId, input.workerId),
				),
			)
			.run();

		return true;
	});
}

export interface FailExtractionAttemptInput extends OwnedAttemptInput {
	errorCode: ExtractionErrorCode;
	errorMessage: string;
	retryable: boolean;
	retryAfterMs?: number;
	/** Set when the remote no longer recognises the handle. */
	clearHandle: boolean;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	/** The patient budget for "the backend is not answering right now". */
	outageWindowMs: number;
	diagnostics?: Record<string, unknown>;
	/** Injected so the backoff jitter is deterministic under test. */
	random?: () => number;
}

export interface FailExtractionAttemptResult {
	requeued: boolean;
	nextAttemptAt: Date | null;
	/** True when this requeue is a patient wait on an unreachable backend. */
	outageWait: boolean;
	/**
	 * false when this worker no longer owned the attempt and nothing was
	 * written. Distinct from `requeued: false`, which means a verdict WAS
	 * written and it was terminal — a caller that conflates the two reports a
	 * job as failed on the strength of a write it did not make.
	 */
	applied: boolean;
}

/**
 * The only path from an active status to `queued` or `failed`.
 *
 * A requeue KEEPS the job's `error_code` / `error_message` on purpose: between
 * the failure and the next claim the UI has to be able to say "retrying after
 * X" rather than inventing a reassuring blank. The claim clears them.
 */
export async function failExtractionAttempt(
	input: FailExtractionAttemptInput,
): Promise<FailExtractionAttemptResult> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const job = ownedActiveJob(tx, input);
		if (!job) {
			return {
				requeued: false,
				nextAttemptAt: null,
				outageWait: false,
				applied: false,
			};
		}

		const decision = decideExtractionRetry({
			code: input.errorCode,
			retryable: input.retryable,
			retryAfterMs: input.retryAfterMs,
			attemptCount: job.attemptCount,
			maxAttempts: input.maxAttempts,
			retryBaseMs: input.retryBaseMs,
			retryMaxMs: input.retryMaxMs,
			outageWindowMs: input.outageWindowMs,
			outage: readExtractionOutageState(job.hintsJson),
			nowMs: now.getTime(),
			random: input.random,
		});

		const attemptResult = tx
			.update(documentExtractionJobAttempts)
			.set({
				status: "failed",
				finishedAt: now,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage,
				retryable: input.retryable,
				diagnosticsJson: input.diagnostics
					? JSON.stringify(input.diagnostics)
					: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobAttempts.id, input.attemptId),
					eq(documentExtractionJobAttempts.jobId, input.jobId),
					eq(documentExtractionJobAttempts.workerId, input.workerId),
					eq(documentExtractionJobAttempts.status, "running"),
				),
			)
			.run();

		if (attemptResult.changes === 0) {
			return {
				requeued: false,
				nextAttemptAt: null,
				outageWait: false,
				applied: false,
			};
		}

		const nextAttemptAt = decision.requeue
			? new Date(now.getTime() + decision.delayMs)
			: null;

		tx.update(documentExtractionJobs)
			.set({
				status: decision.requeue ? "queued" : "failed",
				currentAttemptId: null,
				errorCode: decision.jobErrorCode,
				errorMessage: input.errorMessage,
				retryable: decision.jobRetryable,
				nextAttemptAt,
				completedAt: decision.requeue ? null : now,
				hintsJson: withOutageState(job.hintsJson, decision.outage),
				// An outage wait KEEPS the handle even when the failure asked for it
				// to be cleared only because the job went terminal: the remote job
				// may well still be there when the backend comes back.
				...(input.clearHandle || (!decision.requeue && !decision.outageWait)
					? { remoteHandleJson: null }
					: {}),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.currentAttemptId, input.attemptId),
				),
			)
			.run();

		return {
			requeued: decision.requeue,
			nextAttemptAt,
			outageWait: decision.outageWait,
			applied: true,
		};
	});
}

export interface RecoverStaleExtractionAttemptsInput {
	staleBefore: Date;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	outageWindowMs: number;
	random?: () => number;
	now?: Date;
}

const STALE_WORKER_MESSAGE =
	"The extraction worker stopped responding before finishing this document.";

/**
 * Boot + periodic sweep. Converts an attempt whose worker went silent into a
 * retryable `stale_worker` failure, which the ordinary retry rules then turn
 * into a requeue or a terminal failure.
 *
 * The job KEEPS `remote_handle_json`: a worker that died mid-parse probably
 * left a perfectly healthy remote job behind, and the next attempt should
 * resume it rather than pay for the same parse twice. `handleUnknown` on that
 * resume is what clears the handle, and only then.
 */
export async function recoverStaleExtractionAttempts(
	input: RecoverStaleExtractionAttemptsInput,
): Promise<{ recovered: number; requeued: number }> {
	const now = input.now ?? new Date();

	return db.transaction((tx) => {
		const stale = tx
			.select({
				job: documentExtractionJobs,
				attemptId: documentExtractionJobAttempts.id,
			})
			.from(documentExtractionJobAttempts)
			.innerJoin(
				documentExtractionJobs,
				eq(documentExtractionJobs.id, documentExtractionJobAttempts.jobId),
			)
			.where(
				and(
					inArray(documentExtractionJobs.status, ACTIVE_STATUSES),
					eq(
						documentExtractionJobs.currentAttemptId,
						documentExtractionJobAttempts.id,
					),
					eq(documentExtractionJobAttempts.status, "running"),
					lt(documentExtractionJobAttempts.heartbeatAt, input.staleBefore),
				),
			)
			.all();

		let recovered = 0;
		let requeued = 0;

		for (const row of stale) {
			const outcome = reclaimRunningAttempt(tx, {
				job: row.job,
				attemptId: row.attemptId,
				now,
				maxAttempts: input.maxAttempts,
				retryBaseMs: input.retryBaseMs,
				retryMaxMs: input.retryMaxMs,
				outageWindowMs: input.outageWindowMs,
				random: input.random,
			});
			if (!outcome) continue;
			recovered += 1;
			if (outcome.requeued) requeued += 1;
		}

		return { recovered, requeued };
	});
}

/**
 * One reclaim: mark the attempt `stale_worker` and run the ordinary retry
 * rules over the job. Shared by the heartbeat sweep and the boot sweep, which
 * differ only in how they decide an attempt is dead.
 */
function reclaimRunningAttempt(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	params: {
		job: DocumentExtractionJobRow;
		attemptId: string;
		now: Date;
		maxAttempts: number;
		retryBaseMs: number;
		retryMaxMs: number;
		outageWindowMs: number;
		random?: () => number;
	},
): { requeued: boolean } | null {
	const { now } = params;
	const attemptResult = tx
		.update(documentExtractionJobAttempts)
		.set({
			status: "failed",
			finishedAt: now,
			errorCode: "stale_worker",
			errorMessage: STALE_WORKER_MESSAGE,
			retryable: true,
			updatedAt: now,
		})
		.where(
			and(
				eq(documentExtractionJobAttempts.id, params.attemptId),
				eq(documentExtractionJobAttempts.status, "running"),
			),
		)
		.run();

	if (attemptResult.changes === 0) return null;

	const decision = decideExtractionRetry({
		code: "stale_worker",
		retryable: true,
		attemptCount: params.job.attemptCount,
		maxAttempts: params.maxAttempts,
		retryBaseMs: params.retryBaseMs,
		retryMaxMs: params.retryMaxMs,
		outageWindowMs: params.outageWindowMs,
		outage: readExtractionOutageState(params.job.hintsJson),
		nowMs: now.getTime(),
		random: params.random,
	});

	tx.update(documentExtractionJobs)
		.set({
			status: decision.requeue ? "queued" : "failed",
			currentAttemptId: null,
			errorCode: decision.jobErrorCode,
			errorMessage: STALE_WORKER_MESSAGE,
			retryable: decision.jobRetryable,
			nextAttemptAt: decision.requeue
				? new Date(now.getTime() + decision.delayMs)
				: null,
			completedAt: decision.requeue ? null : now,
			hintsJson: withOutageState(params.job.hintsJson, decision.outage),
			updatedAt: now,
		})
		.where(
			and(
				eq(documentExtractionJobs.id, params.job.id),
				eq(documentExtractionJobs.currentAttemptId, params.attemptId),
			),
		)
		.run();

	return { requeued: decision.requeue };
}

export interface ReclaimDeadWorkerExtractionAttemptsInput {
	/** This process's own worker id. Its attempts are never reclaimed. */
	workerId: string;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	outageWindowMs: number;
	/** Injected so a test can decide liveness without spawning processes. */
	isProcessAlive?: (pid: number) => boolean;
	random?: () => number;
	now?: Date;
}

/**
 * The boot sweep: reclaim, IMMEDIATELY, every running attempt whose worker id
 * proves it belonged to a process that no longer exists on this host.
 *
 * Before this, a deploy left its orphaned attempts looking perfectly healthy —
 * their heartbeats were seconds old at the moment the process died — so nothing
 * touched them until the whole stale window (two minutes) had passed, on a box
 * that was serving again after eleven seconds. A worker id that carries
 * hostname + pid + a per-boot nonce turns that wait into a question the new
 * process can answer at boot: same host, pid not alive, not us ⇒ dead.
 *
 * Conservative in every direction that matters. A worker id from another host
 * is never touched (we cannot see its process table). A worker id in the old
 * format carries no hostname, so it falls back to the stale-window path. An
 * `EPERM` from `kill(pid, 0)` means a process we may not signal, which is a
 * process that EXISTS. Only a pid that is provably gone is reclaimed.
 */
export async function reclaimDeadWorkerExtractionAttempts(
	input: ReclaimDeadWorkerExtractionAttemptsInput,
): Promise<{ recovered: number; requeued: number }> {
	const now = input.now ?? new Date();
	const self = parseWorkerId(input.workerId);
	const isAlive = input.isProcessAlive ?? isProcessAlive;

	return db.transaction((tx) => {
		const running = tx
			.select({
				job: documentExtractionJobs,
				attemptId: documentExtractionJobAttempts.id,
				workerId: documentExtractionJobAttempts.workerId,
			})
			.from(documentExtractionJobAttempts)
			.innerJoin(
				documentExtractionJobs,
				eq(documentExtractionJobs.id, documentExtractionJobAttempts.jobId),
			)
			.where(
				and(
					inArray(documentExtractionJobs.status, ACTIVE_STATUSES),
					eq(
						documentExtractionJobs.currentAttemptId,
						documentExtractionJobAttempts.id,
					),
					eq(documentExtractionJobAttempts.status, "running"),
				),
			)
			.all();

		let recovered = 0;
		let requeued = 0;

		for (const row of running) {
			if (!isDeadWorkerId(row.workerId, self, isAlive)) continue;
			const outcome = reclaimRunningAttempt(tx, {
				job: row.job,
				attemptId: row.attemptId,
				now,
				maxAttempts: input.maxAttempts,
				retryBaseMs: input.retryBaseMs,
				retryMaxMs: input.retryMaxMs,
				outageWindowMs: input.outageWindowMs,
				random: input.random,
			});
			if (!outcome) continue;
			recovered += 1;
			if (outcome.requeued) requeued += 1;
		}

		return { recovered, requeued };
	});
}

function isDeadWorkerId(
	candidate: string | null,
	self: ParsedWorkerId | null,
	isAlive: (pid: number) => boolean,
): boolean {
	if (!candidate || !self) return false;
	// Our own attempts, including the inline direct-text runner's, are alive by
	// definition — we are the process holding them.
	if (candidate === self.raw || candidate.startsWith(`${self.raw}:`)) {
		return false;
	}
	const parsed = parseWorkerId(candidate);
	// An id in the previous format says nothing about which host or process
	// wrote it, so it keeps the stale-window path it has always had.
	if (!parsed) return false;
	if (parsed.hostname !== self.hostname) return false;
	if (parsed.pid === self.pid && parsed.nonce === self.nonce) return false;
	return !isAlive(parsed.pid);
}

export interface RetryExtractionJobInput {
	userId: string;
	jobId: string;
	/** Replaces the stored hints for the next attempt when supplied. */
	hints?: Readonly<Record<string, unknown>> | null;
	/**
	 * The automatic attempt budget. The hard ceiling on total attempts is
	 * derived from it; omitted, the live config value is used.
	 */
	maxAttempts?: number;
	now?: Date;
}

/**
 * The user's Retry button. Legal from `failed` and `canceled` only.
 *
 * `attempt_count` is deliberately NOT reset — attempt numbers stay unique per
 * job, which is what makes the attempt table readable after the fact. What the
 * reset does is clear the error state and the backoff gate, so the claim picks
 * the job up immediately and `failExtractionAttempt` grants it exactly one more
 * attempt before capping again.
 *
 * Bounded by `extractionAttemptCeiling`. Without it, "one more attempt per
 * press" has no end: one user with one broken document could keep a backend
 * seat busy for as long as they were willing to click.
 */
export async function retryExtractionJob(
	input: RetryExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	const now = input.now ?? new Date();
	const ceiling = extractionAttemptCeiling(
		input.maxAttempts ?? getExtractionConfig().maxAttempts,
	);
	return db.transaction((tx) => {
		const [job] = tx
			.select()
			.from(documentExtractionJobs)
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.userId, input.userId),
				),
			)
			.limit(1)
			.all();

		if (!job) return null;
		if (job.status !== "failed" && job.status !== "canceled") return null;
		const outage = readExtractionOutageState(job.hintsJson);
		// Measured in DOCUMENT attempts. A job that spent twelve attempts waiting
		// for a backend that was down has used none of the user's budget, and
		// refusing the button there would punish them for the outage.
		if (extractionDocumentAttempts(job.attemptCount, outage) >= ceiling) {
			return null;
		}

		// A user retry starts a fresh outage window: they are asking us to look
		// again, and the backend may well be back. `waits` is carried so the
		// attempt discount survives.
		const carriedOutage: ExtractionOutageState = {
			since: null,
			waits: outage.waits,
		};

		const result = tx
			.update(documentExtractionJobs)
			.set({
				status: "queued",
				currentAttemptId: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
				nextAttemptAt: null,
				cancelRequestedAt: null,
				completedAt: null,
				hintsJson: withOutageState(
					input.hints === undefined
						? job.hintsJson
						: serializeHints(input.hints),
					carriedOutage,
				),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.status, job.status),
				),
			)
			.run();

		if (result.changes === 0) return null;

		const [updated] = tx
			.select()
			.from(documentExtractionJobs)
			.where(eq(documentExtractionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updated ?? null;
	});
}

export interface CancelExtractionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

/**
 * The user's Cancel button. Legal from `queued` and from any active status.
 *
 * The ledger row goes terminal immediately; the worker finds out on its next
 * heartbeat (which now returns `false`) or its next `isCancelRequested` poll,
 * aborts the signal, and calls `extractor.cancel` best-effort. Whether that
 * remote cleanup succeeds has no bearing on the row: a user who pressed Cancel
 * is owed a canceled job, not a job that stays "parsing" because a backend
 * would not answer.
 */
export async function cancelExtractionJob(
	input: CancelExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const [job] = tx
			.select()
			.from(documentExtractionJobs)
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.userId, input.userId),
				),
			)
			.limit(1)
			.all();

		if (!job) return null;
		if (isTerminalExtractionStatus(job.status as DocumentExtractionStatus)) {
			return null;
		}

		const result = tx
			.update(documentExtractionJobs)
			.set({
				status: "canceled",
				cancelRequestedAt: job.cancelRequestedAt ?? now,
				completedAt: now,
				currentAttemptId: null,
				retryable: false,
				nextAttemptAt: null,
				// The handle is DROPPED, unlike on a stale reclaim.
				//
				// A user cancel is the one abort that DELETEs the remote job, so the
				// stored handle now points at something the backend has thrown away.
				// Keeping it meant a later Retry resumed a deleted job: `getJob`
				// answers `status: "canceled"`, which the error table reads as
				// "canceled by someone else" — a `job_failed` the user never caused,
				// on a document that would have parsed perfectly from scratch.
				remoteHandleJson: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.status, job.status),
				),
			)
			.run();

		if (result.changes === 0) return null;

		if (job.currentAttemptId) {
			tx.update(documentExtractionJobAttempts)
				.set({
					status: "canceled",
					finishedAt: now,
					errorCode: "canceled",
					errorMessage: "Canceled by the user.",
					retryable: false,
					updatedAt: now,
				})
				.where(
					and(
						eq(documentExtractionJobAttempts.id, job.currentAttemptId),
						eq(documentExtractionJobAttempts.status, "running"),
					),
				)
				.run();
		}

		const [updated] = tx
			.select()
			.from(documentExtractionJobs)
			.where(eq(documentExtractionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updated ?? null;
	});
}

export interface MaterializeLegacyExtractionJobInput {
	userId: string;
	sourceArtifactId: string;
	fileName?: string | null;
	mimeType?: string | null;
	sizeBytes?: number | null;
	conversationId?: string | null;
	intakeRoute?: DocumentExtractionIntakeRoute;
	now?: Date;
}

/**
 * The route a pre-ledger artifact would get if it were uploaded today.
 *
 * `reject` collapses to `mineru`: the file is already in the library, so the
 * retry has to resolve to a route the worker can run, and `mineru` is what the
 * pre-ledger path used for everything it did not read inline.
 */
function resolveLegacyIntakeRoute(
	fileName: string,
	mimeType: string | null,
): DocumentExtractionIntakeRoute {
	return getIntakeRoute(fileName, mimeType) === "direct-text"
		? "direct-text"
		: "mineru";
}

/**
 * Turns a pre-ledger artifact into a real, `failed` + `retryable` row so the
 * Retry button has something to act on.
 *
 * This is the ONLY place a legacy artifact is written. The read model
 * synthesises legacy rows for display and writes nothing, because the artifact
 * table is unbounded per user and has no anchor to bound a backfill sweep —
 * the equivalent file-production backfill is safe only because it is scoped to
 * one conversation's chat files.
 */
export async function materializeLegacyExtractionJob(
	input: MaterializeLegacyExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	const existing = await findExistingJob({
		sourceArtifactId: input.sourceArtifactId,
	});
	if (existing) {
		return existing.userId === input.userId ? existing : null;
	}

	// The artifact is the only record of what this document actually is, and
	// the retry endpoint only knows its name. Stamping every legacy row
	// `mineru` sent a pre-ledger `.txt` to the backend parser on retry instead
	// of through direct text — a remote round trip, and a different result, for
	// a file the registry can read locally.
	const [artifact] = await db
		.select({
			name: artifacts.name,
			mimeType: artifacts.mimeType,
			sizeBytes: artifacts.sizeBytes,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, input.sourceArtifactId),
				eq(artifacts.userId, input.userId),
			),
		)
		.limit(1);

	const fileName = input.fileName ?? artifact?.name ?? "document";
	const mimeType = input.mimeType ?? artifact?.mimeType ?? null;

	const now = input.now ?? new Date();
	const { job } = await enqueueExtractionJob({
		userId: input.userId,
		conversationId: input.conversationId ?? null,
		origin: "upload",
		intakeRoute:
			input.intakeRoute ?? resolveLegacyIntakeRoute(fileName, mimeType),
		fileName,
		mimeType,
		sizeBytes: input.sizeBytes ?? artifact?.sizeBytes ?? 0,
		sourceArtifactId: input.sourceArtifactId,
		failure: {
			errorCode: "legacy_unknown",
			errorMessage:
				"This document predates the extraction ledger, so its result is unknown.",
			retryable: true,
		},
		now,
	});

	return job.userId === input.userId ? job : null;
}

/** True while a cancel is pending or done; the worker polls it to honour T13. */
export async function isCancelRequested(jobId: string): Promise<boolean> {
	const [row] = await db
		.select({
			cancelRequestedAt: documentExtractionJobs.cancelRequestedAt,
			status: documentExtractionJobs.status,
		})
		.from(documentExtractionJobs)
		.where(eq(documentExtractionJobs.id, jobId))
		.limit(1);

	if (!row) return false;
	return row.cancelRequestedAt !== null || row.status === "canceled";
}

export async function getExtractionJobRow(
	jobId: string,
): Promise<DocumentExtractionJobRow | null> {
	const [row] = await db
		.select()
		.from(documentExtractionJobs)
		.where(eq(documentExtractionJobs.id, jobId))
		.limit(1);
	return row ?? null;
}

export async function listExtractionJobAttempts(
	jobId: string,
): Promise<DocumentExtractionAttemptRow[]> {
	return db
		.select()
		.from(documentExtractionJobAttempts)
		.where(eq(documentExtractionJobAttempts.jobId, jobId))
		.orderBy(asc(documentExtractionJobAttempts.attemptNumber));
}
