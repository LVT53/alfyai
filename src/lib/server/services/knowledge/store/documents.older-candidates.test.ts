// Which documents a search looks at once the library holds more than the 120 it
// takes by recency.
//
// A search for documents reads the 120 most recently updated ones and ranks only
// those (`SEMANTIC_ARTIFACT_CANDIDATE_LIMIT`). In a library of 400 documents that
// leaves 70% of them out of reach, and in one of 1,500, 92%: an older document is
// never ranked, however well it answers the question and even when the question
// names it (docs/plans/document-ranking/README.md, "Which documents are in the
// running", has the measurements and the cost of the fix).
//
// The fix adds two small groups of OLDER documents to the 120: the ones whose
// stored vector is closest to the question (when the caller embedded it), and the
// ones whose name or opening lines hold every longer word of the question (a
// series told apart by its year, a name, an id: what the embedder is weakest at).
// Both pay only when there ARE older documents, and the vector read is bounded;
// the text of the older documents is never read.
//
// A real migrated SQLite file with real stored vectors, in a three-dimensional
// embedding space so each test says what the embedder "thinks" in plain numbers.
// The real vector store runs (watched, to count what a search reads); the two
// network services, the embedder and the reranker, are the only things replaced.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const { vectorReads } = vi.hoisted(() => ({ vectorReads: [] as number[] }));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

/** The embedder is configured but cannot be reached: a query without its own embedding gets none. */
vi.mock("$lib/server/services/tei-embedder", () => ({
	canUseTeiEmbedder: vi.fn(() => true),
	embedTexts: vi.fn(async () => null),
	embedText: vi.fn(async () => null),
}));

const USER = "owner";
const STRANGER = "someone-else";
const CURRENT = "conv-current";
const INCOGNITO = "conv-incognito";
const DAY_MS = 86_400_000;
const MODEL = "test-embedder";

/** A document is about the query when its vector points along x, about something else along y. */
const QUERY_VECTOR = [1, 0, 0];
const ABOUT_THE_QUERY = [0.9, 0.1, 0];
const ABOUT_SOMETHING_ELSE = [0, 1, 0];
/** Cosines of 0.6 and 0.5 with the query: the usual range for a short query against a long document. */
const FAIRLY_CLOSE = [0.6, 0.8, 0];
const A_LITTLE_LESS_CLOSE = [0.5, Math.sqrt(0.75), 0];

/** The 120 newest documents are always in the running. */
const WINDOW = 120;

let dbPath: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let savedModel: string | undefined;

type NewDocument = {
	id: string;
	text: string;
	ageDays: number;
	/** The stored vector; none means the document has not been embedded yet. */
	vector?: number[];
	name?: string;
	/** What a library shows beside the name: the first lines of the text. */
	summary?: string;
	userId?: string;
	conversationId?: string | null;
	type?: "normalized_document" | "source_document";
};

function addDocuments(documents: NewDocument[]) {
	db.transaction((tx) => {
		for (const document of documents) {
			const writtenAt = new Date(Date.now() - document.ageDays * DAY_MS);
			const userId = document.userId ?? USER;
			tx.insert(schema.artifacts)
				.values({
					id: document.id,
					userId,
					conversationId: document.conversationId ?? null,
					type: document.type ?? "normalized_document",
					retrievalClass: "durable",
					name: document.name ?? `${document.id}.md`,
					summary: document.summary ?? null,
					mimeType: "text/markdown",
					sizeBytes: document.text.length,
					contentText: document.text,
					createdAt: writtenAt,
					updatedAt: writtenAt,
				})
				.run();
			if (document.vector) {
				tx.insert(schema.semanticEmbeddings)
					.values({
						id: `${document.id}:vector`,
						userId,
						subjectType: "artifact",
						subjectId: document.id,
						modelName: MODEL,
						sourceTextHash: "hash",
						dimensions: document.vector.length,
						embeddingJson: JSON.stringify(document.vector),
						createdAt: writtenAt,
						updatedAt: writtenAt,
					})
					.run();
			}
		}
	});
}

