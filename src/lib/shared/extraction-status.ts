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
	"backend_misconfigured",
	"too_large",
	"rate_limited",
	"job_failed",
	"canceled",
	"timeout",
	"protocol",
	"unsupported_type",
	"document_unreadable",
	"empty_result",
	// Ledger-side, never thrown by an extractor:
	"stale_worker",
	"max_attempts",
	"internal",
	"legacy_unknown",
] as const;
export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

/**
 * How the WORKER treats a code, which is a different question from whether the
 * USER may press Retry.
 *
 *  - `attempts` — an ordinary retryable document failure. It consumes the small
 *    per-job attempt budget and backs off between tries.
 *  - `outage` — the backend is not answering right now. This is not evidence
 *    against the document, so it gets its own patient budget: a long,
 *    exponentially backed-off window that does NOT consume the attempt budget.
 *  - `none` — trying again changes nothing until a human changes something.
 */
export const EXTRACTION_AUTO_RETRY_POLICIES = [
	"none",
	"attempts",
	"outage",
] as const;
export type ExtractionAutoRetryPolicy =
	(typeof EXTRACTION_AUTO_RETRY_POLICIES)[number];

export interface ExtractionErrorPolicy {
	/** What the worker does on its own. */
	readonly autoRetry: ExtractionAutoRetryPolicy;
	/**
	 * Whether the user's Retry button should be offered once the job is
	 * terminal. "The system may retry" and "the user may retry" are different
	 * facts: an `auth_failed` is never worth retrying automatically, but the
	 * moment an admin fixes the key, every document that failed on it must be
	 * retryable — otherwise the only way back is to delete and re-upload.
	 */
	readonly userRetryable: boolean;
}

/**
 * The one table. Every code, both facts, in one place.
 *
 * Configuration and environment failures (`auth_failed`, `tier_unavailable`,
 * `backend_misconfigured`, and `unavailable` once its outage window is spent)
 * are NOT auto-retried but ARE user-retryable. Document-level permanent
 * failures (`unsupported_type`, `document_unreadable`, `too_large`,
 * `empty_result`) are neither: nothing anyone can do from the outside makes the
 * same bytes readable.
 */
export const EXTRACTION_ERROR_POLICIES: Readonly<
	Record<ExtractionErrorCode, ExtractionErrorPolicy>
> = {
	// -- the backend is not answering right now -----------------------------
	unavailable: { autoRetry: "outage", userRetryable: true },
	rate_limited: { autoRetry: "outage", userRetryable: true },
	// A timeout — ours on a connect or a poll, or the whole-job deadline — is a
	// statement about the backend's responsiveness, never about the document.
	timeout: { autoRetry: "outage", userRetryable: true },

	// -- ordinary retryable document failures --------------------------------
	job_failed: { autoRetry: "attempts", userRetryable: true },
	// A garbled or unexpected response. Worth one or two more tries, and worth
	// a user retry afterwards because the usual cure is an admin fixing a proxy.
	protocol: { autoRetry: "attempts", userRetryable: true },
	stale_worker: { autoRetry: "attempts", userRetryable: true },

	// -- configuration and environment: an admin fixes it, then the user retries
	auth_failed: { autoRetry: "none", userRetryable: true },
	tier_unavailable: { autoRetry: "none", userRetryable: true },
	backend_misconfigured: { autoRetry: "none", userRetryable: true },

	// -- permanent facts about this document ---------------------------------
	unsupported_type: { autoRetry: "none", userRetryable: false },
	// The format is one we support; THESE BYTES are damaged, truncated, empty or
	// password-protected, and the reader said so deterministically. Re-sending
	// the same bytes reproduces the same refusal, which is why the Retry button
	// is withheld: the way forward is to re-export or unlock the file, and a
	// repaired file has a different hash and therefore becomes a new document.
	document_unreadable: { autoRetry: "none", userRetryable: false },
	too_large: { autoRetry: "none", userRetryable: false },
	empty_result: { autoRetry: "none", userRetryable: false },
	internal: { autoRetry: "none", userRetryable: false },

	// -- ledger-side verdicts -------------------------------------------------
	// The user asked for this one; letting them undo it is the whole point.
	canceled: { autoRetry: "none", userRetryable: true },
	max_attempts: { autoRetry: "none", userRetryable: true },
	legacy_unknown: { autoRetry: "none", userRetryable: true },
};

