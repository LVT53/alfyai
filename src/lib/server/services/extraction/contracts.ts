// The extractor seam.
//
// The ledger knows how to queue, claim, retry, resume and cancel work; it knows
// nothing about how a document is turned into text. Everything specific to a
// backend lives behind `DocumentExtractor`, so a new backend is one new file
// plus one entry in `extractors/registry.ts` — no ledger change, no schema
// change, no status change.
//
// Nothing in this file may name a specific extraction backend. `handle.data`,
// `request.hints` and `result.structured` are all opaque to the ledger: it
// stores and forwards them, and never inspects them.
//
// Module path is `services/extraction/`, not `services/document-extraction/`:
// `services/document-extraction.ts` already exists (today's MinerU 3 client)
// and a sibling directory of the same name is ambiguous to the resolver.

import type {
	ExtractionErrorCode,
	ExtractionPhase,
} from "$lib/shared/extraction-status";
import {
	isExtractionErrorCode,
	RETRYABLE_EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";

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

export const EXTRACTION_HANDLE_VERSION = 1 as const;

/**
 * WHY an in-flight attempt's signal was aborted.
 *
 * The distinction is not cosmetic, and getting it wrong destroys work:
 *
 *  - `user-cancel` — the user (or an account erasure) asked for this document
 *    to stop. The remote job is now garbage and DELETEing it frees the
 *    backend's queue slot.
 *  - `claim-lost` — a stale-attempt sweep or a failed progress write took this
 *    attempt away from us. Another worker is about to resume the very job we
 *    would be deleting.
 *  - `shutdown` — the process is going away. The stored `ExtractionHandle`
 *    exists precisely so the next boot resumes that remote job without a
 *    second upload; deleting it turns a deploy restart into a re-parse.
 *
 * Only `user-cancel` may destroy resumable remote work. An abort that carries
 * no reason at all is treated as if it were `claim-lost`, because keeping a
 * remote job that nobody reads costs a queue slot, while deleting one that is
 * still wanted costs the whole parse.
 */
export const EXTRACTION_ABORT_REASONS = [
	"user-cancel",
	"claim-lost",
	"shutdown",
] as const;
export type ExtractionAbortReason = (typeof EXTRACTION_ABORT_REASONS)[number];

/**
 * The abort reason an extraction signal carries.
 *
 * `name` is `AbortError` so every structural abort check — here, in the
 * extractor, in `mineru/errors.ts` — keeps reading it as an abort. The reason
 * rides alongside rather than replacing it.
 */
export class ExtractionAbortError extends Error {
	readonly name = "AbortError";
	readonly extractionAbortReason: ExtractionAbortReason;

	constructor(reason: ExtractionAbortReason, message?: string) {
		super(message ?? `Extraction aborted: ${reason}`);
		this.extractionAbortReason = reason;
	}
}

const ABORT_REASON_SET: ReadonlySet<string> = new Set(EXTRACTION_ABORT_REASONS);

/** Structural, so a second copy of this module cannot hide the reason. */
export function readExtractionAbortReason(
	value: unknown,
): ExtractionAbortReason | null {
	const reason = (value as { extractionAbortReason?: unknown } | null)
		?.extractionAbortReason;
	return typeof reason === "string" && ABORT_REASON_SET.has(reason)
		? (reason as ExtractionAbortReason)
		: null;
}

/**
 * May this abort destroy resumable remote work?
 *
 * Only for a user cancel. Everything else — an unlabelled abort included — must
 * leave the remote job alone so the stored handle still points at something.
 */
export function abortDiscardsRemoteWork(
	signal: AbortSignal | null | undefined,
): boolean {
	if (!signal?.aborted) return false;
	return readExtractionAbortReason(signal.reason) === "user-cancel";
}

export interface ExtractionProgress {
	phase: ExtractionPhase;
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
	/** Shared registry verdict. "reject" never reaches an extractor. */
	intakeRoute: "direct-text" | "mineru";
	/**
	 * Aborted on user cancel, on stale-claim loss, and on process shutdown.
	 * `signal.reason` carries an `ExtractionAbortError` saying which — read it
	 * with `abortDiscardsRemoteWork` before throwing away anything the next
	 * attempt could resume.
	 */
	signal: AbortSignal;
	onProgress: (progress: ExtractionProgress) => void;
	/** Set when a previous attempt persisted a handle. Undefined = submit fresh. */
	resumeHandle?: ExtractionHandle | null;
	/**
	 * Verified SHA-256 (lowercase hex) of the bytes at `filePathAbsolute`, when
	 * the ledger already holds it. An extractor that needs the digest must fall
	 * back to computing it, so a caller that omits this still works — it just
	 * re-streams the file.
	 */
	contentSha256?: string | null;
	/** Present for an upload job; absent for a readback. */
	sourceArtifactId?: string | null;
	userId?: string | null;
	/**
	 * Durable, caller-supplied extraction hints (e.g. "re-extract at tier X").
	 * Opaque to the ledger, exactly as `handle.data` is.
	 */
	hints?: Readonly<Record<string, unknown>> | null;
}

export interface ExtractDocumentResult {
	/** Non-empty. An extractor that finds nothing throws `empty_result` instead. */
	text: string;
	normalizedName: string;
	mimeType: string;
	pageCount?: number;
	/** Final handle, for diagnostics. */
	handle?: ExtractionHandle | null;
	/**
	 * Backend-specific structured payload, opaque to the ledger and to the
	 * worker. `persist.ts` narrows it with a type guard; until something does,
	 * it is carried and dropped.
	 */
	structured?: unknown;
}

/**
 * The sentence a user is shown for a failure whose real message is not one.
 *
 * `error_message` on the job row is read by the send gate and by the Knowledge
 * row, and for an availability failure it used to be whatever undici said —
 * "fetch failed", "MinerU capability read failed: fetch failed". That is an
 * implementation detail of a HTTP client presented as an explanation of the
 * user's document. The taxonomy code is what actually knows what happened, so
 * the text comes from the code.
 *
 * Only the codes whose upstream message is useless are listed. A `job_failed`
 * carries the engine's own reason and that reason is worth keeping.
 */
const EXTRACTION_ERROR_MESSAGES: Partial<Record<ExtractionErrorCode, string>> =
	{
		unavailable: "The document service could not be reached.",
		timeout: "The document service did not answer in time.",
		rate_limited: "The document service is busy right now.",
		auth_failed:
			"The document service rejected our credentials. Ask an administrator to check the API key.",
		// `backend_misconfigured` is deliberately ABSENT. The only useful sentence
		// for it names the endpoint and the setting to change, and this module may
		// not name a backend — the seam is what lets one be swapped by editing a
		// registry entry, and `boundary.test.ts` holds it to that. The capability
		// probe, which is allowed to know, composes that message itself.
		unsupported_type:
			"The document service cannot read this file type. Convert it to PDF (or another supported format) and upload it again.",
	};

/**
 * The user-facing message for a code, falling back to what the backend said.
 *
 * The fallback is never dropped silently: it lands in the attempt's
 * diagnostics and in the log line, so an operator still has the raw text.
 */
export function extractionErrorMessage(
	code: ExtractionErrorCode,
	fallback: string,
): string {
	return EXTRACTION_ERROR_MESSAGES[code] ?? fallback;
}

export interface DocumentExtractionErrorInit {
	code: ExtractionErrorCode;
	message: string;
	retryable?: boolean;
	retryAfterMs?: number;
	handleUnknown?: boolean;
	details?: Record<string, unknown>;
	cause?: unknown;
}

export class DocumentExtractionError extends Error {
	readonly name = "DocumentExtractionError";
	readonly code: ExtractionErrorCode;
	readonly retryable: boolean;
	/** For `rate_limited`: honour this instead of the computed backoff. */
	readonly retryAfterMs?: number;
	/**
	 * The remote no longer recognises the persisted handle (the backend
	 * restarted). The ledger clears `remote_handle_json` and the next attempt
	 * submits fresh instead of resuming into a void.
	 */
	readonly handleUnknown: boolean;
	readonly details?: Record<string, unknown>;

	constructor(init: DocumentExtractionErrorInit) {
		super(
			init.message,
			init.cause === undefined ? undefined : { cause: init.cause },
		);
		this.code = init.code;
		this.retryable =
			init.retryable ?? RETRYABLE_EXTRACTION_ERROR_CODES.has(init.code);
		this.retryAfterMs = init.retryAfterMs;
		this.handleUnknown = init.handleUnknown ?? false;
		this.details = init.details;
	}
}

/**
 * Structural, not just `instanceof`.
 *
 * `instanceof` compares constructor identity, which is per module INSTANCE: a
 * bundle that loads this module twice (a lazily imported worker beside an
 * eagerly imported route, a test that resets its module registry) would have
 * two `DocumentExtractionError` classes, and a perfectly well-formed error
 * thrown through one would be misread as an unknown throw by the other — and
 * mapped to a non-retryable `internal`, silently turning a transient backend
 * outage into a permanently failed document. Checking the shape instead costs
 * nothing and cannot be defeated that way.
 */
export function isDocumentExtractionError(
	error: unknown,
): error is DocumentExtractionError {
	if (error instanceof DocumentExtractionError) return true;
	if (!(error instanceof Error) || error.name !== "DocumentExtractionError") {
		return false;
	}
	const candidate = error as Partial<DocumentExtractionError>;
	return (
		typeof candidate.code === "string" &&
		isExtractionErrorCode(candidate.code) &&
		typeof candidate.retryable === "boolean"
	);
}

/**
 * Structural, for the same reason `isDocumentExtractionError` is.
 *
 * `AbortSignal` rejects with a DOMException, and `instanceof DOMException` is
 * not a reliable test for one: under jsdom the abort reason fails BOTH
 * `instanceof DOMException` and `instanceof Error`, and any realm boundary
 * (a worker, a second copy of a module, a vm context) does the same in
 * production. An abort read as "an unknown throw" becomes a non-retryable
 * `internal` — which is how a user pressing Cancel could end up looking like a
 * permanently broken document. The name is the only property that survives
 * every one of those boundaries.
 */
export function isAbortError(error: unknown): boolean {
	return (error as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * `AbortSignal.timeout` rejects with this, and it is NOT a cancel.
 *
 * The two used to share one branch, which meant a request timeout that leaked
 * past an extractor's own mapping failed the document permanently as
 * "Extraction was canceled." — a non-retryable verdict, on a fault that is
 * both transient and nobody's decision. A timeout is `timeout` (retryable); a
 * cancel is `canceled` (final). Only the abort path may produce the latter.
 */
export function isTimeoutError(error: unknown): boolean {
	return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** Keeps the raw text where an operator can still find it. */
function rawMessageDetail(error: unknown): Record<string, unknown> | undefined {
	return error instanceof Error && error.message
		? { rawMessage: error.message }
		: undefined;
}

function isConnectionLike(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
		return true;
	}
	const code =
		"code" in error && typeof error.code === "string" ? error.code : null;
	return (
		code === "ECONNREFUSED" ||
		code === "ECONNRESET" ||
		code === "ENOTFOUND" ||
		code === "EAI_AGAIN" ||
		code === "UND_ERR_SOCKET"
	);
}

/**
 * Maps an unknown throw onto the taxonomy. Never throws, and never widens an
 * error that already carries a code — an extractor's own verdict always wins.
 */
export function toDocumentExtractionError(
	error: unknown,
): DocumentExtractionError {
	if (error instanceof DocumentExtractionError) {
		return error;
	}

	if (isDocumentExtractionError(error)) {
		// Structurally one of ours, but built by a different instance of this
		// module. Rebuild it so callers get a real instance with every field
		// present, rather than an object that happens to have some of them.
		return new DocumentExtractionError({
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			retryAfterMs: error.retryAfterMs,
			handleUnknown: error.handleUnknown === true,
			details: error.details,
			cause: error,
		});
	}

	if (isAbortError(error)) {
		return new DocumentExtractionError({
			code: "canceled",
			message: "Extraction was canceled.",
			retryable: false,
			cause: error,
		});
	}

	if (isTimeoutError(error)) {
		return new DocumentExtractionError({
			code: "timeout",
			message: extractionErrorMessage("timeout", "The backend timed out."),
			retryable: true,
			details: rawMessageDetail(error),
			cause: error,
		});
	}

	if (isConnectionLike(error)) {
		// NOT `error.message`: that is "fetch failed", which is undici's account
		// of its own socket, not an explanation anyone can act on.
		return new DocumentExtractionError({
			code: "unavailable",
			message: extractionErrorMessage(
				"unavailable",
				"The backend is unreachable.",
			),
			details: rawMessageDetail(error),
			cause: error,
		});
	}

	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Extraction failed for an unknown reason.";

	return new DocumentExtractionError({
		code: "internal",
		message,
		retryable: false,
		cause: error,
	});
}

export interface DocumentExtractor {
	/** Stable id persisted on the attempt row. */
	readonly name: string;
	/** false ⇒ the ledger never passes `resumeHandle` and discards stored handles. */
	readonly supportsResume: boolean;
	/**
	 * true ⇒ `extract` cleans the remote up itself when its signal is aborted
	 * with `user-cancel`, so the worker must NOT call `cancel` as well.
	 *
	 * Without this the worker had no way to tell "the extractor has already
	 * issued the DELETE" from "nobody has", so it always issued one — and an
	 * extractor that honours the abort reason properly, which is what
	 * `abortDiscardsRemoteWork` exists for, sent two DELETEs for one Stop. The
	 * second is answered 409 and is harmless, but "exactly one request per user
	 * action" is the only version of this anyone can reason about from a log.
	 */
	readonly cancelsOnAbort?: boolean;
	extract(request: ExtractDocumentRequest): Promise<ExtractDocumentResult>;
	/** Best effort remote cleanup on user cancel. Must not throw. */
	cancel?(handle: ExtractionHandle, signal?: AbortSignal): Promise<void>;
}

/**
 * Reads a persisted handle back. A handle whose version or owning extractor no
 * longer matches is discarded rather than handed to a backend that cannot read
 * it — resuming into a foreign handle is the one way this seam could corrupt a
 * live remote job.
 */
export function parseExtractionHandle(
	json: string | null | undefined,
	expectedExtractor?: string,
): ExtractionHandle | null {
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.extractor !== "string") return null;
	if (record.version !== EXTRACTION_HANDLE_VERSION) return null;
	if (expectedExtractor && record.extractor !== expectedExtractor) return null;

	return {
		extractor: record.extractor,
		version: EXTRACTION_HANDLE_VERSION,
		remoteJobId:
			typeof record.remoteJobId === "string" ? record.remoteJobId : null,
		remoteFileId:
			typeof record.remoteFileId === "string" ? record.remoteFileId : null,
		data:
			record.data &&
			typeof record.data === "object" &&
			!Array.isArray(record.data)
				? (record.data as Record<string, unknown>)
				: undefined,
	};
}

export function serializeExtractionHandle(
	handle: ExtractionHandle | null | undefined,
): string | null {
	return handle ? JSON.stringify(handle) : null;
}
