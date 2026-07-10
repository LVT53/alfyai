// Generic CalDAV/CardDAV connector — "caldav" provider, serving tasks
// (VTODO, Task 9a), calendar (VEVENT, Task 9b), and contacts (CardDAV vCard,
// Task 9b). Unlike providers/apple-caldav.ts (which is hard-wired to
// iCloud's specific well-known/redirect dance, and discovers calendar and
// addressbook resources through two entirely separate well-known entry
// points), this connector takes a user-supplied CalDAV base URL + username +
// app-specific password, so it works against any standards-compliant server
// (Nextcloud, Fastmail, mailbox.org, Baïkal, Radicale, ...) — the same
// "bring your own server" posture as providers/nextcloud-files.ts's
// serverUrl. Every URL is validated with the shared `assertPublicHttpsUrl`
// SSRF guard before it is ever fetched.
//
// Discovery (Task 9b) runs once, at connect time: the caller-supplied
// serverUrl -> current-user-principal -> ONE PROPFIND against the principal
// asking for BOTH calendar-home-set (CalDAV) and addressbook-home-set
// (CardDAV) -> collection enumeration under each home set that was found.
// A standards server exposes both DAV properties on the same principal
// resource, so — unlike Apple's two independent well-known chains — a
// single combined PROPFIND covers both. Either home-set (or both) may be
// absent (e.g. a CalDAV-only server with no CardDAV support): that narrows
// which of tasks/calendar/contacts this connection ends up serving, and only
// finding literally nothing under either home set is treated as a connect
// failure. The connection's `capabilities` are derived directly from what
// discovery found (see capabilitiesFromConfig below) — the same "capability
// reflects what was actually granted/discovered" posture as
// providers/google.ts's capabilitiesFromScope.
//
// Low-level CalDAV/CardDAV plumbing (redirect-following PROPFIND/REPORT
// requests, the WebDAV multistatus XML parser, the RFC 5545 line-unfolding/
// property-parsing primitives, the VEVENT/vCard readers and their REPORT
// query bodies, and the collection-type filters) is REUSED from
// providers/apple-caldav.ts rather than duplicated — every export this
// module pulls from there was already used by Apple's own CalDAV/CardDAV
// reads, widened (Task 9b) with `export` keywords and, where a caller needs
// to vary error-message branding, an optional labels argument — with zero
// behavior change to any existing apple-caldav.ts call site (see
// fetchWithTimeout/caldavRequest's doc comments there). Only the pieces
// genuinely specific to a generic (non-iCloud) connection — the
// serverUrl-rooted discovery chain, the combined home-set PROPFIND, the
// VTODO-specific parser, and this module's own CalDavError type — are new
// here.
//
// Read-only by construction for v1: only ever issues PROPFIND/REPORT
// (read-only WebDAV methods). Every network call accepts an injectable
// `fetch` so this module is fully testable against mocked CalDAV/CardDAV
// endpoints.
import { registerConnectionAdapter } from "../adapters";
import type { Capability, ConnectionAdapter } from "../registry";
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
	ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY,
	ADDRESSBOOK_QUERY_BODY,
	AppleCalDavError,
	basicAuthHeader,
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
	parseICalProperty,
	parseICalTimestamp,
	parseReportMultistatus,
	parseVCards,
	parseXml,
	supportsCalendarComponent,
	textOf,
	uidQueryBody,
	unfoldICalLines,
} from "./apple-caldav";
// Type-only, same rationale as apple-caldav.ts's own import of this type
// (see that module's doc comment on the ContactMatch import above
// appleSearchContacts): erased at compile time, so it creates no runtime
// circular dependency with providers/contacts.ts importing
// caldavSearchContacts from this module.
import type { ContactMatch } from "./contacts";
import type { CalendarEvent } from "./google-calendar";
import { assertPublicHttpsUrl } from "./nextcloud-files";

type FetchOpt = { fetch?: typeof fetch };

export type CalDavErrorCode =
	| "invalid_credentials"
	| "needs_reauth"
	| "invalid_config"
	| "request_failed"
	| "connection_not_found";

