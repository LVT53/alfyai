// Apple iCloud CalDAV connect (app-specific password, no OAuth) + read (5.3).
// Apple has no calendar OAuth — the user pastes their Apple ID email and an
// app-specific password generated at appleid.apple.com, and every request is
// Basic-authed with that pair. Discovery walks the standard CalDAV chain
// (.well-known/caldav -> current-user-principal -> calendar-home-set ->
// calendar collections) but iCloud specifically answers the well-known URL
// with a 3xx redirect to a per-account "partition" host (e.g.
// p12-caldav.icloud.com) that must be followed with the SAME credentials —
// undocumented but consistent iCloud behavior. Reads use CalDAV REPORT
// (calendar-query) with a hand-rolled, minimal iCalendar (VEVENT) parser: no
// new dependency is pulled in for this, only line-unfolding + a
// BEGIN/END:VEVENT field scan (see parseICalEvents below). Read-only — writes
// land in Phase 6.2. Every network call accepts an injectable `fetch` so this
// module is fully testable against mocked CalDAV endpoints.
import { createRequire } from "node:module";
import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecret,
	setConnectionSecret,
	updateConnection,
} from "../store";
// Type-only — ContactMatch is owned by contacts.ts (5.8's shared resolver
// hub, see its module doc comment); this is erased at compile time so it
// creates no runtime circular dependency with contacts.ts importing
// appleSearchContacts from this module.
import type { ContactMatch } from "./contacts";
import type { CalendarEvent } from "./google-calendar";

export type { CalendarEvent } from "./google-calendar";

type FetchOpt = { fetch?: typeof fetch };

// jsdom is a real (non-dev) dependency already used server-side as a
// namespace-aware XML parser for WebDAV/CalDAV multistatus responses (see
// providers/nextcloud-files.ts) — reused here rather than pulling in a
// dedicated XML package. Loaded via createRequire, same as there.
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
	JSDOM: new (
		xml: string,
		options?: Record<string, unknown>,
	) => { window: { document: Document } };
};

const USER_AGENT = "AlfyAI";
const WELL_KNOWN_URL = "https://caldav.icloud.com/.well-known/caldav";
// CardDAV (contacts, 5.8) has its own well-known discovery entry point,
// distinct from CalDAV's — both live on iCloud and both redirect to the same
// kind of per-account "partition" host, but the well-known paths themselves
// differ and are discovered independently (contacts does NOT reuse the
// calendar discovery's cached principal/home URLs).
const WELL_KNOWN_CARDDAV_URL =
	"https://contacts.icloud.com/.well-known/carddav";
const REQUEST_TIMEOUT_MS = 15_000;
// Bounds how many 3xx hops a single discovery/read request will follow — a
// real iCloud discovery is at most one redirect (well-known -> partition
// host), this just guards against a misbehaving/looping server.
const MAX_REDIRECTS = 5;

// Exported (Task 9a) so providers/caldav-tasks.ts (the generic CalDAV VTODO
// connector) can reuse the same namespace constants when parsing PROPFIND/
// REPORT multistatus XML, instead of re-declaring them. NOTE for Task 9b
// (generic CalDAV/CardDAV generalization): these low-level exports
// (DAV_NS/CALDAV_NS/CARDDAV_NS, fetchWithTimeout, caldavRequest, textOf,
// firstNs, parseXml below) are a minimal, additive-only "make the existing
// helpers reusable" step — they change no existing behavior (every
// export here was already `function`, just gained the keyword) and every
// apple-caldav.test.ts case stayed green. A real `caldav-client.ts`
// extraction (moving this plumbing to its own module both apple-caldav.ts
// and caldav-tasks.ts import from) is still worth doing but was judged too
// risky to the calendar/contacts read paths to do in the same change as a
// brand-new VTODO connector — a good first task for 9b.
export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const CARDDAV_NS = "urn:ietf:params:xml:ns:carddav";

export type AppleCalDavErrorCode =
	| "invalid_credentials"
	| "needs_reauth"
	| "invalid_config"
	| "request_failed"
	| "connection_not_found";

export class AppleCalDavError extends Error {
	constructor(
		message: string,
		public readonly code: AppleCalDavErrorCode,
	) {
		super(message);
		this.name = "AppleCalDavError";
	}
}

