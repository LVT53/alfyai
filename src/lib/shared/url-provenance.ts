/**
 * Where an address came from: the one vocabulary the browser and the server
 * compare addresses in.
 *
 * The model reads pages, emails and files a stranger may have written, and a
 * prompt injection in them can make it write an address with private data hidden
 * in the path, the query or a subdomain. As a link that is harmless (a click is
 * the reader's choice); as a request nobody clicked (an `<img>`, a favicon, a
 * page the server reads) it hands the data to whoever owns the address. So an
 * address the app requests on its own must come from the user's own words or
 * from a tool's result, never from the model's (docs/plans/exfil-channels).
 *
 * Pure and browser-safe: the chat renderer reads it on the messages it holds,
 * the server on the turn it runs and the messages it stores.
 */
import type { ThinkingSegment } from "$lib/server/services/messages-types";

type ToolCallSegment = Extract<ThinkingSegment, { type: "tool_call" }>;

const MAX_URL_CHARS = 2_000;
const DEFAULT_EXTRACT_LIMIT = 500;
const MAX_VALUE_DEPTH = 12;

/** The tool whose results are pictures to show (see `toolImages`). */
export const IMAGE_SEARCH_TOOL = "image_search";

/** Brave's image proxy: the only host a picture from image_search is shown from. */
export const BRAVE_THUMBNAIL_HOST = "imgs.search.brave.com";

/** The app's same-origin route that serves a Brave thumbnail. */
export const IMAGE_THUMBNAIL_ROUTE = "/api/image-search/thumbnail";

/** The app's same-origin favicon proxy. */
export const FAVICON_ROUTE = "/api/favicon";

/** An absolute http(s) address with nothing in it a request should not carry. */
function parseHttpUrl(raw: unknown): URL | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (
		!value ||
		value.length > MAX_URL_CHARS ||
		!/^https?:\/\/[^/\\]/i.test(value)
	) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (!parsed.hostname || parsed.username || parsed.password) return null;
	return parsed;
}

function withoutWww(hostname: string): string {
	return hostname.replace(/^www\./, "");
}

/**
 * The form two addresses are compared in: the host (lowercase, punycode, without
 * a leading `www.`), a port only when it is not the scheme's default, then the
 * path and query exactly as the URL parser writes them. The scheme and the
 * fragment are left out: `http` and `https` name the same page here, and a
 * fragment never leaves the browser. Null for anything that is not an absolute
 * http(s) address, or that carries a user name or password.
 */
export function provenanceKey(raw: unknown): string | null {
	const parsed = parseHttpUrl(raw);
	if (!parsed) return null;
	const port = parsed.port ? `:${parsed.port}` : "";
	return `${withoutWww(parsed.hostname)}${port}${parsed.pathname}${parsed.search}`;
}

/**
 * The host the favicon proxy names a site by: lowercase, without a leading
 * `www.`. Null for anything that is not an absolute http(s) address.
 */
export function sourceHostOf(raw: unknown): string | null {
	const parsed = parseHttpUrl(raw);
	return parsed ? withoutWww(parsed.hostname) : null;
}

// An absolute address runs from its scheme to the first character no address
// carries as written in text. Brackets end it too: `[a](https://x/y)` is a
// Markdown link, and an address inside brackets is not read as one.
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s<>"'`\\^{}|[\]]+/gi;

// A bare domain as a person types it (`example.com/page`): dotted labels ending
// in a letters-only top-level domain, never straight after `@` (an email
// address), a word character, a dot, a slash or a colon (part of something else).
const BARE_DOMAIN =
	/(?<![@\w.\-/:])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<>"'`\\^{}|[\]]*)?/gi;

const TRAILING_PUNCTUATION = ".,;:!?'\"*_~";

function count(text: string, character: string): number {
	let total = 0;
	for (const each of text) if (each === character) total += 1;
	return total;
}

/**
 * Prose punctuation after an address is not part of it. A closing bracket is,
 * when the address opened one itself (`…/wiki/Foo_(bar)`), and is not when it
 * closes the sentence's own bracket or a Markdown link (`(see https://x/y)`).
 */
function trimTrailing(candidate: string): string {
	let value = candidate;
	for (;;) {
		const last = value.at(-1);
		if (last === undefined) return value;
		if (TRAILING_PUNCTUATION.includes(last)) {
			value = value.slice(0, -1);
			continue;
		}
		if (last === ")" && count(value, ")") > count(value, "(")) {
			value = value.slice(0, -1);
			continue;
		}
		return value;
	}
}

export interface ExtractUrlsOptions {
	/**
	 * Also read bare domains (`example.com/page`) as `https://` addresses. For a
	 * person's own words; a tool's payload is read for absolute addresses only.
	 */
	bareDomains?: boolean;
	/** Stop after this many distinct addresses. */
	limit?: number;
}

/**
 * Every http(s) address in a text, each once, in the order they appear, with
 * trailing prose punctuation trimmed. An HTML-escaped `&amp;` is also read as
 * `&`, since a page's text often carries its links escaped.
 */
export function extractUrls(
	text: unknown,
	options: ExtractUrlsOptions = {},
): string[] {
	if (typeof text !== "string" || !text) return [];
	const limit = options.limit ?? DEFAULT_EXTRACT_LIMIT;
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (candidate: string): boolean => {
		const value = trimTrailing(candidate);
		for (const form of value.includes("&amp;")
			? [value, value.replaceAll("&amp;", "&")]
			: [value]) {
			if (!parseHttpUrl(form) || seen.has(form)) continue;
			seen.add(form);
			found.push(form);
			if (found.length >= limit) return false;
		}
		return true;
	};

	for (const match of text.matchAll(ABSOLUTE_URL)) {
		if (!add(match[0])) return found;
	}
	if (!options.bareDomains) return found;
	// Blank the absolute addresses out first, so their hosts and paths are not
	// read a second time as bare domains.
	const rest = text.replace(ABSOLUTE_URL, (match) => " ".repeat(match.length));
	for (const match of rest.matchAll(BARE_DOMAIN)) {
		if (!add(`https://${match[0]}`)) return found;
	}
	return found;
}

