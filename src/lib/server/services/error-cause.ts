// E1 — the cause -> code seam (ADR-0025 amendment).
//
// Before this module, "should we retry / what stream error code should we
// show" was decided independently in four places, each re-deriving its own
// substring/prose classifier over `error.message`:
//   - normal-chat-model/failover.ts (isNonRetryableFallbackMessage and
//     friends) — worst offender: matched raw prose for "prompt"/"abort",
//     which can appear in a completely unrelated error message (or even
//     echo user-authored text) and misclassify a retryable failure as
//     terminal, or vice versa.
//   - chat-turn/stream-fallback-policy.ts (shouldFallbackToNonStreaming) —
//     its own "is this abort/timeout/network-ish" text scan.
//   - chat-turn/stream.ts (classifyStreamError) — its own "timeout vs
//     network vs backend_failure" text scan for the user-facing
//     `data-stream-error` code.
//   - normal-chat-model/provider-compatibility.ts
//     (classifyOpenAICompatibleProviderError) — falls back to yet another
//     copy of the same retryable/non-retryable term lists when the
//     provider's structured `type`/`code` doesn't match a known term.
//
// This module extracts *structured* signals first (AI SDK error classes,
// HTTP status codes, `.name`, `cause` chains) and only falls back to a
// single, narrow, shared vocabulary of technical transport/protocol terms —
// never words ("prompt", "abort", "schema", ...) that could plausibly
// appear as a substring of unrelated prose. The four sites above now
// delegate here instead of re-deriving their own classification.
import {
	AISDKError,
	APICallError,
	InvalidPromptError,
	LoadAPIKeyError,
} from "ai";

export type ErrorCause =
	| "abort"
	| "timeout"
	| "rate_limit"
	| "network"
	| "auth"
	| "invalid_request"
	| "provider_unavailable"
	| "premature_completion"
	| "provider_error"
	| "unknown";

type CauseLikeError = {
	name?: unknown;
	message?: unknown;
	code?: unknown;
	statusCode?: unknown;
	status?: unknown;
	cause?: unknown;
};

function asCauseLike(error: unknown): CauseLikeError | null {
	return error && typeof error === "object" ? (error as CauseLikeError) : null;
}

/**
 * Structured (never substring-on-prose) abort detection. Replaces every
 * `error.message.toLowerCase().includes("abort")` call on the chat/stream
 * path — those matched the *text* of an error message, which can coincide
 * with unrelated content. `AbortError` is a standard DOM/Node error name set
 * by the runtime when an AbortController fires; it is never derived from
 * message text.
 */
export function isAbortErrorCause(
	error: unknown,
	seen = new Set<unknown>(),
): boolean {
	if (!error || seen.has(error)) return false;
	seen.add(error);
	const record = asCauseLike(error);
	if (!record) return false;
	if (record.name === "AbortError") return true;
	return isAbortErrorCause(record.cause, seen);
}

/**
 * Structured HTTP status-code extraction, walking the `cause` chain. Shared
 * by every call site that previously re-implemented this lookup locally.
 */
export function readErrorHttpStatus(
	error: unknown,
	seen = new Set<unknown>(),
): number | null {
	if (!error || seen.has(error)) return null;
	seen.add(error);
	const record = asCauseLike(error);
	if (!record) return null;
	if (typeof record.statusCode === "number") return record.statusCode;
	if (typeof record.status === "number") return record.status;
	return readErrorHttpStatus(record.cause, seen);
}

function isInvalidPromptErrorCause(
	error: unknown,
	seen = new Set<unknown>(),
): boolean {
	if (!error || seen.has(error)) return false;
	seen.add(error);
	if (InvalidPromptError.isInstance(error)) return true;
	const record = asCauseLike(error);
	if (!record) return false;
	return isInvalidPromptErrorCause(record.cause, seen);
}

function isApiKeyErrorCause(
	error: unknown,
	seen = new Set<unknown>(),
): boolean {
	if (!error || seen.has(error)) return false;
	seen.add(error);
	if (LoadAPIKeyError.isInstance(error)) return true;
	const record = asCauseLike(error);
	if (!record) return false;
	return isApiKeyErrorCause(record.cause, seen);
}

function readRetryableHint(error: unknown): boolean | null {
	if (APICallError.isInstance(error)) return error.isRetryable;
	return null;
}

function errorMessageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const record = asCauseLike(error);
	if (record && typeof record.message === "string") return record.message;
	return "";
}

