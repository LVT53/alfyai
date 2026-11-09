/**
 * MinerU failures, and what each one means to the extraction ledger.
 *
 * Two things live here and nothing else:
 *
 *  - `MineruApiError`, the single throw shape of `client.ts`. It carries the
 *    HTTP status, the server's `code`/`param`, and a TRUNCATED excerpt of the
 *    body. It never carries the API key, a request header, or document text.
 *  - `mapMineruError`, a table-driven translation from what was observed to the
 *    Phase 3 taxonomy (`ExtractionErrorCode`) plus a retryability verdict and a
 *    disposition: "fail", "swallow", or "the server forgot this id, recover by
 *    creating the task again and uploading the bytes again".
 *
 * The table is keyed on the server's `code` (and `param`), never on the HTTP
 * status and never on `message`, because 4.1's messages are pydantic dumps with
 * a URL in them (spike D12). Three exceptions, each deliberate:
 *
 *  - Another protocol's voice (S6, R14). 4.0.12 ALREADY serves `/v1/tasks`, so
 *    during the seconds between a deploy and the URL flip a 4.1 client meets it,
 *    and it answers in 4.0's shape: every error body carries `error.type`
 *    (4.1 never sends one), and a route it lacks answers FastAPI's plain 404
 *    `{detail}`. Either is `wrong-protocol`: retryable and `unavailable`, so a job
 *    caught in that window succeeds once the URL points at 4.1, matched BEFORE
 *    any code rule so 4.0.12's own `task_not_found` is never a forgotten id.
 *    (A FastAPI 405 is not this: it is a client bug.)
 *  - A file's failure is always `parse_failed` (D6); only its message tells a
 *    corrupt, a locked, an unsupported and an unreadable document apart (S8).
 *  - `invalid_request` with `param: "tier"` is how 4.1 says a tier is missing.
 *
 * `errors.test.ts` drives every recorded error under
 * `fixtures/mineru-v41/protocol/` through this table and fails when a recorded
 * answer matches no named rule, so a future fixture run cannot quietly add an
 * unmapped failure mode.
 */

import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	DocumentExtractionError,
	extractionErrorMessage,
} from "../extraction/contracts";
import {
	fastapiErrorSchema,
	type MineruErrorDetail,
	type MineruTaskDetail,
	type MineruTaskFile,
	type MineruUploadLink,
	mineruErrorResponseSchema,
} from "./schemas";

/** Never put more of an upstream body than this into an error message. */
const MINERU_ERROR_BODY_MAX_CHARS = 300;

/**
 * Codes this client mints itself, for failures that never reached an HTTP
 * response or that a 200 cannot express. They are namespaced away from the
 * server's own vocabulary so a future server code can never collide with one.
 */
export const MINERU_CLIENT_ERROR_CODES = {
	/** `fetch` itself failed: connection refused, DNS, socket reset. */
	transportUnreachable: "client_transport_unreachable",
	/** The CALLER's signal fired: user cancel, shutdown, lost claim. */
	canceled: "client_canceled",
	/** OUR timeout fired: requestTimeoutMs or transferTimeoutMs. */
	timeout: "client_timeout",
	/** The whole-job deadline (`jobTimeoutMs`) elapsed while polling. */
	jobDeadline: "client_job_deadline_exceeded",
	/** A 2xx whose body was not JSON. */
	invalidJson: "client_invalid_json",
	/** A 2xx whose body did not match the recorded schema. */
	schemaMismatch: "client_schema_mismatch",
	/** `upload.url` pointed at an origin that is not MINERU_API_URL's (S7). */
	untrustedUploadUrl: "protocol_untrusted_upload_url",
	/** `result_url` pointed at an origin that is not MINERU_API_URL's (S7). */
	untrustedResultUrl: "protocol_untrusted_result_url",
	/** A redirect pointed somewhere we refuse to follow. */
	untrustedRedirect: "protocol_untrusted_redirect",
	/** Downloaded byte count differs from the Content-Length the server sent. */
	byteCountMismatch: "client_byte_count_mismatch",
	/** The download is, or declared itself to be, over the ceiling. */
	downloadTooLarge: "client_download_too_large",
	/** A tier the server does not offer, caught before any bytes move. */
	tierNotAvailable: "client_tier_not_available",
	/**
	 * A poll found the file we submitted still `waiting-file`. In a one-file task
	 * only a PUT moves a file out of that state, so waiting on would run to the
	 * whole-job deadline. The error carries the snapshot's `upload` link when it
	 * has one: `mineruWaitingUpload`.
	 */
	fileWaitingForBytes: "client_file_waiting_for_bytes",
} as const;

/**
 * The server codes that mean "this id is gone". A MinerU restart forgets every
 * task, every file and the whole hash cache (spike §8), and an upload link
 * stops working after an hour; either way the answer is one of these, and the
 * recovery is always the same: create the task again, upload the bytes again
 * (S6). Bounded by the caller, as it always was.
 */
export const MINERU_FORGOTTEN_ID_CODES = [
	"task_not_found",
	"file_not_found",
	"upload_not_found",
	"upload_expired",
] as const;