// Exported for the write executor (6.2, providers/apple-caldav-write.ts) —
// every mutating CalDAV request needs the exact same Basic-auth header this
// module's own reads use.
export function basicAuthHeader(appleId: string, appPassword: string): string {
	return `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
}

// Bounds every CalDAV call to ~15s via AbortController so a slow/unreachable
// iCloud endpoint can't hang a chat turn (or the connect flow) indefinitely —
// mirrors the same pattern in providers/nextcloud-files.ts /
// providers/google-calendar.ts.
export async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new AppleCalDavError(
				`Apple CalDAV request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Low-level CalDAV request helper — issues a PROPFIND/REPORT with Basic auth
// and manually follows 3xx redirects (rather than relying on fetch's own
// redirect handling), re-sending the SAME method/body/Authorization at the
// new Location each hop. This is the one chokepoint that has to cope with
// iCloud's undocumented partition redirect (see module doc comment above);
// every discovery step and every calendar REPORT routes through it.
// ---------------------------------------------------------------------------

export async function caldavRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PROPFIND" | "REPORT",
	depth: "0" | "1",
	body: string,
): Promise<{ xml: string; finalUrl: string }> {
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetchWithTimeout(fetchImpl, currentUrl, {
			method,
			redirect: "manual",
			headers: {
				Authorization: auth,
				"Content-Type": "text/xml; charset=utf-8",
				Depth: depth,
				"User-Agent": USER_AGENT,
			},
			body,
		});

		if (response.status === 401) {
			throw new AppleCalDavError(
				"Apple rejected the Apple ID or app-specific password",
				"invalid_credentials",
			);
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("Location");
			if (!location) {
				throw new AppleCalDavError(
					`Apple CalDAV redirected without a Location header (status ${response.status})`,
					"request_failed",
				);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		if (response.status !== 207) {
			throw new AppleCalDavError(
				`Apple CalDAV ${method} failed with status ${response.status}`,
				"request_failed",
			);
		}
		const xml = await response.text();
		return { xml, finalUrl: currentUrl };
	}
	throw new AppleCalDavError(
		"Too many redirects while talking to Apple CalDAV",
		"request_failed",
	);
}

export function textOf(el: Element | null | undefined): string | null {
	if (!el) return null;
	const text = el.textContent;
	if (text === null) return null;
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function firstNs(
	el: Element | Document,
	ns: string,
	localName: string,
): Element | null {
	const found = el.getElementsByTagNameNS(ns, localName);
	return found.length > 0 ? (found[0] as Element) : null;
}

export function parseXml(xml: string): Document {
	const dom = new JSDOM(xml, { contentType: "application/xml" });
	return dom.window.document;
}

// ---------------------------------------------------------------------------
// Discovery: .well-known/caldav -> current-user-principal -> calendar-home-
// set -> calendar collections that support VEVENT.
// ---------------------------------------------------------------------------

const PRINCIPAL_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
	<d:prop>
		<d:current-user-principal/>
	</d:prop>
</d:propfind>`;

const HOME_SET_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<c:calendar-home-set/>
	</d:prop>
</d:propfind>`;

const COLLECTIONS_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:resourcetype/>
		<d:displayname/>
		<c:supported-calendar-component-set/>
	</d:prop>
</d:propfind>`;

async function discoverPrincipalUrl(
	fetchImpl: typeof fetch,
	auth: string,
): Promise<string> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		WELL_KNOWN_URL,
		auth,
		"PROPFIND",
		"0",
		PRINCIPAL_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const principalHref = textOf(
		firstNs(
			firstNs(doc, DAV_NS, "current-user-principal") ?? doc,
			DAV_NS,
			"href",
		),
	);
	if (!principalHref) {
		throw new AppleCalDavError(
			"Apple CalDAV discovery did not return a current-user-principal",
			"request_failed",
		);
	}
	return new URL(principalHref, finalUrl).toString();
}

async function discoverCalendarHomeUrl(
	fetchImpl: typeof fetch,
	auth: string,
	principalUrl: string,
): Promise<string> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		principalUrl,
		auth,
		"PROPFIND",
		"0",
		HOME_SET_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const homeHref = textOf(
		firstNs(
			firstNs(doc, CALDAV_NS, "calendar-home-set") ?? doc,
			DAV_NS,
			"href",
		),
	);
	if (!homeHref) {
		throw new AppleCalDavError(
			"Apple CalDAV discovery did not return a calendar-home-set",
			"request_failed",
		);
	}
	return new URL(homeHref, finalUrl).toString();
}

// A response entry is a VEVENT-capable calendar collection when its
// resourcetype includes CALDAV:calendar AND its
// supported-calendar-component-set includes a <c:comp name="VEVENT"/> — a
// pure collection (e.g. the home-set root itself) or a reminders-only
// (VTODO) calendar is filtered out.
function isVeventCalendarCollection(responseEl: Element): boolean {
	const propstats = Array.from(
		responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
	);
	const okPropstat =
		propstats.find((ps) => {
			const status = textOf(firstNs(ps, DAV_NS, "status"));
			return status ? / 200 /.test(` ${status} `) : false;
		}) ?? propstats[0];
	const prop = okPropstat ? firstNs(okPropstat, DAV_NS, "prop") : null;
	if (!prop) return false;

	const resourcetype = firstNs(prop, DAV_NS, "resourcetype");
	const isCalendar = resourcetype
		? resourcetype.getElementsByTagNameNS(CALDAV_NS, "calendar").length > 0
		: false;
	if (!isCalendar) return false;

	const compSet = firstNs(prop, CALDAV_NS, "supported-calendar-component-set");
	if (!compSet) return false;
	const comps = Array.from(compSet.getElementsByTagNameNS(CALDAV_NS, "comp"));
	return comps.some((comp) => comp.getAttribute("name") === "VEVENT");
}

async function discoverCalendarUrls(
	fetchImpl: typeof fetch,
	auth: string,
	calendarHomeUrl: string,
): Promise<string[]> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		calendarHomeUrl,
		auth,
		"PROPFIND",
		"1",
		COLLECTIONS_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const urls: string[] = [];
	for (const responseEl of responses) {
		if (!isVeventCalendarCollection(responseEl)) continue;
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		urls.push(new URL(href, finalUrl).toString());
	}
	return urls;
}

export type AppleCalDavConfig = {
	appleId: string;
	principalUrl: string;
	calendarHomeUrl: string;
	calendarUrls: string[];
};

async function discoverAppleCalendars(
	fetchImpl: typeof fetch,
	appleId: string,
	appPassword: string,
): Promise<AppleCalDavConfig> {
	const auth = basicAuthHeader(appleId, appPassword);
	const principalUrl = await discoverPrincipalUrl(fetchImpl, auth);
	const calendarHomeUrl = await discoverCalendarHomeUrl(
		fetchImpl,
		auth,
		principalUrl,
	);
	const calendarUrls = await discoverCalendarUrls(
		fetchImpl,
		auth,
		calendarHomeUrl,
	);
	return { appleId, principalUrl, calendarHomeUrl, calendarUrls };
}

// ---------------------------------------------------------------------------
// CardDAV discovery for Contacts (5.8): .well-known/carddav ->
// current-user-principal -> addressbook-home-set -> addressbook collections.
// Same redirect-following/XML-parsing plumbing as the CalDAV discovery above
// (caldavRequest, parseXml, textOf, firstNs) — CardDAV and CalDAV are sibling
// WebDAV extensions and share the same PROPFIND/REPORT mechanics, only the
// XML namespace and element names differ.
// ---------------------------------------------------------------------------

const ADDRESSBOOK_HOME_SET_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<card:addressbook-home-set/>
	</d:prop>
</d:propfind>`;

const ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<d:resourcetype/>
		<d:displayname/>
	</d:prop>
</d:propfind>`;

async function discoverAddressbookPrincipalUrl(
	fetchImpl: typeof fetch,
	auth: string,
): Promise<string> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		WELL_KNOWN_CARDDAV_URL,
		auth,
		"PROPFIND",
		"0",
		PRINCIPAL_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const principalHref = textOf(
		firstNs(
			firstNs(doc, DAV_NS, "current-user-principal") ?? doc,
			DAV_NS,
			"href",
		),
	);
	if (!principalHref) {
		throw new AppleCalDavError(
			"Apple CardDAV discovery did not return a current-user-principal",
			"request_failed",
		);
	}
	return new URL(principalHref, finalUrl).toString();
}

async function discoverAddressbookHomeUrl(
	fetchImpl: typeof fetch,
	auth: string,
	principalUrl: string,
): Promise<string> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		principalUrl,
		auth,
		"PROPFIND",
		"0",
		ADDRESSBOOK_HOME_SET_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const homeHref = textOf(
		firstNs(
			firstNs(doc, CARDDAV_NS, "addressbook-home-set") ?? doc,
			DAV_NS,
			"href",
		),
	);
	if (!homeHref) {
		throw new AppleCalDavError(
			"Apple CardDAV discovery did not return an addressbook-home-set",
			"request_failed",
		);
	}
	return new URL(homeHref, finalUrl).toString();
}

// A response entry is kept when its resourcetype includes
// CARDDAV:addressbook — filters out the home-set root collection itself
// (which has no addressbook resourcetype), mirroring
// isVeventCalendarCollection's filtering role for CalDAV above.
function isAddressbookCollection(responseEl: Element): boolean {
	const propstats = Array.from(
		responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
	);
	const okPropstat =
		propstats.find((ps) => {
			const status = textOf(firstNs(ps, DAV_NS, "status"));
			return status ? / 200 /.test(` ${status} `) : false;
		}) ?? propstats[0];
	const prop = okPropstat ? firstNs(okPropstat, DAV_NS, "prop") : null;
	if (!prop) return false;

	const resourcetype = firstNs(prop, DAV_NS, "resourcetype");
	return resourcetype
		? resourcetype.getElementsByTagNameNS(CARDDAV_NS, "addressbook").length > 0
		: false;
}

async function discoverAddressbookUrls(
	fetchImpl: typeof fetch,
	auth: string,
	addressbookHomeUrl: string,
): Promise<string[]> {
	const { xml, finalUrl } = await caldavRequest(
		fetchImpl,
		addressbookHomeUrl,
		auth,
		"PROPFIND",
		"1",
		ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const urls: string[] = [];
	for (const responseEl of responses) {
		if (!isAddressbookCollection(responseEl)) continue;
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		urls.push(new URL(href, finalUrl).toString());
	}
	return urls;
}

async function discoverAppleAddressbooks(
	fetchImpl: typeof fetch,
	appleId: string,
	appPassword: string,
): Promise<string[]> {
	const auth = basicAuthHeader(appleId, appPassword);
	const principalUrl = await discoverAddressbookPrincipalUrl(fetchImpl, auth);
	const homeUrl = await discoverAddressbookHomeUrl(
		fetchImpl,
		auth,
		principalUrl,
	);
	return discoverAddressbookUrls(fetchImpl, auth, homeUrl);
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertAppleConnection(params: {
	userId: string;
	appleId: string;
	appPassword: string;
	config: AppleCalDavConfig;
}): Promise<ConnectionPublic> {
	const existing = await findConnectionByAccount(
		params.userId,
		"apple",
		params.appleId,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.appPassword);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw new Error("Failed to update existing Apple connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: params.appleId,
			capabilities: ["calendar"],
			status: "connected",
			secret: params.appPassword,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt that created the row
		// first.
		const raced = await findConnectionByAccount(
			params.userId,
			"apple",
			params.appleId,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.appPassword);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function appleConnect(
	params: {
		userId: string;
		appleId: string;
		appPassword: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const fetchImpl = params.fetch ?? fetch;
	const config = await discoverAppleCalendars(
		fetchImpl,
		params.appleId,
		params.appPassword,
	);
	const connection = await upsertAppleConnection({
		userId: params.userId,
		appleId: params.appleId,
		appPassword: params.appPassword,
		config,
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// Minimal iCal (RFC 5545) VEVENT parser — hand-rolled, no dependency. Only
// unfolds lines and extracts the handful of fields the calendar tool needs
// (UID/SUMMARY/DTSTART/DTEND/LOCATION); anything else in the VEVENT block is
// ignored. Deliberately not a general-purpose iCal library.
// ---------------------------------------------------------------------------

// RFC 5545 §3.1 line folding: a line that starts with a single space or tab
// is a continuation of the previous line (with that one leading whitespace
// character removed, and NOT replaced with anything — i.e. simple
// concatenation). Lines are terminated by CRLF, but a bare LF is tolerated.
// Exported for reuse by providers/apple-caldav-write.ts (6.2's
// preserve-and-patch update) — patching the original resource's exact
// property lines needs the SAME unfolding this read-side parser uses, not a
// second hand-rolled copy of it.
export function unfoldICalLines(text: string): string[] {
	const rawLines = text.split(/\r\n|\r|\n/);
	const lines: string[] = [];
	for (const raw of rawLines) {
		if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
			lines[lines.length - 1] += raw.slice(1);
		} else {
			lines.push(raw);
		}
	}
	return lines;
}

// Reverses the RFC 5545 §3.3.11 TEXT escaping (\\, \;, \,, \N or \n) — only
// applied to free-text fields (SUMMARY/LOCATION), never to structured values
// like DTSTART.
function unescapeICalText(value: string): string {
	return value.replace(/\\(.)/g, (_match, ch: string) => {
		if (ch === "n" || ch === "N") return "\n";
		return ch;
	});
}

export type ICalProperty = {
	name: string;
	params: Record<string, string>;
	value: string;
};

// Splits a single unfolded content line ("NAME;PARAM=VALUE;...:value") into
// its property name, parameter map, and raw value. The split point is the
// FIRST unparametrized colon; everything before it (split on `;`) is the
// name followed by `PARAM=VALUE` pairs. Exported for reuse by
// providers/apple-caldav-write.ts (6.2's preserve-and-patch update) — it
// needs to locate the exact original UID/SUMMARY/DTSTART/... lines within a
// fetched VEVENT block the same way this read-side parser does.
export function parseICalProperty(line: string): ICalProperty | null {
	const colonIndex = line.indexOf(":");
	if (colonIndex === -1) return null;
	const head = line.slice(0, colonIndex);
	const value = line.slice(colonIndex + 1);
	const [rawName, ...paramParts] = head.split(";");
	if (!rawName) return null;
	// RFC 6350 §3.3 (contentline = [group "."] name ...) lets a property carry
	// a leading group prefix — Apple Contacts labels grouped properties this
	// way, e.g. "item1.EMAIL;type=INTERNET:...". Strip that "group." prefix
	// before anything downstream compares the property name, or a labeled
	// EMAIL/TEL never matches its case arm (name would be "ITEM1.EMAIL", not
	// "EMAIL"). An iCalendar property name never contains a '.', so this is a
	// no-op for calendar data — only vCard grouping is affected.
	const dotIndex = rawName.indexOf(".");
	const name = dotIndex === -1 ? rawName : rawName.slice(dotIndex + 1);
	if (!name) return null;
	const params: Record<string, string> = {};
	for (const part of paramParts) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
	}
	return { name: name.toUpperCase(), params, value };
}

// Maps a raw DTSTART/DTEND value to an ISO-ish string. All-day
// (`;VALUE=DATE:YYYYMMDD` or a bare 8-digit value) becomes `YYYY-MM-DD`;
// a timed value (`YYYYMMDDTHHMMSS[Z]`, with or without a TZID param) becomes
// `YYYY-MM-DDTHH:MM:SS` plus a trailing `Z` iff the raw value itself ended in
// Z. A TZID param's offset is deliberately NOT resolved — "ISO-ish is fine"
// for what the calendar tool needs; over-engineering timezone math here isn't
// worth it for a read-only MVP. Exported so the write executor
// (providers/apple-caldav-write.ts) can detect a "no genuine change" update by
// comparing a caller's resent start/end against exactly this parse of the
// original DTSTART/DTEND line — the read and write sides must agree on what a
// stored timestamp "is", rather than each guessing independently.
export function parseICalTimestamp(prop: ICalProperty): string | null {
	const value = prop.value.trim();
	const isDateOnly = prop.params.VALUE === "DATE" || /^\d{8}$/.test(value);
	if (isDateOnly) {
		const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
		if (!match) return null;
		return `${match[1]}-${match[2]}-${match[3]}`;
	}
	const match = value.match(
		/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/,
	);
	if (!match) return null;
	const [, year, month, day, hour, minute, second, zone] = match;
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone ?? ""}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Parses an RFC 5545 §3.3.6 DURATION value (e.g. "PT1H", "P1D", "P1DT2H30M",
// "PT45M", "P2W", optionally sign-prefixed) into signed milliseconds. Returns
// null for anything it can't parse or a bare "P" with no components — the
// caller then falls back to the RFC default end rather than a bogus zero.
function parseICalDuration(value: string): number | null {
	const m = value
		.trim()
		.match(
			/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
		);
	if (!m) return null;
	const [, sign, w, d, h, mi, s] = m;
	if (
		w === undefined &&
		d === undefined &&
		h === undefined &&
		mi === undefined &&
		s === undefined
	) {
		return null;
	}
	const total =
		((((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 + Number(h ?? 0)) * 60 +
			Number(mi ?? 0)) *
			60 +
			Number(s ?? 0)) *
		1000;
	return (sign === "-" ? -1 : 1) * total;
}

// Shifts an already-parsed ISO-ish DTSTART string (from parseICalTimestamp) by
// `ms` milliseconds, preserving its shape: a date-only "YYYY-MM-DD" stays
// date-only; a timed value keeps its trailing "Z" iff the original had one.
// Arithmetic runs through Date.UTC purely so day/month/year rollover is correct
// and server-timezone-independent — this is NOT a timezone conversion, just
// wall-clock addition of the requested offset.
function shiftICalTimestamp(parsed: string, ms: number): string | null {
	const p2 = (n: number) => String(n).padStart(2, "0");
	const dateOnly = parsed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const at = new Date(
			Date.UTC(
				Number(dateOnly[1]),
				Number(dateOnly[2]) - 1,
				Number(dateOnly[3]),
			) + ms,
		);
		return `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}`;
	}
	const timed = parsed.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?$/,
	);
	if (timed) {
		const at = new Date(
			Date.UTC(
				Number(timed[1]),
				Number(timed[2]) - 1,
				Number(timed[3]),
				Number(timed[4]),
				Number(timed[5]),
				Number(timed[6]),
			) + ms,
		);
		return `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}T${p2(at.getUTCHours())}:${p2(at.getUTCMinutes())}:${p2(at.getUTCSeconds())}${timed[7] ?? ""}`;
	}
	return null;
}

export type ParsedICalEvent = {
	uid: string;
	summary?: string;
	location?: string;
	description?: string;
	dtstart: string;
	dtend: string;
	// Raw RRULE value (e.g. "FREQ=WEEKLY;..."), present iff this VEVENT block
	// carries one. Not parsed further — the calendar write tool (6.2) only
	// ever needs "is this event recurring at all", never the rule's actual
	// frequency/interval.
	recurrenceRule?: string;
};

// Scans unfolded lines for BEGIN:VEVENT..END:VEVENT blocks and extracts the
// fields the calendar tool needs. A block missing UID or DTSTART is dropped
// rather than surfaced half-populated — but a block with DTSTART and no DTEND
// is NOT dropped: per RFC 5545 §3.6.1 an event's end is derived from DURATION
// when present, and otherwise defaults (VALUE=DATE start -> start + 1 day; a
// timed start -> zero duration, i.e. end == start). Imported/subscribed ICS
// routinely uses DTSTART+DURATION or DTSTART alone, and silently dropping those
// events was a real data-loss bug.
export function parseICalEvents(icsText: string): ParsedICalEvent[] {
	const lines = unfoldICalLines(icsText);
	const events: ParsedICalEvent[] = [];

	let inEvent = false;
	let uid: string | undefined;
	let summary: string | undefined;
	let location: string | undefined;
	let description: string | undefined;
	let dtstart: string | undefined;
	let dtend: string | undefined;
	let duration: string | undefined;
	let recurrenceRule: string | undefined;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			inEvent = true;
			uid = undefined;
			summary = undefined;
			location = undefined;
			description = undefined;
			dtstart = undefined;
			dtend = undefined;
			duration = undefined;
			recurrenceRule = undefined;
			continue;
		}
		if (line === "END:VEVENT") {
			if (inEvent && uid && dtstart) {
				let end = dtend;
				if (end === undefined && duration !== undefined) {
					const ms = parseICalDuration(duration);
					if (ms !== null) end = shiftICalTimestamp(dtstart, ms) ?? undefined;
				}
				if (end === undefined) {
					// RFC 5545 §3.6.1 defaults: an all-day (VALUE=DATE, so no "T")
					// event lasts one day; a timed event has zero duration.
					const dtstartDateOnly = !dtstart.includes("T");
					end = dtstartDateOnly
						? (shiftICalTimestamp(dtstart, ONE_DAY_MS) ?? dtstart)
						: dtstart;
				}
				events.push({
					uid,
					dtstart,
					dtend: end,
					...(summary !== undefined ? { summary } : {}),
					...(location !== undefined ? { location } : {}),
					...(description !== undefined ? { description } : {}),
					...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
				});
			}
			inEvent = false;
			continue;
		}
		if (!inEvent) continue;

		const prop = parseICalProperty(line);
		if (!prop) continue;
		switch (prop.name) {
			case "UID":
				uid = prop.value;
				break;
			case "SUMMARY":
				summary = unescapeICalText(prop.value);
				break;
			case "LOCATION":
				location = unescapeICalText(prop.value);
				break;
			case "DESCRIPTION":
				description = unescapeICalText(prop.value);
				break;
			case "RRULE":
				recurrenceRule = prop.value;
				break;
			case "DURATION":
				duration = prop.value.trim();
				break;
			case "DTSTART": {
				const parsed = parseICalTimestamp(prop);
				if (parsed) dtstart = parsed;
				break;
			}
			case "DTEND": {
				const parsed = parseICalTimestamp(prop);
				if (parsed) dtend = parsed;
				break;
			}
			default:
				break;
		}
	}

	return events;
}

// ---------------------------------------------------------------------------
// Read: REPORT (calendar-query) filtered by time-range, Depth 1.
// ---------------------------------------------------------------------------

// CalDAV time-range filters use iCal's "basic" UTC form (no dashes/colons,
// always Z) regardless of what format the caller's ISO timestamp used.
function toICalUtcTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		throw new AppleCalDavError(
			`Invalid timeMin/timeMax value: ${iso}`,
			"request_failed",
		);
	}
	return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function calendarQueryBody(timeMin: string, timeMax: string): string {
	const start = toICalUtcTimestamp(timeMin);
	const end = toICalUtcTimestamp(timeMax);
	// The CALDAV:expand (RFC 4791 §9.6.5) inside calendar-data asks the server
	// to MATERIALIZE each recurrence instance that overlaps [start, end) as its
	// own single-occurrence VEVENT, instead of returning the recurring master
	// verbatim. Without it, a weekly series with a long-past DTSTART came back
	// as one VEVENT carrying that original (out-of-window) start, so the whole
	// in-window series collapsed to a single wrongly-dated entry. The expand
	// window MUST match the time-range filter below so every occurrence the
	// filter selects is also expanded. This is read-side only — the write
	// path's UID lookup (uidQueryBody) deliberately does NOT expand, since it
	// needs the real master resource text to patch/delete.
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data>
			<c:expand start="${start}" end="${end}"/>
		</c:calendar-data>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VEVENT">
				<c:time-range start="${start}" end="${end}"/>
			</c:comp-filter>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;
}

function parseReportMultistatus(
	xml: string,
	finalUrl: string,
): CalendarEvent[] {
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const events: CalendarEvent[] = [];
	for (const responseEl of responses) {
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		const propstats = Array.from(
			responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
		);
		const okPropstat =
			propstats.find((ps) => {
				const status = textOf(firstNs(ps, DAV_NS, "status"));
				return status ? / 200 /.test(` ${status} `) : false;
			}) ?? propstats[0];
		const prop = okPropstat ? firstNs(okPropstat, DAV_NS, "prop") : null;
		if (!prop) continue;

		const etag = textOf(firstNs(prop, DAV_NS, "getetag")) ?? undefined;
		const calendarData = textOf(firstNs(prop, CALDAV_NS, "calendar-data"));
		if (!calendarData) continue;

		const absoluteHref = new URL(href, finalUrl).toString();
		for (const parsed of parseICalEvents(calendarData)) {
			events.push({
				id: parsed.uid,
				summary: parsed.summary ?? "",
				start: parsed.dtstart,
				end: parsed.dtend,
				...(parsed.location ? { location: parsed.location } : {}),
				...(parsed.description ? { description: parsed.description } : {}),
				htmlLink: absoluteHref,
				...(etag ? { etag } : {}),
				// Captured verbatim for the 6.2 write path's preserve-and-patch
				// update (see CalendarEvent.rawIcs's doc comment) — this is the
				// exact `calendar-data` text this event was parsed out of, not a
				// re-serialization of the parsed fields above.
				rawIcs: calendarData,
				// See CalendarEvent.recurrence's doc comment (google-calendar.ts):
				// Apple never distinguishes a recurring master from an expanded
				// instance the way Google does, so a bare non-empty array is enough
				// signal for isRecurring — the rule's actual content is unused.
				...(parsed.recurrenceRule
					? { recurrence: [parsed.recurrenceRule] }
					: {}),
			});
		}
	}
	return events;
}

function appleConfig(conn: ConnectionPublic): {
	appleId: string;
	calendarUrls: string[];
} {
	const appleId =
		typeof conn.config.appleId === "string"
			? conn.config.appleId
			: conn.accountIdentifier;
	const calendarUrls = Array.isArray(conn.config.calendarUrls)
		? conn.config.calendarUrls.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	if (!appleId || calendarUrls.length === 0) {
		throw new AppleCalDavError(
			"Connection is missing appleId or calendarUrls in its config",
			"invalid_config",
		);
	}
	return { appleId, calendarUrls };
}

export async function appleListEvents(
	userId: string,
	connectionId: string,
	params: { timeMin: string; timeMax: string },
	opts?: FetchOpt,
): Promise<CalendarEvent[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new AppleCalDavError(
			"Apple connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new AppleCalDavError(
			"No app-specific password stored for this Apple connection",
			"needs_reauth",
		);
	}

	const { appleId, calendarUrls } = appleConfig(conn);
	const auth = basicAuthHeader(appleId, appPassword);
	const body = calendarQueryBody(params.timeMin, params.timeMax);

	const events: CalendarEvent[] = [];
	try {
		for (const calendarUrl of calendarUrls) {
			const { xml, finalUrl } = await caldavRequest(
				fetchImpl,
				calendarUrl,
				auth,
				"REPORT",
				"1",
				body,
			);
			events.push(...parseReportMultistatus(xml, finalUrl));
		}
	} catch (err) {
		if (err instanceof AppleCalDavError && err.code === "invalid_credentials") {
			const detail = "Apple rejected the stored app-specific password";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new AppleCalDavError(detail, "needs_reauth");
		}
		throw err;
	}

	return events.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------------------------------------------------------------------------
// Fetch a single event by UID (Issue 6.2 write path) — a calendar-query
// REPORT filtered by a UID prop-filter, deliberately NOT reusing
// appleListEvents's time-range filter: update/delete need to resolve a
// target event's resourceHref+etag regardless of how far in the past or
// future it falls, which a bounded time-range lookup could simply miss.
// Searches every configured calendar collection and returns the first match.
// ---------------------------------------------------------------------------

// Minimal XML-text escaping for interpolating a caller-supplied value (the
// calendar tool's `eventId`, ultimately model-controlled) into a REPORT
// request body — this is the one CalDAV request body in this module built
// from untrusted input, so escaping here is required to keep it from
// breaking out of the <c:text-match> element (or injecting sibling filter
// elements) rather than merely failing to match.
function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function uidQueryBody(uid: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data/>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VEVENT">
				<c:prop-filter name="UID">
					<c:text-match collation="i;octet" match-type="equals">${escapeXmlText(uid)}</c:text-match>
				</c:prop-filter>
			</c:comp-filter>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;
}

export async function appleGetEventByUid(
	userId: string,
	connectionId: string,
	uid: string,
	opts?: FetchOpt,
): Promise<CalendarEvent | null> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new AppleCalDavError(
			"Apple connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new AppleCalDavError(
			"No app-specific password stored for this Apple connection",
			"needs_reauth",
		);
	}

	const { appleId, calendarUrls } = appleConfig(conn);
	const auth = basicAuthHeader(appleId, appPassword);
	const body = uidQueryBody(uid);

	try {
		for (const calendarUrl of calendarUrls) {
			const { xml, finalUrl } = await caldavRequest(
				fetchImpl,
				calendarUrl,
				auth,
				"REPORT",
				"1",
				body,
			);
			// Defense in depth beyond the server-side UID filter — a server that
			// ignores match-type="equals" and falls back to "contains" semantics
			// must never hand back a different event than the one asked for.
			const match = parseReportMultistatus(xml, finalUrl).find(
				(event) => event.id === uid,
			);
			if (match) return match;
		}
	} catch (err) {
		if (err instanceof AppleCalDavError && err.code === "invalid_credentials") {
			const detail = "Apple rejected the stored app-specific password";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new AppleCalDavError(detail, "needs_reauth");
		}
		throw err;
	}

	return null;
}

// ---------------------------------------------------------------------------
// vCard (RFC 6350) parser for Contacts (5.8) — hand-rolled, no dependency,
// deliberately mirroring parseICalEvents above: vCard and iCalendar share the
// same RFC 5545 §3.1-style line-folding and "NAME;PARAM=VALUE:value" content
// line grammar (RFC 6350 explicitly reuses it), so unfoldICalLines and
// parseICalProperty are reused as-is rather than duplicated. Only extracts
// what the contacts resolver needs (FN, EMAIL, TEL) — not a general-purpose
// vCard library.
// ---------------------------------------------------------------------------

export type ParsedVCard = {
	fn?: string;
	emails: string[];
	phones: string[];
};

export function parseVCards(vcardText: string): ParsedVCard[] {
	const lines = unfoldICalLines(vcardText);
	const cards: ParsedVCard[] = [];

	let inCard = false;
	let fn: string | undefined;
	let emails: string[] = [];
	let phones: string[] = [];

	for (const line of lines) {
		if (line === "BEGIN:VCARD") {
			inCard = true;
			fn = undefined;
			emails = [];
			phones = [];
			continue;
		}
		if (line === "END:VCARD") {
			if (inCard)
				cards.push({ ...(fn !== undefined ? { fn } : {}), emails, phones });
			inCard = false;
			continue;
		}
		if (!inCard) continue;

		const prop = parseICalProperty(line);
		if (!prop) continue;
		switch (prop.name) {
			case "FN":
				fn = unescapeICalText(prop.value);
				break;
			case "EMAIL": {
				const value = unescapeICalText(prop.value.trim());
				if (value) emails.push(value);
				break;
			}
			case "TEL": {
				const value = unescapeICalText(prop.value.trim());
				if (value) phones.push(value);
				break;
			}
			default:
				break;
		}
	}

	return cards;
}

// RFC 6352 §10.3 defines addressbook-query as
// `((allprop|propname|prop)?, filter, limit?)` — the CARDDAV:filter element is
// MANDATORY (no `?` quantifier), unlike CalDAV's calendar-query where the
// filter is likewise required but iCloud is laxer about. Omitting it made a
// strict iCloud endpoint 400 the REPORT, which surfaced upstream as "no
// contacts". We still match/rank client-side (CardDAV has no reliable
// cross-server free-text primitive — see appleSearchContacts), so this filter
// must select EVERY card: with the default `test="anyof"` (logical OR), a
// bare `prop-filter name="UID"` matches any card that HAS a UID and the
// `is-not-defined` arm matches any card that does NOT — together a tautology,
// i.e. all cards, expressed in the RFC's own grammar.
const ADDRESSBOOK_QUERY_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<d:getetag/>
		<card:address-data/>
	</d:prop>
	<card:filter test="anyof">
		<card:prop-filter name="UID"/>
		<card:prop-filter name="UID">
			<card:is-not-defined/>
		</card:prop-filter>
	</card:filter>
</card:addressbook-query>`;

