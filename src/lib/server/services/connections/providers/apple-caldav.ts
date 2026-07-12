// Apple iCloud CalDAV connect (app-specific password, no OAuth) + read (5.3) +
// CardDAV contacts (5.8). Apple has no calendar OAuth — the user pastes their
// Apple ID email and an app-specific password generated at appleid.apple.com,
// and every request is Basic-authed with that pair. Discovery walks the
// standard CalDAV chain (.well-known/caldav -> current-user-principal ->
// calendar-home-set -> calendar collections) but iCloud specifically answers
// the well-known URL with a 3xx redirect to a per-account "partition" host
// (e.g. p12-caldav.icloud.com) that must be followed with the SAME credentials
// — undocumented but consistent iCloud behavior.
//
// The provider-agnostic WebDAV/CalDAV/CardDAV plumbing this module builds on —
// the redirect-following PROPFIND/REPORT transport, the multistatus XML parser
// + propstat selection, the collection-type filters, and the iCal/vCard
// parsers + REPORT query bodies — now lives in ../dav (B3). This module used to
// own all of that and export it as the de-facto shared toolkit; it is now just
// a consumer, holding only the Apple-specific logic: iCloud's well-known URLs,
// the principal/home-set discovery chain, needs_reauth flagging, connection
// storage, and the Apple adapter + health check. Every network call accepts an
// injectable `fetch` so this module is fully testable against mocked endpoints.
import { registerConnectionAdapter } from "../adapters";
import {
	ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY,
	ADDRESSBOOK_QUERY_BODY,
	CALDAV_NS,
	CARDDAV_NS,
	caldavRequest,
	calendarQueryBody,
	DAV_NS,
	firstNs,
	isAddressbookCollection,
	isCalendarCollection,
	okPropOf,
	type ParsedVCard,
	parseReportMultistatus,
	parseVCards,
	parseXml,
	supportsCalendarComponent,
	textOf,
	uidQueryBody,
} from "../dav";
import { basicAuthHeader, ConnectionHttpError } from "../provider-http";
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

// Type-only — ContactMatch is owned by contacts.ts (5.8's shared resolver hub,
// see its module doc comment); this is erased at compile time so it creates no
// runtime circular dependency with contacts.ts importing appleSearchContacts
// from this module.
import type { ContactMatch } from "./contacts";
import type { CalendarEvent } from "./google-calendar";

export type { CalendarEvent } from "./google-calendar";

type FetchOpt = { fetch?: typeof fetch };

const WELL_KNOWN_URL = "https://caldav.icloud.com/.well-known/caldav";
// CardDAV (contacts, 5.8) has its own well-known discovery entry point,
// distinct from CalDAV's — both live on iCloud and both redirect to the same
// kind of per-account "partition" host, but the well-known paths themselves
// differ and are discovered independently (contacts does NOT reuse the calendar
// discovery's cached principal/home URLs).
const WELL_KNOWN_CARDDAV_URL =
	"https://contacts.icloud.com/.well-known/carddav";

export type AppleCalDavErrorCode =
	| "invalid_credentials"
	| "needs_reauth"
	| "invalid_config"
	| "request_failed"
	| "connection_not_found";

export class AppleCalDavError extends ConnectionHttpError<AppleCalDavErrorCode> {
	constructor(message: string, code: AppleCalDavErrorCode) {
		super(message, code);
		this.name = "AppleCalDavError";
	}
}

// Routes every Apple read through the shared ../dav transport while preserving
// this module's exact error type + wording: caldavRequest's generic defaults
// ("CalDAV ...", a neutral credentials message, a plain DavError) are overridden
// so an Apple call still throws an AppleCalDavError that says "Apple CalDAV" /
// "Apple rejected the Apple ID or app-specific password", which the connect
// route and the read paths' needs_reauth flagging both depend on.
async function appleCaldavRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PROPFIND" | "REPORT",
	depth: "0" | "1",
	body: string,
): Promise<{ xml: string; finalUrl: string }> {
	return caldavRequest(fetchImpl, url, auth, method, depth, body, {
		requestLabel: "Apple CalDAV",
		credentialsRejectedMessage:
			"Apple rejected the Apple ID or app-specific password",
		makeError: (message, code) => new AppleCalDavError(message, code),
	});
}

