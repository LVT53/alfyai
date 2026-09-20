// The document-extraction vocabulary, shared by the server ledger and every
// client surface that renders a document's readiness.
//
// Zero value imports on purpose: this module is reached from Svelte components,
// from `$lib/server` services and from route handlers alike, and anything it
// pulled in would travel to all three. The same constraint the shared
// file-type table carries, enforced by the same regex assertion in the test.
//
// Spelling note: this ledger spells the terminal user-cancel state `canceled`
// with one `l`. `file-production/types.ts` spells its own `cancelled` with two.
// The divergence is deliberate and pinned by a test in both directions, so that
// a well-meaning cleanup cannot silently rename one status string into the
// other and break a stored row's meaning.

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
export type DocumentExtractionTerminalStatus =
	(typeof DOCUMENT_EXTRACTION_TERMINAL_STATUSES)[number];

/** The three phases an extractor may report while it owns a job. */
export type ExtractionPhase = "uploading" | "parsing" | "downloading";

export const EXTRACTION_ERROR_CODES = [
	"unavailable",
	"tier_unavailable",
	"auth_failed",
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

/**
 * Default retryability per code. An extractor may override per throw (a 503
 * with a Retry-After is retryable even under a code that usually is not), but
 * when it says nothing this set decides.
 *
 * `auth_failed` is deliberately absent: a wrong API key is not a fault a retry
 * can fix, and burning three attempts plus backoff on it only delays the
 * honest "ask an admin" message.
 */
export const RETRYABLE_EXTRACTION_ERROR_CODES: ReadonlySet<ExtractionErrorCode> =
	new Set<ExtractionErrorCode>([
		"unavailable",
		"rate_limited",
		"timeout",
		"protocol",
		"job_failed",
		"stale_worker",
	]);

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(
	DOCUMENT_EXTRACTION_TERMINAL_STATUSES,
);
const ACTIVE_SET: ReadonlySet<string> = new Set<string>(
	DOCUMENT_EXTRACTION_ACTIVE_STATUSES,
);

export function isTerminalExtractionStatus(
	status: DocumentExtractionStatus,
): boolean {
	return TERMINAL_SET.has(status);
}

export function isActiveExtractionStatus(
	status: DocumentExtractionStatus,
): boolean {
	return ACTIVE_SET.has(status);
}

export function isDocumentExtractionStatus(
	value: unknown,
): value is DocumentExtractionStatus {
	return (
		typeof value === "string" &&
		(DOCUMENT_EXTRACTION_STATUSES as readonly string[]).includes(value)
	);
}

export function isExtractionErrorCode(
	value: unknown,
): value is ExtractionErrorCode {
	return (
		typeof value === "string" &&
		(EXTRACTION_ERROR_CODES as readonly string[]).includes(value)
	);
}

export function isRetryableExtractionErrorCode(
	code: ExtractionErrorCode,
): boolean {
	return RETRYABLE_EXTRACTION_ERROR_CODES.has(code);
}

/** The DTO every client surface consumes. One row, one truth. */
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
	/** true when the row is synthesised from a pre-ledger artifact. */
	legacy: boolean;
}

export const LEGACY_EXTRACTION_JOB_ID_PREFIX = "legacy-extraction:";

export function isLegacyExtractionJobId(id: string): boolean {
	return id.startsWith(LEGACY_EXTRACTION_JOB_ID_PREFIX);
}

export function legacyExtractionJobId(artifactId: string): string {
	return `${LEGACY_EXTRACTION_JOB_ID_PREFIX}${artifactId}`;
}