function parseAddressbookReportMultistatus(xml: string): ParsedVCard[] {
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const cards: ParsedVCard[] = [];
	for (const responseEl of responses) {
		const propstats = Array.from(
			responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
		);
		const okPropstat =
			propstats.find((ps) => {
				const status = textOf(firstNs(ps, DAV_NS, "status"));
				return status ? / 200 /.test(` ${status} `) : false;
			}) ?? propstats[0];
		const prop = okPropstat ? firstNs(okPropstat, DAV_NS, "prop") : null;
		if (!prop) continue;

		const addressData = textOf(firstNs(prop, CARDDAV_NS, "address-data"));
		if (!addressData) continue;
		cards.push(...parseVCards(addressData));
	}
	return cards;
}

function appleContactsCachedAddressbookUrls(
	conn: ConnectionPublic,
): string[] | null {
	const urls = conn.config.addressbookUrls;
	if (!Array.isArray(urls)) return null;
	const strings = urls.filter(
		(value): value is string => typeof value === "string",
	);
	return strings.length > 0 ? strings : null;
}

// Resolves contacts across the Apple ID's CardDAV addressbooks for the
// contacts chat tool / resolveContacts (5.8) — discovery is cached into the
// connection's config on first use (see appleContactsCachedAddressbookUrls
// above), same caching posture as appleListEvents's calendarUrls. Matching
// is client-side (FN or any EMAIL contains `query`, case-insensitive) since
// CardDAV's addressbook-query REPORT has no free-text search primitive worth
// relying on across servers — same rationale as calendar.ts not passing
// `query` through to appleListEvents.
export async function appleSearchContacts(
	userId: string,
	connectionId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new AppleCalDavError(
			"Apple connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new AppleCalDavError(
			"No app-specific password stored for this Apple connection",
			"needs_reauth",
		);
	}

	const appleId =
		typeof conn.config.appleId === "string"
			? conn.config.appleId
			: conn.accountIdentifier;
	const auth = basicAuthHeader(appleId, appPassword);
	const limit = params.limit ?? 10;
	const query = params.query.trim().toLowerCase();

	try {
		let addressbookUrls = appleContactsCachedAddressbookUrls(conn);
		if (!addressbookUrls) {
			addressbookUrls = await discoverAppleAddressbooks(
				fetchImpl,
				appleId,
				appPassword,
			);
			await updateConnection(userId, connectionId, {
				config: { ...conn.config, addressbookUrls },
			});
		}

		const matches: ContactMatch[] = [];
		for (const addressbookUrl of addressbookUrls) {
			const { xml } = await caldavRequest(
				fetchImpl,
				addressbookUrl,
				auth,
				"REPORT",
				"1",
				ADDRESSBOOK_QUERY_BODY,
			);
			for (const card of parseAddressbookReportMultistatus(xml)) {
				const fn = card.fn ?? "";
				const isMatch =
					query.length === 0 ||
					fn.toLowerCase().includes(query) ||
					card.emails.some((email) => email.toLowerCase().includes(query));
				if (!isMatch) continue;
				matches.push({
					name: fn,
					emails: card.emails,
					phones: card.phones,
					source: "apple",
					account: conn.accountIdentifier,
				});
				if (matches.length >= limit) return matches;
			}
		}
		return matches;
	} catch (err) {
		if (err instanceof AppleCalDavError && err.code === "invalid_credentials") {
			const detail = "Apple rejected the stored app-specific password";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new AppleCalDavError(detail, "needs_reauth");
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Adapter — a cheap PROPFIND on the stored principal URL is enough to
// confirm the Apple ID + app-specific password still work, without touching
// any calendar data.
// ---------------------------------------------------------------------------

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const principalUrl =
		typeof conn.config.principalUrl === "string"
			? conn.config.principalUrl
			: "";
	const appleId =
		typeof conn.config.appleId === "string"
			? conn.config.appleId
			: conn.accountIdentifier;
	if (!principalUrl || !appleId) {
		return {
			status: "error",
			detail: "Connection is missing principalUrl or appleId in its config",
		};
	}

	try {
		await caldavRequest(
			fetchImpl,
			principalUrl,
			basicAuthHeader(appleId, secret),
			"PROPFIND",
			"0",
			PRINCIPAL_PROPFIND_BODY,
		);
		return { status: "connected", detail: null };
	} catch (err) {
		if (err instanceof AppleCalDavError && err.code === "invalid_credentials") {
			return {
				status: "needs_reauth",
				detail: "Apple rejected the stored app-specific password",
			};
		}
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// Not annotated as `: ConnectionAdapter` — that would narrow checkHealth's
// call signature to the interface's (secret, conn) shape and break the
// mocked-fetch tests that pass a third `{ fetch }` opts arg, same rationale
// as nextcloudFilesAdapter in providers/nextcloud-files.ts.
export const appleAdapter = {
	provider: "apple" as const,
	checkHealth,
};

registerConnectionAdapter(appleAdapter satisfies ConnectionAdapter);