export class CalDavError extends Error {
	constructor(
		message: string,
		public readonly code: CalDavErrorCode,
	) {
		super(message);
		this.name = "CalDavError";
	}
}

// caldavRequest/fetchWithTimeout (reused from apple-caldav.ts) always throw
// AppleCalDavError, not CalDavError — this connector's own error type. Every
// call site below routes its low-level request through this adapter so the
// rest of the module (and every caller) only ever sees CalDavError, keeping
// AppleCalDavError an apple-caldav.ts-internal-turned-shared implementation
// detail rather than a public-facing type of this module.
function toCalDavError(err: unknown): CalDavError {
	if (err instanceof AppleCalDavError) {
		return new CalDavError(err.message, err.code);
	}
	return new CalDavError(
		err instanceof Error ? err.message : String(err),
		"request_failed",
	);
}

// Wraps apple-caldav.ts's shared caldavRequest with GENERIC error-message
// branding (Task 9b, folded-in review minor 5a): without the `labels`
// argument, caldavRequest's 401/timeout/redirect/status-failed messages read
// "Apple CalDAV ..." / "Apple rejected the Apple ID or app-specific
// password" — wording that leaked verbatim into a Nextcloud/Fastmail/Baïkal
// user's connect-wizard and health-check error text (these routes return
// `err.message` directly, see routes/api/connections/caldav/start/+server
// .ts). Every call site in this module goes through this ONE wrapper, so the
// generic branding is applied exactly once rather than at every call site.
async function request(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PROPFIND" | "REPORT",
	depth: "0" | "1",
	body: string,
): Promise<{ xml: string; finalUrl: string }> {
	try {
		return await caldavRequest(fetchImpl, url, auth, method, depth, body, {
			requestLabel: "CalDAV",
			credentialsRejectedMessage:
				"The server rejected the username or app password",
		});
	} catch (err) {
		throw toCalDavError(err);
	}
}

