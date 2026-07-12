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
// storage, the Apple adapter + health check, AND (Issue 6.2, co-located here by
// C2) the WRITE executor for create/update/delete of calendar events. Keeping
// read and write in one module means the Apple ID auth identity (appleIdOf) and
// the ../dav plumbing are derived once, not across a file split. The write
// executor is registered via registerWriteExecutor (Issue 6.0) so
// confirmPendingWrite (pending-writes.ts) dispatches "apple" pending writes
// here, only after the user has explicitly confirmed. Every network call
// accepts an injectable `fetch` so this module is fully testable against mocked
// endpoints.
import { createHash } from "node:crypto";
import { registerConnectionAdapter } from "../adapters";
import {
	ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY,
	ADDRESSBOOK_QUERY_BODY,
	CALDAV_NS,
	CARDDAV_NS,
	type ConditionalHeader,
	caldavRequest,
	caldavWriteRequest,
	calendarQueryBody,
	DAV_NS,
	firstNs,
	isAddressbookCollection,
	isCalendarCollection,
	okPropOf,
	type ParsedVCard,
	parseICalProperty,
	parseICalTimestamp,
	parseReportMultistatus,
	parseVCards,
	parseXml,
	supportsCalendarComponent,
	textOf,
	uidQueryBody,
	unfoldICalLines,
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
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";

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

// The Apple ID auth identity for a connection — the stored config value when
// present, else the connection's own account identifier. Derived once here and
// reused by every read/write path (appleConfig, appleSearchContacts,
// checkHealth, and the write executor's getAuthOrReauth) so the fallback rule
// lives in exactly one place.
function appleIdOf(conn: ConnectionPublic): string {
	return typeof conn.config.appleId === "string"
		? conn.config.appleId
		: conn.accountIdentifier;
}

function appleConfig(conn: ConnectionPublic): {
	appleId: string;
	calendarUrls: string[];
} {
	const appleId = appleIdOf(conn);
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

	const appleId = appleIdOf(conn);
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
	const appleId = appleIdOf(conn);
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

// ===========================================================================
// WRITE executor (Issue 6.2) — the ONLY code path that ever issues a mutating
// (PUT/DELETE) request against a user's Apple iCloud Calendar. Co-located with
// the read path above (C2) so it reuses appleIdOf and the ../dav plumbing.
//
// CalDAV has no server-enforced idempotent-create or optimistic-concurrency
// primitive beyond plain HTTP conditional requests, and iCloud's own CalDAV
// implementation is undocumented and fragile — so EVERY mutating request here
// carries a conditional header, with no exceptions:
//   - create -> `If-None-Match: *`   (only succeeds if nothing exists yet)
//   - update/delete -> `If-Match: {etag}` (only succeeds if unchanged since read)
// A 412 on create means "already created" (idempotent success, not an error);
// a 412 on update/delete means the resource changed since it was last read,
// which is surfaced as `conflict_changed` and NEVER retried/overwritten
// unconditionally. This is the whole "can't corrupt files" guarantee for this
// provider — see this module's doc comment for why iCloud's CalDAV behavior
// can't be trusted to be safe any other way.
// ===========================================================================

// Timeout error for every write-path CalDAV call — injected into ../dav's
// caldavWriteRequest so it keeps this module's exact wording. Throws a plain
// Error (not AppleCalDavError) on abort — matching the previous private
// fetchWithTimeout — because every call site already maps any thrown error to a
// request_failed write result.
const appleCalDavWriteTimeout = (ms: number) =>
	new Error(`Apple CalDAV write request timed out after ${ms}ms`);

// ---------------------------------------------------------------------------
// content parsing — the calendar tool (normal-chat-tools/calendar.ts) is the
// only producer of this shape; this module is the only consumer.
// ---------------------------------------------------------------------------

type AppleCalendarWriteEventFields = {
	summary?: string;
	start?: string;
	end?: string;
	location?: string;
	description?: string;
};

export type AppleCalendarWriteContent = {
	// Required for create_event — the collection a new .ics resource is PUT
	// into.
	calendarUrl?: string;
	// Required for update_event/delete_event — the exact resource identified
	// by the tool's propose-time fetch (appleGetEventByUid).
	resourceHref?: string;
	etag?: string;
	// Required for update_event — identifies which VEVENT block within
	// `originalIcs` (below) to patch, rather than the executor having to
	// guess it back out of resourceHref (which may not follow this module's
	// own `{uid}.ics` naming convention for an event that pre-dates this
	// connection, e.g. one created from a Mac/iPhone).
	uid?: string;
	// Required for update_event (corruption-safety fix) — the ORIGINAL
	// `calendar-data` VCALENDAR document text for the target resource,
	// exactly as iCloud returned it (the event is already fetched at propose
	// time to resolve resourceHref/etag, so this costs no extra round trip).
	// A CalDAV PUT replaces the whole resource, and this tool only ever
	// models a handful of VEVENT properties — so update PATCHES this text in
	// place (see patchVevent below) rather than regenerating a brand-new
	// VEVENT from just those fields, which would silently destroy any
	// property this schema doesn't know about (ATTENDEE/ORGANIZER/VALARM/
	// RRULE/CATEGORIES/X-*/...). Without this, executeUpdate refuses the
	// write rather than risk that.
	originalIcs?: string;
	event?: AppleCalendarWriteEventFields;
	// Set by the tool at propose time (via appleGetEventByUid's `recurrence`)
	// when the target event carries an RRULE. update_event refuses outright
	// whenever this is true — see the module doc comment on
	// executeUpdate below for why. This is a defense-in-depth check (the
	// primary guardrail lives in the calendar tool, which never even creates
	// a pending write for a recurring update): staleness between propose and
	// confirm time is still caught by the mandatory If-Match/etag check
	// above, which would 412 if the event's RRULE-ness itself changed
	// server-side in between.
	recurring?: boolean;
};

function parseContent(content: string): AppleCalendarWriteContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<AppleCalendarWriteContent>;
		return {
			...(typeof parsed.calendarUrl === "string"
				? { calendarUrl: parsed.calendarUrl }
				: {}),
			...(typeof parsed.resourceHref === "string"
				? { resourceHref: parsed.resourceHref }
				: {}),
			...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
			...(typeof parsed.uid === "string" ? { uid: parsed.uid } : {}),
			...(typeof parsed.originalIcs === "string"
				? { originalIcs: parsed.originalIcs }
				: {}),
			...(parsed.event && typeof parsed.event === "object"
				? { event: parsed.event as AppleCalendarWriteEventFields }
				: {}),
			...(typeof parsed.recurring === "boolean"
				? { recurring: parsed.recurring }
				: {}),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Deterministic client-derived UID (create idempotency) — mirrors
// google-calendar.ts's googleEventIdForOp: deriving the UID from the
// pending write's idempotencyKey (a pure function of the WriteOperation) so
// re-attempting the SAME create (a retried confirm after a crash, or a
// second pending write proposed from byte-identical tool input) always PUTs
// the exact same resource path. `If-None-Match: *` then turns iCloud's own
// 412 on that re-PUT into idempotent success rather than a silent duplicate
// event — no persisted state of its own needed, the determinism is the whole
// mechanism.
export function appleEventUidForOp(op: WriteOperation): string {
	const hash = createHash("sha256").update(idempotencyKey(op)).digest("hex");
	return `${hash}@alfyai.app`;
}

// ---------------------------------------------------------------------------
// Minimal iCalendar (RFC 5545) VEVENT serializer — hand-rolled, no
// dependency, mirroring the read-side iCal parsing in reverse. Used ONLY by
// create_event, which always generates a brand-new resource (there is no
// pre-existing content to preserve). update_event does NOT use this — see
// patchVevent below for why "regenerate the whole VEVENT from just this
// tool's minimal fields" was a corruption bug (it silently dropped ATTENDEE/
// ORGANIZER/VALARM/RRULE/CATEGORIES/X-*/... on every update) and how the fix
// instead patches the original resource's exact text in place.
// ---------------------------------------------------------------------------

const ALL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINE_OCTETS = 75;

// Raised whenever this module refuses to write ICS content rather than risk
// emitting something malformed or corrupting/dropping data — see
// assertNoLineBreak and patchVevent below. Caught at the single dispatch
// point in registerWriteExecutor's execute() and turned into a typed
// WriteExecutionResult, never left to leak as an unhandled exception.
class IcalWriteError extends Error {
	constructor(
		message: string,
		public readonly reason: "invalid_ical_value" | "missing_target",
	) {
		super(message);
		this.name = "IcalWriteError";
	}
}

// Defense-in-depth guard against ICS line-injection: any value THIS module
// interpolates directly into a NEW content line (as opposed to copying an
// existing line byte-for-byte out of an already-parsed original resource)
// must not carry a raw CR/LF — those bytes are the wire format's own line
// terminator, so an unescaped one would end the current content line and
// start a brand-new, value-controlled one (i.e. inject an extra ICS
// property/component) rather than staying inside this property's value.
// TEXT properties (SUMMARY/LOCATION/DESCRIPTION) never hit this — they
// already escape real line breaks via escapeICalText's \r/\n handling below.
// This exists for values that do NOT go through TEXT escaping, e.g. UID —
// there is no way to *safely* represent a raw line break in a non-TEXT
// property, so this rejects the write outright instead of ever emitting
// malformed/injectable ICS.
function assertNoLineBreak(value: string, field: string): string {
	if (/[\r\n]/.test(value)) {
		throw new IcalWriteError(
			`${field} contains an embedded line break and cannot be safely written to a CalDAV resource`,
			"invalid_ical_value",
		);
	}
	return value;
}

// Reverses the read-side unescapeICalText — RFC 5545 §3.3.11 TEXT
// escaping. Backslash MUST be escaped first, before the other replacements
// introduce new backslashes of their own; escaping it again afterwards would
// double-escape them. CRLF/bare-CR/bare-LF are all normalized to the same
// `\n` escape (a real embedded line break has only one valid representation
// in iCalendar TEXT) — this also closes the one gap that let a raw `\r`
// (without a paired `\n`) survive escaping and land as a literal control
// byte inside a folded content line.
function escapeICalText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\r\n/g, "\\n")
		.replace(/\r/g, "\\n")
		.replace(/\n/g, "\\n")
		.replace(/,/g, "\\,")
		.replace(/;/g, "\\;");
}

function icalDateOnly(value: string): string {
	return value.replace(/-/g, "");
}

// Always emits the UTC "basic" form (YYYYMMDDTHHMMSSZ) regardless of what
// offset/zone the input ISO string carried — this module never writes a
// TZID, mirroring parseICalTimestamp's read-side stance that resolving
// timezone offsets precisely isn't worth the complexity for this connector.
function icalUtcTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid event date/time value: ${JSON.stringify(value)}`);
	}
	return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function toICalDtProperty(name: "DTSTART" | "DTEND", value: string): string {
	return ALL_DAY_PATTERN.test(value)
		? `${name};VALUE=DATE:${icalDateOnly(value)}`
		: `${name}:${icalUtcTimestamp(value)}`;
}

// RFC 5545 §3.1 line folding: no content line may exceed 75 octets
// (UTF-8 bytes, NOT characters); continuation lines are introduced by a
// CRLF followed by a single space, and that leading space itself counts
// toward the next line's 75-octet budget. Splits on octet boundaries only —
// never inside a multi-byte UTF-8 character — by backing off while the byte
// at the candidate split point is a UTF-8 continuation byte (0b10xxxxxx).
function foldICalLine(line: string): string {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= MAX_LINE_OCTETS) return line;

	const chunks: string[] = [];
	let start = 0;
	let limit = MAX_LINE_OCTETS;
	while (start < bytes.length) {
		let end = Math.min(start + limit, bytes.length);
		while (end > start + 1 && (bytes[end] as number) >>> 6 === 0b10) end--;
		chunks.push(bytes.subarray(start, end).toString("utf8"));
		start = end;
		// Every continuation line after the first starts with one leading
		// space, which itself occupies one of the 75 octets.
		limit = MAX_LINE_OCTETS - 1;
	}
	return chunks.join("\r\n ");
}

function serializeVevent(
	uid: string,
	event: AppleCalendarWriteEventFields,
): string {
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//AlfyAI//Calendar Write 1.0//EN",
		"BEGIN:VEVENT",
		// uid is always the deterministic sha256-hex-derived value from
		// appleEventUidForOp in practice — never user/model-controlled — but
		// this is still run through the same line-break guard every other
		// interpolated value gets, on principle (see assertNoLineBreak's doc
		// comment).
		`UID:${assertNoLineBreak(uid, "uid")}`,
		`DTSTAMP:${icalUtcTimestamp(new Date().toISOString())}`,
	];
	if (event.start !== undefined)
		lines.push(toICalDtProperty("DTSTART", event.start));
	if (event.end !== undefined) lines.push(toICalDtProperty("DTEND", event.end));
	if (event.summary !== undefined) {
		lines.push(`SUMMARY:${escapeICalText(event.summary)}`);
	}
	if (event.location !== undefined) {
		lines.push(`LOCATION:${escapeICalText(event.location)}`);
	}
	if (event.description !== undefined) {
		lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
	}
	lines.push("END:VEVENT", "END:VCALENDAR");
	return `${lines.map(foldICalLine).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Preserve-and-patch VEVENT update (corruption-safety fix) — CalDAV's PUT
// replaces the WHOLE resource, so an update built by regenerating a fresh
// VEVENT from only this tool's modeled fields (SUMMARY/DTSTART/DTEND/
// LOCATION/DESCRIPTION) silently destroyed every OTHER property a
// pre-existing event carried: ATTENDEE, ORGANIZER, VALARM (reminders),
// RRULE, CATEGORIES, X-* extensions, etc. — on ANY update, including a bare
// location tweak. patchVevent instead starts from the ORIGINAL fetched ICS
// text (AppleCalendarWriteContent.originalIcs, captured by the calendar tool
// at propose time — the event is already fetched there for its etag) and
// replaces ONLY the specific top-level property lines the caller actually
// supplied, leaving every other line — including nested sub-components like
// BEGIN:VALARM..END:VALARM blocks, VTIMEZONE, and anything outside the
// target VEVENT entirely — untouched and in its original position.
// ---------------------------------------------------------------------------

// Locates the [start, end] unfolded-line indices of the BEGIN:VEVENT..
// END:VEVENT block whose UID property matches `uid` exactly (a calendar-data
// document can in principle hold more than one VEVENT, e.g. a recurring
// master plus RECURRENCE-ID overrides sharing a UID — recurring events never
// reach this function, see executeUpdate's guardrail, so matching the first
// occurrence is unambiguous for anything that does).
function findVeventBlock(
	lines: string[],
	uid: string,
): { start: number; end: number } | null {
	let blockStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === "BEGIN:VEVENT") {
			blockStart = i;
			continue;
		}
		if (lines[i] === "END:VEVENT" && blockStart !== -1) {
			const hasMatchingUid = lines.slice(blockStart + 1, i).some((line) => {
				const prop = parseICalProperty(line);
				return prop?.name === "UID" && prop.value === uid;
			});
			if (hasMatchingUid) return { start: blockStart, end: i };
			blockStart = -1;
		}
	}
	return null;
}

