/**
 * The shared session-expiry contract between the request gate and the browser.
 *
 * The gate lives in `src/hooks.server.ts`. For a page it answers an expired
 * session with a redirect to `/login`, which the browser follows by itself. An
 * API request cannot be told that way: `fetch` follows the 303 silently, the
 * public login route answers 200 with HTML, and the caller is handed a
 * "successful" response whose body is a web page rather than the JSON it asked
 * for. That is the exact shape of the bug this contract fixes — an expired
 * session made models, conversation lists and sends fail as parse errors or
 * empty state, with nothing on screen saying the session had ended.
 *
 * So the gate answers an API path with 401, this `code` in the body, and this
 * header on the response. The header is the discriminator every browser
 * transport keys on: it can be read without consuming the body, so one check
 * covers JSON endpoints, SSE streams and file downloads alike, and it can never
 * be confused with the other 401s in this app (a wrong password on the login
 * form, a wrong current password in Settings), which are about the credentials
 * just typed, not about the session being gone.
 */
export const SESSION_EXPIRED_CODE = "session_expired";

export const SESSION_EXPIRED_HEADER = "x-session-expired";

/**
 * The server's own English text, on the same footing as the other server-side
 * error strings in this app. The browser localizes from the `code` instead of
 * displaying this, and only falls back to it if the row ever fails to render.
 */
export const SESSION_EXPIRED_MESSAGE =
	"Your session has expired. Please sign in again.";

type SessionExpirySignal = {
	status: number;
	headers?: { get(name: string): string | null } | null;
};

/**
 * Whether a response is the gate saying "this session is gone".
 *
 * Reads defensively: this runs on every response the browser API layer sees,
 * including the hand-rolled `Response`-like fakes that the client tests inject,
 * which may carry no `headers` at all.
 */
export function isSessionExpiredResponse(
	response: SessionExpirySignal | null | undefined,
): boolean {
	if (!response || response.status !== 401) return false;
	const headers = response.headers;
	if (!headers || typeof headers.get !== "function") return false;
	return headers.get(SESSION_EXPIRED_HEADER) === "1";
}