// Shared needs_reauth mapping (Task 9b DRY pass) for every read (tasks,
// events, event-by-uid, contacts): each of those reads a live app password
// out of the store and then issues one or more `request()` calls against the
// caller's server, so an `invalid_credentials` response can surface at any
// point in that read. Rather than duplicating the "mark the connection
// needs_reauth, then rethrow a needs_reauth CalDavError with the same
// user-facing detail" logic at every call site, every read routes its body
// through this one wrapper — any other error (including any other
// CalDavError code) passes through unchanged.
async function withReauthMapping<T>(
	userId: string,
	connectionId: string,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof CalDavError && err.code === "invalid_credentials") {
			const detail = "The server rejected the stored app password";
			await updateConnection(userId, connectionId, {
				status: "needs_reauth",
				statusDetail: detail,
			});
			throw new CalDavError(detail, "needs_reauth");
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Discovery: the user-supplied serverUrl -> current-user-principal -> (ONE
// combined PROPFIND for) calendar-home-set + addressbook-home-set ->
// collection enumeration under each home set found. Unlike
// apple-caldav.ts's discoverAppleCalendars/discoverAppleAddressbooks (two
// entirely independent well-known chains), there is no `.well-known` hop —
// the caller-supplied `serverUrl` IS the starting PROPFIND target (the same
// "paste your server's CalDAV URL" convention DAVx5/Thunderbird use), and a
// single principal resource on a standards server exposes both DAV
// properties, so one home-set PROPFIND covers both CalDAV and CardDAV.
// ---------------------------------------------------------------------------

const PRINCIPAL_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
	<d:prop>
		<d:current-user-principal/>
	</d:prop>
</d:propfind>`;

// Requests calendar-home-set AND addressbook-home-set in a single PROPFIND —
// see this module's doc comment for why one request covers both here, unlike
// apple-caldav.ts's two separate discovery chains.
const HOME_SETS_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<c:calendar-home-set/>
		<card:addressbook-home-set/>
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
	serverUrl: string,
	auth: string,
): Promise<string> {
	const { xml, finalUrl } = await request(
		fetchImpl,
		serverUrl,
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
		throw new CalDavError(
			"CalDAV discovery did not return a current-user-principal",
			"request_failed",
		);
	}
	return new URL(principalHref, finalUrl).toString();
}

// Either home-set (or both) may be genuinely absent — e.g. a CalDAV-only
// server with no CardDAV support at all returns no addressbook-home-set
// property, which is NOT an error here (contrast with Apple's
// discoverCalendarHomeUrl, which treats a missing calendar-home-set as
// fatal): the caller (discoverCalDavResources below) only fails the whole
// connect if NEITHER home set — and therefore nothing at all — was found.
async function discoverHomeSets(
	fetchImpl: typeof fetch,
	auth: string,
	principalUrl: string,
): Promise<{
	calendarHomeUrl: string | null;
	addressbookHomeUrl: string | null;
}> {
	const { xml, finalUrl } = await request(
		fetchImpl,
		principalUrl,
		auth,
		"PROPFIND",
		"0",
		HOME_SETS_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const calendarHomeHref = textOf(
		firstNs(
			firstNs(doc, CALDAV_NS, "calendar-home-set") ?? doc,
			DAV_NS,
			"href",
		),
	);
	const addressbookHomeHref = textOf(
		firstNs(
			firstNs(doc, CARDDAV_NS, "addressbook-home-set") ?? doc,
			DAV_NS,
			"href",
		),
	);
	return {
		calendarHomeUrl: calendarHomeHref
			? new URL(calendarHomeHref, finalUrl).toString()
			: null,
		addressbookHomeUrl: addressbookHomeHref
			? new URL(addressbookHomeHref, finalUrl).toString()
			: null,
	};
}

// A single PROPFIND under calendarHomeUrl enumerates every collection once,
// then classifies each by its supported-calendar-component-set: a
// collection supporting VTODO goes into taskListUrls, one supporting VEVENT
// goes into calendarUrls — a collection supporting BOTH (some servers put
// events and to-dos in one calendar) correctly lands in both lists, rather
// than needing two separate PROPFINDs the way discovering VTODO-only (9a)
// and VEVENT-only used to be treated as unrelated concerns.
async function discoverCalendarCollections(
	fetchImpl: typeof fetch,
	auth: string,
	calendarHomeUrl: string,
): Promise<{ taskListUrls: string[]; calendarUrls: string[] }> {
	const { xml, finalUrl } = await request(
		fetchImpl,
		calendarHomeUrl,
		auth,
		"PROPFIND",
		"1",
		COLLECTIONS_PROPFIND_BODY,
	);
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const taskListUrls: string[] = [];
	const calendarUrls: string[] = [];
	for (const responseEl of responses) {
		const prop = okPropOf(responseEl);
		if (!prop || !isCalendarCollection(prop)) continue;
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		const url = new URL(href, finalUrl).toString();
		if (supportsCalendarComponent(prop, "VTODO")) taskListUrls.push(url);
		if (supportsCalendarComponent(prop, "VEVENT")) calendarUrls.push(url);
	}
	return { taskListUrls, calendarUrls };
}

async function discoverAddressbookUrls(
	fetchImpl: typeof fetch,
	auth: string,
	addressbookHomeUrl: string,
): Promise<string[]> {
	const { xml, finalUrl } = await request(
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

export type CalDavConfig = {
	serverUrl: string;
	username: string;
	principalUrl: string;
	taskListUrls: string[];
	// calendarUrls/addressbookUrls (Task 9b) — VEVENT-supporting calendar
	// collections and CardDAV addressbook collections, respectively. Either
	// (or both) may be an empty array when the server doesn't expose that
	// kind of resource; capabilitiesFromConfig below reflects that directly
	// in what the connection is enabled for.
	calendarUrls: string[];
	addressbookUrls: string[];
};

async function discoverCalDavResources(
	fetchImpl: typeof fetch,
	serverUrl: string,
	username: string,
	appPassword: string,
): Promise<CalDavConfig> {
	const auth = basicAuthHeader(username, appPassword);
	const principalUrl = await discoverPrincipalUrl(fetchImpl, serverUrl, auth);
	const { calendarHomeUrl, addressbookHomeUrl } = await discoverHomeSets(
		fetchImpl,
		auth,
		principalUrl,
	);

	let taskListUrls: string[] = [];
	let calendarUrls: string[] = [];
	if (calendarHomeUrl) {
		({ taskListUrls, calendarUrls } = await discoverCalendarCollections(
			fetchImpl,
			auth,
			calendarHomeUrl,
		));
	}

	let addressbookUrls: string[] = [];
	if (addressbookHomeUrl) {
		addressbookUrls = await discoverAddressbookUrls(
			fetchImpl,
			auth,
			addressbookHomeUrl,
		);
	}

	if (
		taskListUrls.length === 0 &&
		calendarUrls.length === 0 &&
		addressbookUrls.length === 0
	) {
		throw new CalDavError(
			"CalDAV discovery did not find any calendars, task lists, or addressbooks on this server",
			"request_failed",
		);
	}

	return {
		serverUrl,
		username,
		principalUrl,
		taskListUrls,
		calendarUrls,
		addressbookUrls,
	};
}

// Derives the connection's capabilities directly from what discovery found —
// the same "capability reflects what was actually granted/discovered"
// posture as providers/google.ts's capabilitiesFromScope (there, reversed
// against the OAuth scope string; here, against non-empty discovered URL
// lists). A caldav connection therefore only ever ends up enabled for the
// capabilities its specific server actually supports.
function capabilitiesFromConfig(config: CalDavConfig): Capability[] {
	const capabilities: Capability[] = [];
	if (config.taskListUrls.length > 0) capabilities.push("tasks");
	if (config.calendarUrls.length > 0) capabilities.push("calendar");
	if (config.addressbookUrls.length > 0) capabilities.push("contacts");
	return capabilities;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function upsertCalDavConnection(params: {
	userId: string;
	username: string;
	appPassword: string;
	config: CalDavConfig;
}): Promise<ConnectionPublic> {
	const discoveredCapabilities = capabilitiesFromConfig(params.config);
	const existing = await findConnectionByAccount(
		params.userId,
		"caldav",
		params.username,
	);
	if (existing) {
		// Union with whatever was already enabled (mirrors
		// providers/google.ts's upsertGoogleConnection merge posture) — a
		// re-connect that happens to hit a moment when a collection is
		// temporarily unreachable never SILENTLY narrows what the connection
		// is enabled for.
		const mergedCapabilities = [
			...new Set([...existing.capabilities, ...discoveredCapabilities]),
		];
		await setConnectionSecret(params.userId, existing.id, params.appPassword);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
			capabilities: mergedCapabilities,
		});
		if (!updated)
			throw new Error("Failed to update existing CalDAV connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "caldav",
			label: "CalDAV",
			accountIdentifier: params.username,
			capabilities: discoveredCapabilities,
			status: "connected",
			secret: params.appPassword,
			config: params.config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent connect attempt — same pattern as
		// apple-caldav.ts's/github.ts's upsert helper.
		const raced = await findConnectionByAccount(
			params.userId,
			"caldav",
			params.username,
		);
		if (!raced) throw err;
		const mergedCapabilities = [
			...new Set([...raced.capabilities, ...discoveredCapabilities]),
		];
		await setConnectionSecret(params.userId, raced.id, params.appPassword);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
			capabilities: mergedCapabilities,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function caldavConnect(
	params: {
		userId: string;
		serverUrl: string;
		username: string;
		appPassword: string;
	} & FetchOpt,
): Promise<{ connection: ConnectionPublic }> {
	const username = params.username.trim();
	const appPassword = params.appPassword.trim();
	if (!username || !appPassword) {
		throw new CalDavError(
			"A username and app password are required",
			"invalid_config",
		);
	}
	let serverUrl: string;
	try {
		serverUrl = assertPublicHttpsUrl(params.serverUrl);
	} catch (err) {
		throw new CalDavError(
			err instanceof Error ? err.message : String(err),
			"invalid_config",
		);
	}
	const fetchImpl = params.fetch ?? fetch;

	const config = await discoverCalDavResources(
		fetchImpl,
		serverUrl,
		username,
		appPassword,
	);
	const connection = await upsertCalDavConnection({
		userId: params.userId,
		username,
		appPassword,
		config,
	});
	return { connection };
}

// ---------------------------------------------------------------------------
// VTODO (RFC 5545 §3.6.2) parser — hand-rolled, reusing apple-caldav.ts's
// generic line-unfolding/property-parsing primitives (unfoldICalLines,
// parseICalProperty, parseICalTimestamp), mirroring how that module's own
// parseICalEvents scans BEGIN/END:VEVENT blocks, just for BEGIN/END:VTODO
// and the VTODO-specific fields (DUE/STATUS/PRIORITY instead of
// DTSTART/DTEND).
// ---------------------------------------------------------------------------

function unescapeICalText(value: string): string {
	return value.replace(/\\(.)/g, (_match, ch: string) => {
		if (ch === "n" || ch === "N") return "\n";
		return ch;
	});
}

export type ParsedICalTodo = {
	uid: string;
	summary?: string;
	description?: string;
	due?: string;
	status?: string;
	priority?: number;
};

export function parseICalTodos(icsText: string): ParsedICalTodo[] {
	const lines = unfoldICalLines(icsText);
	const todos: ParsedICalTodo[] = [];

	let inTodo = false;
	let uid: string | undefined;
	let summary: string | undefined;
	let description: string | undefined;
	let due: string | undefined;
	let status: string | undefined;
	let priority: number | undefined;

	for (const line of lines) {
		if (line === "BEGIN:VTODO") {
			inTodo = true;
			uid = undefined;
			summary = undefined;
			description = undefined;
			due = undefined;
			status = undefined;
			priority = undefined;
			continue;
		}
		if (line === "END:VTODO") {
			if (inTodo && uid) {
				todos.push({
					uid,
					...(summary !== undefined ? { summary } : {}),
					...(description !== undefined ? { description } : {}),
					...(due !== undefined ? { due } : {}),
					...(status !== undefined ? { status } : {}),
					...(priority !== undefined ? { priority } : {}),
				});
			}
			inTodo = false;
			continue;
		}
		if (!inTodo) continue;

		const prop = parseICalProperty(line);
		if (!prop) continue;
		switch (prop.name) {
			case "UID":
				uid = prop.value;
				break;
			case "SUMMARY":
				summary = unescapeICalText(prop.value);
				break;
			case "DESCRIPTION":
				description = unescapeICalText(prop.value);
				break;
			case "DUE": {
				const parsed = parseICalTimestamp(prop);
				if (parsed) due = parsed;
				break;
			}
			case "STATUS":
				status = prop.value.trim();
				break;
			case "PRIORITY": {
				const parsed = Number.parseInt(prop.value.trim(), 10);
				if (Number.isFinite(parsed)) priority = parsed;
				break;
			}
			default:
				break;
		}
	}

	return todos;
}

// ---------------------------------------------------------------------------
// Read: REPORT (calendar-query) filtered to VTODO, across every discovered
// task list.
// ---------------------------------------------------------------------------

const VTODO_QUERY_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data/>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VTODO"/>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;

export type CalDavTask = {
	id: string;
	summary: string;
	description?: string;
	due?: string;
	status?: string;
	priority?: number;
	url: string;
};

function parseTodoReportMultistatus(
	xml: string,
	finalUrl: string,
): CalDavTask[] {
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const tasks: CalDavTask[] = [];
	for (const responseEl of responses) {
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		const prop = okPropOf(responseEl);
		if (!prop) continue;

		const calendarData = textOf(firstNs(prop, CALDAV_NS, "calendar-data"));
		if (!calendarData) continue;

		const absoluteHref = new URL(href, finalUrl).toString();
		for (const parsed of parseICalTodos(calendarData)) {
			tasks.push({
				id: parsed.uid,
				summary: parsed.summary ?? "",
				...(parsed.description ? { description: parsed.description } : {}),
				...(parsed.due ? { due: parsed.due } : {}),
				...(parsed.status ? { status: parsed.status } : {}),
				...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
				url: absoluteHref,
			});
		}
	}
	return tasks;
}

// Shared read-config extraction (Task 9b DRY pass) for every per-resource
// read function below: each derives `username` (falling back to the
// connection's accountIdentifier, same as checkHealth does) and a filtered
// array of URL-config strings for one config field, then throws
// `invalid_config` with a field-specific detail if either turns out empty.
// The only per-resource-type variation was WHICH config field to read and
// WHAT noun to name in the error string — both now passed in by the caller
// instead of being copy-pasted three times.
function caldavResourceConfig(
	conn: ConnectionPublic,
	field: "taskListUrls" | "calendarUrls" | "addressbookUrls",
	noun: string,
): { username: string; urls: string[] } {
	const username =
		typeof conn.config.username === "string"
			? conn.config.username
			: conn.accountIdentifier;
	const rawUrls = conn.config[field];
	const urls = Array.isArray(rawUrls)
		? rawUrls.filter((value): value is string => typeof value === "string")
		: [];
	if (!username || urls.length === 0) {
		throw new CalDavError(
			`Connection is missing username or ${noun} in its config`,
			"invalid_config",
		);
	}
	return { username, urls };
}

export async function caldavListTasks(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<CalDavTask[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new CalDavError(
			"CalDAV connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new CalDavError(
			"No app password stored for this CalDAV connection",
			"needs_reauth",
		);
	}

	const { username, urls: taskListUrls } = caldavResourceConfig(
		conn,
		"taskListUrls",
		"taskListUrls",
	);
	const auth = basicAuthHeader(username, appPassword);

	return await withReauthMapping(userId, connectionId, async () => {
		const tasks: CalDavTask[] = [];
		for (const taskListUrl of taskListUrls) {
			const { xml, finalUrl } = await request(
				fetchImpl,
				taskListUrl,
				auth,
				"REPORT",
				"1",
				VTODO_QUERY_BODY,
			);
			tasks.push(...parseTodoReportMultistatus(xml, finalUrl));
		}
		return tasks;
	});
}

// ---------------------------------------------------------------------------
// Calendar read (Task 9b) — REPORT (calendar-query) across every discovered
// VEVENT-supporting calendar collection, and a UID-scoped lookup for a
// single event. Both reuse apple-caldav.ts's exported calendarQueryBody/
// uidQueryBody/parseReportMultistatus — the exact same REPORT bodies and
// multistatus parsing Apple's own appleListEvents/appleGetEventByUid use
// (see that module's doc comments on `expand` and on the UID prop-filter);
// the XML shape and CalDAV semantics here are standard, not Apple-specific.
// ---------------------------------------------------------------------------

export async function caldavListEvents(
	userId: string,
	connectionId: string,
	params: { timeMin: string; timeMax: string },
	opts?: FetchOpt,
): Promise<CalendarEvent[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new CalDavError(
			"CalDAV connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new CalDavError(
			"No app password stored for this CalDAV connection",
			"needs_reauth",
		);
	}

	const { username, urls: calendarUrls } = caldavResourceConfig(
		conn,
		"calendarUrls",
		"calendarUrls",
	);
	const auth = basicAuthHeader(username, appPassword);
	let body: string;
	try {
		body = calendarQueryBody(params.timeMin, params.timeMax);
	} catch (err) {
		throw toCalDavError(err);
	}

	return await withReauthMapping(userId, connectionId, async () => {
		const events: CalendarEvent[] = [];
		for (const calendarUrl of calendarUrls) {
			const { xml, finalUrl } = await request(
				fetchImpl,
				calendarUrl,
				auth,
				"REPORT",
				"1",
				body,
			);
			events.push(...parseReportMultistatus(xml, finalUrl));
		}
		return events.sort((a, b) => a.start.localeCompare(b.start));
	});
}

export async function caldavGetEventByUid(
	userId: string,
	connectionId: string,
	uid: string,
	opts?: FetchOpt,
): Promise<CalendarEvent | null> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new CalDavError(
			"CalDAV connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new CalDavError(
			"No app password stored for this CalDAV connection",
			"needs_reauth",
		);
	}

	const { username, urls: calendarUrls } = caldavResourceConfig(
		conn,
		"calendarUrls",
		"calendarUrls",
	);
	const auth = basicAuthHeader(username, appPassword);
	const body = uidQueryBody(uid);

	return await withReauthMapping(userId, connectionId, async () => {
		for (const calendarUrl of calendarUrls) {
			const { xml, finalUrl } = await request(
				fetchImpl,
				calendarUrl,
				auth,
				"REPORT",
				"1",
				body,
			);
			// Defense in depth beyond the server-side UID filter — same
			// rationale as appleGetEventByUid's identical check.
			const match = parseReportMultistatus(xml, finalUrl).find(
				(event) => event.id === uid,
			);
			if (match) return match;
		}
		return null;
	});
}

// ---------------------------------------------------------------------------
// Contacts read (Task 9b) — CardDAV addressbook-query REPORT across every
// discovered addressbook collection, matched client-side (same rationale as
// appleSearchContacts: CardDAV has no reliable cross-server free-text search
// primitive). Reuses apple-caldav.ts's exported ADDRESSBOOK_QUERY_BODY/
// parseVCards — the vCard shape and CardDAV semantics here are standard, not
// Apple-specific.
// ---------------------------------------------------------------------------

function parseAddressbookReport(xml: string): ParsedVCard[] {
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

// Resolves contacts across the connection's CardDAV addressbooks for the
// contacts chat tool / resolveContacts (providers/contacts.ts) — matching is
// client-side (FN or any EMAIL contains `query`, case-insensitive), same
// posture and rationale as appleSearchContacts.
export async function caldavSearchContacts(
	userId: string,
	connectionId: string,
	params: { query: string; limit?: number },
	opts?: FetchOpt,
): Promise<ContactMatch[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		throw new CalDavError(
			"CalDAV connection not found",
			"connection_not_found",
		);
	}

	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		throw new CalDavError(
			"No app password stored for this CalDAV connection",
			"needs_reauth",
		);
	}

	const { username, urls: addressbookUrls } = caldavResourceConfig(
		conn,
		"addressbookUrls",
		"addressbookUrls",
	);
	const auth = basicAuthHeader(username, appPassword);
	const limit = params.limit ?? 10;
	const query = params.query.trim().toLowerCase();

	return await withReauthMapping(userId, connectionId, async () => {
		const matches: ContactMatch[] = [];
		for (const addressbookUrl of addressbookUrls) {
			const { xml } = await request(
				fetchImpl,
				addressbookUrl,
				auth,
				"REPORT",
				"1",
				ADDRESSBOOK_QUERY_BODY,
			);
			for (const card of parseAddressbookReport(xml)) {
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
					source: "caldav",
					account: conn.accountIdentifier,
				});
				if (matches.length >= limit) return matches;
			}
		}
		return matches;
	});
}

// ---------------------------------------------------------------------------
// Adapter — a cheap PROPFIND on the stored principal URL confirms the
// username/app-password still work, without touching any task/event/contact
// data.
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
	const username =
		typeof conn.config.username === "string"
			? conn.config.username
			: conn.accountIdentifier;
	if (!principalUrl || !username) {
		return {
			status: "error",
			detail: "Connection is missing principalUrl or username in its config",
		};
	}

	try {
		await request(
			fetchImpl,
			principalUrl,
			basicAuthHeader(username, secret),
			"PROPFIND",
			"0",
			PRINCIPAL_PROPFIND_BODY,
		);
		return { status: "connected", detail: null };
	} catch (err) {
		if (err instanceof CalDavError && err.code === "invalid_credentials") {
			return {
				status: "needs_reauth",
				detail: "The server rejected the stored app password",
			};
		}
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// Not annotated as `: ConnectionAdapter` — same rationale as appleAdapter in
// providers/apple-caldav.ts: that annotation would narrow checkHealth's call
// signature to the interface's (secret, conn) shape and break the
// mocked-fetch tests that pass a third `{ fetch }` opts arg.
export const caldavAdapter = {
	provider: "caldav" as const,
	requiresSecret: true,
	checkHealth,
};

registerConnectionAdapter(caldavAdapter satisfies ConnectionAdapter);
