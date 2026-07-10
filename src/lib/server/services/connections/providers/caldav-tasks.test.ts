import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-connections-caldav-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

function xmlResponse(status: number, xml: string): Response {
	return new Response(xml, {
		status,
		headers: { "Content-Type": "application/xml" },
	});
}

const SERVER_INPUT = "https://dav.example.com/remote.php/dav/";
const SERVER = "https://dav.example.com/remote.php/dav";
const USERNAME = "alice";
const APP_PASSWORD = "app-password-123";

const PRINCIPAL_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/dav/principals/users/alice/</d:href>
		<d:propstat>
			<d:prop>
				<d:current-user-principal><d:href>/dav/principals/users/alice/</d:href></d:current-user-principal>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

// Calendar-home-set only — no addressbook-home-set — so the discovery tests
// below exercise the "this server has no CardDAV support" lenient path (see
// discoverHomeSets's doc comment in caldav-tasks.ts): addressbookUrls stays
// empty and "contacts" is not among the discovered capabilities.
const HOME_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/dav/principals/users/alice/</d:href>
		<d:propstat>
			<d:prop>
				<c:calendar-home-set><d:href>/dav/calendars/alice/</d:href></c:calendar-home-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

// Both calendar-home-set AND addressbook-home-set — used by the "discovers
// tasks + calendar + contacts capabilities" test below to exercise the full
// combined-PROPFIND discovery path.
const HOME_XML_WITH_ADDRESSBOOK = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/dav/principals/users/alice/</d:href>
		<d:propstat>
			<d:prop>
				<c:calendar-home-set><d:href>/dav/calendars/alice/</d:href></c:calendar-home-set>
				<card:addressbook-home-set><d:href>/dav/addressbooks/alice/</d:href></card:addressbook-home-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

const ADDRESSBOOK_COLLECTIONS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/dav/addressbooks/alice/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/></d:resourcetype>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/dav/addressbooks/alice/contacts/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
				<d:displayname>Contacts</d:displayname>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

const COLLECTIONS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/dav/calendars/alice/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/></d:resourcetype>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/dav/calendars/alice/tasks/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
				<d:displayname>Tasks</d:displayname>
				<c:supported-calendar-component-set>
					<c:comp name="VTODO"/>
				</c:supported-calendar-component-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/dav/calendars/alice/personal/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
				<d:displayname>Personal</d:displayname>
				<c:supported-calendar-component-set>
					<c:comp name="VEVENT"/>
				</c:supported-calendar-component-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

function discoveryFetchMock(appPassword = APP_PASSWORD) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(
			`Basic ${Buffer.from(`${USERNAME}:${appPassword}`).toString("base64")}`,
		);

		if (url === SERVER) {
			expect(init?.method).toBe("PROPFIND");
			return xmlResponse(207, PRINCIPAL_XML);
		}
		if (url === "https://dav.example.com/dav/principals/users/alice/") {
			return xmlResponse(207, HOME_XML);
		}
		if (url === "https://dav.example.com/dav/calendars/alice/") {
			return xmlResponse(207, COLLECTIONS_XML);
		}
		throw new Error(`Unexpected fetch to ${url}`);
	});
}

// ---------------------------------------------------------------------------
// caldavConnect
// ---------------------------------------------------------------------------