// ---------------------------------------------------------------------------
// Discovery: .well-known/caldav -> current-user-principal -> calendar-home-set
// -> calendar collections that support VEVENT.
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
	const { xml, finalUrl } = await appleCaldavRequest(
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
	const { xml, finalUrl } = await appleCaldavRequest(
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

// A response entry is a VEVENT-capable calendar collection when its resourcetype
// includes CALDAV:calendar AND its supported-calendar-component-set includes a
// <c:comp name="VEVENT"/> — a pure collection (e.g. the home-set root itself) or
// a reminders-only (VTODO) calendar is filtered out.
function isVeventCalendarCollection(responseEl: Element): boolean {
	const prop = okPropOf(responseEl);
	if (!prop) return false;
	return (
		isCalendarCollection(prop) && supportsCalendarComponent(prop, "VEVENT")
	);
}

async function discoverCalendarUrls(
	fetchImpl: typeof fetch,
	auth: string,
	calendarHomeUrl: string,
): Promise<string[]> {
	const { xml, finalUrl } = await appleCaldavRequest(
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
// Same redirect-following/XML-parsing plumbing as the CalDAV discovery above —
// CardDAV and CalDAV are sibling WebDAV extensions and share the same
// PROPFIND/REPORT mechanics, only the XML namespace and element names differ.
// ---------------------------------------------------------------------------

const ADDRESSBOOK_HOME_SET_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<card:addressbook-home-set/>
	</d:prop>
</d:propfind>`;

async function discoverAddressbookPrincipalUrl(
	fetchImpl: typeof fetch,
	auth: string,
): Promise<string> {
	const { xml, finalUrl } = await appleCaldavRequest(
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
	const { xml, finalUrl } = await appleCaldavRequest(
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

async function discoverAddressbookUrls(
	fetchImpl: typeof fetch,
	auth: string,
	addressbookHomeUrl: string,
): Promise<string[]> {
	const { xml, finalUrl } = await appleCaldavRequest(
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
// Read: REPORT (calendar-query) filtered by time-range, Depth 1.
// ---------------------------------------------------------------------------

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
	let body: string;
	try {
		body = calendarQueryBody(params.timeMin, params.timeMax);
	} catch (err) {
		throw new AppleCalDavError(
			err instanceof Error ? err.message : String(err),
			"request_failed",
		);
	}

	const events: CalendarEvent[] = [];
	try {
		for (const calendarUrl of calendarUrls) {
			const { xml, finalUrl } = await appleCaldavRequest(
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
// Fetch a single event by UID (Issue 6.2 write path) — a calendar-query REPORT
// filtered by a UID prop-filter, deliberately NOT reusing appleListEvents's
// time-range filter: update/delete need to resolve a target event's
// resourceHref+etag regardless of how far in the past or future it falls, which
// a bounded time-range lookup could simply miss. Searches every configured
// calendar collection and returns the first match.
// ---------------------------------------------------------------------------

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
			const { xml, finalUrl } = await appleCaldavRequest(
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
// Contacts (5.8) — CardDAV addressbook-query REPORT across every discovered
// addressbook, matched client-side (CardDAV has no reliable cross-server
// free-text search primitive worth relying on across servers, so the query is
// applied client-side — same rationale as calendar.ts not passing `query`
// through to appleListEvents).
// ---------------------------------------------------------------------------

function parseAddressbookReportMultistatus(xml: string): ParsedVCard[] {
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const cards: ParsedVCard[] = [];
	for (const responseEl of responses) {
		const prop = okPropOf(responseEl);
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

// Resolves contacts across the Apple ID's CardDAV addressbooks for the contacts
// chat tool / resolveContacts (5.8) — discovery is cached into the connection's
// config on first use, same caching posture as appleListEvents's calendarUrls.
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
			const { xml } = await appleCaldavRequest(
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
// Adapter — a cheap PROPFIND on the stored principal URL is enough to confirm
// the Apple ID + app-specific password still work, without touching any
// calendar data.
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
		await appleCaldavRequest(
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

// Not annotated as `: ConnectionAdapter` — that would narrow checkHealth's call
// signature to the interface's (secret, conn) shape and break the mocked-fetch
// tests that pass a third `{ fetch }` opts arg, same rationale as
// nextcloudFilesAdapter in providers/nextcloud-files.ts.
export const appleAdapter = {
	provider: "apple" as const,
	checkHealth,
};

registerConnectionAdapter(appleAdapter satisfies ConnectionAdapter);
