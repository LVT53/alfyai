import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type {
	ImapClientOptions,
	ImapFetchedMessage,
	ImapFlowLike,
	ImapMailbox,
} from "./imap";

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
	dbPath = `./data/test-connections-imap-${randomUUID()}.db`;
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

// ---------------------------------------------------------------------------
// Fake ImapFlow client — no real socket is ever opened. Every method call is
// recorded so tests can assert on exactly what the module did (e.g. that the
// mailbox was opened read-only, that no \Seen-setting call was ever made).
// ---------------------------------------------------------------------------

async function* asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

type FakeBehavior = {
	connect?: () => Promise<void> | void;
	logout?: () => Promise<void> | void;
	mailboxOpen?: () => Promise<unknown> | unknown;
	search?: (query: Record<string, unknown>) => number[] | false;
	fetch?: (
		range: number[] | string,
		query: Record<string, unknown>,
	) => AsyncIterable<ImapFetchedMessage>;
	fetchOne?: (
		seq: number | string,
		query: Record<string, unknown>,
	) => Promise<ImapFetchedMessage | false>;
	list?: () => ImapMailbox[] | Promise<ImapMailbox[]>;
};

class FakeImapClient implements ImapFlowLike {
	connectCalls = 0;
	logoutCalls = 0;
	closeCalls = 0;
	// Not part of ImapFlowLike (the interface deliberately has no way to set
	// flags) — kept only so tests can assert this was never invoked, proving
	// the \Seen-never-set contract structurally as well as behaviorally.
	messageFlagsAddCalls: unknown[] = [];
	mailboxOpenCalls: { path: string; options?: { readOnly?: boolean } }[] = [];
	searchCalls: Record<string, unknown>[] = [];
	fetchCalls: { range: unknown; query: Record<string, unknown> }[] = [];
	fetchOneCalls: { seq: unknown; query: Record<string, unknown> }[] = [];
	listCalls = 0;

	constructor(private behavior: FakeBehavior = {}) {}

	async connect(): Promise<void> {
		this.connectCalls++;
		await this.behavior.connect?.();
	}

	async logout(): Promise<void> {
		this.logoutCalls++;
		await this.behavior.logout?.();
	}

	close(): void {
		this.closeCalls++;
	}

	async mailboxOpen(
		path: string,
		options?: { readOnly?: boolean },
	): Promise<{ exists?: number; uidValidity?: bigint }> {
		this.mailboxOpenCalls.push({ path, options });
		return (
			((await this.behavior.mailboxOpen?.()) as
				| { exists?: number; uidValidity?: bigint }
				| undefined) ?? { exists: 0 }
		);
	}

	async search(query: Record<string, unknown>): Promise<number[] | false> {
		this.searchCalls.push(query);
		return this.behavior.search ? this.behavior.search(query) : [];
	}

	fetch(
		range: number[] | string,
		query: Record<string, unknown>,
	): AsyncIterable<ImapFetchedMessage> {
		this.fetchCalls.push({ range, query });
		return this.behavior.fetch
			? this.behavior.fetch(range, query)
			: asyncIterableOf([]);
	}

	async fetchOne(
		seq: number | string,
		query: Record<string, unknown>,
	): Promise<ImapFetchedMessage | false> {
		this.fetchOneCalls.push({ seq, query });
		return this.behavior.fetchOne ? this.behavior.fetchOne(seq, query) : false;
	}

	async list(): Promise<ImapMailbox[]> {
		this.listCalls++;
		return this.behavior.list ? await this.behavior.list() : [];
	}
}

function createClientFactory(client: FakeImapClient) {
	return (_options: ImapClientOptions) => client;
}

const USER_ID = "userA";

async function seedImapConnection(overrides: { password?: string } = {}) {
	const { createConnection } = await import("../store");
	return createConnection({
		userId: USER_ID,
		provider: "imap",
		label: "Email",
		accountIdentifier: "alice@example.com",
		capabilities: ["email"],
		status: "connected",
		secret: overrides.password ?? "correct-horse",
		config: {
			email: "alice@example.com",
			imapHost: "imap.example.com",
			imapPort: 993,
			imapSecure: true,
		},
	});
}