/** `count` unrelated documents, ages `fromDays` upward a tenth of a day apart. */
function fillers(
	prefix: string,
	count: number,
	fromDays: number,
	options: { vector?: number[] | null } = {},
): NewDocument[] {
	const vector =
		options.vector === null
			? undefined
			: (options.vector ?? ABOUT_SOMETHING_ELSE);
	return Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${index}`,
		text: `Garden notes number ${index}.`,
		ageDays: fromDays + index / 10,
		vector,
	}));
}

async function search(
	query: string,
	options: {
		queryEmbedding?: number[];
		excludeConversationId?: string;
		limit?: number;
	} = {},
) {
	const { findRelevantArtifactsByTypesDetailed } = await import("./documents");
	return findRelevantArtifactsByTypesDetailed({
		userId: USER,
		query,
		types: ["normalized_document"],
		limit: options.limit ?? 5,
		excludeConversationId: options.excludeConversationId,
		queryEmbedding:
			"queryEmbedding" in options ? options.queryEmbedding : QUERY_VECTOR,
	});
}

async function idsFor(
	query: string,
	options: Parameters<typeof search>[1] = {},
): Promise<string[]> {
	return (await search(query, options)).map((match) => match.artifact.id);
}

describe("document search beyond the newest 120", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-documents-older-candidates-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		savedModel = process.env.TEI_EMBEDDER_MODEL;
		process.env.TEI_EMBEDDER_MODEL = MODEL;
		vi.resetModules();
		vectorReads.length = 0;
		// The real vector store, watched: how many vectors each read asks for is the
		// cost of a search. Registered after the reset, so every test gets the store
		// of its own database (a factory registered at the top is not run again).
		vi.doMock("$lib/server/services/semantic-embeddings", async () => {
			const actual = await vi.importActual<
				typeof import("$lib/server/services/semantic-embeddings")
			>("$lib/server/services/semantic-embeddings");
			return {
				...actual,
				listSemanticEmbeddingsBySubject: (
					params: Parameters<typeof actual.listSemanticEmbeddingsBySubject>[0],
				) => {
					vectorReads.push(params.subjectIds.length);
					return actual.listSemanticEmbeddingsBySubject(params);
				},
			};
		});

		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		const now = new Date();
		for (const [id, email] of [
			[USER, "owner@example.com"],
			[STRANGER, "stranger@example.com"],
		] as const) {
			db.insert(schema.users)
				.values({
					id,
					email,
					passwordHash: "hash",
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}
		for (const [id, memoryIncognito] of [
			[CURRENT, false],
			[INCOGNITO, true],
		] as const) {
			db.insert(schema.conversations)
				.values({
					id,
					userId: USER,
					title: id,
					memoryIncognito,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}
	});

	afterEach(async () => {
		if (savedModel === undefined) delete process.env.TEI_EMBEDDER_MODEL;
		else process.env.TEI_EMBEDDER_MODEL = savedModel;
		sqlite.close();
		try {
			const appDb = await import("$lib/server/db");
			appDb.sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("finds the old document whose meaning answers the question when 120 newer ones fill the window", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "lease-deposit-hu",
				name: "Bérleti szerződés.md",
				text: "A kaució visszafizetése a bérleti jogviszony megszűnésekor történik.",
				ageDays: 400,
				vector: ABOUT_THE_QUERY,
			},
			...fillers("old", 5, 200),
		]);

		// No word of the question is in the lease: only its vector says it answers.
		expect((await idsFor("tenant deposit refund"))[0]).toBe("lease-deposit-hu");
	});

	it("takes the older documents closest to the question, not the newest of the older ones", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			// 100 older documents, the right one the oldest of all.
			...fillers("old", 100, 60),
			{
				id: "lease-deposit-hu",
				name: "Bérleti szerződés.md",
				text: "A kaució visszafizetése a bérleti jogviszony megszűnésekor történik.",
				ageDays: 900,
				vector: ABOUT_THE_QUERY,
			},
		]);

		expect((await idsFor("tenant deposit refund"))[0]).toBe("lease-deposit-hu");
	});

	it("reads no extra vectors while the library fits the window, and the older documents' vectors beyond it", async () => {
		addDocuments(fillers("recent", 100, 1));
		await search("tenant deposit refund");
		// One read: the shortlist over the 100 candidates, as before.
		expect(vectorReads).toEqual([100]);

		vectorReads.length = 0;
		addDocuments(fillers("old", 30, 60));
		await search("tenant deposit refund");
		// The 30 documents outside the window are compared by vector (1st read);
		// the 24 closest join the 120 for the usual shortlist (2nd read).
		expect(vectorReads).toEqual([10, 130]);
	});

	it("compares at most the 2,000 newest of the older documents, so a very large library costs a bounded search", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			...fillers("old", 2100, 60),
		]);

		await search("tenant deposit refund");

		expect(vectorReads[0]).toBe(2000);
	});

	it("leaves out the older documents the search may not see", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "mine-old",
				text: "A kaució visszafizetése.",
				ageDays: 200,
				vector: ABOUT_THE_QUERY,
			},
			{
				id: "strangers-old",
				text: "A kaució visszafizetése.",
				ageDays: 201,
				vector: ABOUT_THE_QUERY,
				userId: STRANGER,
			},
			{
				id: "this-chats-old",
				text: "A kaució visszafizetése.",
				ageDays: 202,
				vector: ABOUT_THE_QUERY,
				conversationId: CURRENT,
			},
			{
				id: "incognito-chats-old",
				text: "A kaució visszafizetése.",
				ageDays: 203,
				vector: ABOUT_THE_QUERY,
				conversationId: INCOGNITO,
			},
			{
				id: "the-upload-itself",
				text: "A kaució visszafizetése.",
				ageDays: 204,
				vector: ABOUT_THE_QUERY,
				type: "source_document",
			},
		]);

		const ids = await idsFor("tenant deposit refund", {
			excludeConversationId: CURRENT,
		});

		expect(ids).toEqual(["mine-old"]);
	});

	it("finds the one document of a series that the question names by its year, when forty others are closer in meaning", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			// Forty leases the embedder likes better than the one asked for: more than
			// the 24 the vector pass takes.
			...Array.from({ length: 40 }, (_, index) => ({
				id: `hatvany-${1970 + index}`,
				name: `Hatvany lease ${1970 + index}.md`,
				text: "Lease. Deposit refund terms.",
				ageDays: 100 + index,
				vector: FAIRLY_CLOSE,
			})),
			{
				id: "hatvany-2019",
				name: "Hatvany lease 2019.md",
				text: "Lease. Deposit refund terms.",
				ageDays: 400,
				vector: A_LITTLE_LESS_CLOSE,
			},
		]);

		expect((await idsFor("Hatvany lease 2019"))[0]).toBe("hatvany-2019");
	});

	it("finds it by its name when the question could not be embedded, and not a document that has only some of its words", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "hatvany-2019",
				name: "Hatvany lease 2019.md",
				text: "Lease.",
				ageDays: 400,
			},
			{
				id: "hatvany-2018",
				name: "Hatvany lease 2018.md",
				text: "Lease.",
				ageDays: 410,
			},
		]);

		expect(
			await idsFor("Hatvany lease 2019", { queryEmbedding: undefined }),
		).toEqual(["hatvany-2019"]);
	});

	it("adds only the 12 newest of the documents whose names hold the question's words", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			...Array.from({ length: 20 }, (_, index) => ({
				id: `hatvany-${index}`,
				name: `Hatvany lease ${index}.md`,
				text: "Lease.",
				ageDays: 100 + index,
			})),
		]);

		const ids = await idsFor("Hatvany lease", {
			queryEmbedding: undefined,
			limit: 50,
		});

		expect(ids.sort()).toEqual(
			Array.from({ length: 12 }, (_, index) => `hatvany-${index}`).sort(),
		);
	});

	it("finds a document by the words of its opening lines, which a library shows beside the name", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "minutes",
				name: "Minutes.md",
				summary:
					"The zebra crossed the quartz bridge by the harbour lantern at dusk.",
				text: "The zebra crossed the quartz bridge by the harbour lantern at dusk. Long minutes follow.",
				ageDays: 300,
			},
		]);

		expect(
			await idsFor("zebra quartz harbour lantern", {
				queryEmbedding: undefined,
			}),
		).toEqual(["minutes"]);
	});

	it("reads a Hungarian name by its whole words, not by the pieces between its accents", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "vineyard-notes",
				name: "Gyümölcsöző szőlőtőkék termése.md",
				text: "Bőséges volt.",
				ageDays: 300,
			},
			// Holds "lcs" and "term", the pieces of the phrase's words that are left
			// when each accented letter is taken for a separator, and one word of three:
			// were it a candidate it would be in the answer.
			{
				id: "place-names",
				name: "Alcsút. A termése.md",
				text: "Térkép.",
				ageDays: 310,
			},
		]);

		expect(
			await idsFor("gyümölcsöző szőlőtőkék termése", {
				queryEmbedding: undefined,
			}),
		).toEqual(["vineyard-notes"]);
	});

	it("matches a name that opens with an accented capital by its lowercase words", async () => {
		addDocuments([
			...fillers("recent", WINDOW, 1),
			{
				id: "handover",
				name: "Épület átadás-átvételi jegyzőkönyv.md",
				text: "Jegyzőkönyv.",
				ageDays: 300,
			},
		]);

		expect(
			await idsFor("épület átadás-átvételi", { queryEmbedding: undefined }),
		).toEqual(["handover"]);
	});

	it("still answers from the newest documents when no older document has been embedded yet", async () => {
		addDocuments([
			{
				id: "fresh-lease",
				text: "Deposit refund terms.",
				ageDays: 2,
				vector: ABOUT_THE_QUERY,
			},
			...fillers("recent", WINDOW, 3),
			...fillers("old", 40, 60, { vector: null }),
		]);

		expect((await idsFor("tenant deposit refund"))[0]).toBe("fresh-lease");
	});
});