// The RFC 5545 ABNF for a VEVENT (`eventprop *alarmc`) puts every top-level
// property BEFORE any nested sub-component — so a newly-inserted property
// (one the original resource didn't have) must land before the first
// BEGIN:... line in the block, not merely before END:VEVENT, or it would
// come after e.g. a BEGIN:VALARM..END:VALARM block and violate that
// ordering. Falls back to just before END:VEVENT when there's no
// sub-component to avoid.
function findInsertionIndex(
	lines: string[],
	start: number,
	end: number,
): number {
	for (let i = start + 1; i < end; i++) {
		if (lines[i]?.startsWith("BEGIN:")) return i;
	}
	return end;
}

// Finds the first line index in [start, end) matching `pattern`, WITHOUT
// ever looking inside a nested sub-component (BEGIN:...END:... — e.g.
// VALARM). This is what keeps replaceOrInsert below from mistaking, say, a
// VALARM's own DESCRIPTION line for the VEVENT's top-level DESCRIPTION
// property and overwriting content inside a supposedly-untouched alarm.
function findTopLevelLineIndex(
	lines: string[],
	start: number,
	end: number,
	pattern: RegExp,
): number {
	let i = start;
	while (i < end) {
		const line = lines[i] as string;
		if (line.startsWith("BEGIN:")) {
			// Skip the entire nested sub-component (which may itself nest
			// further, hence tracking depth) before resuming the top-level scan.
			let depth = 1;
			i++;
			while (i < end && depth > 0) {
				const inner = lines[i] as string;
				if (inner.startsWith("BEGIN:")) depth++;
				else if (inner.startsWith("END:")) depth--;
				i++;
			}
			continue;
		}
		if (pattern.test(line)) return i;
		i++;
	}
	return -1;
}