// ---------------------------------------------------------------------------
// imapConnect
// ---------------------------------------------------------------------------

describe("imapConnect", () => {
	it("connects, validates via mailboxOpen, and stores an encrypted secret + non-secret config", async () => {
		seedUser(USER_ID);
		const { imapConnect } = await import("./imap");
		const { getConnectionSecret } = await import("../store");

		const client = new FakeImapClient();

		const { connection } = await imapConnect({
			userId: USER_ID,
			email: "alice@example.com",
			imapHost: "imap.example.com",
			password: "hunter2",
			createClient: createClientFactory(client),
		});

		expect(connection.provider).toBe("imap");
		expect(connection.accountIdentifier).toBe("alice@example.com");
		expect(connection.capabilities).toEqual(["email"]);
		expect(connection.status).toBe("connected");
		expect(connection.hasSecret).toBe(true);
		expect("secret" in connection).toBe(false);
		expect(JSON.stringify(connection)).not.toContain("hunter2");
		expect(connection.config).toEqual({
			email: "alice@example.com",
			imapHost: "imap.example.com",
			imapPort: 993,
			imapSecure: true,
		});

		expect(client.connectCalls).toBe(1);
		expect(client.mailboxOpenCalls).toEqual([
			{ path: "INBOX", options: { readOnly: true } },
		]);
		expect(client.logoutCalls).toBe(1);

		const decrypted = await getConnectionSecret(USER_ID, connection.id);
		expect(decrypted).toBe("hunter2");
	});

	it("applies port/secure defaults (993/true) when not supplied", async () => {
		seedUser(USER_ID);
		const { imapConnect } = await import("./imap");
		const client = new FakeImapClient();

		const { connection } = await imapConnect({
			userId: USER_ID,
			email: "alice@example.com",
			imapHost: "imap.example.com",
			password: "hunter2",
			createClient: createClientFactory(client),
		});

		expect(connection.config.imapPort).toBe(993);
		expect(connection.config.imapSecure).toBe(true);
	});

	it("an auth failure surfaces a clear invalid_credentials error with no password in the message, and still closes the connection", async () => {
		seedUser(USER_ID);
		const { imapConnect, ImapError } = await import("./imap");

		const client = new FakeImapClient({
			connect: () => {
				const err = new Error("Authentication failed");
				(
					err as unknown as { authenticationFailed: boolean }
				).authenticationFailed = true;
				throw err;
			},
		});

		try {
			await imapConnect({
				userId: USER_ID,
				email: "alice@example.com",
				imapHost: "imap.example.com",
				password: "wrong-pw",
				createClient: createClientFactory(client),
			});
			throw new Error("expected imapConnect to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ImapError);
			expect((err as InstanceType<typeof ImapError>).code).toBe(
				"invalid_credentials",
			);
			expect((err as Error).message).not.toContain("wrong-pw");
			expect((err as Error).message.toLowerCase()).toContain("invalid");
		}

		// Connection is always closed, even when connect() itself throws.
		expect(client.logoutCalls).toBe(1);
	});

	it("a non-auth connection failure (e.g. unreachable host) is mapped to connection_failed and still closes", async () => {
		seedUser(USER_ID);
		const { imapConnect } = await import("./imap");

		const client = new FakeImapClient({
			connect: () => {
				throw new Error("ECONNREFUSED");
			},
		});

		await expect(
			imapConnect({
				userId: USER_ID,
				email: "alice@example.com",
				imapHost: "imap.example.com",
				password: "hunter2",
				createClient: createClientFactory(client),
			}),
		).rejects.toMatchObject({ code: "connection_failed" });
		expect(client.logoutCalls).toBe(1);
	});

	it("rejects an empty imapHost as invalid_config without ever constructing a client", async () => {
		seedUser(USER_ID);
		const { imapConnect } = await import("./imap");

		await expect(
			imapConnect({
				userId: USER_ID,
				email: "alice@example.com",
				imapHost: "   ",
				password: "hunter2",
			}),
		).rejects.toMatchObject({ code: "invalid_config" });
	});

	it("re-connecting the same email updates (not duplicates) the connection and refreshes the stored secret", async () => {
		seedUser(USER_ID);
		const { imapConnect } = await import("./imap");
		const { listConnectionsForUser, getConnectionSecret } = await import(
			"../store"
		);

		const first = await imapConnect({
			userId: USER_ID,
			email: "alice@example.com",
			imapHost: "imap.example.com",
			password: "first-pw",
			createClient: createClientFactory(new FakeImapClient()),
		});
		const second = await imapConnect({
			userId: USER_ID,
			email: "alice@example.com",
			imapHost: "imap.example.com",
			password: "second-pw",
			createClient: createClientFactory(new FakeImapClient()),
		});

		expect(second.connection.id).toBe(first.connection.id);
		const rows = await listConnectionsForUser(USER_ID);
		expect(rows).toHaveLength(1);
		const decrypted = await getConnectionSecret(USER_ID, second.connection.id);
		expect(decrypted).toBe("second-pw");
	});
});

// ---------------------------------------------------------------------------
// imapListRecent / imapSearch
// ---------------------------------------------------------------------------

function envelopeMessage(params: {
	uid: number;
	subject: string;
	from?: { name?: string; address?: string };
	date?: string;
	seen?: boolean;
}): ImapFetchedMessage {
	return {
		uid: params.uid,
		envelope: {
			subject: params.subject,
			date: params.date ?? "2026-07-08T10:00:00.000Z",
			from: params.from ? [params.from] : [],
		},
		flags: new Set(params.seen ? ["\\Seen"] : []),
	};
}

describe("imapListRecent", () => {
	it("returns EmailHeader[] parsed from search + fetch, most-recent-first, capped at the requested limit", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");

		const messages = [1, 2, 3, 4, 5].map((uid) =>
			envelopeMessage({
				uid,
				subject: `Subject ${uid}`,
				from: { name: "Bob", address: "bob@example.com" },
				seen: uid % 2 === 0,
			}),
		);
		const client = new FakeImapClient({
			search: () => [1, 2, 3, 4, 5],
			fetch: () => asyncIterableOf(messages),
		});

		const headers = await imapListRecent(
			USER_ID,
			conn.id,
			{ limit: 3 },
			{ createClient: createClientFactory(client) },
		);

		expect(headers).toHaveLength(3);
		expect(headers.map((h) => h.uid)).toEqual([5, 4, 3]);
		expect(headers[0]).toEqual({
			uid: 5,
			from: "Bob <bob@example.com>",
			subject: "Subject 5",
			date: "2026-07-08T10:00:00.000Z",
			seen: false,
		});
		expect(client.mailboxOpenCalls).toEqual([
			{ path: "INBOX", options: { readOnly: true } },
		]);
		expect(client.logoutCalls).toBe(1);
	});

	it("passes { seen: false } to search when unseenOnly is set", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [],
			fetch: () => asyncIterableOf([]),
		});

		await imapListRecent(
			USER_ID,
			conn.id,
			{ unseenOnly: true },
			{ createClient: createClientFactory(client) },
		);

		expect(client.searchCalls).toEqual([{ seen: false }]);
	});

	it("never marks \\Seen: only search/fetch (BODY.PEEK-backed) are called, and the mailbox is opened read-only", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [1],
			fetch: () =>
				asyncIterableOf([envelopeMessage({ uid: 1, subject: "Hi" })]),
		});

		await imapListRecent(
			USER_ID,
			conn.id,
			{},
			{ createClient: createClientFactory(client) },
		);

		expect(client.mailboxOpenCalls[0]?.options).toEqual({ readOnly: true });
		expect(client.messageFlagsAddCalls).toEqual([]);
		// The fetch call requests uid/envelope/flags only — never a raw source
		// fetch that could imply a non-peek read.
		expect(client.fetchCalls[0]?.query).toEqual({
			envelope: true,
			flags: true,
			uid: true,
		});
	});

	it("connection is always closed even when search rejects", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent, ImapError } = await import("./imap");

		const client = new FakeImapClient({
			search: () => {
				throw new Error("boom");
			},
		});

		await expect(
			imapListRecent(
				USER_ID,
				conn.id,
				{},
				{ createClient: createClientFactory(client) },
			),
		).rejects.toBeInstanceOf(ImapError);
		expect(client.logoutCalls).toBe(1);
	});

	it("an auth failure mid-read is mapped to needs_reauth and flags the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");
		const { getConnection } = await import("../store");

		const client = new FakeImapClient({
			search: () => {
				const err = new Error("no");
				(
					err as unknown as { authenticationFailed: boolean }
				).authenticationFailed = true;
				throw err;
			},
		});

		const promise = imapListRecent(
			USER_ID,
			conn.id,
			{},
			{ createClient: createClientFactory(client) },
		);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		const updated = await getConnection(USER_ID, conn.id);
		expect(updated?.status).toBe("needs_reauth");
	});
});