export interface MineruApiErrorInit {
	message: string;
	/** null for a failure that never produced an HTTP response. */
	status?: number | null;
	code: string;
	param?: string | null;
	detail?: MineruErrorDetail | null;
	/** True when the body was FastAPI's `{detail}` rather than MinerU's. */
	fastapi?: boolean;
	/**
	 * Why this answer is another protocol's, or null when it is not: an
	 * `error.type` (4.0.x sends one on every error body, 4.1 never does), or a
	 * FastAPI 404 `{detail}` for a route the server lacks.
	 */
	wrongProtocol?: string | null;
	/** Already truncated and already scrubbed. */
	bodyExcerpt?: string | null;
	retryAfterMs?: number | null;
	/** Path only ("/v1/tasks/job_x"), never a full URL with a query. */
	requestPath?: string | null;
	details?: Record<string, unknown>;
	cause?: unknown;
}

/**
 * Everything `client.ts` throws.
 *
 * Structural `name` check rather than `instanceof` for the same reason
 * `extraction/contracts.ts` gives: a module loaded twice (lazy worker import
 * beside an eager route import) would otherwise produce two classes and one
 * would not recognise the other's errors.
 */
export class MineruApiError extends Error {
	readonly name = "MineruApiError";
	readonly status: number | null;
	/** "" when the body carried none (FastAPI's, or not JSON at all). */
	readonly code: string;
	readonly param: string | null;
	readonly detail: MineruErrorDetail | null;
	readonly fastapi: boolean;
	/** See `MineruApiErrorInit.wrongProtocol`. Such an error is never a forgotten id. */
	readonly wrongProtocol: string | null;
	readonly bodyExcerpt: string | null;
	readonly retryAfterMs: number | null;
	readonly requestPath: string | null;
	readonly details: Record<string, unknown> | undefined;

	constructor(init: MineruApiErrorInit) {
		super(
			init.message,
			init.cause === undefined ? undefined : { cause: init.cause },
		);
		this.status = init.status ?? null;
		this.code = init.code;
		this.param = init.param ?? null;
		this.detail = init.detail ?? null;
		this.fastapi = init.fastapi ?? false;
		this.wrongProtocol = init.wrongProtocol ?? null;
		this.bodyExcerpt = init.bodyExcerpt ?? null;
		this.retryAfterMs = init.retryAfterMs ?? null;
		this.requestPath = init.requestPath ?? null;
		this.details = init.details;
	}
}

export function isMineruApiError(error: unknown): error is MineruApiError {
	if (error instanceof MineruApiError) return true;
	if (!(error instanceof Error) || error.name !== "MineruApiError")
		return false;
	const candidate = error as Partial<MineruApiError>;
	return typeof candidate.code === "string";
}

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

/**
 * Collapses whitespace and cuts the body down to something safe to log.
 *
 * MinerU echoes the request back in its validation messages (pydantic prints
 * `input_value=…`), so an untruncated body could carry a filename or a header
 * value.
 */
export function truncateMineruBody(
	text: string,
	maxChars = MINERU_ERROR_BODY_MAX_CHARS,
): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
}

/**
 * Removes the configured API key from anything about to be logged or put into
 * an error message. Cheap, and it makes "the key never appears in an error"
 * a property of the code rather than of everyone's discipline.
 */
export function redactMineruSecrets(text: string, apiKey: string): string {
	if (!apiKey) return text;
	return text.split(apiKey).join("[redacted]");
}

interface ParsedMineruErrorBody {
	detail: MineruErrorDetail | null;
	/** True when FastAPI's `{detail}` envelope was recognised. */
	fastapi: boolean;
	/**
	 * The `error.type` of the body, if it has one. 4.0.x puts one on every error
	 * (`invalid_request_error`, `authentication_error`, `api_error`, ...); 4.1
	 * never does (spike section 6). Read from the raw JSON BEFORE the envelope is
	 * validated, so an old body that fails the 4.1 schema (4.0 sends `param:
	 * null`, and may send what it likes) cannot hide it.
	 */
	legacyType: string | null;
	excerpt: string;
}

function legacyTypeOf(parsed: unknown): string | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const error = (parsed as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return null;
	const type = (error as { type?: unknown }).type;
	return typeof type === "string" && type.length > 0 ? type : null;
}

/**
 * Reads a non-2xx body. Tries MinerU's envelope, then FastAPI's, then gives up
 * and keeps a truncated excerpt: an opaque body is still worth a message.
 */
export function parseMineruErrorBody(
	bodyText: string,
	maxChars = MINERU_ERROR_BODY_MAX_CHARS,
): ParsedMineruErrorBody {
	const excerpt = truncateMineruBody(bodyText, maxChars);
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return { detail: null, fastapi: false, legacyType: null, excerpt };
	}
	const legacyType = legacyTypeOf(parsed);

	const envelope = mineruErrorResponseSchema.safeParse(parsed);
	if (envelope.success) {
		return {
			detail: envelope.data.error,
			fastapi: false,
			legacyType,
			excerpt,
		};
	}

	const fastapi = fastapiErrorSchema.safeParse(parsed);
	if (fastapi.success) {
		const { detail } = fastapi.data;
		if (typeof detail === "string") {
			return {
				detail: { code: null, message: detail, param: null },
				fastapi: true,
				legacyType,
				excerpt,
			};
		}
		const first = detail[0];
		return {
			detail: {
				code: null,
				message: first?.msg ?? "Request validation failed",
				param: first?.loc?.join(".") ?? null,
			},
			fastapi: true,
			legacyType,
			excerpt,
		};
	}

	return { detail: null, fastapi: false, legacyType, excerpt };
}

