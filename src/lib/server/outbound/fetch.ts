// A `fetch` for addresses nobody on this server's side chose: a host a model
// wrote into a reply, a page a search returned, an image address in a document
// a user pasted. It reaches the public internet and nothing else.
//
// What `fetch` cannot do and this does:
//
//  - It judges the ADDRESS, not the text. The name is resolved here, every
//    answer must be public (`isPublicAddress`), and the socket then connects to
//    the answers that were checked, through the `lookup` hook of `node:https`.
//    There is no second resolution between the check and the connection, so a
//    name that answers "public" to the check and "127.0.0.1" to the connect
//    (DNS rebinding) gets nothing. An IP literal in the URL never reaches a
//    lookup at all (the socket takes it as it is), so it is judged up front.
//  - Redirects are never followed. A 3xx comes back as a response and the
//    caller decides, through this same function, so every hop is checked like
//    a first request.
//  - One timeout for the whole exchange, a byte cap that is enforced while the
//    body arrives (a missing or false Content-Length buys nothing), no cookies,
//    no credentials, no compression, and a connection per request.
//
// It speaks https only. Nothing here sends a header the caller did not name
// beyond the few that make a request a request.

import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPublicAddress, isReservedHostname } from "./public-address";

export type OutboundFailureCode =
	/** Not an absolute https URL, or it carries credentials. */
	| "bad_url"
	| "blocked_scheme"
	/** A name that can only mean somebody's private network (`*.internal`, `localhost`). */
	| "blocked_host"
	/** An IP literal, or an address a name resolved to, that is not public. */
	| "blocked_address"
	| "dns_failed"
	| "timeout"
	| "aborted"
	| "too_large"
	| "network";

/** What went wrong, and never where: the message carries no host and no address. */
export class OutboundFetchError extends Error {
	readonly code: OutboundFailureCode;

	constructor(code: OutboundFailureCode, options?: ErrorOptions) {
		super(`outbound fetch failed: ${code}`, options);
		this.name = "OutboundFetchError";
		this.code = code;
	}
}

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

/** Name to every address it answers with. Injectable so tests never touch DNS. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The part of `fetch` this module honours. A real `fetch` is assignable to it. */
export interface OutboundFetchInit {
	/** Only `accept`, `accept-language` and `user-agent` are sent. */
	headers?: HeadersInit;
	signal?: AbortSignal | null;
	/** Always manual: a redirect is returned, never followed. */
	redirect?: "manual";
}

export type OutboundFetch = (
	input: string | URL,
	init?: OutboundFetchInit,
) => Promise<Response>;

export interface OutboundFetchOptions {
	/** The whole exchange: connect, headers and body. Default 8 s. */
	timeoutMs?: number;
	/** The body, counted as it arrives. Default 2 MiB. */
	maxBytes?: number;
}

export interface OutboundFetchDeps {
	resolve?: HostResolver;
	/** The transport; tests substitute it. Production always uses `node:https`. */
	request?: typeof httpsRequest;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** More answers than this are not a name anybody serves a favicon from. */
const MAX_ADDRESSES = 16;
const FORWARDED_HEADERS = ["accept", "accept-language", "user-agent"];
const DEFAULT_USER_AGENT = "AlfyAI/2.0";

type UrlVerdict =
	| { ok: true; url: URL }
	| {
			ok: false;
			code: Extract<
				OutboundFailureCode,
				"bad_url" | "blocked_scheme" | "blocked_host" | "blocked_address"
			>;
	  };

/**
 * Whether a URL may be requested at all, judged without the network: an https
 * URL with no credentials whose host is neither an address that is not public
 * nor a name that can only be somebody's private network. A host name still
 * has to survive the resolution that `createOutboundFetch` makes when it
 * connects; this is the part that can be answered up front, and the answer a
 * caller that is handed some other `fetch` (a test double) can ask for.
 */
export function assessOutboundUrl(raw: string | URL): UrlVerdict {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, code: "bad_url" };
	}
	if (url.protocol !== "https:") return { ok: false, code: "blocked_scheme" };
	if (url.username !== "" || url.password !== "") {
		return { ok: false, code: "bad_url" };
	}
	// `new URL` has already turned `0x7f.1`, `2130706433` and `[::FFFF:127.0.0.1]`
	// into the one canonical form of the address they name.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "") return { ok: false, code: "bad_url" };
	if (isIP(host) !== 0) {
		return isPublicAddress(host)
			? { ok: true, url }
			: { ok: false, code: "blocked_address" };
	}
	if (isReservedHostname(host)) return { ok: false, code: "blocked_host" };
	return { ok: true, url };
}

const resolveWithOperatingSystem: HostResolver = async (hostname) => {
	const answers = await dnsLookup(hostname, { all: true, order: "verbatim" });
	return answers.map(({ address }) => ({
		address,
		family: isIP(address) === 6 ? 6 : 4,
	}));
};