/**
 * Every absolute http(s) address in the strings of a JSON-like value (a tool's
 * payload as the model received it), each once. Bounded in depth and count, so
 * a hostile payload cannot make this walk long.
 */
export function extractUrlsFromValue(
	value: unknown,
	limit = DEFAULT_EXTRACT_LIMIT,
): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const visit = (node: unknown, depth: number): boolean => {
		if (found.length >= limit || depth > MAX_VALUE_DEPTH) {
			return found.length < limit;
		}
		if (typeof node === "string") {
			for (const url of extractUrls(node, { limit: limit - found.length })) {
				if (seen.has(url)) continue;
				seen.add(url);
				found.push(url);
				if (found.length >= limit) return false;
			}
			return true;
		}
		if (Array.isArray(node)) {
			for (const item of node) if (!visit(item, depth + 1)) return false;
			return true;
		}
		if (node && typeof node === "object") {
			for (const item of Object.values(node)) {
				if (!visit(item, depth + 1)) return false;
			}
		}
		return true;
	};
	visit(value, 0);
	return found;
}

function toolCalls(
	segments: readonly ThinkingSegment[] | null | undefined,
): ToolCallSegment[] {
	return (segments ?? []).filter(
		(segment): segment is ToolCallSegment => segment?.type === "tool_call",
	);
}

/** A picture image_search returned. */
export interface ToolImage {
	/** The picture's own address, as the search returned it. */
	url: string;
	/** Brave's resized copy, the one the chat shows; null when there is none. */
	thumbnail: string | null;
}

/** Whether this is an address on Brave's image proxy (https, its host, no port). */
export function isBraveThumbnailUrl(raw: unknown): boolean {
	const parsed = parseHttpUrl(raw);
	return Boolean(
		parsed &&
			parsed.protocol === "https:" &&
			parsed.hostname === BRAVE_THUMBNAIL_HOST &&
			!parsed.port,
	);
}

/**
 * The pictures image_search returned in these tool calls. Read off the calls'
 * candidates, which the server writes from the search's own results: a model
 * chooses a call's input, never its candidates.
 */
export function toolImages(
	segments: readonly ThinkingSegment[] | null | undefined,
): ToolImage[] {
	const images: ToolImage[] = [];
	for (const call of toolCalls(segments)) {
		if (call.name !== IMAGE_SEARCH_TOOL || call.status !== "done") continue;
		for (const candidate of call.candidates ?? []) {
			const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
			if (!parseHttpUrl(url)) continue;
			const thumbnail = candidate.metadata?.thumbnail;
			images.push({
				url,
				thumbnail:
					typeof thumbnail === "string" && isBraveThumbnailUrl(thumbnail)
						? thumbnail.trim()
						: null,
			});
		}
	}
	return images;
}

/**
 * The hosts of every address these tool calls returned, named the way the
 * favicon proxy names them. Results only: a call's input is the model's own
 * words and never counts.
 */
export function toolSourceHosts(
	segments: readonly ThinkingSegment[] | null | undefined,
): Set<string> {
	const hosts = new Set<string>();
	for (const call of toolCalls(segments)) {
		for (const candidate of call.candidates ?? []) {
			const host = sourceHostOf(candidate.url);
			if (host) hosts.add(host);
		}
	}
	return hosts;
}

/** The same-origin address that shows a Brave thumbnail. */
export function imageThumbnailRouteUrl(thumbnail: string): string {
	return `${IMAGE_THUMBNAIL_ROUTE}?url=${encodeURIComponent(thumbnail)}`;
}

/** The same-origin address of a host's favicon. */
export function faviconRouteUrl(host: string): string {
	return `${FAVICON_ROUTE}?domain=${encodeURIComponent(host)}`;
}

/**
 * The one query parameter of an address on one of the app's own routes, or
 * null when the address is anything else: another path, another origin, a
 * second parameter, a fragment. For checking an `<img src>` the renderer may or
 * may not have written itself.
 */
function readOwnRouteParameter(
	src: unknown,
	route: string,
	parameter: string,
): string | null {
	if (typeof src !== "string" || !src.startsWith(`${route}?`)) return null;
	if (src.length > MAX_URL_CHARS * 2 || /[\s\\#]/.test(src)) return null;
	let parsed: URL;
	try {
		parsed = new URL(src, "https://app.invalid");
	} catch {
		return null;
	}
	if (parsed.origin !== "https://app.invalid" || parsed.pathname !== route) {
		return null;
	}
	const keys = [...parsed.searchParams.keys()];
	if (keys.length !== 1 || keys[0] !== parameter) return null;
	return parsed.searchParams.get(parameter);
}

/** The Brave address a thumbnail route address shows, or null. */
export function readImageThumbnailRouteUrl(src: unknown): string | null {
	const thumbnail = readOwnRouteParameter(src, IMAGE_THUMBNAIL_ROUTE, "url");
	return thumbnail && isBraveThumbnailUrl(thumbnail) ? thumbnail : null;
}

/** The host a favicon route address asks for, or null. */
export function readFaviconRouteUrl(src: unknown): string | null {
	return readOwnRouteParameter(src, FAVICON_ROUTE, "domain");
}