/**
 * The one line an error carries. For `invalid_request` it is the code and the
 * param, NOT the server's text: that is pydantic's dump (spike D12), with a
 * URL in it and the value we sent echoed back, and it ends up in
 * `error_message`, which people read. Every other code keeps its short,
 * stable sentence ("Task job_x not found").
 */
function summarizeBody(parsed: ParsedMineruErrorBody, status: number): string {
	const detail = parsed.detail;
	if (detail?.code === "invalid_request") {
		return detail.param
			? `invalid_request (${detail.param})`
			: "invalid_request";
	}
	return detail?.message || parsed.excerpt || `HTTP ${status}`;
}

/**
 * Builds the error for a non-2xx response.
 *
 * `client.ts` calls this with an ALREADY SCRUBBED body, and `errors.test.ts`
 * calls it with the recorded bodies, so the test drives exactly the production
 * path rather than a paraphrase of it.
 */
export function mineruApiErrorFromBody(input: {
	status: number;
	bodyText: string;
	path?: string;
	retryAfterMs?: number | null;
	maxChars?: number;
}): MineruApiError {
	const parsed = parseMineruErrorBody(input.bodyText, input.maxChars);
	return new MineruApiError({
		message: `MinerU ${input.path ?? "request"} failed with ${input.status}: ${summarizeBody(parsed, input.status)}`,
		status: input.status,
		code: parsed.detail?.code ?? "",
		param: parsed.detail?.param ?? null,
		detail: parsed.detail,
		fastapi: parsed.fastapi,
		wrongProtocol:
			parsed.legacyType !== null
				? `error.type ${parsed.legacyType}`
				: parsed.fastapi && input.status === 404
					? "a FastAPI 404 {detail}"
					: null,
		bodyExcerpt: parsed.excerpt,
		retryAfterMs: input.retryAfterMs ?? null,
		requestPath: input.path ?? null,
	});
}

// ---------------------------------------------------------------------------
// The mapping table
// ---------------------------------------------------------------------------

/**
 * What the caller should DO, beyond knowing which taxonomy code to report.
 *
 *  - `fail`: throw. `taxonomy`/`retryable` are the ledger's verdict.
 *  - `swallow`: nothing is wrong. Cancelling something already terminal is the
 *    only case, and it means the goal is already met.
 *  - `recover-by-reupload`: the server forgot this id. Do NOT fail: create the
 *    task again, upload the bytes again and take the new ids (S6).
 */
export type MineruErrorDisposition = "fail" | "swallow" | "recover-by-reupload";

export interface MineruErrorMapping {
	/** The table row that matched. `"fallback:*"` means nothing did. */
	readonly rule: string;
	/** False when only a status-shaped fallback matched: the test asserts this. */
	readonly known: boolean;
	readonly taxonomy: ExtractionErrorCode;
	/** Overrides `RETRYABLE_EXTRACTION_ERROR_CODES` where they differ. */
	readonly retryable: boolean;
	/** The stored handle is poisonous; the ledger must clear it. */
	readonly handleUnknown: boolean;
	readonly disposition: MineruErrorDisposition;
	readonly retryAfterMs: number | null;
	/** One static line, for a log or a review. Never user-facing, never upstream text. */
	readonly reason: string;
}

interface MineruErrorRule {
	rule: string;
	/** Matched against `MineruApiError.code`. */
	code?: string;
	/** Matches an error whose body was FastAPI's `{detail}`, which has no code. */
	fastapi?: boolean;
	/** Matches an error that `MineruApiError.wrongProtocol` calls another protocol's. */
	wrongProtocol?: boolean;
	status?: number | readonly number[];
	param?: string | readonly string[];
	message?: RegExp;
	taxonomy: ExtractionErrorCode;
	retryable: boolean;
	handleUnknown?: boolean;
	disposition?: MineruErrorDisposition;
	reason: string;
}

/** The row that reads the server's refusal of a tier (see `isMineruTierRefusal`). */
const TIER_REFUSAL_RULE = "400:tier-not-available";

/**
 * Ordered: the first matching row wins. Order matters in two places: the tier
 * row sits before the generic `invalid_request` it is a case of, and the
 * `parse_failed` rows run from the specific wordings to the catch-all.
 */