// Builds the replacement DTSTART/DTEND line for an update patch — the
// two-part corruption fix for timed events:
//
//   (a) Returns undefined ("leave the original line byte-identical") when
//       `newValue` is not a GENUINE change from the original property.
//       calendar.ts always resends the existing start/end even on a
//       metadata-only edit (`start: input.start ?? existing.start`), and
//       `existing.start` is exactly parseICalTimestamp(originalLine). So a
//       rename would otherwise rewrite an unchanged DTSTART — dropping its
//       TZID and, via new Date() below, shifting the instant by the server's
//       UTC offset. Comparing against the same parse the read side produced
//       detects that no-op precisely.
//
//   (b) When the value IS a genuine change, a zone-less ("floating" or
//       TZID-local) datetime keeps its literal wall-clock digits and the
//       ORIGINAL TZID param, rather than being fed through new Date()/
//       toISOString (which reinterprets a zone-less string in the server's
//       local timezone and silently moves the event). A value carrying an
//       explicit Z (or offset) is safe to normalize to UTC; a bare date
//       becomes VALUE=DATE.
function buildDtLine(
	name: "DTSTART" | "DTEND",
	originalLine: string | undefined,
	newValue: string,
): string | undefined {
	const originalProp = originalLine ? parseICalProperty(originalLine) : null;
	if (originalProp) {
		const originalParsed = parseICalTimestamp(originalProp);
		if (originalParsed !== null && originalParsed === newValue)
			return undefined;
	}
	if (ALL_DAY_PATTERN.test(newValue)) {
		return `${name};VALUE=DATE:${icalDateOnly(newValue)}`;
	}
	// A zone-less local datetime: no trailing Z and no explicit ±HH:MM offset.
	const localMatch = newValue.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
	);
	if (localMatch) {
		const [, y, mo, d, h, mi, s] = localMatch;
		const basic = `${y}${mo}${d}T${h}${mi}${s ?? "00"}`;
		const tzid = originalProp?.params.TZID;
		return tzid ? `${name};TZID=${tzid}:${basic}` : `${name}:${basic}`;
	}
	return `${name}:${icalUtcTimestamp(newValue)}`;
}

