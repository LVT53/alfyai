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
const REQUEST_TIMEOUT_MS = 15_000;
// Bounds how many 3xx hops a single discovery/read request will follow — a
// real iCloud discovery is at most one redirect (well-known -> partition
// host), this just guards against a misbehaving/looping server.
const MAX_REDIRECTS = 5;

const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

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

function basicAuthHeader(appleId: string, appPassword: string): string {
	return `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
}

// Bounds every CalDAV call to ~15s via AbortController so a slow/unreachable
// iCloud endpoint can't hang a chat turn (or the connect flow) indefinitely —
// mirrors the same pattern in providers/nextcloud-files.ts /
// providers/google-calendar.ts.
async function fetchWithTimeout(
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

async function caldavRequest(
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

function textOf(el: Element | null | undefined): string | null {
	if (!el) return null;
	const text = el.textContent;
	if (text === null) return null;
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function firstNs(
	el: Element | Document,
	ns: string,
	localName: string,
): Element | null {
	const found = el.getElementsByTagNameNS(ns, localName);
	return found.length > 0 ? (found[0] as Element) : null;
}

function parseXml(xml: string): Document {
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
function unfoldICalLines(text: string): string[] {
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

type ICalProperty = {
	name: string;
	params: Record<string, string>;
	value: string;
};

// Splits a single unfolded content line ("NAME;PARAM=VALUE;...:value") into
// its property name, parameter map, and raw value. The split point is the
// FIRST unparametrized colon; everything before it (split on `;`) is the
// name followed by `PARAM=VALUE` pairs.
function parseICalProperty(line: string): ICalProperty | null {
	const colonIndex = line.indexOf(":");
	if (colonIndex === -1) return null;
	const head = line.slice(0, colonIndex);
	const value = line.slice(colonIndex + 1);
	const [name, ...paramParts] = head.split(";");
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
// worth it for a read-only MVP.
function parseICalTimestamp(prop: ICalProperty): string | null {
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

export type ParsedICalEvent = {
	uid: string;
	summary?: string;
	location?: string;
	dtstart: string;
	dtend: string;
};

// Scans unfolded lines for BEGIN:VEVENT..END:VEVENT blocks and extracts the
// fields the calendar tool needs. A block missing UID, DTSTART, or DTEND is
// dropped rather than surfaced half-populated.
export function parseICalEvents(icsText: string): ParsedICalEvent[] {
	const lines = unfoldICalLines(icsText);
	const events: ParsedICalEvent[] = [];

	let inEvent = false;
	let uid: string | undefined;
	let summary: string | undefined;
	let location: string | undefined;
	let dtstart: string | undefined;
	let dtend: string | undefined;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			inEvent = true;
			uid = undefined;
			summary = undefined;
			location = undefined;
			dtstart = undefined;
			dtend = undefined;
			continue;
		}
		if (line === "END:VEVENT") {
			if (inEvent && uid && dtstart && dtend) {
				events.push({
					uid,
					dtstart,
					dtend,
					...(summary !== undefined ? { summary } : {}),
					...(location !== undefined ? { location } : {}),
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
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data/>
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
				htmlLink: absoluteHref,
				...(etag ? { etag } : {}),
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