const MINERU_ERROR_RULES: readonly MineruErrorRule[] = [
	// -- transport and client-side, no HTTP response ------------------------
	{
		rule: "client:transport",
		code: MINERU_CLIENT_ERROR_CODES.transportUnreachable,
		taxonomy: "unavailable",
		retryable: true,
		reason: "MinerU could not be reached",
	},
	{
		rule: "client:canceled",
		code: MINERU_CLIENT_ERROR_CODES.canceled,
		taxonomy: "canceled",
		retryable: false,
		reason: "the caller's signal fired",
	},
	{
		rule: "client:timeout",
		code: MINERU_CLIENT_ERROR_CODES.timeout,
		taxonomy: "timeout",
		retryable: true,
		reason: "our own per-request timeout fired",
	},
	{
		rule: "client:job-deadline",
		code: MINERU_CLIENT_ERROR_CODES.jobDeadline,
		taxonomy: "timeout",
		retryable: true,
		reason: "the whole-job deadline elapsed; cancel the remote task first",
	},
	{
		rule: "client:invalid-json",
		code: MINERU_CLIENT_ERROR_CODES.invalidJson,
		taxonomy: "protocol",
		retryable: true,
		reason: "a 200 is not automatically valid",
	},
	{
		rule: "client:schema-mismatch",
		code: MINERU_CLIENT_ERROR_CODES.schemaMismatch,
		taxonomy: "protocol",
		retryable: true,
		reason: "the response did not match the recorded shape",
	},
	{
		rule: "client:untrusted-upload-url",
		code: MINERU_CLIENT_ERROR_CODES.untrustedUploadUrl,
		taxonomy: "protocol",
		retryable: false,
		reason: "a misconfigured or hostile server; retrying only repeats it",
	},
	{
		rule: "client:untrusted-result-url",
		code: MINERU_CLIENT_ERROR_CODES.untrustedResultUrl,
		taxonomy: "protocol",
		retryable: false,
		reason: "a misconfigured or hostile server; retrying only repeats it",
	},
	{
		rule: "client:untrusted-redirect",
		code: MINERU_CLIENT_ERROR_CODES.untrustedRedirect,
		taxonomy: "protocol",
		retryable: false,
		reason: "a redirect we refuse to follow; retrying only repeats it",
	},
	{
		rule: "client:byte-count-mismatch",
		code: MINERU_CLIENT_ERROR_CODES.byteCountMismatch,
		taxonomy: "protocol",
		retryable: true,
		reason: "the download did not match the length the server announced",
	},
	{
		rule: "client:download-too-large",
		code: MINERU_CLIENT_ERROR_CODES.downloadTooLarge,
		taxonomy: "protocol",
		retryable: true,
		reason: "the result is, or announced itself as, over the download ceiling",
	},
	{
		rule: "client:tier-not-available",
		code: MINERU_CLIENT_ERROR_CODES.tierNotAvailable,
		taxonomy: "tier_unavailable",
		retryable: false,
		reason: "the desired tier is not offered; fail before any bytes move",
	},
	/**
	 * The PUT never landed (a transport error or timeout during it, a worker
	 * restart between createTask and its 200, or a 400 that left the file waiting,
	 * D13), and the stored handle brought a later attempt back to a task that will
	 * not move by itself. The caller's fast path is to PUT again with the link the
	 * error carries; failing that, create again. If the error escapes, the handle
	 * is spent so that the next attempt creates a fresh task instead of resuming
	 * this one into the same stall.
	 */
	{
		rule: "client:file-waiting",
		code: MINERU_CLIENT_ERROR_CODES.fileWaitingForBytes,
		taxonomy: "protocol",
		retryable: true,
		handleUnknown: true,
		reason:
			"the task is still waiting for the file's bytes: PUT them again, or create the task again",
	},

	// -- the server answered in another protocol's voice ----------------------
	/**
	 * 4.0.12 ALREADY mounts POST /v1/tasks, GET and DELETE /v1/tasks/{id} and GET
	 * /v1/files/{id}/content (R14), so a 4.1 manifest sent there is refused by its
	 * own validation: HTTP 400 in 4.0's error shape, `{"error":{"type":
	 * "invalid_request_error","code":"invalid_request",...,"param":null}}`. Every
	 * 4.0 error body carries `error.type`; a 4.1 one never does. Routes 4.0.12
	 * lacks (the PUT, the cancel) answer FastAPI's plain 404 `{detail}`.
	 *
	 * Both mean the same thing, and it is not about the document: the URL still
	 * points at the old server (the seconds between a deploy and the URL flip, S6),
	 * or at a proxy in front of the wrong thing. `unavailable` gets the patient
	 * outage budget, and the job succeeds once the URL is right. It comes BEFORE
	 * every code rule, so 4.0.12's 404 `task_not_found` (which has a type) is not
	 * mistaken for a forgotten id and re-created into the same wall, and its 401
	 * is not read as our key being wrong. The cause is in
	 * `MineruApiError.wrongProtocol` and travels into the error's details.
	 */
	{
		rule: "wrong-protocol",
		wrongProtocol: true,
		taxonomy: "unavailable",
		retryable: true,
		reason:
			"the server answered in another protocol's voice (4.0.x): it is not a 4.1 MinerU yet",
	},
	/**
	 * A FastAPI 405 is NOT the old server (it only ever says 404 for a route it
	 * lacks): it is a 4.1 route answering a method it does not have, i.e. a bug in
	 * this client such as an empty task id making `/v1/tasks/`. Not an outage.
	 */
	{
		rule: "405:method-not-allowed",
		fastapi: true,
		status: 405,
		taxonomy: "protocol",
		retryable: false,
		reason: "a 4.1 route refused our method: a client bug, not an outage",
	},

	// -- authentication -----------------------------------------------------
	{
		rule: "401:invalid_api_key",
		code: "invalid_api_key",
		taxonomy: "auth_failed",
		retryable: false,
		reason: "a wrong or missing key is not something a retry fixes",
	},

	// -- tier ---------------------------------------------------------------
	/**
	 * 4.0 said 503 `quality_tier_unavailable`; 4.1 says 400 `invalid_request`
	 * with `param: "tier"` (D14). Our client only sends ids it got from
	 * /v1/tiers, so this is a tier the server stopped offering: a
	 * misconfiguration an admin fixes, never an outage and never a loop.
	 */
	{
		rule: TIER_REFUSAL_RULE,
		code: "invalid_request",
		param: "tier",
		taxonomy: "tier_unavailable",
		retryable: false,
		reason: "a misconfiguration, not an outage; never show it as one",
	},

	// -- request shape ------------------------------------------------------
	{
		rule: "400:page_range_invalid",
		code: "page_range_invalid",
		taxonomy: "protocol",
		retryable: false,
		reason: "unreachable: this client never sends a page range",
	},

	// -- uploads ------------------------------------------------------------
	{
		rule: "400:upload_size_mismatch",
		code: "upload_size_mismatch",
		taxonomy: "protocol",
		retryable: true,
		reason:
			"the file changed size since we measured it, or the declared size contradicts the cached bytes; a new attempt measures again",
	},
	{
		rule: "400:file_hash_mismatch",
		code: "file_hash_mismatch",
		taxonomy: "protocol",
		retryable: true,
		reason: "the bytes are not the bytes we hashed; a new attempt hashes again",
	},
	{
		rule: "413:file_too_large",
		code: "file_too_large",
		taxonomy: "too_large",
		retryable: false,
		reason: "UNVERIFIED: the spike's server set no size limit",
	},

	// -- tasks and forgotten ids (S6) ----------------------------------------
	{
		rule: "409:task_already_terminal",
		code: "task_already_terminal",
		taxonomy: "protocol",
		retryable: false,
		disposition: "swallow",
		reason: "cancelling, or uploading to, a finished task: nothing to do",
	},
	{
		rule: "404:task_not_found",
		code: "task_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "the server restarted and forgot the task: create it again",
	},
	{
		rule: "404:file_not_found",
		code: "file_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "the server forgot the file (or its result): create the task again",
	},
	{
		rule: "404:upload_not_found",
		code: "upload_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason:
			"the server knows the task but not this file: create the task again",
	},
	{
		rule: "410:upload_expired",
		code: "upload_expired",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "UNVERIFIED: the upload link is good for an hour; create it again",
	},
	{
		rule: "429:rate_limit_exceeded",
		code: "rate_limit_exceeded",
		taxonomy: "rate_limited",
		retryable: true,
		reason: "UNVERIFIED: honour Retry-After when present",
	},
	{
		rule: "503:server_shutting_down",
		code: "server_shutting_down",
		taxonomy: "unavailable",
		retryable: true,
		reason: "UNVERIFIED: the server is stopping; it comes back",
	},

	// -- file-level failures (S8) ---------------------------------------------
	/**
	 * Every cause of a failed file is the single code `parse_failed` (D6); only
	 * the message differs, so these rows read it. They run from the specific
	 * wordings to the catch-all, and they are anchored on phrases rather than on
	 * the file name, so a renamed file cannot change a verdict. The message is
	 * only ever MATCHED here, never shown (D12): the user's sentence comes from
	 * the taxonomy code.
	 *
	 * "Unsupported file type: <ext or detected type>". A permanent refusal that
	 * looks exactly like a transient one: read as an ordinary failure it burned
	 * three attempts plus backoff and then offered a Retry that could never work.
	 */
	{
		rule: "file:parse_failed:unsupported-type",
		code: "parse_failed",
		message: /unsupported (file|input|document|source) (type|format)/i,
		taxonomy: "unsupported_type",
		retryable: false,
		reason:
			"MinerU cannot read this format at all; a retry repeats the refusal",
	},
	/**
	 * "Failed to load document (PDFium: Incorrect password error)." The document
	 * is locked, and stays locked however often we ask. These sit before the
	 * general PDFium row because every PDFium reason arrives under "Failed to
	 * load document".
	 */
	{
		rule: "file:parse_failed:protected",
		code: "parse_failed",
		message:
			/incorrect password|unsupported security scheme|password[\s-]?protected|\bencrypted\b/i,
		taxonomy: "document_unreadable",
		retryable: false,
		reason:
			"the document is locked; the same bytes stay locked however often we ask",
	},
	/**
	 * "Failed to load document (PDFium: Data format error)." pypdfium2 raises one
	 * sentence for every way a PDF cannot be opened, and also for a document with
	 * no pages (D17: a zero-page PDF arrives as "Incorrect password error"). The
	 * wording is `PDFium: <reason>`, wrapped, so it is matched as a phrase.
	 */
	{
		rule: "file:parse_failed:unreadable-document",
		code: "parse_failed",
		message: /failed to load document|\bpdfium\b|data format error/i,
		taxonomy: "document_unreadable",
		retryable: false,
		reason:
			"the reader cannot open these bytes at all; a retry repeats the refusal",
	},
	/**
	 * "Invalid XLSX package: file is not a ZIP archive." An Office file whose
	 * container is not one (D17: a CSV named .xlsx). Final for these bytes.
	 */
	{
		rule: "file:parse_failed:invalid-package",
		code: "parse_failed",
		message: /\binvalid \w+ package\b/i,
		taxonomy: "document_unreadable",
		retryable: false,
		reason: "the Office container is not one; a retry repeats the refusal",
	},
	/**
	 * Carried over from 4.0.4, where a scan with nothing legible answered
	 * `parse_empty` / "Parse completed but returned no pages". 4.1.7 was not seen
	 * to say it (the result parser raises `empty_result` itself), but if it ever
	 * does, retrying cannot make text appear.
	 */
	{
		rule: "file:parse_empty",
		code: "parse_empty",
		taxonomy: "empty_result",
		retryable: false,
		reason: "the parse finished and there was nothing in the document",
	},
	{
		rule: "file:parse_failed:empty",
		code: "parse_failed",
		message:
			/returned no pages|no (readable )?(text|pages) (was )?(found|extracted)|empty (document|result)/i,
		taxonomy: "empty_result",
		retryable: false,
		reason:
			"the same outcome under the generic code; the document has no text to find",
	},
	{
		rule: "file:parse_failed",
		code: "parse_failed",
		taxonomy: "job_failed",
		retryable: true,
		reason: "the engine failed on this file",
	},

	// -- the generic validation error, LAST among the coded rules ----------
	{
		rule: "400:invalid_request",
		code: "invalid_request",
		taxonomy: "protocol",
		retryable: false,
		reason: "we sent a request this server rejects; a retry repeats it",
	},
];

