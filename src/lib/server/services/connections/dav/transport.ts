// Provider-agnostic WebDAV/CalDAV/CardDAV request transport (B3). Two shapes,
// both built on providerFetch (B1) so the ~15s timeout + injectable-`fetch`
// test seam is shared rather than hand-rolled per provider:
//
//   - caldavRequest: the read-oriented PROPFIND/REPORT form that manually
//     follows 3xx redirects (re-sending the SAME method/body/Authorization at
//     each hop — this is the one chokepoint that copes with iCloud's
//     undocumented partition redirect) and expects a 207 multistatus body.
//   - caldavWriteRequest: the mutating PUT/DELETE sibling that follows the same
//     redirect dance but does NOT assume 207 — a write response is
//     200/201/204/404/410/412 with no XML body, so it returns the raw Response
//     and lets the caller interpret the status.
//
// Both were previously private to (and re-implemented across) providers/
// apple-caldav.ts and providers/apple-caldav-write.ts. Error branding is
// injectable (makeError / labels / timeoutError) so a caller keeps its own
// error type + exact wording — Apple throws AppleCalDavError, the generic
// connector wraps into CalDavError — while the transport logic lives once here.
import { ConnectionHttpError, providerFetch } from "../provider-http";

// Matches every WebDAV provider's User-Agent so read and write requests present
// the same identity to the server.
const USER_AGENT = "AlfyAI";

// Bounds how many 3xx hops a single request will follow — a real iCloud
// discovery/write is at most one redirect (well-known/collection -> partition
// host); this just guards against a misbehaving/looping server.
const MAX_REDIRECTS = 5;

// The two codes caldavRequest itself can raise. Callers with a broader error
// union (Apple's needs_reauth/invalid_config/..., the generic connector's) pass
// a makeError factory whose own constructor accepts this subset.
export type DavErrorCode = "invalid_credentials" | "request_failed";

// Default error type thrown by caldavRequest when a caller does not inject its
// own via `makeError`. The generic CalDAV connector catches this and re-wraps
// it into its own CalDavError; Apple injects a factory so an AppleCalDavError
// propagates directly.
export class DavError extends ConnectionHttpError<DavErrorCode> {
	constructor(message: string, code: DavErrorCode) {
		super(message, code);
		this.name = "DavError";
	}
}

// Lets a caller override the branding baked into caldavRequest's error
// messages/type without touching the transport logic. Every field defaults to
// generic ("CalDAV") wording + DavError, so a caller that passes nothing still
// gets sensible, provider-neutral errors.
export type CalDavRequestOptions = {
	requestLabel?: string;
	credentialsRejectedMessage?: string;
	makeError?: (message: string, code: DavErrorCode) => Error;
};

export async function caldavRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PROPFIND" | "REPORT",
	depth: "0" | "1",
	body: string,
	options: CalDavRequestOptions = {},
): Promise<{ xml: string; finalUrl: string }> {
	const requestLabel = options.requestLabel ?? "CalDAV";
	const credentialsRejectedMessage =
		options.credentialsRejectedMessage ?? "The server rejected the credentials";
	const makeError =
		options.makeError ?? ((message, code) => new DavError(message, code));

	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await providerFetch(currentUrl, {
			method,
			redirect: "manual",
			headers: {
				Authorization: auth,
				"Content-Type": "text/xml; charset=utf-8",
				Depth: depth,
				"User-Agent": USER_AGENT,
			},
			body,
			fetch: fetchImpl,
			timeoutError: (ms) =>
				makeError(
					`${requestLabel} request timed out after ${ms}ms`,
					"request_failed",
				),
		});

		if (response.status === 401) {
			throw makeError(credentialsRejectedMessage, "invalid_credentials");
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("Location");
			if (!location) {
				throw makeError(
					`${requestLabel} redirected without a Location header (status ${response.status})`,
					"request_failed",
				);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		if (response.status !== 207) {
			throw makeError(
				`${requestLabel} ${method} failed with status ${response.status}`,
				"request_failed",
			);
		}
		const xml = await response.text();
		return { xml, finalUrl: currentUrl };
	}
	throw makeError(
		`Too many redirects while talking to ${requestLabel}`,
		"request_failed",
	);
}

// The mandatory conditional header every CalDAV write carries — CalDAV has no
// server-enforced idempotent-create/optimistic-concurrency primitive beyond
// plain HTTP conditional requests:
//   - create -> `If-None-Match: *`   (only succeeds if nothing exists yet)
//   - update/delete -> `If-Match: {etag}` (only succeeds if unchanged)
export type ConditionalHeader =
	| { name: "If-None-Match"; value: "*" }
	| { name: "If-Match"; value: string };

export type CalDavWriteRequestOptions = {
	// Builds the error thrown on abort/timeout. Defaults to a plain Error with
	// generic wording; Apple's write executor injects its own so its existing
	// request_failed mapping is unchanged.
	timeoutError?: (ms: number) => Error;
	// Builds the error thrown on a redirect with no Location header / a redirect
	// loop. Defaults to a plain Error, matching the write executor's previous
	// hand-rolled behavior (any such throw is caught and mapped to
	// request_failed by the caller).
	makeError?: (message: string) => Error;
};

// Issues a PUT/DELETE with Basic auth and the caller's mandatory conditional
// header, manually following iCloud's undocumented partition redirect the same
// way caldavRequest does for PROPFIND/REPORT — but WITHOUT the "expect a 207
// multistatus body" assumption, which does not hold for a write response
// (200/201/204/404/410/412, no XML body). Returns the raw Response so the
// caller can interpret the status (a 412 is a conflict for update/delete but
// idempotent success for a create; a 404/410 DELETE is idempotent success).
export async function caldavWriteRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PUT" | "DELETE",
	conditional: ConditionalHeader,
	body?: string,
	options: CalDavWriteRequestOptions = {},
): Promise<Response> {
	const makeError = options.makeError ?? ((message) => new Error(message));
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await providerFetch(currentUrl, {
			method,
			redirect: "manual",
			headers: {
				Authorization: auth,
				"User-Agent": USER_AGENT,
				[conditional.name]: conditional.value,
				...(body !== undefined
					? { "Content-Type": "text/calendar; charset=utf-8" }
					: {}),
			},
			...(body !== undefined ? { body } : {}),
			fetch: fetchImpl,
			...(options.timeoutError ? { timeoutError: options.timeoutError } : {}),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("Location");
			if (!location) {
				throw makeError(
					`CalDAV write redirected without a Location header (status ${response.status})`,
				);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		return response;
	}
	throw makeError("Too many redirects while writing to CalDAV");
}