describe("caldavConnect", () => {
	it("discovers task lists AND calendars (filtering by supported-calendar-component-set) and stores encrypted secret", async () => {
		seedUser("userA");
		const { caldavConnect } = await import("./caldav-tasks");
		const { getConnectionSecret } = await import("../store");

		const { connection } = await caldavConnect({
			userId: "userA",
			serverUrl: SERVER_INPUT,
			username: USERNAME,
			appPassword: APP_PASSWORD,
			fetch: discoveryFetchMock() as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("caldav");
		expect(connection.accountIdentifier).toBe(USERNAME);
		// The COLLECTIONS_XML fixture has one VTODO calendar ("tasks") and one
		// VEVENT calendar ("personal") — no addressbook-home-set at all (see
		// HOME_XML), so "contacts" is correctly absent.
		expect(connection.capabilities).toEqual(["tasks", "calendar"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect(JSON.stringify(connection)).not.toContain(APP_PASSWORD);
		expect(connection.config.taskListUrls).toEqual([
			"https://dav.example.com/dav/calendars/alice/tasks/",
		]);
		expect(connection.config.calendarUrls).toEqual([
			"https://dav.example.com/dav/calendars/alice/personal/",
		]);
		expect(connection.config.addressbookUrls).toEqual([]);

		const decrypted = await getConnectionSecret("userA", connection.id);
		expect(decrypted).toBe(APP_PASSWORD);
	});

	it("also discovers addressbooks (contacts capability) when the server exposes an addressbook-home-set", async () => {
		seedUser("userA");
		const { caldavConnect } = await import("./caldav-tasks");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from(`${USERNAME}:${APP_PASSWORD}`).toString("base64")}`,
				);
				if (url === SERVER) return xmlResponse(207, PRINCIPAL_XML);
				if (url === "https://dav.example.com/dav/principals/users/alice/") {
					return xmlResponse(207, HOME_XML_WITH_ADDRESSBOOK);
				}
				if (url === "https://dav.example.com/dav/calendars/alice/") {
					return xmlResponse(207, COLLECTIONS_XML);
				}
				if (url === "https://dav.example.com/dav/addressbooks/alice/") {
					return xmlResponse(207, ADDRESSBOOK_COLLECTIONS_XML);
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const { connection } = await caldavConnect({
			userId: "userA",
			serverUrl: SERVER_INPUT,
			username: USERNAME,
			appPassword: APP_PASSWORD,
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.capabilities).toEqual(["tasks", "calendar", "contacts"]);
		expect(connection.config.addressbookUrls).toEqual([
			"https://dav.example.com/dav/addressbooks/alice/contacts/",
		]);
	});

	it("fails the connect when discovery finds no calendars, task lists, or addressbooks at all", async () => {
		seedUser("userA");
		const { caldavConnect, CalDavError } = await import("./caldav-tasks");

		const emptyCollectionsXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/dav/calendars/alice/</d:href>
		<d:propstat>
			<d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === SERVER) return xmlResponse(207, PRINCIPAL_XML);
			if (url === "https://dav.example.com/dav/principals/users/alice/") {
				return xmlResponse(207, HOME_XML);
			}
			if (url === "https://dav.example.com/dav/calendars/alice/") {
				return xmlResponse(207, emptyCollectionsXml);
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		try {
			await caldavConnect({
				userId: "userA",
				serverUrl: SERVER_INPUT,
				username: USERNAME,
				appPassword: APP_PASSWORD,
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"request_failed",
			);
		}
	});

	it("rejects a non-https/private serverUrl without ever calling fetch (SSRF guard)", async () => {
		seedUser("userA");
		const { caldavConnect, CalDavError } = await import("./caldav-tasks");
		const fetchMock = vi.fn();

		try {
			await caldavConnect({
				userId: "userA",
				serverUrl: "http://127.0.0.1/dav/",
				username: USERNAME,
				appPassword: APP_PASSWORD,
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 anywhere in discovery surfaces invalid_credentials with no password in the message, and generic (not Apple-branded) wording", async () => {
		seedUser("userA");
		const { caldavConnect, CalDavError } = await import("./caldav-tasks");
		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		try {
			await caldavConnect({
				userId: "userA",
				serverUrl: SERVER_INPUT,
				username: USERNAME,
				appPassword: "wrong-pw",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"invalid_credentials",
			);
			expect((err as Error).message).not.toContain("wrong-pw");
			// Folded-in Task 9a review minor (5a): a generic CalDAV connection
			// (Nextcloud/Fastmail/Baïkal/...) must never surface "Apple" in its
			// error text — this is the exact message the connect-wizard shows the
			// user verbatim (routes/api/connections/caldav/start/+server.ts returns
			// err.message directly).
			expect((err as Error).message).not.toContain("Apple");
			expect((err as Error).message).toBe(
				"The server rejected the username or app password",
			);
		}
	});

	it("a non-207/401 status surfaces generic (not Apple-branded) wording", async () => {
		seedUser("userA");
		const { caldavConnect, CalDavError } = await import("./caldav-tasks");
		const fetchMock = vi.fn(async () => new Response("", { status: 500 }));

		try {
			await caldavConnect({
				userId: "userA",
				serverUrl: SERVER_INPUT,
				username: USERNAME,
				appPassword: APP_PASSWORD,
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as Error).message).not.toContain("Apple");
			expect((err as Error).message).toBe(
				"CalDAV PROPFIND failed with status 500",
			);
		}
	});

	it("requires both a username and app password without ever calling fetch", async () => {
		seedUser("userA");
		const { caldavConnect, CalDavError } = await import("./caldav-tasks");
		const fetchMock = vi.fn();

		try {
			await caldavConnect({
				userId: "userA",
				serverUrl: SERVER_INPUT,
				username: "  ",
				appPassword: "",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"invalid_config",
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("re-connecting the same username updates (not duplicates) the connection", async () => {
		seedUser("userA");
		const { caldavConnect } = await import("./caldav-tasks");
		const { listConnectionsForUser } = await import("../store");

		const first = await caldavConnect({
			userId: "userA",
			serverUrl: SERVER_INPUT,
			username: USERNAME,
			appPassword: "first-pw",
			fetch: discoveryFetchMock("first-pw") as unknown as typeof fetch,
		});
		const second = await caldavConnect({
			userId: "userA",
			serverUrl: SERVER_INPUT,
			username: USERNAME,
			appPassword: "second-pw",
			fetch: discoveryFetchMock("second-pw") as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const all = await listConnectionsForUser("userA");
		expect(all.filter((c) => c.provider === "caldav")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// parseICalTodos
// ---------------------------------------------------------------------------

describe("parseICalTodos", () => {
	it("parses a VTODO block's summary/description/due/status/priority", async () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VTODO",
			"UID:todo-1",
			"SUMMARY:Renew passport",
			"DESCRIPTION:Bring the old one and 2 photos",
			"DUE;VALUE=DATE:20260715",
			"STATUS:NEEDS-ACTION",
			"PRIORITY:1",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");

		expect(await parseICalTodosHelper(ics)).toEqual([
			{
				uid: "todo-1",
				summary: "Renew passport",
				description: "Bring the old one and 2 photos",
				due: "2026-07-15",
				status: "NEEDS-ACTION",
				priority: 1,
			},
		]);
	});

	it("drops a VTODO block with no UID", async () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VTODO",
			"SUMMARY:No uid here",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		expect(await parseICalTodosHelper(ics)).toEqual([]);
	});
});

async function parseICalTodosHelper(ics: string) {
	const { parseICalTodos } = await import("./caldav-tasks");
	return parseICalTodos(ics);
}

// ---------------------------------------------------------------------------
// caldavListTasks
// ---------------------------------------------------------------------------

async function seedCalDavConnection(
	overrides: {
		appPassword?: string;
		capabilities?: string[];
		config?: Record<string, unknown>;
	} = {},
) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: "userA",
		provider: "caldav",
		label: "CalDAV",
		accountIdentifier: USERNAME,
		capabilities: overrides.capabilities ?? ["tasks"],
		status: "connected",
		secret: overrides.appPassword ?? APP_PASSWORD,
		config: {
			serverUrl: SERVER,
			username: USERNAME,
			principalUrl: "https://dav.example.com/dav/principals/users/alice/",
			taskListUrls: ["https://dav.example.com/dav/calendars/alice/tasks/"],
			calendarUrls: [],
			addressbookUrls: [],
			...overrides.config,
		},
	});
}

const VTODO_REPORT_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/dav/calendars/alice/tasks/todo-1.ics</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>"etag-1"</d:getetag>
				<c:calendar-data>BEGIN:VCALENDAR\r
BEGIN:VTODO\r
UID:todo-1\r
SUMMARY:Renew passport\r
DUE;VALUE=DATE:20260715\r
STATUS:NEEDS-ACTION\r
PRIORITY:1\r
END:VTODO\r
END:VCALENDAR</c:calendar-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

describe("caldavListTasks", () => {
	it("reads VTODOs across every discovered task list", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection();
		const { caldavListTasks } = await import("./caldav-tasks");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://dav.example.com/dav/calendars/alice/tasks/",
				);
				expect(init?.method).toBe("REPORT");
				return xmlResponse(207, VTODO_REPORT_XML);
			},
		);

		const tasks = await caldavListTasks("userA", conn.id, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(tasks).toEqual([
			{
				id: "todo-1",
				summary: "Renew passport",
				due: "2026-07-15",
				status: "NEEDS-ACTION",
				priority: 1,
				url: "https://dav.example.com/dav/calendars/alice/tasks/todo-1.ics",
			},
		]);
	});

	it("maps a 401 to needs_reauth and persists it on the connection", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection();
		const { caldavListTasks, CalDavError } = await import("./caldav-tasks");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		try {
			await caldavListTasks("userA", conn.id, {
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected caldavListTasks to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"needs_reauth",
			);
		}
		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

// ---------------------------------------------------------------------------
// caldavListEvents / caldavGetEventByUid (Task 9b — generic VEVENT read)
// ---------------------------------------------------------------------------

const CALENDAR_URL = "https://dav.example.com/dav/calendars/alice/personal/";

const VEVENT_REPORT_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/dav/calendars/alice/personal/event-1.ics</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>"etag-evt-1"</d:getetag>
				<c:calendar-data>BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:event-1\r
SUMMARY:Team sync\r
LOCATION:Room 4\r
DTSTART:20260715T090000Z\r
DTEND:20260715T093000Z\r
END:VEVENT\r
END:VCALENDAR</c:calendar-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

describe("caldavListEvents", () => {
	it("reads VEVENTs across every discovered VEVENT-supporting calendar (a NON-iCloud base URL)", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "calendar"],
			config: { calendarUrls: [CALENDAR_URL] },
		});
		const { caldavListEvents } = await import("./caldav-tasks");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(CALENDAR_URL);
				expect(init?.method).toBe("REPORT");
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from(`${USERNAME}:${APP_PASSWORD}`).toString("base64")}`,
				);
				return xmlResponse(207, VEVENT_REPORT_XML);
			},
		);

		const events = await caldavListEvents(
			"userA",
			conn.id,
			{
				timeMin: "2026-07-01T00:00:00.000Z",
				timeMax: "2026-07-31T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(events).toEqual([
			{
				id: "event-1",
				summary: "Team sync",
				location: "Room 4",
				start: "2026-07-15T09:00:00Z",
				end: "2026-07-15T09:30:00Z",
				htmlLink:
					"https://dav.example.com/dav/calendars/alice/personal/event-1.ics",
				etag: '"etag-evt-1"',
				rawIcs: expect.stringContaining("SUMMARY:Team sync"),
			},
		]);
	});

	it("maps a 401 to needs_reauth, persists it, and never mentions Apple", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "calendar"],
			config: { calendarUrls: [CALENDAR_URL] },
		});
		const { caldavListEvents, CalDavError } = await import("./caldav-tasks");
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		try {
			await caldavListEvents(
				"userA",
				conn.id,
				{
					timeMin: "2026-07-01T00:00:00.000Z",
					timeMax: "2026-07-31T00:00:00.000Z",
				},
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected caldavListEvents to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"needs_reauth",
			);
			expect((err as Error).message).not.toContain("Apple");
		}
		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("caldavGetEventByUid", () => {
	it("returns the matching event by UID", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "calendar"],
			config: { calendarUrls: [CALENDAR_URL] },
		});
		const { caldavGetEventByUid } = await import("./caldav-tasks");

		const fetchMock = vi.fn(async () => xmlResponse(207, VEVENT_REPORT_XML));

		const event = await caldavGetEventByUid("userA", conn.id, "event-1", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(event?.id).toBe("event-1");
		expect(event?.summary).toBe("Team sync");
	});

	it("returns null when no calendar has a matching UID", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "calendar"],
			config: { calendarUrls: [CALENDAR_URL] },
		});
		const { caldavGetEventByUid } = await import("./caldav-tasks");

		const fetchMock = vi.fn(async () =>
			xmlResponse(
				207,
				`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`,
			),
		);

		const event = await caldavGetEventByUid("userA", conn.id, "nope", {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(event).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// caldavSearchContacts (Task 9b — generic CardDAV vCard read)
// ---------------------------------------------------------------------------

const ADDRESSBOOK_URL =
	"https://dav.example.com/dav/addressbooks/alice/contacts/";

const VCARD_REPORT_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/dav/addressbooks/alice/contacts/card-1.vcf</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>"etag-card-1"</d:getetag>
				<card:address-data>BEGIN:VCARD\r
FN:Jane Doe\r
EMAIL:jane@example.com\r
TEL:+1-555-0100\r
END:VCARD</card:address-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

describe("caldavSearchContacts", () => {
	it("reads vCards across every discovered addressbook and matches by name/email (a NON-iCloud base URL)", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "contacts"],
			config: { addressbookUrls: [ADDRESSBOOK_URL] },
		});
		const { caldavSearchContacts } = await import("./caldav-tasks");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(ADDRESSBOOK_URL);
				expect(init?.method).toBe("REPORT");
				return xmlResponse(207, VCARD_REPORT_XML);
			},
		);

		const matches = await caldavSearchContacts(
			"userA",
			conn.id,
			{ query: "jane" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "Jane Doe",
				emails: ["jane@example.com"],
				phones: ["+1-555-0100"],
				source: "caldav",
				account: USERNAME,
			},
		]);
	});

	it("returns no matches for a query that matches nothing", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "contacts"],
			config: { addressbookUrls: [ADDRESSBOOK_URL] },
		});
		const { caldavSearchContacts } = await import("./caldav-tasks");

		const fetchMock = vi.fn(async () => xmlResponse(207, VCARD_REPORT_XML));

		const matches = await caldavSearchContacts(
			"userA",
			conn.id,
			{ query: "nobody-matches-this" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(matches).toEqual([]);
	});

	it("maps a 401 to needs_reauth and never mentions Apple", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection({
			capabilities: ["tasks", "contacts"],
			config: { addressbookUrls: [ADDRESSBOOK_URL] },
		});
		const { caldavSearchContacts, CalDavError } = await import(
			"./caldav-tasks"
		);

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		try {
			await caldavSearchContacts(
				"userA",
				conn.id,
				{ query: "jane" },
				{ fetch: fetchMock as unknown as typeof fetch },
			);
			throw new Error("expected caldavSearchContacts to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CalDavError);
			expect((err as InstanceType<typeof CalDavError>).code).toBe(
				"needs_reauth",
			);
			expect((err as Error).message).not.toContain("Apple");
		}
	});
});

// ---------------------------------------------------------------------------
// checkHealth (adapter)
// ---------------------------------------------------------------------------

describe("caldav checkHealth", () => {
	it("reports connected on a successful principal PROPFIND", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection();
		const { caldavAdapter } = await import("./caldav-tasks");

		const fetchMock = vi.fn(async () => xmlResponse(207, PRINCIPAL_XML));

		const result = await caldavAdapter.checkHealth(APP_PASSWORD, conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result).toEqual({ status: "connected", detail: null });
	});

	it("reports needs_reauth on a 401", async () => {
		seedUser("userA");
		const conn = await seedCalDavConnection();
		const { caldavAdapter } = await import("./caldav-tasks");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		const result = await caldavAdapter.checkHealth(APP_PASSWORD, conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(result.status).toBe("needs_reauth");
	});

	it("requiresSecret is true", async () => {
		const { caldavAdapter } = await import("./caldav-tasks");
		expect(caldavAdapter.requiresSecret).toBe(true);
	});
});