const RULES_BY_ID = new Map<string, MineruErrorRule>(
	MINERU_ERROR_RULES.map((rule) => [rule.rule, rule]),
);

function ruleById(id: string): MineruErrorRule {
	const rule = RULES_BY_ID.get(id);
	if (!rule) throw new Error(`Unknown MinerU error rule "${id}"`);
	return rule;
}

function matchesParam(rule: MineruErrorRule, param: string | null): boolean {
	if (rule.param === undefined) return true;
	if (param === null) return false;
	return typeof rule.param === "string"
		? rule.param === param
		: rule.param.includes(param);
}

function matchesStatus(rule: MineruErrorRule, status: number | null): boolean {
	if (rule.status === undefined) return true;
	if (status === null) return false;
	return typeof rule.status === "number"
		? rule.status === status
		: rule.status.includes(status);
}

function findRule(input: {
	code: string | null;
	status: number | null;
	param: string | null;
	message: string;
	fastapi: boolean;
	wrongProtocol: boolean;
}): MineruErrorRule | null {
	for (const rule of MINERU_ERROR_RULES) {
		if (rule.wrongProtocol) {
			if (!input.wrongProtocol) continue;
		} else if (rule.fastapi) {
			if (!input.fastapi) continue;
		} else if (!input.code || rule.code !== input.code) {
			continue;
		}
		if (!matchesStatus(rule, input.status)) continue;
		if (!matchesParam(rule, input.param)) continue;
		if (rule.message && !rule.message.test(input.message)) continue;
		return rule;
	}
	return null;
}