/**
 * The `lookup` hook of `net.connect`: resolve, refuse the connection if ANY
 * answer is not public, otherwise hand back exactly the answers that passed.
 * Node asks for the whole list (`all`) when it races address families and for
 * one address otherwise; both shapes are answered.
 */
function createGuardedLookup(resolve: HostResolver): LookupFunction {
	return (hostname, options, callback) => {
		const refuse = (code: OutboundFailureCode, cause?: unknown): void =>
			callback(new OutboundFetchError(code, { cause }), "");
		resolve(hostname).then(
			(answers) => {
				if (answers.length === 0) return refuse("dns_failed");
				if (!answers.every(({ address }) => isPublicAddress(address))) {
					return refuse("blocked_address");
				}
				const family =
					options.family === 4 || options.family === "IPv4"
						? 4
						: options.family === 6 || options.family === "IPv6"
							? 6
							: 0;
				const usable = answers
					.filter((answer) => family === 0 || answer.family === family)
					.slice(0, MAX_ADDRESSES);
				if (usable.length === 0) return refuse("dns_failed");
				if (options.all) return callback(null, usable);
				return callback(null, usable[0].address, usable[0].family);
			},
			(error: unknown) => {
				if (error instanceof OutboundFetchError) callback(error, "");
				else refuse("dns_failed", error);
			},
		);
	};
}

function forwardedHeaders(
	init: HeadersInit | undefined,
): Record<string, string> {
	const given = new Headers(init);
	const sent: Record<string, string> = {
		// Compressed bodies would have to be inflated before the byte cap means
		// anything, and a favicon or a picture has nothing to gain from it.
		"accept-encoding": "identity",
		"user-agent": DEFAULT_USER_AGENT,
	};
	for (const name of FORWARDED_HEADERS) {
		const value = given.get(name);
		if (value !== null) sent[name] = value;
	}
	return sent;
}

function toResponse(message: IncomingMessage, body: Buffer): Response {
	const headers = new Headers();
	for (const [name, value] of Object.entries(message.headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const status = message.statusCode ?? 0;
	const hasNoBody = status === 204 || status === 205 || status === 304;
	return new Response(hasNoBody ? null : new Uint8Array(body), {
		status,
		statusText: message.statusMessage,
		headers,
	});
}

/**
 * Builds a `fetch` that connects to the public internet only. Each call is one
 * GET, with its own connection and its own resolution.
 */
export function createOutboundFetch(
	deps: OutboundFetchDeps = {},
	options: OutboundFetchOptions = {},
): OutboundFetch {
	const request = deps.request ?? httpsRequest;
	const lookup = createGuardedLookup(
		deps.resolve ?? resolveWithOperatingSystem,
	);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	return (input, init = {}) => {
		const verdict = assessOutboundUrl(input);
		if (!verdict.ok) {
			return Promise.reject(new OutboundFetchError(verdict.code));
		}
		const { url } = verdict;

		const deadline = AbortSignal.timeout(timeoutMs);
		const signal = init.signal
			? AbortSignal.any([init.signal, deadline])
			: deadline;

		return new Promise<Response>((resolve, reject) => {
			const fail = (error: unknown): void => {
				if (error instanceof OutboundFetchError) reject(error);
				else if (deadline.aborted) reject(new OutboundFetchError("timeout"));
				else if (signal.aborted) reject(new OutboundFetchError("aborted"));
				else reject(new OutboundFetchError("network", { cause: error }));
			};

			const requestOptions: RequestOptions = {
				protocol: "https:",
				hostname: url.hostname.replace(/^\[|\]$/g, ""),
				port: url.port === "" ? 443 : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: forwardedHeaders(init.headers),
				// A connection of its own: nothing pooled survives to the next
				// request's resolution.
				agent: false,
				lookup,
				signal,
			};

			let outgoing: ReturnType<typeof httpsRequest>;
			try {
				outgoing = request(requestOptions, (message) => {
					const declared = Number(message.headers["content-length"]);
					if (Number.isFinite(declared) && declared > maxBytes) {
						message.destroy();
						outgoing.destroy();
						reject(new OutboundFetchError("too_large"));
						return;
					}
					const chunks: Buffer[] = [];
					let received = 0;
					message.on("data", (chunk: Buffer) => {
						received += chunk.length;
						if (received > maxBytes) {
							message.destroy();
							outgoing.destroy();
							reject(new OutboundFetchError("too_large"));
							return;
						}
						chunks.push(chunk);
					});
					message.on("end", () => {
						try {
							resolve(toResponse(message, Buffer.concat(chunks)));
						} catch (error) {
							fail(error);
						}
					});
					message.on("error", fail);
					message.on("close", () => {
						if (!message.complete) fail(new Error("response ended early"));
					});
				});
			} catch (error) {
				fail(error);
				return;
			}
			outgoing.on("error", fail);
			outgoing.end();
		});
	};
}

/** The shared instance for callers with no limits of their own. */
export const outboundFetch: OutboundFetch = createOutboundFetch();
