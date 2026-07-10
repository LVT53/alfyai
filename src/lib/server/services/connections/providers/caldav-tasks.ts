// Generic CalDAV VTODO read connector (Task 9a — "tasks" capability,
// provider 2 of 2). Unlike providers/apple-caldav.ts (which is hard-wired to
// iCloud's specific well-known/redirect dance), this connector takes a
// user-supplied CalDAV base URL + username + app-specific password, so it
// works against any standards-compliant server (Nextcloud, Fastmail,
// mailbox.org, Baïkal, Radicale, ...) — the same "bring your own server"
// posture as providers/nextcloud-files.ts's serverUrl. Every URL is
// validated with the shared `assertPublicHttpsUrl` SSRF guard before it is
// ever fetched.
//
// Low-level CalDAV plumbing (redirect-following PROPFIND/REPORT requests,
// the WebDAV multistatus XML parser, and the RFC 5545 line-unfolding/
// property-parsing primitives) is REUSED from providers/apple-caldav.ts
// rather than duplicated — see that module's doc comment on `DAV_NS` for why
// those exports exist and what's still owed to Task 9b (a real
// `caldav-client.ts` extraction). Only the VTODO-specific pieces (discovery
// filtered to VTODO-supporting collections, the VTODO REPORT query, and the
// VTODO field parser) are new here.
//
// Read-only by construction for v1: only ever issues PROPFIND/REPORT
// (read-only WebDAV methods). Every network call accepts an injectable
// `fetch` so this module is fully testable against mocked CalDAV endpoints.
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
import {
	AppleCalDavError,
	basicAuthHeader,
	CALDAV_NS,
	caldavRequest,
	DAV_NS,
	firstNs,
	parseICalProperty,
	parseICalTimestamp,
	parseXml,
	textOf,
	unfoldICalLines,
} from "./apple-caldav";
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

async function request(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PROPFIND" | "REPORT",
	depth: "0" | "1",
	body: string,
): Promise<{ xml: string; finalUrl: string }> {
	try {
		return await caldavRequest(fetchImpl, url, auth, method, depth, body);
	} catch (err) {
		throw toCalDavError(err);
	}
}

// ---------------------------------------------------------------------------
// Discovery: the user-supplied serverUrl -> current-user-principal ->
// calendar-home-set -> calendar collections that support VTODO. Unlike
// apple-caldav.ts's discoverAppleCalendars, there is no `.well-known` hop —
// the caller-supplied `serverUrl` IS the starting PROPFIND target (the same
// "paste your server's CalDAV URL" convention DAVx5/Thunderbird use), which
// also sidesteps needing a per-vendor well-known path.
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

async function discoverCalendarHomeUrl(
	fetchImpl: typeof fetch,
	auth: string,
	principalUrl: string,
): Promise<string> {
	const { xml, finalUrl } = await request(
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
		throw new CalDavError(
			"CalDAV discovery did not return a calendar-home-set",
			"request_failed",
		);
	}
	return new URL(homeHref, finalUrl).toString();
}

// A response entry is a VTODO-capable calendar collection when its
// resourcetype includes CALDAV:calendar AND its
// supported-calendar-component-set includes a <c:comp name="VTODO"/> — the
// VTODO analogue of apple-caldav.ts's isVeventCalendarCollection.
function isVtodoCalendarCollection(responseEl: Element): boolean {
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
	return comps.some((comp) => comp.getAttribute("name") === "VTODO");
}

async function discoverTaskListUrls(
	fetchImpl: typeof fetch,
	auth: string,
	calendarHomeUrl: string,
): Promise<string[]> {
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

	const urls: string[] = [];
	for (const responseEl of responses) {
		if (!isVtodoCalendarCollection(responseEl)) continue;
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
};

async function discoverCalDavTaskLists(
	fetchImpl: typeof fetch,
	serverUrl: string,
	username: string,
	appPassword: string,
): Promise<CalDavConfig> {
	const auth = basicAuthHeader(username, appPassword);
	const principalUrl = await discoverPrincipalUrl(fetchImpl, serverUrl, auth);
	const calendarHomeUrl = await discoverCalendarHomeUrl(
		fetchImpl,
		auth,
		principalUrl,
	);
	const taskListUrls = await discoverTaskListUrls(
		fetchImpl,
		auth,
		calendarHomeUrl,
	);
	return { serverUrl, username, principalUrl, taskListUrls };
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
	const existing = await findConnectionByAccount(
		params.userId,
		"caldav",
		params.username,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.appPassword);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config: params.config,
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
			capabilities: ["tasks"],
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

	const config = await discoverCalDavTaskLists(
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

function caldavConfig(conn: ConnectionPublic): {
	username: string;
	taskListUrls: string[];
} {
	const username =
		typeof conn.config.username === "string"
			? conn.config.username
			: conn.accountIdentifier;
	const taskListUrls = Array.isArray(conn.config.taskListUrls)
		? conn.config.taskListUrls.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	if (!username || taskListUrls.length === 0) {
		throw new CalDavError(
			"Connection is missing username or taskListUrls in its config",
			"invalid_config",
		);
	}
	return { username, taskListUrls };
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

	const { username, taskListUrls } = caldavConfig(conn);
	const auth = basicAuthHeader(username, appPassword);

	const tasks: CalDavTask[] = [];
	try {
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

	return tasks;
}

// ---------------------------------------------------------------------------
// Adapter — a cheap PROPFIND on the stored principal URL confirms the
// username/app-password still work, without touching any task data.
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
