/**
 * MinerU failures, and what each one means to the extraction ledger.
 *
 * Two things live here and nothing else:
 *
 *  - `MineruApiError`, the single throw shape of `client.ts`. It carries the
 *    HTTP status, the server's `code`/`type`/`param`, and a TRUNCATED excerpt
 *    of the body. It never carries the API key, a request header, or document
 *    text.
 *  - `mapMineruError`, a table-driven translation from what was observed to the
 *    Phase 3 taxonomy (`ExtractionErrorCode`) plus a retryability verdict and a
 *    disposition — "fail", "swallow", or "the server forgot this id, recover by
 *    re-uploading the bytes".
 *
 * The table is keyed on the server's `code`, not on the HTTP status, because
 * the status lies in both directions: `feature_requires_api_key` is a 403 that
 * becomes a 400 `unsupported_output_format` once a key is present for the very
 * same request, and an unknown `file_id` is a 202 that only fails later, inside
 * the job. `errors.test.ts` drives every probe under `fixtures/mineru-v1/errors/`
 * through this table and fails when a recorded `code` matches no rule, so a
 * future fixture run cannot quietly add an unmapped failure mode.
 */

import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	DocumentExtractionError,
	extractionErrorMessage,
} from "../extraction/contracts";
import {
	fastapiValidationErrorSchema,
	type MineruErrorDetail,
	type MineruJob,
	mineruErrorResponseSchema,
} from "./schemas";

/** Never put more of an upstream body than this into an error message. */
export const MINERU_ERROR_BODY_MAX_CHARS = 300;

/**
 * Codes this client mints itself, for failures that never reached an HTTP
 * response or that a 200 cannot express. They are namespaced away from the
 * server's own vocabulary so a future server code can never collide with one.
 */
export const MINERU_CLIENT_ERROR_CODES = {
	/** `fetch` itself failed: connection refused, DNS, socket reset. */
	transportUnreachable: "client_transport_unreachable",
	/** The CALLER's signal fired — user cancel, shutdown, lost claim. */
	canceled: "client_canceled",
	/** OUR timeout fired: requestTimeoutMs or transferTimeoutMs. */
	timeout: "client_timeout",
	/** The whole-job deadline (`jobTimeoutMs`) elapsed while polling. */
	jobDeadline: "client_job_deadline_exceeded",
	/** A 2xx whose body was not JSON. */
	invalidJson: "client_invalid_json",
	/** A 2xx whose body did not match the recorded schema. */
	schemaMismatch: "client_schema_mismatch",
	/** `upload_url` pointed at an origin that is not MINERU_API_URL's. */
	untrustedUploadUrl: "protocol_untrusted_upload_url",
	/** A redirect pointed somewhere we refuse to follow. */
	untrustedRedirect: "protocol_untrusted_redirect",
	/** Downloaded byte count ≠ the `output_files.*.bytes` the job promised. */
	byteCountMismatch: "client_byte_count_mismatch",
	/** The download blew through the configured cap mid-stream. */
	downloadTooLarge: "client_download_too_large",
	/** Terminal `completed`, but `output_files.zip` was null. */
	missingZipOutput: "client_missing_zip_output",
	/** A tier or output format the server does not offer — caught before upload. */
	tierNotAvailable: "client_tier_not_available",
} as const;

export type MineruClientErrorCode =
	(typeof MINERU_CLIENT_ERROR_CODES)[keyof typeof MINERU_CLIENT_ERROR_CODES];

/**
 * The three 404s that mean "this id is gone" after a MinerU restart. Bytes
 * survive `--upload-dir` as content-addressed blobs; identifiers do not. The
 * recovery is always the same: `POST /v1/uploads` with the known sha256 and
 * take the NEW `file_id`.
 */
export const MINERU_FORGOTTEN_ID_CODES = [
	"job_not_found",
	"file_not_found",
	"upload_not_found",
] as const;

