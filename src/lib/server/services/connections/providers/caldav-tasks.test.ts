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
	it("discovers task lists (filtering to VTODO-supporting collections) and stores encrypted secret", async () => {
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
		expect(connection.capabilities).toEqual(["tasks"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect(JSON.stringify(connection)).not.toContain(APP_PASSWORD);
		expect(connection.config.taskListUrls).toEqual([
			"https://dav.example.com/dav/calendars/alice/tasks/",
		]);

		const decrypted = await getConnectionSecret("userA", connection.id);
		expect(decrypted).toBe(APP_PASSWORD);
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

	it("a 401 anywhere in discovery surfaces invalid_credentials with no password in the message", async () => {
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

async function seedCalDavConnection(overrides: { appPassword?: string } = {}) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: "userA",
		provider: "caldav",
		label: "CalDAV",
		accountIdentifier: USERNAME,
		capabilities: ["tasks"],
		status: "connected",
		secret: overrides.appPassword ?? APP_PASSWORD,
		config: {
			serverUrl: SERVER,
			username: USERNAME,
			principalUrl: "https://dav.example.com/dav/principals/users/alice/",
			taskListUrls: ["https://dav.example.com/dav/calendars/alice/tasks/"],
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