function toMapping(
	rule: MineruErrorRule,
	retryAfterMs: number | null,
): MineruErrorMapping {
	return {
		rule: rule.rule,
		known: true,
		taxonomy: rule.taxonomy,
		retryable: rule.retryable,
		handleUnknown: rule.handleUnknown ?? false,
		disposition: rule.disposition ?? "fail",
		retryAfterMs,
		reason: rule.reason,
	};
}

function fallbackForStatus(status: number | null): MineruErrorMapping {
	if (status === 422) {
		return {
			rule: "fallback:422",
			known: false,
			taxonomy: "protocol",
			retryable: false,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: "FastAPI's own validation envelope; our request is malformed",
		};
	}
	if (status !== null && status >= 500) {
		return {
			rule: "fallback:5xx",
			known: false,
			taxonomy: "unavailable",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: "an unclassified server error",
		};
	}
	if (status !== null && status >= 400) {
		return {
			rule: "fallback:4xx",
			known: false,
			taxonomy: "protocol",
			retryable: false,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: "an unclassified rejection of our request",
		};
	}
	return {
		rule: "fallback:unknown",
		known: false,
		taxonomy: "unavailable",
		retryable: true,
		handleUnknown: false,
		disposition: "fail",
		retryAfterMs: null,
		reason: "an unrecognised failure",
	};
}

/**
 * Maps any throw from `client.ts`, or from `fetch` underneath it, onto the
 * taxonomy. Never throws.
 */
export function mapMineruError(error: unknown): MineruErrorMapping {
	if (isMineruApiError(error)) {
		const rule = findRule({
			code: error.code,
			status: error.status,
			param: error.param,
			message: error.detail?.message ?? error.message,
			fastapi: error.fastapi,
			wrongProtocol: (error.wrongProtocol ?? null) !== null,
		});
		if (rule) return toMapping(rule, error.retryAfterMs);
		return {
			...fallbackForStatus(error.status),
			retryAfterMs: error.retryAfterMs,
		};
	}

	// AbortSignal.timeout aborts with a TimeoutError; a caller's controller
	// aborts with an AbortError. AbortSignal.any forwards whichever fired, which
	// is the only reason "our deadline" and "the user pressed cancel" can be
	// told apart at all.
	//
	// Read by NAME rather than by `instanceof DOMException`: under jsdom (and in
	// any bundle that loads a second copy of a realm) the abort reason is a
	// DOMException that fails both `instanceof DOMException` and `instanceof
	// Error`, and misreading a cancel as an outage would retry work the user
	// just asked us to stop.
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "TimeoutError")
		return toMapping(ruleById("client:timeout"), null);
	if (name === "AbortError")
		return toMapping(ruleById("client:canceled"), null);

	if (isTransportFailure(error)) {
		return toMapping(ruleById("client:transport"), null);
	}

	return fallbackForStatus(null);
}