function patchVevent(
	originalIcs: string,
	uid: string,
	event: AppleCalendarWriteEventFields,
): string {
	assertNoLineBreak(uid, "uid");
	const lines = unfoldICalLines(originalIcs);
	const block = findVeventBlock(lines, uid);
	if (!block) {
		throw new IcalWriteError(
			"Original ICS does not contain a VEVENT matching the expected UID",
			"missing_target",
		);
	}

	let end = block.end;
	let insertAt = findInsertionIndex(lines, block.start, block.end);

	// Replaces the first TOP-LEVEL line in the block matching `pattern` with
	// `newLine`; if none matches, inserts `newLine` at the ordering-safe
	// insertion point above. A `newLine` of `undefined` means the caller
	// didn't supply this field — leave the block completely untouched for it
	// (the whole point of patching rather than regenerating).
	const replaceOrInsert = (pattern: RegExp, newLine: string | undefined) => {
		if (newLine === undefined) return;
		const idx = findTopLevelLineIndex(lines, block.start + 1, end, pattern);
		if (idx !== -1) {
			lines[idx] = newLine;
			return;
		}
		lines.splice(insertAt, 0, newLine);
		insertAt += 1;
		end += 1;
	};

	// DTSTART/DTEND go through buildDtLine rather than replaceOrInsert: the
	// caller always resends the existing start/end, so a straight replace would
	// rewrite an unchanged line and lose its TZID / shift its instant. buildDtLine
	// returns undefined for a no-op change, which replaceDt honors by leaving the
	// original line byte-identical.
	const replaceDt = (
		name: "DTSTART" | "DTEND",
		pattern: RegExp,
		newValue: string | undefined,
	) => {
		if (newValue === undefined) return;
		const idx = findTopLevelLineIndex(lines, block.start + 1, end, pattern);
		const originalLine = idx !== -1 ? (lines[idx] as string) : undefined;
		const newLine = buildDtLine(name, originalLine, newValue);
		if (newLine === undefined) return;
		if (idx !== -1) {
			lines[idx] = newLine;
			return;
		}
		lines.splice(insertAt, 0, newLine);
		insertAt += 1;
		end += 1;
	};

	replaceOrInsert(
		/^SUMMARY(;|:)/i,
		event.summary !== undefined
			? `SUMMARY:${escapeICalText(event.summary)}`
			: undefined,
	);
	replaceDt("DTSTART", /^DTSTART(;|:)/i, event.start);
	replaceDt("DTEND", /^DTEND(;|:)/i, event.end);
	replaceOrInsert(
		/^LOCATION(;|:)/i,
		event.location !== undefined
			? `LOCATION:${escapeICalText(event.location)}`
			: undefined,
	);
	replaceOrInsert(
		/^DESCRIPTION(;|:)/i,
		event.description !== undefined
			? `DESCRIPTION:${escapeICalText(event.description)}`
			: undefined,
	);

	// Best-effort SEQUENCE bump — correct CalDAV/iCalendar etiquette on a
	// modification, but only when it's trivially safe: a TOP-LEVEL SEQUENCE
	// must already be present and parse cleanly as a plain integer. Never
	// inserted if absent (an absent SEQUENCE is a perfectly valid VEVENT —
	// RFC 5545 defaults it to 0) — skipping is always safe, guessing is not.
	const sequencePattern = /^SEQUENCE:(-?\d+)\s*$/i;
	const seqIdx = findTopLevelLineIndex(
		lines,
		block.start + 1,
		end,
		sequencePattern,
	);
	if (seqIdx !== -1) {
		const match = sequencePattern.exec(lines[seqIdx] as string);
		if (match) {
			lines[seqIdx] = `SEQUENCE:${Number.parseInt(match[1] as string, 10) + 1}`;
		}
	}

	return `${lines.map(foldICalLine).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// fetch plumbing
// ---------------------------------------------------------------------------

// Issues a PUT/DELETE with Basic auth and the caller's mandatory conditional
// header via ../dav's write-capable request variant, which follows iCloud's
// undocumented partition redirect the same way the read transport does for
// PROPFIND/REPORT but WITHOUT the "expect a 207 multistatus XML body"
// assumption (a write response is 200/201/204/404/410/412 with no XML body).
// The abort/timeout error factory is injected so it keeps this module's exact
// "Apple CalDAV write ..." wording.
async function appleCaldavWriteRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PUT" | "DELETE",
	conditional: ConditionalHeader,
	body?: string,
): Promise<Response> {
	return caldavWriteRequest(fetchImpl, url, auth, method, conditional, body, {
		timeoutError: appleCalDavWriteTimeout,
	});
}

// A 401 here means iCloud rejected the (stored) app-specific password for
// this specific request. Never logs/surfaces the password itself — only a
// generic detail, same posture as the read-side flagging above.
async function flagWriteNeedsReauth(
	userId: string,
	connectionId: string,
): Promise<void> {
	await updateConnection(userId, connectionId, {
		status: "needs_reauth",
		statusDetail:
			"Apple rejected the write request for this Calendar connection",
	});
}

async function getAuthOrReauth(
	userId: string,
	connectionId: string,
): Promise<
	{ ok: true; auth: string } | { ok: false; result: WriteExecutionResult }
> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		return { ok: false, result: { ok: false, reason: "connection_not_found" } };
	}
	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		return { ok: false, result: { ok: false, reason: "needs_reauth" } };
	}
	return { ok: true, auth: basicAuthHeader(appleIdOf(conn), appPassword) };
}

// ---------------------------------------------------------------------------
// create / update / delete
// ---------------------------------------------------------------------------

async function executeCreate(
	userId: string,
	connectionId: string,
	auth: string,
	op: WriteOperation,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.calendarUrl)
		return { ok: false, reason: "missing_calendar_url" };

	const uid = appleEventUidForOp(op);
	const resourceHref = `${content.calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
	const ics = serializeVevent(uid, content.event ?? {});

	const response = await appleCaldavWriteRequest(
		fetchImpl,
		resourceHref,
		auth,
		"PUT",
		{ name: "If-None-Match", value: "*" },
		ics,
	);

	if (response.status === 401) {
		await flagWriteNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (response.status === 412) {
		// The client-derived resource already exists — idempotent success, NOT
		// a double-create. Never falls back to an unconditional PUT.
		return { ok: true, detail: "already created" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	return { ok: true, etag: response.headers.get("ETag"), detail: "created" };
}

// Recurring events are refused here unconditionally (regardless of any
// scope) — CalDAV has no "this occurrence only" primitive equivalent to
// Google's expanded-instance ids, and regenerating a recurring master's whole
// VEVENT (RRULE/EXDATE/RECURRENCE-ID overrides) from this tool's minimal
// event fields would risk silently destroying the series definition. The
// calendar tool itself already refuses to even create a pending write for a
// recurring update (see normal-chat-tools/calendar.ts) — this check is
// defense-in-depth for any pending write that reaches this executor anyway.
async function executeUpdate(
	userId: string,
	connectionId: string,
	auth: string,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.resourceHref || !content.etag || !content.uid) {
		return { ok: false, reason: "missing_target" };
	}
	if (content.recurring) {
		return { ok: false, reason: "recurring_update_unsupported" };
	}
	if (!content.originalIcs) {
		// Without the original resource text there is nothing safe to patch —
		// regenerating a brand-new VEVENT from only this tool's minimal event
		// fields would silently destroy any property (ATTENDEE/ORGANIZER/
		// VALARM/RRULE/CATEGORIES/X-*/...) the pre-existing event carries that
		// this schema doesn't model. Refuse rather than risk that corruption;
		// the calendar tool always supplies this (see
		// AppleCalendarWriteContent.originalIcs's doc comment) so this only
		// fires for a malformed/legacy pending write.
		return { ok: false, reason: "missing_target" };
	}

	const ics = patchVevent(
		content.originalIcs,
		content.uid,
		content.event ?? {},
	);
	const response = await appleCaldavWriteRequest(
		fetchImpl,
		content.resourceHref,
		auth,
		"PUT",
		{ name: "If-Match", value: content.etag },
		ics,
	);

	if (response.status === 401) {
		await flagWriteNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (response.status === 412) {
		// The resource changed since it was read — NEVER retried/overwritten
		// unconditionally.
		return { ok: false, reason: "conflict_changed" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	return {
		ok: true,
		etag: response.headers.get("ETag"),
		detail: "event updated",
	};
}

async function executeDelete(
	userId: string,
	connectionId: string,
	auth: string,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.resourceHref || !content.etag) {
		return { ok: false, reason: "missing_target" };
	}

	const response = await appleCaldavWriteRequest(
		fetchImpl,
		content.resourceHref,
		auth,
		"DELETE",
		{ name: "If-Match", value: content.etag },
	);

	if (response.status === 401) {
		await flagWriteNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	// 404/410 means the resource is already gone — idempotent success, not a
	// failure to surface a second time.
	if (response.status === 404 || response.status === 410) {
		return { ok: true, detail: "already deleted" };
	}
	if (response.status === 412) {
		return { ok: false, reason: "conflict_changed" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	// Deleting a recurring event's resource removes the WHOLE series (CalDAV
	// has only one resource per series, master + overrides together) — the
	// calendar tool's preview already surfaces this before confirm; `detail`
	// here just reflects it back for anything that logs/displays the result.
	return { ok: true, detail: content.recurring ? "series deleted" : "deleted" };
}

// ---------------------------------------------------------------------------
// registration (Issue 6.0) — imported for its side effect by pending-writes
// .ts, the same way providers/nextcloud-files.ts is (see the comment above
// that import for why this needs to happen on that exact import path).
// ---------------------------------------------------------------------------

registerWriteExecutor({
	provider: "apple",
	async execute(userId, connectionId, op, content, opts) {
		const parsed = parseContent(content);
		if (!parsed) return { ok: false, reason: "unsupported_operation" };

		try {
			const authResult = await getAuthOrReauth(userId, connectionId);
			if (!authResult.ok) return authResult.result;

			switch (op.action) {
				case "calendar.create_event":
					// Every branch is explicitly `await`ed (rather than returned as a
					// bare promise) so a SYNCHRONOUS throw inside these functions
					// (icalUtcTimestamp on an invalid date, patchVevent's
					// IcalWriteError, etc.) becomes a rejection of THIS async
					// function's own execution — which the surrounding try/catch can
					// actually intercept. Returning the promise unawaited would let
					// its eventual rejection propagate past this catch entirely.
					return await executeCreate(
						userId,
						connectionId,
						authResult.auth,
						op,
						parsed,
						opts,
					);
				case "calendar.update_event":
					return await executeUpdate(
						userId,
						connectionId,
						authResult.auth,
						parsed,
						opts,
					);
				case "calendar.delete_event":
					return await executeDelete(
						userId,
						connectionId,
						authResult.auth,
						parsed,
						opts,
					);
				default:
					return { ok: false, reason: "unsupported_operation" };
			}
		} catch (err) {
			// IcalWriteError is a deliberate refusal (an unsafe-to-write value, or
			// an original resource patchVevent couldn't locate the target VEVENT
			// in) — surface its specific typed reason rather than the generic
			// fallback below.
			if (err instanceof IcalWriteError) {
				return { ok: false, reason: err.reason };
			}
			// Anything else — caldavWriteRequest throws on a timeout/redirect-loop
			// /missing Location header, icalUtcTimestamp throws on an invalid
			// date — none of those are the user's fault, and none of them should
			// ever leak internals (or the app-specific password, which never
			// appears in these error messages to begin with) back through the
			// confirm response.
			return { ok: false, reason: "request_failed" };
		}
	},
});
