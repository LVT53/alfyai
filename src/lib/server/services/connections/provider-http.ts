// Shared HTTP plumbing for the connection providers (B1).
//
// Every fetch-based provider (Immich, Google Calendar/People, GitHub,
// Nextcloud Files, OneDrive, Apple CalDAV, Plex, OwnTracks, …) used to
// hand-roll the exact same AbortController + setTimeout + AbortError→timeout
// + clearTimeout dance and its own `const REQUEST_TIMEOUT_MS = 15_000`. This
// module owns that plumbing once so the ~15s bound is uniform across every
// provider — including Plex's and OwnTracks's health checks, which previously
// called raw fetch with NO timeout wrapper at all.
//
// Every provider already threads an injectable `fetch` through its call sites
// (so tests run against mocked endpoints, never a live server); `providerFetch`
// keeps that seam via the `fetch` option.
//
// IMAP is deliberately NOT a client of this module: it speaks raw TCP via
// ImapFlow, not fetch, so there is no request/timeout shape here for it to
// share.

// ---------------------------------------------------------------------------
// Shared error base
// ---------------------------------------------------------------------------

// The common shape every provider error class already had: a message plus a
// `code` string. Each provider's named error (ImmichError, GitHubError, …)
// extends this base, keeping its own `name` and its own narrow `code` union
// (via the generic parameter) so every `err instanceof <Provider>Error` and
// `err.code === "…"` check in the routes and tests keeps working unchanged —
// while `err instanceof ConnectionHttpError` now unifies them all.
export class ConnectionHttpError<Code extends string = string> extends Error {
	constructor(
		message: string,
		public readonly code: Code,
	) {
		super(message);
		this.name = "ConnectionHttpError";
	}
}

// ---------------------------------------------------------------------------
// Auth-header helpers
// ---------------------------------------------------------------------------

// `Authorization: Bearer <token>` — the shape Google Calendar/People, Immich's
// login/key-mint, GitHub, and OneDrive all send.
export function bearerAuthHeader(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

// `x-api-key: <secret>` — Immich's authorized-request shape (its minted API
// key is sent this way, not as a Bearer).
export function apiKeyHeader(secret: string): Record<string, string> {
	return { "x-api-key": secret };
}

// `Authorization: Basic base64(user:password)` — CalDAV/CardDAV (Apple + the
// generic connector) and Nextcloud. Returns the header VALUE (not a
// `{ Authorization }` object) because its call sites pass the string around
// (e.g. re-sending the same auth across redirect hops). apple-caldav.ts
// re-exports this so its existing importers keep importing it from there.
export function basicAuthHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// providerFetch
// ---------------------------------------------------------------------------

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type ProviderFetchInit = RequestInit & {
	// Injectable fetch (defaults to the global) — the test seam every provider
	// relies on. Providers pass their own `fetchImpl`.
	fetch?: typeof fetch;
	// Overridable per-request timeout; defaults to ~15s.
	timeoutMs?: number;
	// Builds the error thrown on abort/timeout. Providers pass a factory that
	// returns their own error type + exact message wording (some throw a plain
	// Error, the read providers throw their <Provider>Error). When omitted, a
	// generic request_failed ConnectionHttpError is thrown.
	timeoutError?: (timeoutMs: number) => Error;
};

// Bounds a single HTTP call to `timeoutMs` via an AbortController so a
// reachable-but-hung server can't stall a chat turn (or a connect flow)
// indefinitely. The AbortError raised when the timer fires is mapped to the
// caller's timeout error; any other rejection (an ordinary network failure)
// propagates unchanged. The timer is always cleared in `finally`.
export async function providerFetch(
	url: string,
	init: ProviderFetchInit = {},
): Promise<Response> {
	const {
		fetch: fetchImpl = fetch,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
		timeoutError,
		...requestInit
	} = init;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...requestInit, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw timeoutError
				? timeoutError(timeoutMs)
				: new ConnectionHttpError(
						`Request timed out after ${timeoutMs}ms`,
						"request_failed",
					);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
