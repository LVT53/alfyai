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

// googleSearchContacts goes through the real googleRefreshAccessToken (5.1),
// which requires GOOGLE_OAUTH_CLIENT_ID/SECRET to be configured — set them
// for the duration of this file, mirroring google.connect.test.ts.
const ENV_KEYS = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"];

beforeEach(() => {
	vi.resetModules();
	process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
	process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";

	dbPath = `./data/test-connections-contacts-${randomUUID()}.db`;
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
	for (const key of ENV_KEYS) delete process.env[key];
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const PEOPLE_SEARCH_URL =
	"https://people.googleapis.com/v1/people:searchContacts";
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

async function seedGoogleConnection(
	overrides: { oauthScopes?: string[]; capabilities?: string[] } = {},
) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: "userA",
		provider: "google",
		label: "Google",
		accountIdentifier: "alice@example.com",
		capabilities: overrides.capabilities ?? ["contacts"],
		status: "connected",
		secret: JSON.stringify({
			refreshToken: "refresh-abc",
			accessToken: "old-token",
		}),
		oauthScopes: overrides.oauthScopes ?? [
			"openid",
			"https://www.googleapis.com/auth/userinfo.email",
			CONTACTS_SCOPE,
		],
		config: {},
	});
}

function googleTokenAndPeopleFetchMock(peopleResponse: () => Response) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === GOOGLE_TOKEN_URL) {
			expect(init?.method).toBe("POST");
			return jsonResponse(200, { access_token: "new-token", expires_in: 3600 });
		}
		if (url.startsWith(PEOPLE_SEARCH_URL)) {
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer new-token");
			return peopleResponse();
		}
		throw new Error(`Unexpected fetch to ${url}`);
	});
}