export interface MineruApiErrorInit {
	message: string;
	/** null for a failure that never produced an HTTP response. */
	status?: number | null;
	code: string;
	type?: string | null;
	param?: string | null;
	detail?: MineruErrorDetail | null;
	/** True when the body was FastAPI's `{detail:[…]}` rather than MinerU's. */
	fastapiValidation?: boolean;
	/** Already truncated and already scrubbed. */
	bodyExcerpt?: string | null;
	retryAfterMs?: number | null;
	/** Path only ("/v1/parse/jobs/job_x"), never a full URL with a query. */
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
	readonly code: string;
	readonly type: string | null;
	readonly param: string | null;
	readonly detail: MineruErrorDetail | null;
	readonly fastapiValidation: boolean;
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
		this.type = init.type ?? null;
		this.param = init.param ?? null;
		this.detail = init.detail ?? null;
		this.fastapiValidation = init.fastapiValidation ?? false;
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
 * MinerU echoes the request back in some validation messages, so an untruncated
 * body could carry a filename, a page of document text, or a header value.
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

export interface ParsedMineruErrorBody {
	detail: MineruErrorDetail | null;
	/** True when FastAPI's `{detail:[…]}` 422 envelope was recognised. */
	fastapiValidation: boolean;
	excerpt: string;
}

/**
 * Reads a non-2xx body. Tries MinerU's envelope, then FastAPI's, then gives up
 * and keeps a truncated excerpt — an opaque body is still worth a message.
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
		return { detail: null, fastapiValidation: false, excerpt };
	}

	const envelope = mineruErrorResponseSchema.safeParse(parsed);
	if (envelope.success) {
		return {
			detail: envelope.data.error,
			fastapiValidation: false,
			excerpt,
		};
	}

	const validation = fastapiValidationErrorSchema.safeParse(parsed);
	if (validation.success) {
		const first = validation.data.detail[0];
		return {
			detail: {
				type: "invalid_request_error",
				code: null,
				message: first?.msg ?? "Request validation failed",
				param: first?.loc?.join(".") ?? null,
			},
			fastapiValidation: true,
			excerpt,
		};
	}

	return { detail: null, fastapiValidation: false, excerpt };
}

/**
 * Builds the error for a non-2xx response.
 *
 * `client.ts` calls this with an ALREADY SCRUBBED body, and `errors.test.ts`
 * calls it with the recorded probe bodies, so the test drives exactly the
 * production path rather than a paraphrase of it.
 */
export function mineruApiErrorFromBody(input: {
	status: number;
	bodyText: string;
	path?: string;
	retryAfterMs?: number | null;
	maxChars?: number;
}): MineruApiError {
	const parsed = parseMineruErrorBody(input.bodyText, input.maxChars);
	const summary =
		parsed.detail?.message || parsed.excerpt || `HTTP ${input.status}`;
	return new MineruApiError({
		message: `MinerU ${input.path ?? "request"} failed with ${input.status}: ${summary}`,
		status: input.status,
		code: parsed.detail?.code ?? "",
		type: parsed.detail?.type ?? null,
		param: parsed.detail?.param ?? null,
		detail: parsed.detail,
		fastapiValidation: parsed.fastapiValidation,
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
 *  - `recover-by-reupload`: the server forgot this id. Do NOT fail: re-`POST
 *    /v1/uploads` with the known sha256, take the new `file_id` and resubmit.
 */
export type MineruErrorDisposition = "fail" | "swallow" | "recover-by-reupload";

export interface MineruErrorMapping {
	/** The table row that matched. `"fallback:*"` means nothing did. */
	readonly rule: string;
	/** False when only a status-shaped fallback matched — the test asserts this. */
	readonly known: boolean;
	readonly taxonomy: ExtractionErrorCode;
	/** Overrides `RETRYABLE_EXTRACTION_ERROR_CODES` where they differ. */
	readonly retryable: boolean;
	/** The stored handle is poisonous; the ledger must clear it. */
	readonly handleUnknown: boolean;
	readonly disposition: MineruErrorDisposition;
	readonly retryAfterMs: number | null;
	/** One line, for a log or a review. Never user-facing prose. */
	readonly reason: string;
}

interface MineruErrorRule {
	rule: string;
	/** Matched against `MineruApiError.code`. */
	code?: string;
	status?: number | readonly number[];
	param?: string | readonly string[];
	message?: RegExp;
	taxonomy: ExtractionErrorCode;
	retryable: boolean;
	handleUnknown?: boolean;
	disposition?: MineruErrorDisposition;
	reason: string;
}

/**
 * Ordered: the first matching row wins. Order matters in exactly one place —
 * `Tier 'standard' not available in this server` is a 400 `invalid_request`
 * like a dozen others, and it must be read as `tier_unavailable` (a
 * misconfiguration an admin can fix) rather than as a protocol bug.
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
		reason: "the whole-job deadline elapsed; cancel the remote job first",
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
		reason: "the download did not match the promised byte count",
	},
	{
		rule: "client:download-too-large",
		code: MINERU_CLIENT_ERROR_CODES.downloadTooLarge,
		taxonomy: "protocol",
		retryable: true,
		reason: "the stream exceeded the size the job itself declared",
	},
	{
		rule: "client:missing-zip",
		code: MINERU_CLIENT_ERROR_CODES.missingZipOutput,
		taxonomy: "protocol",
		retryable: true,
		reason: "a terminal completed job without the zip we requested",
	},
	{
		rule: "client:tier-not-available",
		code: MINERU_CLIENT_ERROR_CODES.tierNotAvailable,
		taxonomy: "tier_unavailable",
		retryable: false,
		reason: "the desired tier is not offered; fail before any bytes move",
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
	{
		rule: "400:tier-not-available",
		code: "invalid_request",
		message: /not available in this server/i,
		taxonomy: "tier_unavailable",
		retryable: false,
		reason: "a misconfiguration, not an outage — never show it as one",
	},
	{
		rule: "503:quality_tier_unavailable",
		code: "quality_tier_unavailable",
		taxonomy: "tier_unavailable",
		retryable: false,
		reason: "PDF/image on a flash-only server; send tier:flash explicitly",
	},

	// -- request shape ------------------------------------------------------
	{
		rule: "403:feature_requires_api_key",
		code: "feature_requires_api_key",
		taxonomy: "protocol",
		retryable: false,
		reason:
			"never means 'add a key and retry' — with a key the code silently becomes unsupported_output_format",
	},
	{
		rule: "400:unsupported_output_format",
		code: "unsupported_output_format",
		taxonomy: "protocol",
		retryable: false,
		reason: "we asked for a format this server cannot produce",
	},
	{
		rule: "400:unsupported_source",
		code: "unsupported_source",
		taxonomy: "protocol",
		retryable: false,
		reason: "we only ever send file_id sources",
	},
	{
		rule: "400:page_range_invalid",
		code: "page_range_invalid",
		taxonomy: "protocol",
		retryable: false,
		reason: "unreachable — this client never sends page_range",
	},
	{
		rule: "404:model_not_found",
		code: "model_not_found",
		taxonomy: "protocol",
		retryable: false,
		reason: "we never name a model",
	},

	// -- uploads ------------------------------------------------------------
	{
		rule: "400:file_hash_mismatch",
		code: "file_hash_mismatch",
		taxonomy: "protocol",
		retryable: true,
		reason: "the PUT lost or corrupted bytes; re-PUT once",
	},
	{
		rule: "409:upload_not_ready",
		code: "upload_not_ready",
		taxonomy: "protocol",
		retryable: true,
		reason: "the bytes never landed; re-PUT them",
	},
	{
		rule: "413:upload_size_mismatch",
		code: "upload_size_mismatch",
		taxonomy: "protocol",
		retryable: true,
		reason: "undocumented upstream; the declared byte count did not match",
	},
	{
		rule: "409:upload_already_terminal",
		code: "upload_already_terminal",
		taxonomy: "protocol",
		retryable: false,
		disposition: "swallow",
		reason: "the upload is already gone, which is what we wanted",
	},
	{
		rule: "413:file_too_large",
		code: "file_too_large",
		taxonomy: "too_large",
		retryable: false,
		reason: "UNVERIFIED — never triggered by the spike",
	},

	// -- jobs ---------------------------------------------------------------
	{
		rule: "409:job_already_terminal",
		code: "job_already_terminal",
		taxonomy: "protocol",
		retryable: false,
		disposition: "swallow",
		reason: "cancelling a finished job: nothing to do",
	},
	{
		rule: "404:job_not_found",
		code: "job_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "restart recovery R1: the id is gone, the bytes are not",
	},
	{
		rule: "404:file_not_found",
		code: "file_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "restart recovery R4: re-upload by sha and resubmit",
	},
	{
		rule: "404:upload_not_found",
		code: "upload_not_found",
		taxonomy: "protocol",
		retryable: true,
		disposition: "recover-by-reupload",
		reason: "restart recovery R2: the upload id is gone",
	},
	{
		rule: "429:rate_limit_exceeded",
		code: "rate_limit_exceeded",
		taxonomy: "rate_limited",
		retryable: true,
		reason: "UNVERIFIED — honour Retry-After when present",
	},

	// -- file-level (deferred) failures ------------------------------------
	/**
	 * MinerU's permanent refusal, which looks exactly like a transient one.
	 *
	 * 4.0.4 answers AVIF, SVG and anything else its readers do not implement
	 * with a file-level `parse_failed` whose message is "Unsupported file type:
	 * <name>". Read as an ordinary `job_failed` it burned three attempts plus
	 * backoff and then offered a Retry that could never succeed — the most
	 * expensive possible way to tell a user their file cannot be read. It is
	 * matched on the message because the CODE is the generic one; the regex is
	 * anchored on the phrase rather than the filename so a renamed file or a
	 * different suffix still matches.
	 *
	 * Ordered before `file:parse_failed`, which is the catch-all for the same
	 * code.
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
	{
		rule: "file:unsupported_file_type",
		code: "unsupported_file_type",
		taxonomy: "unsupported_type",
		retryable: false,
		reason: "the same refusal, should a build ever give it a code of its own",
	},
	/**
	 * The document itself cannot be opened — a deterministic fact about these
	 * bytes, which 4.0.4 reports under the same generic `parse_failed`.
	 *
	 * MinerU loads PDFs through pypdfium2, whose one raise site is
	 * `_helpers/document.py`:
	 *
	 *     raise PdfiumError(f"Failed to load document (PDFium: {ErrorToStr.get(err_code)}).")
	 *
	 * reached both when PDFium refuses the file and when the loaded document has
	 * FEWER THAN ONE PAGE — which is why a corrupt PDF and a zero-page PDF, the
	 * two files the live test admitted, arrive wearing the same sentence. The
	 * `ErrorToStr` table (`internal/consts.py`) is the whole sibling family:
	 * "Data format error", "Incorrect password error", "Unsupported security
	 * scheme error", "File access error", "Page not found or content error",
	 * "Unknown error", "Success" (the zero-page case).
	 *
	 * Matched on the wording rather than the code, exactly as the
	 * `unsupported-type` rule above is, and anchored on the PHRASE so a renamed
	 * file cannot change the verdict. Read as an ordinary `job_failed` this
	 * burned the whole attempt budget re-parsing bytes that cannot parse.
	 *
	 * ORDER IS LOAD-BEARING TWICE. These sit before
	 * `file:parse_failed:missing-file`, because "Page not found or content
	 * error" contains "not found" and would otherwise be read as the server
	 * dropping an id; and the protection rule sits before the general one,
	 * because every PDFium reason arrives under "Failed to load document".
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
	{
		rule: "file:file_encrypted",
		code: "file_encrypted",
		taxonomy: "document_unreadable",
		retryable: false,
		reason: "4.0.4 registers this code; treat it as the locked document it is",
	},
	{
		rule: "file:parse_failed:unreadable-document",
		code: "parse_failed",
		message: /failed to load document|\bpdfium\b|data format error/i,
		taxonomy: "document_unreadable",
		retryable: false,
		reason:
			"the reader cannot open these bytes at all; a retry repeats the refusal",
	},
	{
		rule: "file:file_corrupted",
		code: "file_corrupted",
		taxonomy: "document_unreadable",
		retryable: false,
		reason: "4.0.4 registers this code; the bytes are damaged, not the server",
	},
	/**
	 * The parse SUCCEEDED and found nothing — which is a fact about the
	 * document, not about the server.
	 *
	 * 4.0.4 answers a scan with nothing legible on it, and a file whose pages
	 * are all empty, with `parse_empty` / "Parse completed but returned no
	 * pages". Unmapped, that fell through to the `job_failed` catch-all below
	 * and was RETRYABLE: three attempts plus backoff re-parsing bytes that
	 * cannot become text, and then a Retry button offered to the user that
	 * could never succeed.
	 *
	 * `empty_result` is the code the result parser already raises for exactly
	 * this outcome when it reads the zip itself (`result.ts`, "every block was
	 * a running head or empty"). The two paths reach the same verdict on
	 * purpose: `empty_result` is `{ autoRetry: "none", userRetryable: false }`
	 * in the shared status table, so neither the worker nor the user is
	 * invited to try again.
	 *
	 * Ordered before `file:parse_failed:missing-file`, whose /not found/ would
	 * otherwise swallow a message like "no pages found".
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
		rule: "file:parse_failed:missing-file",
		code: "parse_failed",
		message: /not found/i,
		taxonomy: "protocol",
		retryable: true,
		handleUnknown: true,
		reason:
			"the server is dropping ids under us; the stored handle is poisonous",
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
}): MineruErrorRule | null {
	if (!input.code) return null;
	for (const rule of MINERU_ERROR_RULES) {
		if (rule.code !== input.code) continue;
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

function fallbackForStatus(
	status: number | null,
	fastapiValidation: boolean,
): MineruErrorMapping {
	if (fastapiValidation || status === 422) {
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
 * Maps any throw from `client.ts` — or from `fetch` underneath it — onto the
 * taxonomy. Never throws.
 */
export function mapMineruError(error: unknown): MineruErrorMapping {
	if (isMineruApiError(error)) {
		const rule = findRule({
			code: error.code,
			status: error.status,
			param: error.param,
			message: error.detail?.message ?? error.message,
		});
		if (rule) return toMapping(rule, error.retryAfterMs);
		return {
			...fallbackForStatus(error.status, error.fastapiValidation),
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

	return fallbackForStatus(null, false);
}

/** `TypeError: fetch failed`, ECONNREFUSED, ENOTFOUND and friends. */
export function isTransportFailure(error: unknown): boolean {
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
 * The recovery is D7: re-upload by sha256 and take the new `file_id`; never
 * persist an id across a MinerU restart.
 */
export function isMineruForgottenIdError(error: unknown): boolean {
	return (
		isMineruApiError(error) &&
		(MINERU_FORGOTTEN_ID_CODES as readonly string[]).includes(error.code)
	);
}

// ---------------------------------------------------------------------------
// Deferred, file-level failures
// ---------------------------------------------------------------------------

export interface MineruJobFailureOptions {
	/** True when WE issued the DELETE; a cancel we asked for is not a failure. */
	canceledByUs?: boolean;
	/** The output format the caller needs present on a completed file. */
	requiredOutput?: keyof NonNullable<
		NonNullable<MineruJob["files"][number]["output_files"]>
	>;
}

/**
 * A terminal remote job is SPENT, whatever it failed on.
 *
 * `mapMineruJobFailure` is only ever reached with a job MinerU has already
 * settled, so every failure it returns is a final answer about that job id. Any
 * later attempt that resumed the id would issue one `GET` against a job that
 * cannot change its mind and fail again for the same reason — which is exactly
 * what a corrupt PDF did: three attempts, two of them `resumed: true` against
 * the same dead job, and then a Retry that resumed it a fourth time.
 *
 * So the handle is poisoned here, at the one place that knows the remote job is
 * finished. The ledger's `clearHandle` then makes the NEXT attempt — automatic,
 * user Retry, re-upload or re-extract alike — submit a fresh job. Re-uploading
 * costs nothing extra: `createUpload` deduplicates by sha256, so the bytes are
 * already there and the PUT is skipped.
 *
 * The cases that legitimately KEEP a handle never come through here: a lost
 * claim, a stale-worker reclaim, a shutdown and a transport error all leave the
 * remote job RUNNING, and resuming it is the whole reason the handle is emitted
 * before the first poll.
 */
function spent(mapping: MineruErrorMapping): MineruErrorMapping {
	return mapping.handleUnknown ? mapping : { ...mapping, handleUnknown: true };
}

/**
 * Reads a TERMINAL job and decides whether it actually succeeded.
 *
 * A `202` at create proves nothing and neither does `status: "completed"`: an
 * unknown `file_id` surfaces as a file-level `engine_error`/`parse_failed`, a
 * bad `page_range` as a file-level `page_range_invalid`, and a job can report
 * `completed` with `output_files.zip === null`. Returns `null` when the job is
 * genuinely usable.
 *
 * Every non-null return carries `handleUnknown: true`; see `spent` above.
 */
export function mapMineruJobFailure(
	job: MineruJob,
	options: MineruJobFailureOptions = {},
): MineruErrorMapping | null {
	const requiredOutput = options.requiredOutput ?? "zip";

	if (job.status === "canceled") {
		if (options.canceledByUs) return null;
		return spent({
			rule: "job:canceled-by-someone-else",
			known: true,
			taxonomy: "job_failed",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: "the job was canceled while we were not cancelling",
		});
	}

	const file = job.files[0] ?? null;
	const detail = file?.error ?? null;

	if (detail) {
		const rule = findRule({
			code: detail.code ?? null,
			status: null,
			param: detail.param ?? null,
			message: detail.message,
		});
		if (rule) return spent(toMapping(rule, null));
		return spent({
			rule: "job:file-error-unmapped",
			known: false,
			taxonomy: "job_failed",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: `unmapped file-level code ${detail.code ?? "(none)"}`,
		});
	}

	if (job.status === "failed" || job.status === "partial" || !file) {
		return spent({
			rule: "job:failed-without-detail",
			known: true,
			taxonomy: "job_failed",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: `job status ${job.status} with no file-level error`,
		});
	}

	if (file.status !== "completed") {
		return spent({
			rule: "job:file-not-completed",
			known: true,
			taxonomy: "job_failed",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: `file status ${file.status} on a terminal job`,
		});
	}

	if (!file.output_files?.[requiredOutput]) {
		return spent({
			rule: "job:missing-output",
			known: true,
			taxonomy: "protocol",
			retryable: true,
			handleUnknown: false,
			disposition: "fail",
			retryAfterMs: null,
			reason: `terminal completed job without output_files.${String(requiredOutput)}`,
		});
	}

	return null;
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
 * alone cannot: a `protocol` from a wrong sha is worth one more PUT, and a
 * `protocol` from an untrusted `upload_url` is not worth anything.
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

/** The rule ids, for a test that wants to prove the table is exhaustive. */
export function mineruErrorRuleIds(): readonly string[] {
	return MINERU_ERROR_RULES.map((rule) => rule.rule);
}

/** Every server-side `code` the table knows by name. */
export function mineruMappedErrorCodes(): readonly string[] {
	return [
		...new Set(
			MINERU_ERROR_RULES.map((rule) => rule.code).filter(
				(code): code is string => typeof code === "string",
			),
		),
	];
}