// Narrow, technical-term fallback used only when nothing structured is
// available (a bare `Error(message)` from Node/undici/a provider SDK that
// sets neither `name`, `statusCode`, nor a recognizable AI SDK error class).
// Deliberately excludes "prompt" and "abort" — those are handled above via
// structured checks — and any other word plausible in ordinary prose.
const TIMEOUT_TERMS = [
	"timed out",
	"timeout",
	"apitimeouterror",
	"readtimeout",
	"read timeout",
];
const RATE_LIMIT_TERMS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
];
const NETWORK_TERMS = [
	"econnreset",
	"econnrefused",
	"eai_again",
	"enotfound",
	"fetch failed",
	"socket hang up",
	"socket",
	"network error",
	"connect",
	"connect_tcp",
	"connect tcp",
	"terminated",
];
const PROVIDER_UNAVAILABLE_TERMS = [
	"temporarily unavailable",
	"service unavailable",
	"overloaded",
	"overload",
	"internal server error",
	"server error",
];
const PREMATURE_COMPLETION_TERMS = [
	"premature",
	"before any output",
	"before usable assistant answer",
	"stream ended unexpectedly",
	"stream closed unexpectedly",
];
const AUTH_TERMS = [
	"invalid api key",
	"authentication",
	"unauthorized",
	"forbidden",
];
const INVALID_REQUEST_TERMS = [
	"schema",
	"response_format",
	"refusal",
	"content policy",
	"context length",
];

function includesAny(message: string, terms: string[]): boolean {
	return terms.some((term) => message.includes(term));
}

/**
 * The canonical cause -> code seam. Structured signals (AI SDK error
 * classes, HTTP status, `.name`) are checked first; a shared, narrow set of
 * technical terms is used only as a last resort for bare `Error(message)`
 * values that carry no other signal.
 */
export function classifyErrorCause(error: unknown): ErrorCause {
	if (isAbortErrorCause(error)) return "abort";
	if (isInvalidPromptErrorCause(error)) return "invalid_request";
	if (isApiKeyErrorCause(error)) return "auth";

	const httpStatus = readErrorHttpStatus(error);
	if (httpStatus !== null) {
		if (httpStatus === 401 || httpStatus === 403) return "auth";
		if (httpStatus === 429) return "rate_limit";
		if (httpStatus >= 500) return "provider_unavailable";
		if (httpStatus === 400 || httpStatus === 422) return "invalid_request";
	}

	const retryableHint = readRetryableHint(error);

	const message = errorMessageOf(error).toLowerCase();
	if (message) {
		if (includesAny(message, TIMEOUT_TERMS)) return "timeout";
		if (includesAny(message, RATE_LIMIT_TERMS)) return "rate_limit";
		if (includesAny(message, NETWORK_TERMS)) return "network";
		if (includesAny(message, PROVIDER_UNAVAILABLE_TERMS))
			return "provider_unavailable";
		if (includesAny(message, PREMATURE_COMPLETION_TERMS))
			return "premature_completion";
		if (includesAny(message, AUTH_TERMS)) return "auth";
		if (includesAny(message, INVALID_REQUEST_TERMS)) return "invalid_request";
	}

	if (retryableHint === true) return "provider_unavailable";
	if (retryableHint === false) return "provider_error";
	if (httpStatus !== null) return "provider_error";
	if (AISDKError.isInstance(error)) return "provider_error";

	return "unknown";
}

/**
 * Default retryability for a cause, used by call sites that have no extra
 * provider-adapter context. `"unknown"`/`"provider_error"` default to
 * non-retryable — a cause we cannot positively identify as transient should
 * not be retried blindly.
 */
export function isRetryableErrorCause(cause: ErrorCause): boolean {
	switch (cause) {
		case "timeout":
		case "rate_limit":
		case "network":
		case "provider_unavailable":
		case "premature_completion":
			return true;
		case "abort":
		case "auth":
		case "invalid_request":
		case "provider_error":
		case "unknown":
			return false;
	}
}

/**
 * A cause definitively identified as a permanent/terminal failure — worth
 * short-circuiting a retry decision on immediately, ahead of any
 * provider-adapter or HTTP-status classification. Deliberately narrower than
 * `!isRetryableErrorCause(cause)`: "provider_error"/"unknown" are *not*
 * retryable by default, but they are not definitively terminal either, so
 * callers should let other structured signals (HTTP status, adapter
 * classification) have a say before giving up on them.
 */
export function isTerminalErrorCause(cause: ErrorCause): boolean {
	return cause === "abort" || cause === "auth" || cause === "invalid_request";
}
