import { isSessionExpiredResponse } from "$lib/session-expiry";
import {
	markSessionExpired,
	observeSessionFromResponse,
} from "$lib/stores/session";

export type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export class ApiError extends Error {
	readonly code?: string;
	readonly errorKey?: string;
	readonly fieldErrors?: Record<string, string>;
	/**
	 * The endpoint's `details` object, verbatim and unvalidated. Endpoints use
	 * it to carry the values their `errorKey` interpolates (`fileName`,
	 * `extension`) and the state the client should adopt (`maxFileUploadSize`
	 * on a 413). Optional and untyped on purpose: every reader narrows the one
	 * field it wants, so an endpoint may add a field without touching this.
	 */
	readonly details?: Record<string, unknown>;
	/**
	 * The send gate's per-attachment rows, verbatim off the 422 body. The
	 * streaming client already carries them on its error so the composer can
	 * render a translated sentence per file instead of echoing the server's
	 * English; `/api/chat/send` answers the same body, so the non-streaming
	 * Atlas path has to carry them too or the same refusal reads differently
	 * depending on which client made the request. Left untyped here for the
	 * same reason as `details`: the one reader
	 * (`chat/[conversationId]/_helpers.ts`) validates it structurally.
	 */
	readonly attachmentExtraction?: unknown;
	/**
	 * The readiness half of the same 422, carried for the same reason and
	 * validated by the same reader.
	 *
	 * `attachmentExtraction` explains a file the extraction ledger is still
	 * working on; `attachmentReadiness` explains the ones the ledger has
	 * nothing to say about — a deleted file, a non-document, an image with no
	 * text — and those are exactly the refusals whose server sentence is
	 * English prose. `toFriendlySendError` has read this field since the reason
	 * codes landed, but only `streaming.ts` ever attached it, so the identical
	 * refusal read Hungarian on the stream and English on `/api/chat/send`.
	 */
	readonly attachmentReadiness?: unknown;
	readonly status: number;

	constructor(
		message: string,
		options: {
			code?: string;
			errorKey?: string;
			fieldErrors?: Record<string, string>;
			details?: Record<string, unknown>;
			attachmentExtraction?: unknown;
			attachmentReadiness?: unknown;
			status: number;
		},
	) {
		super(message);
		this.name = "ApiError";
		this.code = options.code;
		this.errorKey = options.errorKey;
		this.fieldErrors = options.fieldErrors;
		this.details = options.details;
		this.attachmentExtraction = options.attachmentExtraction;
		this.attachmentReadiness = options.attachmentReadiness;
		this.status = options.status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const LOGIN_PATH = "/login";

/**
 * Does this 401 mean "your session is gone", or "this endpoint refused this
 * particular request"?
 *
 * The distinction is not academic. `/api/auth/login` answers 401 with "Invalid
 * email or password", and the settings routes that re-ask for the password
 * before a destructive action answer 401 with "Incorrect password" — inside a
 * perfectly good session. Raising the "you have been signed out" row because
 * the user mistyped their password in a confirmation dialog would be worse
 * than the bug this fixes.
 *
 * Two signals say "session", and either one is enough:
 *
 *  - `x-session-expired: 1`, which the request gate in `hooks.server.ts` puts
 *    on its own refusal. This is the primary discriminator: it is readable
 *    without consuming the body, so the same check works for a JSON endpoint,
 *    an SSE stream and the download probe, and a credential 401 can never
 *    carry it by accident.
 *  - the message "Unauthorized" — what every session gate INSIDE a route says:
 *    `json({error: "Unauthorized"})`, `createJsonErrorResponse("Unauthorized",
 *    401)` and `requireApiUser`'s `error(401, "Unauthorized")` (which
 *    serializes as `{"message":"Unauthorized"}` — `readErrorPayload` reads both
 *    keys). Those refusals never reach the hook, so they have no header to
 *    carry; matching the word keeps them covered.
 *
 * Deliberately conservative in both directions: an unrecognised 401 is still
 * surfaced as an `ApiError` and shown, which is only ever the old behaviour.
 */
function isSessionExpiry(
	status: number,
	message: string,
	response?: SessionSignal | null,
): boolean {
	if (status !== 401) return false;
	if (isSessionExpiredResponse(response)) return true;
	return message.trim().toLowerCase() === "unauthorized";
}

/**
 * Just enough of a `Response` for the header check. Loose on purpose: the
 * hand-rolled fakes in the client tests may carry no `headers` at all.
 */
type SessionSignal = {
	status: number;
	headers?: { get(name: string): string | null } | null;
};

/**
 * The app's one reaction to an expired session.
 *
 * Nothing used to notice. The server hook answered every unauthenticated
 * request — API calls included — with a 303 to /login, `fetch` followed it, and
 * the client was handed a 200 and an HTML page; `requestJson` then failed to
 * parse it and threw a plain `Error` with no status, so even the one 401 guard
 * that existed (the extraction poller's) never fired. Now that the hook answers
 * 401, this is where the client acts on it.
 *
 * The reaction is to raise the shell's signed-out row, NOT to navigate. Yanking
 * the tab to /login the moment a background poller is refused would throw away
 * whatever the user was in the middle of — a half-written message, an open
 * document — for a condition that another tab signing in can heal on its own.
 * The row says what happened and offers the way back; `markSessionExpired` is
 * idempotent for the row and throttles the announcement, so a burst of refused
 * calls is one row and one toast rather than a storm.
 *
 * `observed()` below already reports every response the helpers see, header and
 * all. This path exists for the second signal — a route's own "Unauthorized",
 * which has no header — and for the callers that read an error body themselves.
 *
 * On /login there is no shell and so no row, and a wrong password there must
 * not leave a verdict behind for the page the user lands on next.
 */
function noteSessionExpiry(
	status: number,
	message: string,
	response?: SessionSignal | null,
): void {
	if (!isSessionExpiry(status, message, response)) return;
	if (typeof window === "undefined") return;
	if (window.location.pathname === LOGIN_PATH) return;
	markSessionExpired();
}

/**
 * Report a 401 that did not come through this module's helpers. The streaming
 * client (`$lib/services/streaming.ts`) builds its own `fetch` and reads its
 * own error body, so it calls this to reach the same verdict. Pass the response
 * when there is one, so the gate's header is read rather than only its message.
 */
export function reportAuthFailure(
	status: number,
	message: string,
	response?: SessionSignal | null,
): void {
	noteSessionExpiry(status, message, response);
}

function performRequest(
	fetchImpl: FetchLike,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<Response> {
	return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
}

/**
 * Report what the response says about this tab's session, and hand it straight
 * back. Called by each helper below on a response it has already awaited —
 * deliberately not folded into `performRequest`, because turning that into an
 * `async` function (or chaining a `.then` onto it) would put an extra microtask
 * between `fetch` resolving and the caller seeing it. Component code that
 * renders after one `await tick()` is sensitive to exactly that.
 */
function observed(response: Response): Response {
	observeSessionFromResponse(response);
	return response;
}

async function throwRequestError(
	response: Response,
	errorMessage: string,
): Promise<never> {
	const error = await readErrorPayload(response, errorMessage);
	throw new ApiError(error.message, {
		code: error.code,
		errorKey: error.errorKey,
		fieldErrors: error.fieldErrors,
		details: error.details,
		attachmentExtraction: error.attachmentExtraction,
		attachmentReadiness: error.attachmentReadiness,
		status: response.status,
	});
}

type ErrorPayload = {
	message: string;
	code?: string;
	errorKey?: string;
	fieldErrors?: Record<string, string>;
	details?: Record<string, unknown>;
	attachmentExtraction?: unknown;
	attachmentReadiness?: unknown;
};

/**
 * The one place every failed response is read.
 *
 * `requestJson` / `requestVoid` / `requestText` reach it through
 * `throwRequestError`, and the three `requestResponse` callers that build their
 * own errors call it directly — so noticing an expired session here covers
 * every interactive API call the app makes, without a branch in each helper.
 * The two raw-`fetch` call sites that bypass the helpers entirely
 * (`preview-runtime`, `DocumentsList`) call it for the same reason.
 *
 * The response goes in alongside the message: the gate's header is the
 * discriminator, and a caller that reached here with a raw `fetch` has had no
 * other chance to report it.
 */
export async function readErrorPayload(
	response: Response,
	fallback: string,
): Promise<ErrorPayload> {
	const payload = await parseErrorPayload(response, fallback);
	noteSessionExpiry(response.status, payload.message, response);
	return payload;
}

async function parseErrorPayload(
	response: Response,
	fallback: string,
): Promise<ErrorPayload> {
	const text = await response.text().catch(() => "");
	if (!text) return { message: fallback };

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const message = parsed.error ?? parsed.message;
			const code =
				typeof parsed.code === "string" && parsed.code.trim()
					? parsed.code
					: undefined;
			const errorKey =
				typeof parsed.errorKey === "string" && parsed.errorKey.trim()
					? parsed.errorKey
					: undefined;
			const fieldErrors = isRecord(parsed.fieldErrors)
				? Object.fromEntries(
						Object.entries(parsed.fieldErrors).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string",
						),
					)
				: undefined;
			const details = isRecord(parsed.details) ? parsed.details : undefined;
			const attachmentExtraction = Array.isArray(parsed.attachmentExtraction)
				? parsed.attachmentExtraction
				: undefined;
			// Shallow, like its sibling: the one reader validates each row.
			const attachmentReadiness = Array.isArray(parsed.attachmentReadiness)
				? parsed.attachmentReadiness
				: undefined;
			if (typeof message === "string" && message.trim()) {
				return {
					message,
					code,
					errorKey,
					fieldErrors,
					details,
					attachmentExtraction,
					attachmentReadiness,
				};
			}
			if (
				code ||
				errorKey ||
				fieldErrors ||
				details ||
				attachmentExtraction ||
				attachmentReadiness
			)
				return {
					message: fallback,
					code,
					errorKey,
					fieldErrors,
					details,
					attachmentExtraction,
					attachmentReadiness,
				};
		}
	} catch {
		// Fall back to raw text below.
	}

	return { message: text.trim() || fallback };
}

export async function requestJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<T> {
	const response = observed(await performRequest(fetchImpl, input, init));
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new Error(
			"Received an invalid response from the server. Please try again.",
		);
	}
}

export async function requestVoid(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	const response = observed(await performRequest(fetchImpl, input, init));
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
}

export async function requestResponse(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: FetchLike = fetch,
): Promise<Response> {
	return observed(await performRequest(fetchImpl, input, init));
}

export async function requestText(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<string> {
	const response = observed(await performRequest(fetchImpl, input, init));
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
	return response.text();
}