describe("imapSearch", () => {
	it("searches by full text and applies since/limit", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [10, 11],
			fetch: () =>
				asyncIterableOf([
					envelopeMessage({ uid: 10, subject: "Invoice" }),
					envelopeMessage({ uid: 11, subject: "Invoice 2" }),
				]),
		});

		const headers = await imapSearch(
			USER_ID,
			conn.id,
			{ query: "invoice", since: "2026-01-01", limit: 5 },
			{ createClient: createClientFactory(client) },
		);

		// A2: a date-only `since` string is normalized to a Date so imapflow's
		// search-compiler emits a proper "DD-Mon-YYYY" SINCE term (a bare string
		// would skip the WITHIN/BEFORE date handling in the compiler).
		expect(client.searchCalls).toEqual([
			{ text: "invoice", since: new Date("2026-01-01") },
		]);
		expect(headers.map((h) => h.uid)).toEqual([11, 10]);
	});

	it("A2: a from+since search emits native FROM + SINCE keys AND'd with each text word", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [10],
			fetch: () =>
				asyncIterableOf([envelopeMessage({ uid: 10, subject: "Report" })]),
		});

		await imapSearch(
			USER_ID,
			conn.id,
			{ query: "report", from: "anna@example.com", since: "2026-07-01" },
			{ createClient: createClientFactory(client) },
		);

		// The structured keys (FROM/SINCE) ride along with the per-word TEXT term
		// so every criterion AND's together (IMAP search terms are implicitly AND'd).
		expect(client.searchCalls).toEqual([
			{
				from: "anna@example.com",
				since: new Date("2026-07-01"),
				text: "report",
			},
		]);
	});

	it("A2: a date-only `since` normalizes to a Date (structured-only search, no free text)", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [5],
			fetch: () =>
				asyncIterableOf([envelopeMessage({ uid: 5, subject: "Hi" })]),
		});

		await imapSearch(
			USER_ID,
			conn.id,
			{ since: "2026-07-01", before: "2026-07-31" },
			{ createClient: createClientFactory(client) },
		);

		// No free-text words -> exactly one SEARCH built purely from the
		// structured keys, with the date strings normalized to Date objects.
		expect(client.searchCalls).toHaveLength(1);
		const call = client.searchCalls[0];
		expect(call?.since).toBeInstanceOf(Date);
		expect((call?.since as Date).toISOString()).toBe(
			"2026-07-01T00:00:00.000Z",
		);
		expect(call?.before).toBeInstanceOf(Date);
		expect((call?.before as Date).toISOString()).toBe(
			"2026-07-31T00:00:00.000Z",
		);
		expect(call?.text).toBeUndefined();
	});

	it("A2: combined structured keys AND across the per-word text intersection", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const perWord: Record<string, number[]> = {
			invoice: [10, 11, 12],
			acme: [11, 12, 13],
		};
		const client = new FakeImapClient({
			search: (query) => perWord[query.text as string] ?? [],
			fetch: () =>
				asyncIterableOf([
					envelopeMessage({ uid: 11, subject: "Invoice from Acme" }),
					envelopeMessage({ uid: 12, subject: "Acme invoice #2" }),
				]),
		});

		const headers = await imapSearch(
			USER_ID,
			conn.id,
			{ query: "invoice acme", from: "anna@example.com" },
			{ createClient: createClientFactory(client) },
		);

		// One SEARCH per word, each carrying the shared FROM key.
		expect(client.searchCalls).toEqual([
			{ from: "anna@example.com", text: "invoice" },
			{ from: "anna@example.com", text: "acme" },
		]);
		// Only UIDs present in BOTH per-word result sets survive.
		expect(headers.map((h) => h.uid).sort((a, b) => a - b)).toEqual([11, 12]);
	});

	it("returns an empty list without opening a connection when there is no query or filter", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const client = new FakeImapClient();
		const headers = await imapSearch(
			USER_ID,
			conn.id,
			{ query: "   " },
			{ createClient: createClientFactory(client) },
		);

		expect(headers).toEqual([]);
		expect(client.connectCalls).toBe(0);
	});

	it("BUG 3 regression: a multi-word query AND's one TEXT term per word and returns the intersection", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		// IMAP `SEARCH TEXT <string>` is a single contiguous-substring match, so
		// the pre-fix `{ text: "invoice acme" }` matches only that exact run and
		// almost always returns nothing. Post-fix, each word is its own TEXT term
		// and the results are AND'd (intersected): only messages containing ALL
		// words survive.
		const perWord: Record<string, number[]> = {
			invoice: [10, 11, 12],
			acme: [11, 12, 13],
		};
		const client = new FakeImapClient({
			search: (query) => perWord[query.text as string] ?? [],
			fetch: () =>
				asyncIterableOf([
					envelopeMessage({ uid: 11, subject: "Invoice from Acme" }),
					envelopeMessage({ uid: 12, subject: "Acme invoice #2" }),
				]),
		});

		const headers = await imapSearch(
			USER_ID,
			conn.id,
			{ query: "invoice acme" },
			{ createClient: createClientFactory(client) },
		);

		// One TEXT search per word — the fake received AND'd per-word terms.
		expect(client.searchCalls).toEqual([{ text: "invoice" }, { text: "acme" }]);
		// Only UIDs present in BOTH per-word result sets (11, 12) come back.
		expect(headers.map((h) => h.uid).sort((a, b) => a - b)).toEqual([11, 12]);
	});
});