export function extractionErrorPolicy(
	code: ExtractionErrorCode,
): ExtractionErrorPolicy {
	return EXTRACTION_ERROR_POLICIES[code];
}

/**
 * Default AUTOMATIC retryability per code, derived from the table above so the
 * two can never disagree. An extractor may still override per throw (a 503 with
 * a Retry-After is retryable even under a code that usually is not).
 */
export const RETRYABLE_EXTRACTION_ERROR_CODES: ReadonlySet<ExtractionErrorCode> =
	new Set<ExtractionErrorCode>(
		EXTRACTION_ERROR_CODES.filter(
			(code) => EXTRACTION_ERROR_POLICIES[code].autoRetry !== "none",
		),
	);

/**
 * The codes that mean "the backend is not answering right now".
 *
 * They share the patient outage budget instead of the small attempt budget:
 * `MAX_ATTEMPTS 3` with a 2 s base backoff tolerates about ten seconds of
 * downtime, and a backend restart takes longer than that, so every in-flight
 * document used to fail permanently on a blip it had nothing to do with.
 */
export const OUTAGE_EXTRACTION_ERROR_CODES: ReadonlySet<ExtractionErrorCode> =
	new Set<ExtractionErrorCode>(
		EXTRACTION_ERROR_CODES.filter(
			(code) => EXTRACTION_ERROR_POLICIES[code].autoRetry === "outage",
		),
	);

export function isOutageExtractionErrorCode(
	code: ExtractionErrorCode,
): boolean {
	return OUTAGE_EXTRACTION_ERROR_CODES.has(code);
}

/** Whether the user's Retry button may be offered for this code. */
export function isUserRetryableExtractionErrorCode(
	code: ExtractionErrorCode,
): boolean {
	return EXTRACTION_ERROR_POLICIES[code].userRetryable;
}

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
	/**
	 * When the worker will claim this job again, for a `queued` row sitting
	 * behind a backoff gate. The one thing a client needs beyond `retryable` to
	 * say when a waiting document will be tried again.
	 *
	 * Optional rather than required: a client that predates it treats the whole
	 * DTO as data it may not have all of, and a `null` from an older server is
	 * indistinguishable from "no gate", which is the honest reading anyway.
	 */
	nextAttemptAt?: number | null;
	/** true when the row is synthesised from a pre-ledger artifact. */
	legacy: boolean;
}

/**
 * True while the job is queued behind a backoff gate BECAUSE the backend is
 * not answering — as opposed to queued because the worker has not reached it.
 *
 * The chip and the Knowledge row say two different things about those two, so
 * the distinction is drawn once, here, rather than in each surface.
 */
export function isExtractionWaitingForBackend(
	job: Pick<DocumentExtractionJobDTO, "status" | "error">,
): boolean {
	return (
		job.status === "queued" &&
		job.error !== null &&
		isOutageExtractionErrorCode(job.error.code)
	);
}

/**
 * How many artifact ids one batch status read may ask about.
 *
 * Lives here because both sides of the wire need the same number and neither
 * can own it: a SvelteKit route module may export only its handlers, and the
 * client poller is not something a route may import. Two hand-kept copies
 * (route 50, poller 50) is exactly the arrangement where lowering one and
 * forgetting the other turns every poll into a 400.
 */
export const EXTRACTION_STATUS_BATCH_LIMIT = 50;

/**
 * One attachment's extraction state, as the send gate saw it.
 *
 * This is the single wire shape for the per-attachment rows on a 422:
 * `knowledge/store/attachments.ts` builds them, `chat-turn/types.ts` carries
 * them on `ChatTurnRequestError`, and the composer renders them. It lives in
 * the shared vocabulary because the client is one of the three, and nothing
 * client-side may reach into `$lib/server`.
 */
export interface AttachmentExtractionStatusItem {
	artifactId: string;
	name: string | null;
	status: DocumentExtractionStatus;
	errorCode: ExtractionErrorCode | null;
	retryable: boolean;
}

export const LEGACY_EXTRACTION_JOB_ID_PREFIX = "legacy-extraction:";

export function isLegacyExtractionJobId(id: string): boolean {
	return id.startsWith(LEGACY_EXTRACTION_JOB_ID_PREFIX);
}

export function legacyExtractionJobId(artifactId: string): string {
	return `${LEGACY_EXTRACTION_JOB_ID_PREFIX}${artifactId}`;
}