/** `TypeError: fetch failed`, ECONNREFUSED, ENOTFOUND and friends. */
function isTransportFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
		return true;
	}
	const direct = "code" in error ? (error as { code?: unknown }).code : null;
	const cause = (error as { cause?: { code?: unknown } }).cause?.code ?? null;
	const code = typeof direct === "string" ? direct : cause;
	return (
		typeof code === "string" &&
		[
			"ECONNREFUSED",
			"ECONNRESET",
			"ENOTFOUND",
			"EAI_AGAIN",
			"EPIPE",
			"UND_ERR_SOCKET",
			"UND_ERR_CONNECT_TIMEOUT",
		].includes(code)
	);
}

/**
 * True when this failure means "the server no longer knows this identifier".
 * The recovery (S6) is to create the task again and upload again; never
 * persist an id across a MinerU restart as if it were still good.
 */
export function isMineruForgottenIdError(error: unknown): boolean {
	return (
		isMineruApiError(error) &&
		// 4.0.12 answers 404 task_not_found too, with an error.type: that is the
		// old server, and creating the task again would only meet the same wall.
		(error.wrongProtocol ?? null) === null &&
		(MINERU_FORGOTTEN_ID_CODES as readonly string[]).includes(error.code)
	);
}

/**
 * True when the SERVER refused a tier on a request: 400 `invalid_request` with
 * `param: "tier"`, in 4.1's voice. This client only asks for a tier its own read
 * of `/v1/tiers` listed, so the refusal means that read is out of date, and
 * whoever holds a copy of it should read it again. A tier our own check refused
 * (`client_tier_not_available`) is the list speaking, not the server, and is not
 * this.
 */
export function isMineruTierRefusal(error: unknown): boolean {
	return mapMineruError(error).rule === TIER_REFUSAL_RULE;
}

// ---------------------------------------------------------------------------
// A task that is waiting for its bytes
// ---------------------------------------------------------------------------

/**
 * The error a poll throws when the file it was watching is still `waiting-file`.
 * The snapshot's `upload` link, if it had one, rides in `details` (read it back
 * with `mineruWaitingUpload`); the details also name the task and the file.
 */
export function mineruFileWaitingError(
	taskId: string,
	file: MineruTaskFile,
): MineruApiError {
	return new MineruApiError({
		code: MINERU_CLIENT_ERROR_CODES.fileWaitingForBytes,
		message: `MinerU task ${taskId} is still waiting for the bytes of its file.`,
		requestPath: `/v1/tasks/${encodeURIComponent(taskId)}`,
		details: { taskId, fileId: file.file_id, upload: file.upload ?? null },
	});
}

/**
 * The upload link a poll found the submitted file still waiting at, or null when
 * `error` is not that error or its snapshot carried no link (then there is
 * nothing to PUT to: create the task again).
 */
export function mineruWaitingUpload(error: unknown): MineruUploadLink | null {
	if (
		!isMineruApiError(error) ||
		error.code !== MINERU_CLIENT_ERROR_CODES.fileWaitingForBytes
	) {
		return null;
	}
	const upload = error.details?.upload as Partial<MineruUploadLink> | null;
	if (
		typeof upload?.url !== "string" ||
		upload.url.length === 0 ||
		typeof upload.headers !== "object" ||
		upload.headers === null
	) {
		return null;
	}
	return upload as MineruUploadLink;
}

// ---------------------------------------------------------------------------
// Settled tasks
// ---------------------------------------------------------------------------

export interface MineruTaskFailureOptions {
	/**
	 * True when WE issued the cancel. It only changes the verdict for a canceled
	 * file: `task:canceled-by-us` (taxonomy `canceled`, not retryable) instead of
	 * `task:canceled-by-someone-else`. It never turns a verdict into `null`.
	 */
	canceledByUs?: boolean;
	/**
	 * The file this caller submitted. Defaults to the first one, which is the
	 * only one a one-file task (S2) has; it matters for a multi-file task that
	 * ended `partial`, where one file completed and another failed.
	 */
	fileId?: string | null;
}

/** The file a caller submitted: the one `fileId` names, else the first. */
export function pickMineruTaskFile(
	task: MineruTaskDetail,
	fileId?: string | null,
): MineruTaskFile | null {
	if (fileId) return task.files.find((file) => file.file_id === fileId) ?? null;
	return task.files[0] ?? null;
}

/**
 * A terminal remote task is SPENT, whatever it failed on.
 *
 * `mapMineruTaskFailure` is only ever reached with a task MinerU has already
 * settled, so every failure it returns is a final answer about that task id.
 * Any later attempt that resumed the id would issue one `GET` against a task
 * that cannot change its mind and fail again for the same reason.
 *
 * So the handle is poisoned here, at the one place that knows the remote task
 * is finished. The ledger's `clearHandle` then makes the NEXT attempt, whether
 * automatic, user Retry, re-upload or re-extract, submit a fresh task.
 * Re-uploading costs nothing extra: the hash cache skips the PUT.
 *
 * The cases that legitimately KEEP a handle never come through here: a lost
 * claim, a stale-worker reclaim, a shutdown and a transport error all leave the
 * remote task running, and resuming it is the whole reason the handle is
 * emitted before the first poll.
 */
