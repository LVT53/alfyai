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
 * perfectly good session. Bouncing the user to the login screen because they
 * mistyped their password in a confirmation dialog would be worse than the bug
 * this fixes.
 *
 * Every SESSION gate in the app, by contrast, says exactly "Unauthorized": the
 * hook's own `{"error":"Unauthorized"}`, the routes' `json({error:
 * "Unauthorized"})` / `createJsonErrorResponse("Unauthorized", 401)`, and
 * `requireApiUser`'s `error(401, "Unauthorized")` (which serializes as
 * `{"message":"Unauthorized"}` — `readErrorPayload` reads both keys). Matching
 * on that is deliberately conservative: if a gate ever stops saying it, the
 * caller still gets its `ApiError` and shows it, which is only ever today's
 * behaviour, never a spurious redirect.
 */
function isSessionExpiry(status: number, message: string): boolean {
	return status === 401 && message.trim().toLowerCase() === "unauthorized";
}

/**
 * The single in-flight navigation. Not a permanent latch: it is cleared when
 * the navigation settles, so signing in again re-arms the handling. Between
 * being set and settling it absorbs every other 401 — a page with a poller
 * running, an evidence fetch and a conversation refresh can produce a handful
 * at once, and they must produce ONE navigation.
 */
let pendingSessionExpiry: Promise<void> | null = null;

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
 * The loop defences, in order:
 *  - on the login page this does nothing, so the 401 that a wrong password
 *    produces never navigates;
 *  - `pendingSessionExpiry` collapses a burst into one navigation;
 *  - after it lands, `window.location.pathname` is already /login, so every
 *    later 401 — from a poller whose component has not torn down yet, from an
 *    in-flight request that resolves after the fact — is a no-op.
 * Background pollers therefore cannot cause a redirect storm even though they
 * go through this same path. The extraction poller additionally stops itself
 * for good on 401/403; that behaviour is unchanged and still wanted.
 *
 * `goto` is imported lazily so that merely importing this module does not pull
 * in SvelteKit's navigation runtime on the server or in a unit test.
 */
function noteSessionExpiry(status: number, message: string): void {
	if (!isSessionExpiry(status, message)) return;
	if (typeof window === "undefined") return;
	if (pendingSessionExpiry) return;
	if (window.location.pathname === LOGIN_PATH) return;

	pendingSessionExpiry = (async () => {
		const { goto } = await import("$app/navigation");
		await goto(LOGIN_PATH, { invalidateAll: true });
	})()
		.catch(() => {
			// No SPA router to hand this to (or it refused). A full load reaches
			// the login screen from anywhere and throws away the stale client
			// state on the way.
			window.location.assign(LOGIN_PATH);
		})
		.finally(() => {
			pendingSessionExpiry = null;
		});
}

/**
 * Report a 401 that did not come through this module's helpers. The streaming
 * client (`$lib/services/streaming.ts`) builds its own `fetch` and reads its
 * own error body, so it calls this to get the same one-navigation behaviour.
 */
export function reportAuthFailure(status: number, message: string): void {
	noteSessionExpiry(status, message);
}

function performRequest(
	fetchImpl: FetchLike,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<Response> {
	return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
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
 */
export async function readErrorPayload(
	response: Response,
	fallback: string,
): Promise<ErrorPayload> {
	const payload = await parseErrorPayload(response, fallback);
	noteSessionExpiry(response.status, payload.message);
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
	const response = await performRequest(fetchImpl, input, init);
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
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
}

export async function requestResponse(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: FetchLike = fetch,
): Promise<Response> {
	return performRequest(fetchImpl, input, init);
}

export async function requestText(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<string> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
	return response.text();
}
