/**
 * The two address rules a board holds to, declared once. Zod only (no import of
 * a component or of the server), because three readers must agree to the byte:
 * the block schemas that judge a stored board and a model's change
 * (`canvas-blocks.ts`), the listing that offers what the chat has, and the block
 * that finally draws the address.
 *
 * Why the rules are this strict. A board is the one place a model can write an
 * address the browser will use on its own: an `<img>` is a request nobody
 * clicked. An address from outside the app would let whatever wrote the board
 * send the page's contents to a stranger in the query string, and even an
 * address of the app's own would make the browser call any route of the app
 * with the reader's cookies. So a photo is exactly one of the app's thumbnail
 * proxies and nothing else, and it is checked by the shape of the whole string:
 * "starts with one slash" is not enough, because a URL parser reads a backslash
 * as a slash and drops tabs and line breaks, which turns `/\evil.example` and
 * `/<TAB>/evil.example` into another origin.
 */

/**
 * The Immich thumbnail proxy (`/api/connections/immich/thumbnail/[assetId]`): an
 * asset id is one safe path segment (the route's own rule, a UUID in production),
 * and the connection, when there is one, is the route's one query parameter.
 * Nothing else: no fragment, no second parameter, no dot, slash or backslash.
 */
const PHOTO_PROXY_PATH =
	/^\/api\/connections\/immich\/thumbnail\/[A-Za-z0-9_-]{1,200}(?:\?connectionId=[A-Za-z0-9_.~%-]{1,300})?$/;

const PHOTO_PATH_MAX_CHARS = 2_000;

/** Whether this is one of the app's own thumbnail addresses: the only image a board loads. */
export function isPhotoProxyPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= PHOTO_PATH_MAX_CHARS &&
		PHOTO_PROXY_PATH.test(value)
	);
}

const SOURCE_URL_MAX_CHARS = 2_000;

// A run of anything a reader could not have typed into an address bar as it
// stands: spaces, control characters and the DEL that follows them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const UNSAFE_URL_CHARACTER = /[\s\u0000-\u001f\u007f]/;

/**
 * Whether this is a web address a source may link to: http or https, a host, and
 * nothing a reader could not have typed. A `javascript:` or `data:` link, a
 * scheme-relative or a relative one, an address with a space or a line break in
 * it — each would be a link that does something other than open a page.
 */
export function isHttpSourceUrl(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > SOURCE_URL_MAX_CHARS ||
		!/^https?:\/\//i.test(value) ||
		UNSAFE_URL_CHARACTER.test(value)
	) {
		return false;
	}
	try {
		const parsed = new URL(value);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			parsed.hostname.length > 0
		);
	} catch {
		return false;
	}
}
