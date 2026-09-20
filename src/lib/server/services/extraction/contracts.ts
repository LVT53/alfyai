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
	/** Aborted on user cancel, on stale-claim loss, and on process shutdown. */
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

function isAbortLike(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === "AbortError" || error.name === "TimeoutError";
	}
	return error instanceof Error && error.name === "AbortError";
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

	if (isAbortLike(error)) {
		return new DocumentExtractionError({
			code: "canceled",
			message: "Extraction was canceled.",
			retryable: false,
			cause: error,
		});
	}

	if (isConnectionLike(error)) {
		return new DocumentExtractionError({
			code: "unavailable",
			message:
				error instanceof Error
					? error.message
					: "The extraction backend is unreachable.",
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