function spent(mapping: MineruErrorMapping): MineruErrorMapping {
	return mapping.handleUnknown ? mapping : { ...mapping, handleUnknown: true };
}

function taskVerdict(
	rule: string,
	taxonomy: ExtractionErrorCode,
	reason: string,
	retryable = true,
): MineruErrorMapping {
	return spent({
		rule,
		known: true,
		taxonomy,
		retryable,
		handleUnknown: false,
		disposition: "fail",
		retryAfterMs: null,
		reason,
	});
}

/**
 * Reads a TERMINAL task and decides whether the file we submitted is usable.
 *
 * A 202 at create proves nothing and neither does a task `status`: the file is
 * what counts. A `partial` task holds a completed file beside a failed one, a
 * task cancelled mid-way keeps the results that were already done (spike D24),
 * and a `failed` task has no top-level error, only `files[].error` (D6).
 *
 * Returns `null` EXACTLY when the file is usable: `completed` and carrying a
 * `result_url`, so a caller may download `pickMineruTaskFile(task, fileId).result_url`
 * whenever this is `null`. Every other outcome, our own cancel included, is a
 * mapping.
 *
 * Every non-null return carries `handleUnknown: true`; see `spent` above.
 */
export function mapMineruTaskFailure(
	task: MineruTaskDetail,
	options: MineruTaskFailureOptions = {},
): MineruErrorMapping | null {
	const file = pickMineruTaskFile(task, options.fileId);
	if (!file) {
		return taskVerdict(
			"task:no-file",
			"protocol",
			"a settled task without the file we submitted",
		);
	}

	if (file.status === "completed") {
		if (!file.result_url) {
			return taskVerdict(
				"task:missing-result-url",
				"protocol",
				"a completed file without a result_url",
			);
		}
		return null;
	}

	if (file.error) {
		const rule = findRule({
			code: file.error.code ?? null,
			status: null,
			param: file.error.param ?? null,
			message: file.error.message,
			fastapi: false,
			wrongProtocol: false,
		});
		if (rule) return spent(toMapping(rule, null));
		return spent({
			rule: "task:file-error-unmapped",
			known: false,
			taxonomy: "job_failed",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: "an unmapped file-level error code",
		});
	}

	if (file.status === "canceled" || task.status === "canceled") {
		// Our own cancel is an answer too, and not a result: `null` means there is
		// a `result_url` to download, and a caller that trusted it here would
		// download `undefined`.
		if (options.canceledByUs) {
			return taskVerdict(
				"task:canceled-by-us",
				"canceled",
				"we canceled the task",
				false,
			);
		}
		return taskVerdict(
			"task:canceled-by-someone-else",
			"job_failed",
			"the task was canceled while we were not cancelling",
		);
	}

	if (file.status === "failed") {
		return taskVerdict(
			"task:failed-without-detail",
			"job_failed",
			"a failed file that says nothing about why",
		);
	}

	return taskVerdict(
		"task:file-not-completed",
		"job_failed",
		`file status ${file.status} on a settled task`,
	);
}

// ---------------------------------------------------------------------------
// The bridge to the ledger
// ---------------------------------------------------------------------------

export interface MineruExtractionErrorOptions {
	/** Prefixed to the mapped message, e.g. "MinerU upload failed". */
	context?: string;
	/** Extra diagnostics. Must never contain a credential or document text. */
	details?: Record<string, unknown>;
}

/**
 * Turns a client failure into the error the ledger understands.
 *
 * `retryable` comes from the table, not from
 * `RETRYABLE_EXTRACTION_ERROR_CODES`, because the table knows things the code
 * alone cannot: a `protocol` from a changed file size is worth one more
 * attempt, and a `protocol` from an untrusted `upload.url` is not.
 */
export function mineruErrorToExtractionError(
	error: unknown,
	options: MineruExtractionErrorOptions = {},
): DocumentExtractionError {
	const mapping = mapMineruError(error);
	const base =
		error instanceof Error
			? error.message
			: "MinerU failed for an unknown reason";
	const raw = options.context ? `${options.context}: ${base}` : base;
	// For a code whose upstream message explains nothing a user can act on —
	// "fetch failed" is the canonical example — the sentence comes from the
	// code. The raw text is kept in the diagnostics either way.
	const message = extractionErrorMessage(mapping.taxonomy, raw);

	const details: Record<string, unknown> = { ...options.details };
	details.mineruRule = mapping.rule;
	if (message !== raw) details.rawMessage = raw;
	if (isMineruApiError(error)) {
		if (error.status !== null) details.httpStatus = error.status;
		details.mineruCode = error.code;
		if (error.param) details.mineruParam = error.param;
		if (error.wrongProtocol) details.wrongProtocol = error.wrongProtocol;
		if (error.requestPath) details.path = error.requestPath;
	}

	return new DocumentExtractionError({
		code: mapping.taxonomy,
		message,
		retryable: mapping.retryable,
		retryAfterMs: mapping.retryAfterMs ?? undefined,
		handleUnknown: mapping.handleUnknown,
		details,
		cause: error,
	});
}