describe("googleSearchContacts", () => {
	it("resolves People searchContacts results (one email-only, one email+phone) into ContactMatch[]", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContacts } = await import("./contacts");

		const fetchMock = googleTokenAndPeopleFetchMock(() =>
			jsonResponse(200, {
				results: [
					{
						person: {
							names: [{ displayName: "Ann Example" }],
							emailAddresses: [{ value: "ann@example.com" }],
						},
					},
					{
						person: {
							names: [{ displayName: "Bob Example" }],
							emailAddresses: [{ value: "bob@example.com" }],
							phoneNumbers: [{ value: "+1-555-1000" }],
						},
					},
				],
			}),
		);

		const matches = await googleSearchContacts(
			"userA",
			conn.id,
			{ query: "example" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "Ann Example",
				emails: ["ann@example.com"],
				phones: [],
				source: "google",
				account: "alice@example.com",
			},
			{
				name: "Bob Example",
				emails: ["bob@example.com"],
				phones: ["+1-555-1000"],
				source: "google",
				account: "alice@example.com",
			},
		]);

		const peopleCall = fetchMock.mock.calls.find(([u]) =>
			String(u).startsWith(PEOPLE_SEARCH_URL),
		);
		const requestedUrl = new URL(String(peopleCall?.[0]));
		expect(requestedUrl.searchParams.get("query")).toBe("example");
		expect(requestedUrl.searchParams.get("readMask")).toBe(
			"names,emailAddresses,phoneNumbers",
		);
		expect(requestedUrl.searchParams.get("pageSize")).toBe("10");
	});

	it("returns a typed scope_missing error and never calls the People API when contacts.readonly is absent", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection({
			oauthScopes: [
				"openid",
				"https://www.googleapis.com/auth/userinfo.email",
				"https://www.googleapis.com/auth/calendar.readonly",
			],
		});
		const { googleSearchContacts, ContactsError } = await import("./contacts");

		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should never be called when scope is missing");
		});

		await expect(
			googleSearchContacts(
				"userA",
				conn.id,
				{ query: "ann" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toBeInstanceOf(ContactsError);
		await expect(
			googleSearchContacts(
				"userA",
				conn.id,
				{ query: "ann" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "scope_missing" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a post-refresh 401 from the People API throws a typed needs_reauth error and flags the connection", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContacts, ContactsError } = await import("./contacts");
		const { getConnection } = await import("../store");

		const fetchMock = googleTokenAndPeopleFetchMock(
			() => new Response("", { status: 401 }),
		);

		const promise = googleSearchContacts(
			"userA",
			conn.id,
			{ query: "ann" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(ContactsError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("resolveContacts", () => {
	async function seedAppleConnection(
		accountIdentifier: string,
		addressbookUrl: string,
	) {
		const { createConnection } = await import("../store");
		return createConnection({
			userId: "userA",
			provider: "apple",
			label: `Apple ${accountIdentifier}`,
			accountIdentifier,
			capabilities: ["contacts"],
			status: "connected",
			secret: "app-specific-pw",
			config: {
				appleId: accountIdentifier,
				addressbookUrls: [addressbookUrl],
			},
		});
	}

	function vcardXml(fn: string, email: string) {
		const vcard = [
			"BEGIN:VCARD",
			`FN:${fn}`,
			`EMAIL:${email}`,
			"END:VCARD",
			"",
		].join("\r\n");
		return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:response>
		<d:href>/card/${fn}.vcf</d:href>
		<d:propstat>
			<d:prop>
				<card:address-data>${vcard}</card:address-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`;
	}

	it("merges + de-dupes matches across a google AND an apple connection (by lowercased name + first email)", async () => {
		seedUser("userA");
		await seedGoogleConnection();
		await seedAppleConnection(
			"bob@icloud.com",
			"https://p1-contacts.icloud.com/card/",
		);
		const { resolveContacts } = await import("./contacts");

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === GOOGLE_TOKEN_URL) {
					return jsonResponse(200, {
						access_token: "new-token",
						expires_in: 3600,
					});
				}
				if (url.startsWith(PEOPLE_SEARCH_URL)) {
					return jsonResponse(200, {
						results: [
							{
								person: {
									names: [{ displayName: "Ann Example" }],
									emailAddresses: [{ value: "ann@example.com" }],
								},
							},
						],
					});
				}
				if (url === "https://p1-contacts.icloud.com/card/") {
					expect(init?.method).toBe("REPORT");
					return new Response(vcardXml("Bob Smith", "bob@example.com"), {
						status: 207,
						headers: { "Content-Type": "application/xml" },
					});
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const matches = await resolveContacts(
			"userA",
			{ query: "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toHaveLength(2);
		expect(matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Ann Example", source: "google" }),
				expect.objectContaining({ name: "Bob Smith", source: "apple" }),
			]),
		);
	});

	it("one source erroring (e.g. google scope_missing) does not fail the whole resolve — the other source's matches still come through", async () => {
		seedUser("userA");
		await seedGoogleConnection({
			oauthScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
		});
		await seedAppleConnection(
			"bob@icloud.com",
			"https://p1-contacts.icloud.com/card/",
		);
		const { resolveContacts } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://p1-contacts.icloud.com/card/") {
				return new Response(vcardXml("Bob Smith", "bob@example.com"), {
					status: 207,
					headers: { "Content-Type": "application/xml" },
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const matches = await resolveContacts(
			"userA",
			{ query: "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			expect.objectContaining({ name: "Bob Smith", source: "apple" }),
		]);
	});

	it("returns an empty array (no throw) when every source fails", async () => {
		seedUser("userA");
		await seedGoogleConnection({
			oauthScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
		});
		const { resolveContacts } = await import("./contacts");

		const matches = await resolveContacts("userA", { query: "" });
		expect(matches).toEqual([]);
	});

	it("caps merged results to the requested limit", async () => {
		seedUser("userA");
		await seedGoogleConnection();
		const { resolveContacts } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			if (url.startsWith(PEOPLE_SEARCH_URL)) {
				return jsonResponse(200, {
					results: [
						{
							person: {
								names: [{ displayName: "Ann" }],
								emailAddresses: [{ value: "ann@example.com" }],
							},
						},
						{
							person: {
								names: [{ displayName: "Bob" }],
								emailAddresses: [{ value: "bob@example.com" }],
							},
						},
					],
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const matches = await resolveContacts(
			"userA",
			{ query: "", limit: 1 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(matches).toHaveLength(1);
	});
});