// ---------------------------------------------------------------------------
// imapCount (A4) — unread/search count via a header-free IMAP SEARCH
// ---------------------------------------------------------------------------

describe("imapCount", () => {
	it("A4: returns the full number of matching UIDs (never the fetch cap) and never fetches headers", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapCount } = await import("./imap");

		// Far more than DEFAULT_LIST_LIMIT (20) / MAX_LIST_LIMIT (50): the count
		// must reflect ALL matching UIDs, proving the list cap does not apply.
		const uids = Array.from({ length: 200 }, (_, i) => i + 1);
		const client = new FakeImapClient({
			search: () => uids,
		});

		const count = await imapCount(
			USER_ID,
			conn.id,
			{ unseenOnly: true },
			{ createClient: createClientFactory(client) },
		);

		expect(count).toBe(200);
		// Unread count is a pure SEARCH {seen:false} ...
		expect(client.searchCalls).toEqual([{ seen: false }]);
		// ... with NO header/body fetch at all (uids.length is the free, accurate
		// count), so no message can ever be mislabeled read.
		expect(client.fetchCalls).toEqual([]);
		expect(client.mailboxOpenCalls[0]?.options).toEqual({ readOnly: true });
		expect(client.logoutCalls).toBe(1);
	});

	it("A4: counts everything (SEARCH ALL) when neither unseenOnly nor a filter is given", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapCount } = await import("./imap");

		const client = new FakeImapClient({ search: () => [1, 2, 3, 4] });

		const count = await imapCount(
			USER_ID,
			conn.id,
			{},
			{ createClient: createClientFactory(client) },
		);

		expect(count).toBe(4);
		expect(client.searchCalls).toEqual([{ all: true }]);
		expect(client.fetchCalls).toEqual([]);
	});

	it("A4: counts a structured search (AND'd) without fetching headers", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapCount } = await import("./imap");

		const perWord: Record<string, number[]> = {
			invoice: [10, 11, 12],
			acme: [11, 12, 13],
		};
		const client = new FakeImapClient({
			search: (query) => perWord[query.text as string] ?? [],
		});

		const count = await imapCount(
			USER_ID,
			conn.id,
			{ query: "invoice acme", from: "anna@example.com" },
			{ createClient: createClientFactory(client) },
		);

		expect(count).toBe(2); // intersection of [10,11,12] and [11,12,13]
		expect(client.searchCalls).toEqual([
			{ from: "anna@example.com", text: "invoice" },
			{ from: "anna@example.com", text: "acme" },
		]);
		expect(client.fetchCalls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// imapReadMessage
// ---------------------------------------------------------------------------

describe("imapReadMessage", () => {
	it("prefers text/plain from a multipart/alternative structure and decodes quoted-printable", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 42,
						envelope: { subject: "Hello", date: "2026-07-08T00:00:00Z" },
						flags: new Set(),
						bodyStructure: {
							type: "multipart/alternative",
							childNodes: [
								{
									part: "1",
									type: "text/plain",
									encoding: "quoted-printable",
									parameters: { charset: "utf-8" },
								},
								{
									part: "2",
									type: "text/html",
									encoding: "7bit",
									parameters: { charset: "utf-8" },
								},
							],
						},
					} satisfies ImapFetchedMessage);
				}
				if (query.bodyParts) {
					return Promise.resolve({
						uid: 42,
						bodyParts: new Map([
							["1", Buffer.from("Caf=C3=A9 h=C3=A9llo =\r\nworld", "ascii")],
						]),
					} satisfies ImapFetchedMessage);
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 42 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.header.uid).toBe(42);
		expect(result.header.subject).toBe("Hello");
		expect(result.text).toBe("Café héllo world");
		expect(client.logoutCalls).toBe(1);
	});

	it("BUG 1 regression: reads a single-part (non-multipart) text/plain body stored under imapflow's LOWERCASED 'text' key", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 55,
						envelope: { subject: "Newsletter" },
						flags: new Set(),
						bodyStructure: {
							type: "text/plain",
							encoding: "7bit",
							parameters: { charset: "utf-8" },
						},
					});
				}
				if (query.bodyParts) {
					// Real imapflow LOWERCASES every FETCH response part key (see
					// tools.js formatMessageResponse), so a single-part body
					// requested as "TEXT" comes back keyed "text". The fake mirrors
					// that here — the case the earlier uppercase-keyed fakes missed.
					return Promise.resolve({
						uid: 55,
						bodyParts: new Map([
							["text", Buffer.from("Hello from a plain email", "utf8")],
						]),
					});
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 55 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.text).toBe("Hello from a plain email");
	});

	it("BUG 2 regression: decodes a quoted-printable body in a non-UTF-8 charset (iso-8859-1) without mojibake", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		// Multipart with a NUMERIC part id ("1") so this test isolates the
		// quoted-printable/charset bug from the single-part lookup bug (BUG 1):
		// numeric ids are case-invariant, so the part is always found.
		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 88,
						envelope: { subject: "Accented" },
						flags: new Set(),
						bodyStructure: {
							type: "multipart/mixed",
							childNodes: [
								{
									part: "1",
									type: "text/plain",
									encoding: "quoted-printable",
									parameters: { charset: "iso-8859-1" },
								},
							],
						},
					});
				}
				if (query.bodyParts) {
					// In iso-8859-1, é is the single byte 0xE9 ("=E9") and ï is 0xEF
					// ("=EF"). Decoding these bytes as utf-8 (the pre-fix behavior)
					// yields U+FFFD replacement chars, not the intended letters.
					return Promise.resolve({
						uid: 88,
						bodyParts: new Map([["1", Buffer.from("caf=E9 na=EFve", "ascii")]]),
					});
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 88 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.text).toBe("café naïve");
	});

	it("falls back to text/html and strips tags when no text/plain part exists", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 7,
						envelope: { subject: "Only HTML" },
						flags: new Set(),
						bodyStructure: {
							type: "text/html",
							encoding: "7bit",
							parameters: { charset: "utf-8" },
						},
					});
				}
				if (query.bodyParts) {
					return Promise.resolve({
						uid: 7,
						bodyParts: new Map([
							// imapflow returns single-part bodies under a LOWERCASED key.
							["text", Buffer.from("<p>Hi <b>there</b></p>", "utf8")],
						]),
					});
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 7 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.text).toBe("Hi there");
	});

	it("caps the decoded body text length", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const longText = "a".repeat(30_000);
		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 1,
						envelope: { subject: "Long" },
						flags: new Set(),
						bodyStructure: {
							type: "text/plain",
							encoding: "7bit",
							parameters: { charset: "utf-8" },
						},
					});
				}
				if (query.bodyParts) {
					return Promise.resolve({
						uid: 1,
						bodyParts: new Map([["text", Buffer.from(longText, "utf8")]]),
					});
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 1 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.text.length).toBeLessThan(longText.length);
		expect(result.text.endsWith("...")).toBe(true);
	});

	it("throws message_not_found when the UID doesn't resolve, and still closes the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: () => Promise.resolve(false),
		});

		await expect(
			imapReadMessage(
				USER_ID,
				conn.id,
				{ uid: 999 },
				{ createClient: createClientFactory(client) },
			),
		).rejects.toMatchObject({ code: "message_not_found" });
		expect(client.logoutCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// imapAdapter.checkHealth
// ---------------------------------------------------------------------------

describe("imapAdapter.checkHealth", () => {
	it("connect + mailboxOpen succeed -> connected", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapAdapter } = await import("./imap");

		const client = new FakeImapClient();
		const health = await imapAdapter.checkHealth("correct-horse", conn, {
			createClient: createClientFactory(client),
		});

		expect(health.status).toBe("connected");
		expect(client.logoutCalls).toBe(1);
	});

	it("auth failure -> needs_reauth, no secret in the detail", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapAdapter } = await import("./imap");

		const client = new FakeImapClient({
			connect: () => {
				const err = new Error("no");
				(
					err as unknown as { authenticationFailed: boolean }
				).authenticationFailed = true;
				throw err;
			},
		});

		const health = await imapAdapter.checkHealth("correct-horse", conn, {
			createClient: createClientFactory(client),
		});

		expect(health.status).toBe("needs_reauth");
		expect(health.detail).not.toContain("correct-horse");
	});

	it("other failures -> error", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapAdapter } = await import("./imap");

		const client = new FakeImapClient({
			connect: () => {
				throw new Error("ETIMEDOUT");
			},
		});

		const health = await imapAdapter.checkHealth("correct-horse", conn, {
			createClient: createClientFactory(client),
		});

		expect(health.status).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// Folder scoping (GAP B4) — reads can open a named folder (Sent/Archive/…),
