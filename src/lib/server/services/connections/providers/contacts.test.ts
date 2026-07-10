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
			"names,emailAddresses,phoneNumbers,organizations",
		);
		expect(requestedUrl.searchParams.get("pageSize")).toBe("10");
	});

	it("surfaces the current organization (company + title) on a match, and omits the field when there is none (GAP B8 org)", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContacts } = await import("./contacts");

		const fetchMock = googleTokenAndPeopleFetchMock(() =>
			jsonResponse(200, {
				results: [
					{
						person: {
							names: [{ displayName: "Erin Acme" }],
							emailAddresses: [{ value: "erin@acme.example" }],
							organizations: [
								// A past org that should lose to the `current: true` one.
								{ name: "Old Co", title: "Intern", current: false },
								{ name: "Acme Corp", title: "Engineer", current: true },
							],
						},
					},
					{
						person: {
							names: [{ displayName: "Frank Noorg" }],
							emailAddresses: [{ value: "frank@example.com" }],
						},
					},
				],
			}),
		);

		const matches = await googleSearchContacts(
			"userA",
			conn.id,
			{ query: "acme" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "Erin Acme",
				emails: ["erin@acme.example"],
				phones: [],
				source: "google",
				account: "alice@example.com",
				organization: { company: "Acme Corp", title: "Engineer" },
			},
			{
				name: "Frank Noorg",
				emails: ["frank@example.com"],
				phones: [],
				source: "google",
				account: "alice@example.com",
			},
		]);
		// No `organization` key at all when there's no org data — not an
		// `organization: undefined` that would still show up in a JSON payload.
		expect(Object.hasOwn(matches[1], "organization")).toBe(false);
	});

	it("warms the People cache and retries once when the first search returns empty (cold-cache gotcha)", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContacts } = await import("./contacts");

		let peopleCallCount = 0;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, _init?: RequestInit) => {
				const url = String(input);
				if (url === GOOGLE_TOKEN_URL) {
					return jsonResponse(200, {
						access_token: "new-token",
						expires_in: 3600,
					});
				}
				if (url.startsWith(PEOPLE_SEARCH_URL)) {
					peopleCallCount += 1;
					// 1st real query: cold cache -> empty. 2nd: warmup (empty
					// query). 3rd: retry, now warm -> the real match.
					if (peopleCallCount < 3) {
						return jsonResponse(200, { results: [] });
					}
					return jsonResponse(200, {
						results: [
							{
								person: {
									names: [{ displayName: "Cara Example" }],
									emailAddresses: [{ value: "cara@example.com" }],
								},
							},
						],
					});
				}
				throw new Error(`Unexpected fetch to ${url}`);
			},
		);

		const matches = await googleSearchContacts(
			"userA",
			conn.id,
			{ query: "cara" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "Cara Example",
				emails: ["cara@example.com"],
				phones: [],
				source: "google",
				account: "alice@example.com",
			},
		]);
		const peopleCalls = fetchMock.mock.calls.filter(([u]) =>
			String(u).startsWith(PEOPLE_SEARCH_URL),
		);
		expect(peopleCalls).toHaveLength(3);
		// The middle call is the warmup — an empty query.
		expect(new URL(String(peopleCalls[1]?.[0])).searchParams.get("query")).toBe(
			"",
		);
	});

	it("does NOT warm/retry when the first search already returns matches", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContacts } = await import("./contacts");

		const fetchMock = googleTokenAndPeopleFetchMock(() =>
			jsonResponse(200, {
				results: [
					{
						person: {
							names: [{ displayName: "Dan Example" }],
							emailAddresses: [{ value: "dan@example.com" }],
						},
					},
				],
			}),
		);

		await googleSearchContacts(
			"userA",
			conn.id,
			{ query: "dan" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		const peopleCalls = fetchMock.mock.calls.filter(([u]) =>
			String(u).startsWith(PEOPLE_SEARCH_URL),
		);
		expect(peopleCalls).toHaveLength(1);
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

// Routes a Google People API URL to which of the three group-resolution
// calls it is: contactGroups.list (exactly `/v1/contactGroups`),
// contactGroups.get (`/v1/contactGroups/{id}`), or people:batchGet.
function classifyGoogleContactsUrl(
	urlStr: string,
): "list" | "get" | "batchGet" | null {
	const url = new URL(urlStr);
	if (url.pathname === "/v1/contactGroups") return "list";
	if (url.pathname.startsWith("/v1/contactGroups/")) return "get";
	if (url.pathname === "/v1/people:batchGet") return "batchGet";
	return null;
}

describe("googleSearchContactsByGroup", () => {
	function groupsListFetchMock(params: {
		groups: Array<{ resourceName: string; formattedName: string }>;
		members: string[];
		batchGetResponses: unknown[];
	}) {
		return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			const kind = classifyGoogleContactsUrl(url);
			if (kind) {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer new-token");
			}
			if (kind === "list") {
				return jsonResponse(200, {
					contactGroups: params.groups.map((g) => ({
						resourceName: g.resourceName,
						// The real API returns `name` (not `formattedName`) because the
						// request's groupFields mask can't include formattedName — the
						// parse falls back to `name`. Mock reflects that reality.
						name: g.formattedName,
						groupType: "USER_CONTACT_GROUP",
						memberCount: params.members.length,
					})),
				});
			}
			if (kind === "get") {
				return jsonResponse(200, { memberResourceNames: params.members });
			}
			if (kind === "batchGet") {
				return jsonResponse(200, { responses: params.batchGetResponses });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});
	}

	it("resolves a group by name via contactGroups.list -> contactGroups.get -> people:batchGet, surfacing organization", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContactsByGroup } = await import("./contacts");

		const fetchMock = groupsListFetchMock({
			groups: [{ resourceName: "contactGroups/123", formattedName: "Family" }],
			members: ["people/1", "people/2"],
			batchGetResponses: [
				{
					person: {
						names: [{ displayName: "Ann Family" }],
						emailAddresses: [{ value: "ann@family.example" }],
					},
				},
				{
					person: {
						names: [{ displayName: "Bob Family" }],
						emailAddresses: [{ value: "bob@family.example" }],
						organizations: [{ name: "Acme Corp", title: "CEO", current: true }],
					},
				},
			],
		});

		const matches = await googleSearchContactsByGroup(
			"userA",
			conn.id,
			{ groupName: "Family" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			{
				name: "Ann Family",
				emails: ["ann@family.example"],
				phones: [],
				source: "google",
				account: "alice@example.com",
			},
			{
				name: "Bob Family",
				emails: ["bob@family.example"],
				phones: [],
				source: "google",
				account: "alice@example.com",
				organization: { company: "Acme Corp", title: "CEO" },
			},
		]);

		const getCall = fetchMock.mock.calls.find(
			([u]) => classifyGoogleContactsUrl(String(u)) === "get",
		);
		const getUrl = new URL(String(getCall?.[0]));
		expect(getUrl.pathname).toBe("/v1/contactGroups/123");
		expect(getUrl.searchParams.get("maxMembers")).toBe("200");

		const batchCall = fetchMock.mock.calls.find(
			([u]) => classifyGoogleContactsUrl(String(u)) === "batchGet",
		);
		const batchUrl = new URL(String(batchCall?.[0]));
		expect(batchUrl.searchParams.getAll("resourceNames")).toEqual([
			"people/1",
			"people/2",
		]);
		expect(batchUrl.searchParams.get("personFields")).toBe(
			"names,emailAddresses,phoneNumbers,organizations",
		);
	});

	it("matches group names case-insensitively, preferring an exact match over a substring match", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContactsByGroup } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			const kind = classifyGoogleContactsUrl(url);
			if (kind === "list") {
				return jsonResponse(200, {
					contactGroups: [
						{
							resourceName: "contactGroups/extended",
							formattedName: "My Family Extended",
							groupType: "USER_CONTACT_GROUP",
						},
						{
							resourceName: "contactGroups/exact",
							formattedName: "Family",
							groupType: "USER_CONTACT_GROUP",
						},
					],
				});
			}
			if (kind === "get") {
				return jsonResponse(200, { memberResourceNames: [] });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		await googleSearchContactsByGroup(
			"userA",
			conn.id,
			{ groupName: "family" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		const getCall = fetchMock.mock.calls.find(
			([u]) => classifyGoogleContactsUrl(String(u)) === "get",
		);
		expect(String(getCall?.[0])).toContain("contactGroups/exact");
	});

	it("returns an empty array (not an error) when no group matches the name", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContactsByGroup } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			if (classifyGoogleContactsUrl(url) === "list") {
				return jsonResponse(200, {
					contactGroups: [
						{ resourceName: "contactGroups/1", formattedName: "Work" },
					],
				});
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const matches = await googleSearchContactsByGroup(
			"userA",
			conn.id,
			{ groupName: "Family" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(matches).toEqual([]);
	});

	it("returns an empty array when the matched group has no members", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContactsByGroup } = await import("./contacts");

		const fetchMock = groupsListFetchMock({
			groups: [{ resourceName: "contactGroups/empty", formattedName: "Empty" }],
			members: [],
			batchGetResponses: [],
		});

		const matches = await googleSearchContactsByGroup(
			"userA",
			conn.id,
			{ groupName: "Empty" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(matches).toEqual([]);
		expect(
			fetchMock.mock.calls.some(
				([u]) => classifyGoogleContactsUrl(String(u)) === "batchGet",
			),
		).toBe(false);
	});

	it("a post-refresh 401 from contactGroups.list throws a typed needs_reauth error and flags the connection", async () => {
		seedUser("userA");
		const conn = await seedGoogleConnection();
		const { googleSearchContactsByGroup, ContactsError } = await import(
			"./contacts"
		);
		const { getConnection } = await import("../store");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			if (classifyGoogleContactsUrl(url) === "list") {
				return new Response("", { status: 401 });
			}
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const promise = googleSearchContactsByGroup(
			"userA",
			conn.id,
			{ groupName: "Family" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(ContactsError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection("userA", conn.id);
		expect(updated?.status).toBe("needs_reauth");
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
		const { googleSearchContactsByGroup, ContactsError } = await import(
			"./contacts"
		);

		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should never be called when scope is missing");
		});

		await expect(
			googleSearchContactsByGroup(
				"userA",
				conn.id,
				{ groupName: "Family" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "scope_missing" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("resolveContactsByGroup", () => {
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

	it("resolves a Google group's members and never dispatches an Apple connection (groups are Google-only in v1)", async () => {
		seedUser("userA");
		await seedGoogleConnection();
		await seedAppleConnection(
			"bob@icloud.com",
			"https://p1-contacts.icloud.com/card/",
		);
		const { resolveContactsByGroup } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			const kind = classifyGoogleContactsUrl(url);
			if (kind === "list") {
				return jsonResponse(200, {
					contactGroups: [
						{ resourceName: "contactGroups/1", formattedName: "Family" },
					],
				});
			}
			if (kind === "get") {
				return jsonResponse(200, { memberResourceNames: ["people/1"] });
			}
			if (kind === "batchGet") {
				return jsonResponse(200, {
					responses: [
						{
							person: {
								names: [{ displayName: "Ann Family" }],
								emailAddresses: [{ value: "ann@family.example" }],
							},
						},
					],
				});
			}
			// If this resolves an Apple CardDAV URL, that's a bug — Apple groups
			// aren't supported in v1 and should never be dispatched to.
			throw new Error(`Unexpected fetch to ${url}`);
		});

		const matches = await resolveContactsByGroup(
			"userA",
			{ groupName: "Family" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(matches).toEqual([
			expect.objectContaining({ name: "Ann Family", source: "google" }),
		]);
	});

	it("one Google connection erroring (e.g. scope_missing) does not throw — resolves to an empty array", async () => {
		seedUser("userA");
		await seedGoogleConnection({
			oauthScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
		});
		const { resolveContactsByGroup } = await import("./contacts");

		const matches = await resolveContactsByGroup("userA", {
			groupName: "Family",
		});
		expect(matches).toEqual([]);
	});

	it("caps merged results to the requested limit", async () => {
		seedUser("userA");
		await seedGoogleConnection();
		const { resolveContactsByGroup } = await import("./contacts");

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === GOOGLE_TOKEN_URL) {
				return jsonResponse(200, {
					access_token: "new-token",
					expires_in: 3600,
				});
			}
			const kind = classifyGoogleContactsUrl(url);
			if (kind === "list") {
				return jsonResponse(200, {
					contactGroups: [
						{ resourceName: "contactGroups/1", formattedName: "Family" },
					],
				});
			}
			if (kind === "get") {
				return jsonResponse(200, {
					memberResourceNames: ["people/1", "people/2"],
				});
			}
			if (kind === "batchGet") {
				return jsonResponse(200, {
					responses: [
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

		const matches = await resolveContactsByGroup(
			"userA",
			{ groupName: "Family", limit: 1 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(matches).toHaveLength(1);
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
