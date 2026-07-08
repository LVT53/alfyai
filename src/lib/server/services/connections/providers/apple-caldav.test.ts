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
	dbPath = `./data/test-connections-apple-${randomUUID()}.db`;
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

function redirectResponse(status: number, location: string): Response {
	return new Response("", { status, headers: { Location: location } });
}

const WELL_KNOWN = "https://caldav.icloud.com/.well-known/caldav";
const PARTITION = "https://p12-caldav.icloud.com";

const PRINCIPAL_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/12345678/principal/</d:href>
		<d:propstat>
			<d:prop>
				<d:current-user-principal><d:href>/12345678/principal/</d:href></d:current-user-principal>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

const HOME_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/12345678/principal/</d:href>
		<d:propstat>
			<d:prop>
				<c:calendar-home-set><d:href>/12345678/calendars/</d:href></c:calendar-home-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

const COLLECTIONS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:response>
		<d:href>/12345678/calendars/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:displayname>root</d:displayname>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/12345678/calendars/home/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
				<d:displayname>Home</d:displayname>
				<c:supported-calendar-component-set>
					<c:comp name="VEVENT"/>
					<c:comp name="VTODO"/>
				</c:supported-calendar-component-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/12345678/calendars/notes/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
				<d:displayname>Reminders</d:displayname>
				<c:supported-calendar-component-set>
					<c:comp name="VTODO"/>
				</c:supported-calendar-component-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

function discoveryFetchMock(appPassword = "app-specific-pw") {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(
			`Basic ${Buffer.from(`alice@icloud.com:${appPassword}`).toString("base64")}`,
		);

		if (url === WELL_KNOWN) {
			expect(init?.method).toBe("PROPFIND");
			return redirectResponse(301, `${PARTITION}/.well-known/caldav`);
		}
		if (url === `${PARTITION}/.well-known/caldav`) {
			return xmlResponse(207, PRINCIPAL_XML);
		}
		if (url === `${PARTITION}/12345678/principal/`) {
			return xmlResponse(207, HOME_XML);
		}
		if (url === `${PARTITION}/12345678/calendars/`) {
			return xmlResponse(207, COLLECTIONS_XML);
		}
		throw new Error(`Unexpected fetch to ${url}`);
	});
}