// resolved SPECIAL-USE-first then by name, defaulting to INBOX.
// ---------------------------------------------------------------------------

describe("folder scoping (B4)", () => {
	it("resolves a named folder to its SPECIAL-USE mailbox path and opens THAT (not INBOX), read-only", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");

		const client = new FakeImapClient({
			list: () => [
				{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
				{ path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
			],
			search: () => [1],
			fetch: () =>
				asyncIterableOf([envelopeMessage({ uid: 1, subject: "To Bob" })]),
		});

		await imapListRecent(
			USER_ID,
			conn.id,
			{ folder: "Sent" },
			{ createClient: createClientFactory(client) },
		);

		expect(client.mailboxOpenCalls).toEqual([
			{ path: "Sent Items", options: { readOnly: true } },
		]);
	});

	it("falls back to a case-insensitive name/path match when no special-use flag applies", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapSearch } = await import("./imap");

		const client = new FakeImapClient({
			list: () => [
				{ path: "INBOX", name: "INBOX" },
				{ path: "Projects", name: "Projects" },
			],
			search: () => [3],
			fetch: () =>
				asyncIterableOf([envelopeMessage({ uid: 3, subject: "Spec" })]),
		});

		await imapSearch(
			USER_ID,
			conn.id,
			{ query: "spec", folder: "projects" },
			{ createClient: createClientFactory(client) },
		);

		expect(client.mailboxOpenCalls).toEqual([
			{ path: "Projects", options: { readOnly: true } },
		]);
	});

	it("throws folder_not_found for an unknown folder, and still closes the connection", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			list: () => [{ path: "INBOX", name: "INBOX" }],
		});

		await expect(
			imapReadMessage(
				USER_ID,
				conn.id,
				{ uid: 1, folder: "Nonexistent" },
				{ createClient: createClientFactory(client) },
			),
		).rejects.toMatchObject({ code: "folder_not_found" });
		expect(client.logoutCalls).toBe(1);
	});

	it("default (no folder) still opens INBOX and never calls list()", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListRecent } = await import("./imap");

		const client = new FakeImapClient({
			search: () => [],
			fetch: () => asyncIterableOf([]),
		});

		await imapListRecent(
			USER_ID,
			conn.id,
			{},
			{ createClient: createClientFactory(client) },
		);

		expect(client.mailboxOpenCalls).toEqual([
			{ path: "INBOX", options: { readOnly: true } },
		]);
		expect(client.listCalls).toBe(0);
	});

	it("imapListFolders returns path/name/specialUse for every mailbox", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapListFolders } = await import("./imap");

		const client = new FakeImapClient({
			list: () => [
				{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
				{ path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
				{ path: "Archive", name: "Archive", specialUse: "\\Archive" },
				{ path: "Work/Clients", name: "Clients" },
			],
		});

		const folders = await imapListFolders(USER_ID, conn.id, {
			createClient: createClientFactory(client),
		});

		expect(folders).toEqual([
			{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
			{ path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
			{ path: "Archive", name: "Archive", specialUse: "\\Archive" },
			{ path: "Work/Clients", name: "Clients" },
		]);
		expect(client.mailboxOpenCalls[0]?.options).toEqual({ readOnly: true });
		expect(client.logoutCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Attachments (GAP B5) — imapReadMessage lists attachment metadata parsed from
// the already-fetched bodyStructure, without downloading any bytes.
// ---------------------------------------------------------------------------

describe("attachments (B5)", () => {
	it("lists attachment filename/contentType/size from bodyStructure, keeping the text body, without a bytes download", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 70,
						envelope: { subject: "Here is the invoice" },
						flags: new Set(),
						bodyStructure: {
							type: "multipart/mixed",
							childNodes: [
								{
									part: "1",
									type: "text/plain",
									encoding: "7bit",
									parameters: { charset: "utf-8" },
								},
								{
									part: "2",
									type: "application/pdf",
									encoding: "base64",
									size: 12345,
									disposition: "attachment",
									dispositionParameters: { filename: "invoice.pdf" },
								},
							],
						},
					} satisfies ImapFetchedMessage);
				}
				if (query.bodyParts) {
					return Promise.resolve({
						uid: 70,
						bodyParts: new Map([["1", Buffer.from("See attached", "utf8")]]),
					} satisfies ImapFetchedMessage);
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 70 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.text).toBe("See attached");
		expect(result.attachments).toEqual([
			{ filename: "invoice.pdf", contentType: "application/pdf", size: 12345 },
		]);
		const bodyPartFetches = client.fetchOneCalls.filter(
			(c) => (c.query as { bodyParts?: unknown }).bodyParts,
		);
		expect(bodyPartFetches).toHaveLength(1);
	});

	it("returns an empty attachments list for a plain single-part message", async () => {
		seedUser(USER_ID);
		const conn = await seedImapConnection();
		const { imapReadMessage } = await import("./imap");

		const client = new FakeImapClient({
			fetchOne: (_seq, query) => {
				if (query.bodyStructure) {
					return Promise.resolve({
						uid: 71,
						envelope: { subject: "Plain" },
						flags: new Set(),
						bodyStructure: {
							type: "text/plain",
							encoding: "7bit",
							parameters: { charset: "utf-8" },
						},
					});
				}
				if (query.bodyParts) {
					return Promise.resolve({
						uid: 71,
						bodyParts: new Map([["text", Buffer.from("Hi", "utf8")]]),
					});
				}
				return Promise.resolve(false);
			},
		});

		const result = await imapReadMessage(
			USER_ID,
			conn.id,
			{ uid: 71 },
			{ createClient: createClientFactory(client) },
		);

		expect(result.attachments).toEqual([]);
	});
});