describe("appleConnect", () => {
	it("follows an iCloud partition redirect during discovery and stores principal/home/calendar URLs + encrypted secret", async () => {
		seedUser("userA");
		const { appleConnect } = await import("./apple-caldav");
		const { getConnectionSecret } = await import("../store");

		const fetchMock = discoveryFetchMock();

		const { connection } = await appleConnect({
			userId: "userA",
			appleId: "alice@icloud.com",
			appPassword: "app-specific-pw",
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(connection.provider).toBe("apple");
		expect(connection.accountIdentifier).toBe("alice@icloud.com");
		expect(connection.capabilities).toEqual(["calendar"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(JSON.stringify(connection)).not.toContain("app-specific-pw");

		expect(connection.config.principalUrl).toBe(
			`${PARTITION}/12345678/principal/`,
		);
		expect(connection.config.calendarHomeUrl).toBe(
			`${PARTITION}/12345678/calendars/`,
		);
		// Only the collection whose supported-calendar-component-set includes
		// VEVENT is kept — the reminders-only collection is filtered out.
		expect(connection.config.calendarUrls).toEqual([
			`${PARTITION}/12345678/calendars/home/`,
		]);

		const decrypted = await getConnectionSecret("userA", connection.id);
		expect(decrypted).toBe("app-specific-pw");
	});

	it("a 401 anywhere in discovery surfaces a clear invalid-credentials error with no password in the message", async () => {
		seedUser("userA");
		const { appleConnect, AppleCalDavError } = await import("./apple-caldav");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		try {
			await appleConnect({
				userId: "userA",
				appleId: "alice@icloud.com",
				appPassword: "wrong-pw",
				fetch: fetchMock as unknown as typeof fetch,
			});
			throw new Error("expected appleConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(AppleCalDavError);
			expect((err as InstanceType<typeof AppleCalDavError>).code).toBe(
				"invalid_credentials",
			);
			expect((err as Error).message).not.toContain("wrong-pw");
			expect((err as Error).message.toLowerCase()).toContain("apple id");
		}
	});

	it("re-connecting the same Apple ID updates (not duplicates) the connection and refreshes the stored secret", async () => {
		seedUser("userA");
		const { appleConnect } = await import("./apple-caldav");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);

		const first = await appleConnect({
			userId: "userA",
			appleId: "alice@icloud.com",
			appPassword: "first-pw",
			fetch: discoveryFetchMock("first-pw") as unknown as typeof fetch,
		});

		const second = await appleConnect({
			userId: "userA",
			appleId: "alice@icloud.com",
			appPassword: "second-pw",
			fetch: discoveryFetchMock("second-pw") as unknown as typeof fetch,
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser("userA");
		expect(rows).toHaveLength(1);

		const decrypted = await getConnectionSecret("userA", second.connection.id);
		expect(decrypted).toBe("second-pw");
	});
});

describe("appleAdapter.checkHealth", () => {
	async function seedConnection() {
		const { createConnection } = await import("../store");
		return createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: "app-specific-pw",
			config: {
				appleId: "alice@icloud.com",
				principalUrl: `${PARTITION}/12345678/principal/`,
				calendarHomeUrl: `${PARTITION}/12345678/calendars/`,
				calendarUrls: [`${PARTITION}/12345678/calendars/home/`],
			},
		});
	}

	it("207 on the principal -> connected", async () => {
		seedUser("userA");
		const conn = await seedConnection();
		const { appleAdapter } = await import("./apple-caldav");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe(`${PARTITION}/12345678/principal/`);
			return xmlResponse(207, PRINCIPAL_XML);
		});

		const health = await appleAdapter.checkHealth("app-specific-pw", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("connected");
	});

	it("401 -> needs_reauth, no secret in the detail", async () => {
		seedUser("userA");
		const conn = await seedConnection();
		const { appleAdapter } = await import("./apple-caldav");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		const health = await appleAdapter.checkHealth("app-specific-pw", conn, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("app-specific-pw");
	});
});

describe("appleListEvents", () => {
	async function seedConnection() {
		const { createConnection } = await import("../store");
		return createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
			capabilities: ["calendar"],
			status: "connected",
			secret: "app-specific-pw",
			config: {
				appleId: "alice@icloud.com",
				principalUrl: `${PARTITION}/12345678/principal/`,
				calendarHomeUrl: `${PARTITION}/12345678/calendars/`,
				calendarUrls: [`${PARTITION}/12345678/calendars/home/`],
			},
		});
	}

	const TIMED_ICS = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:evt-1@icloud.com",
		"SUMMARY:Team sync",
		"DTSTART:20260709T130000Z",
		"DTEND:20260709T133000Z",
		"LOCATION:Conference Room",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");

	const ALL_DAY_ICS = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:evt-2@icloud.com",
		"SUMMARY:Company Holiday",
		"DTSTART;VALUE=DATE:20260710",
		"DTEND;VALUE=DATE:20260711",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");

	function multistatusReport(
		entries: { href: string; etag: string; ics: string }[],
	) {
		const responses = entries
			.map(
				(entry) => `
	<d:response>
		<d:href>${entry.href}</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>${entry.etag}</d:getetag>
				<c:calendar-data>${entry.ics
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")}</c:calendar-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>`,
			)
			.join("");
		return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`;
	}

	it("parses a REPORT multistatus with a timed and an all-day VEVENT, capturing etag + href", async () => {
		seedUser("userA");
		const conn = await seedConnection();
		const { appleListEvents } = await import("./apple-caldav");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(`${PARTITION}/12345678/calendars/home/`);
				expect(init?.method).toBe("REPORT");
				const headers = new Headers(init?.headers);
				expect(headers.get("Depth")).toBe("1");
				expect(String(init?.body)).toContain("VEVENT");
				return xmlResponse(
					207,
					multistatusReport([
						{
							href: "/12345678/calendars/home/evt-1.ics",
							etag: '"etag-1"',
							ics: TIMED_ICS,
						},
						{
							href: "/12345678/calendars/home/evt-2.ics",
							etag: '"etag-2"',
							ics: ALL_DAY_ICS,
						},
					]),
				);
			},
		);

		const events = await appleListEvents(
			"userA",
			conn.id,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(events).toEqual([
			expect.objectContaining({
				id: "evt-1@icloud.com",
				summary: "Team sync",
				start: "2026-07-09T13:00:00Z",
				end: "2026-07-09T13:30:00Z",
				location: "Conference Room",
				htmlLink: `${PARTITION}/12345678/calendars/home/evt-1.ics`,
				etag: '"etag-1"',
			}),
			expect.objectContaining({
				id: "evt-2@icloud.com",
				summary: "Company Holiday",
				start: "2026-07-10",
				end: "2026-07-11",
				htmlLink: `${PARTITION}/12345678/calendars/home/evt-2.ics`,
				etag: '"etag-2"',
			}),
		]);
	});

	it("a 401 on REPORT throws a typed needs_reauth error and flags the connection", async () => {
		seedUser("userA");
		const conn = await seedConnection();
		const { appleListEvents, AppleCalDavError } = await import(
			"./apple-caldav"
		);
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		const promise = appleListEvents(
			"userA",
			conn.id,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(AppleCalDavError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("appleSearchContacts", () => {
	const CARD_WELL_KNOWN = "https://contacts.icloud.com/.well-known/carddav";
	const CARD_PARTITION = "https://p50-contacts.icloud.com";

	const CARD_PRINCIPAL_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/12345678/principal2/</d:href>
		<d:propstat>
			<d:prop>
				<d:current-user-principal><d:href>/12345678/principal2/</d:href></d:current-user-principal>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

	const CARD_HOME_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/12345678/principal2/</d:href>
		<d:propstat>
			<d:prop>
				<card:addressbook-home-set><d:href>/12345678/carddavhome/</d:href></card:addressbook-home-set>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

	const CARD_COLLECTIONS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/12345678/carddavhome/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/></d:resourcetype>
				<d:displayname>root</d:displayname>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
	<d:response>
		<d:href>/12345678/carddavhome/card/</d:href>
		<d:propstat>
			<d:prop>
				<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
				<d:displayname>Contacts</d:displayname>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;

	const VCARD_ANN = [
		"BEGIN:VCARD",
		"VERSION:3.0",
		"FN:This is a very long display na",
		" me that wraps",
		"EMAIL:ann@example.com",
		"EMAIL:ann.work@example.com",
		"TEL:+1-555-1000",
		"END:VCARD",
		"",
	].join("\r\n");

	const VCARD_BOB = [
		"BEGIN:VCARD",
		"VERSION:3.0",
		"FN:Bob Smith",
		"EMAIL:bob@example.com",
		"END:VCARD",
		"",
	].join("\r\n");

	function addressbookMultistatus(
		entries: { href: string; etag: string; vcard: string }[],
	) {
		const responses = entries
			.map(
				(entry) => `
	<d:response>
		<d:href>${entry.href}</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>${entry.etag}</d:getetag>
				<card:address-data>${entry.vcard
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")}</card:address-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>`,
			)
			.join("");
		return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}
</d:multistatus>`;
	}

	async function seedContactsConnection() {
		const { createConnection } = await import("../store");
		return createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
			capabilities: ["calendar", "contacts"],
			status: "connected",
			secret: "app-specific-pw",
			config: {
				appleId: "alice@icloud.com",
				principalUrl: `${PARTITION}/12345678/principal/`,
				calendarHomeUrl: `${PARTITION}/12345678/calendars/`,
				calendarUrls: [`${PARTITION}/12345678/calendars/home/`],
			},
		});
	}

	function discoveryPlusReportFetchMock() {
		return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === CARD_WELL_KNOWN) {
				return redirectResponse(301, `${CARD_PARTITION}/.well-known/carddav`);
			}
			if (url === `${CARD_PARTITION}/.well-known/carddav`) {
				return xmlResponse(207, CARD_PRINCIPAL_XML);
			}
			if (url === `${CARD_PARTITION}/12345678/principal2/`) {
				return xmlResponse(207, CARD_HOME_XML);
			}
			if (url === `${CARD_PARTITION}/12345678/carddavhome/`) {
				return xmlResponse(207, CARD_COLLECTIONS_XML);
			}
			if (url === `${CARD_PARTITION}/12345678/carddavhome/card/`) {
				expect(init?.method).toBe("REPORT");
				return xmlResponse(
					207,
					addressbookMultistatus([
						{
							href: "/12345678/carddavhome/card/ann.vcf",
							etag: '"etag-ann"',
							vcard: VCARD_ANN,
						},
						{
							href: "/12345678/carddavhome/card/bob.vcf",
							etag: '"etag-bob"',
							vcard: VCARD_BOB,
						},
					]),
				);
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
	}

	it("discovers addressbooks (following a partition redirect), parses+filters vCards by query, and caches addressbookUrls to config without disturbing existing calendar config", async () => {
		seedUser("userA");
		const conn = await seedContactsConnection();
		const { appleSearchContacts } = await import("./apple-caldav");
		const { getConnection } = await import("../store");

		const fetchMock = discoveryPlusReportFetchMock();

		const matches = await appleSearchContacts(
			"userA",
			conn.id,
			{ query: "ann" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "This is a very long display name that wraps",
				emails: ["ann@example.com", "ann.work@example.com"],
				phones: ["+1-555-1000"],
				source: "apple",
				account: "alice@icloud.com",
			},
		]);

		const updated = await getConnection("userA", conn.id);
		expect(updated?.config.addressbookUrls).toEqual([
			`${CARD_PARTITION}/12345678/carddavhome/card/`,
		]);
		// The pre-existing calendar config (cached by 5.3) must survive the
		// config merge — updateConnection replaces the whole config column, so
		// appleSearchContacts must spread the existing config rather than
		// overwrite it wholesale.
		expect(updated?.config.calendarUrls).toEqual([
			`${PARTITION}/12345678/calendars/home/`,
		]);
	});

	it("does not filter out any contact when the query is empty", async () => {
		seedUser("userA");
		const conn = await seedContactsConnection();
		const { appleSearchContacts } = await import("./apple-caldav");

		const matches = await appleSearchContacts(
			"userA",
			conn.id,
			{ query: "" },
			{ fetch: discoveryPlusReportFetchMock() as unknown as typeof fetch },
		);

		expect(matches.map((m) => m.name)).toEqual([
			"This is a very long display name that wraps",
			"Bob Smith",
		]);
	});

	it("reuses cached addressbookUrls on a second call instead of re-running discovery", async () => {
		seedUser("userA");
		const conn = await seedContactsConnection();
		const { appleSearchContacts } = await import("./apple-caldav");

		await appleSearchContacts(
			"userA",
			conn.id,
			{ query: "ann" },
			{ fetch: discoveryPlusReportFetchMock() as unknown as typeof fetch },
		);

		// This mock only understands the REPORT endpoint — any discovery call
		// (well-known/principal/home/collections) throws, proving the cached
		// addressbookUrls were reused instead of rediscovered.
		const reportOnlyFetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === `${CARD_PARTITION}/12345678/carddavhome/card/`) {
					expect(init?.method).toBe("REPORT");
					return xmlResponse(
						207,
						addressbookMultistatus([
							{
								href: "/12345678/carddavhome/card/ann.vcf",
								etag: '"etag-ann"',
								vcard: VCARD_ANN,
							},
						]),
					);
				}
				throw new Error(`Unexpected (re-discovery) fetch to ${url}`);
			},
		);

		const matches = await appleSearchContacts(
			"userA",
			conn.id,
			{ query: "ann" },
			{ fetch: reportOnlyFetchMock as unknown as typeof fetch },
		);
		expect(matches).toHaveLength(1);
	});

	it("a 401 on the addressbook REPORT throws a typed needs_reauth error and flags the connection, without leaking the password", async () => {
		seedUser("userA");
		const { createConnection, getConnection } = await import("../store");
		const conn = await createConnection({
			userId: "userA",
			provider: "apple",
			label: "Apple iCloud",
			accountIdentifier: "alice@icloud.com",
			capabilities: ["contacts"],
			status: "connected",
			secret: "app-specific-pw",
			config: {
				appleId: "alice@icloud.com",
				addressbookUrls: [`${CARD_PARTITION}/12345678/carddavhome/card/`],
			},
		});
		const { appleSearchContacts, AppleCalDavError } = await import(
			"./apple-caldav"
		);

		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));

		const promise = appleSearchContacts(
			"userA",
			conn.id,
			{ query: "ann" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(AppleCalDavError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });
		await expect(promise).rejects.not.toMatchObject({
			message: expect.stringContaining("app-specific-pw"),
		});

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("parseVCards", () => {
	it("unfolds a folded (continuation) FN line per RFC 6350/5545 and collects multiple EMAIL/TEL", async () => {
		const { parseVCards } = await import("./apple-caldav");
		const vcard = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:This is a very long display na",
			" me that wraps",
			"EMAIL:ann@example.com",
			"EMAIL:ann.work@example.com",
			"TEL:+1-555-1000",
			"TEL:+1-555-2000",
			"END:VCARD",
			"",
		].join("\r\n");

		expect(parseVCards(vcard)).toEqual([
			{
				fn: "This is a very long display name that wraps",
				emails: ["ann@example.com", "ann.work@example.com"],
				phones: ["+1-555-1000", "+1-555-2000"],
			},
		]);
	});

	it("handles a vCard with no TEL", async () => {
		const { parseVCards } = await import("./apple-caldav");
		const vcard = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:Bob Smith",
			"EMAIL:bob@example.com",
			"END:VCARD",
			"",
		].join("\r\n");

		expect(parseVCards(vcard)).toEqual([
			{ fn: "Bob Smith", emails: ["bob@example.com"], phones: [] },
		]);
	});

	it("parses multiple VCARDs in one address-data blob", async () => {
		const { parseVCards } = await import("./apple-caldav");
		const vcard = [
			"BEGIN:VCARD",
			"FN:Ann",
			"EMAIL:ann@example.com",
			"END:VCARD",
			"BEGIN:VCARD",
			"FN:Bob",
			"EMAIL:bob@example.com",
			"END:VCARD",
			"",
		].join("\r\n");

		expect(parseVCards(vcard)).toEqual([
			{ fn: "Ann", emails: ["ann@example.com"], phones: [] },
			{ fn: "Bob", emails: ["bob@example.com"], phones: [] },
		]);
	});
});

describe("iCal VEVENT parsing", () => {
	it("unfolds a folded (continuation) SUMMARY line per RFC 5545", async () => {
		const { parseICalEvents } = await import("./apple-caldav");
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:evt-fold@icloud.com",
			"SUMMARY:This is a very long summary that wraps",
			"  across a continuation line",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");

		const events = parseICalEvents(ics);
		expect(events).toHaveLength(1);
		expect(events[0]?.summary).toBe(
			"This is a very long summary that wraps across a continuation line",
		);
	});

	it("parses an all-day event distinctly from a timed event", async () => {
		const { parseICalEvents } = await import("./apple-caldav");
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:allday@icloud.com",
			"SUMMARY:Holiday",
			"DTSTART;VALUE=DATE:20260710",
			"DTEND;VALUE=DATE:20260711",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");

		const events = parseICalEvents(ics);
		expect(events).toEqual([
			expect.objectContaining({
				uid: "allday@icloud.com",
				summary: "Holiday",
				dtstart: "2026-07-10",
				dtend: "2026-07-11",
			}),
		]);
	});

	it("handles missing optional fields (no LOCATION, no SUMMARY)", async () => {
		const { parseICalEvents } = await import("./apple-caldav");
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:bare@icloud.com",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");

		const events = parseICalEvents(ics);
		expect(events).toEqual([
			expect.objectContaining({
				uid: "bare@icloud.com",
				dtstart: "2026-07-09T09:00:00Z",
				dtend: "2026-07-09T09:30:00Z",
			}),
		]);
		expect(events[0]?.summary).toBeUndefined();
		expect(events[0]?.location).toBeUndefined();
	});
});
