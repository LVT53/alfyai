// The order a document search returns, from the three signals it has: how many of
// the query's words a document contains, how close its meaning is (the embedder's
// cosine) and the reranker's verdict.
//
// The order used to be that of the query's word count alone for every document
// more than a few minutes old: the fusion score was multiplied by
// exp(-0.011 * ageInSECONDS), which is 0 after about ten minutes, so the cosine,
// the reranker and the project boost were weighed for nothing and only
// `0.35 * lexicalScore` was left. A Hungarian question about a deposit never found
// the English clause that answers it, and a paraphrase lost to any document that
// happened to share a few everyday words with the question.
//
// Every document here is days or months old on purpose: how recently a document was
// written is a tie-break, and these tests are about what decides before it.
//
// A real migrated SQLite file for the candidate pass; the two things that need a
// model, the cosines and the reranker, are set by hand so each test says which
// signal it relies on.

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { Artifact } from "$lib/server/services/knowledge/types";

type SemanticMatch = {
	item: Artifact;
	subjectId: string;
	semanticScore: number;
};

type RerankResult = {
	items: Array<{ item: Artifact; index: number; score: number }>;
	confidence: number;
};

const { mockShortlistSemanticMatchesBySubject, mockRerankItems } = vi.hoisted(
	() => ({
		mockShortlistSemanticMatchesBySubject: vi.fn(
			async (_params: { items: Artifact[] }) => [] as SemanticMatch[] | null,
		),
		mockRerankItems: vi.fn(
			async (_params: { items: Artifact[] }) => null as RerankResult | null,
		),
	}),
);

vi.mock("$lib/server/services/semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: mockShortlistSemanticMatchesBySubject,
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => true),
	rerankItems: mockRerankItems,
}));

const USER = "owner";
const DAY_MS = 86_400_000;
/** `TEI_RERANKER_MAX_TEXTS`: the real client scores the first this-many documents it is handed and no others. */
const RERANKER_CAP = 8;

let dbPath: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function addDocument(params: {
	id: string;
	name: string;
	text: string;
	ageDays: number;
}) {
	const writtenAt = new Date(Date.now() - params.ageDays * DAY_MS);
	db.insert(schema.artifacts)
		.values({
			id: params.id,
			userId: USER,
			conversationId: null,
			type: "normalized_document",
			retrievalClass: "durable",
			name: params.name,
			mimeType: "text/markdown",
			sizeBytes: params.text.length,
			contentText: params.text,
			createdAt: writtenAt,
			updatedAt: writtenAt,
		})
		.run();
}

/** The embedder's cosine for the named documents. Any other document is outside its shortlist, as the 25th and later are. */
function setCosines(cosines: Record<string, number>) {
	mockShortlistSemanticMatchesBySubject.mockImplementation(async ({ items }) =>
		Object.entries(cosines)
			.sort(([, left], [, right]) => right - left)
			.flatMap(([id, semanticScore]) => {
				const item = items.find((artifact) => artifact.id === id);
				return item ? [{ item, subjectId: id, semanticScore }] : [];
			}),
	);
}

/** The reranker, cap included. A document it scores that is not named here gets a low score. */
function setReranker(scores: Record<string, number>) {
	mockRerankItems.mockImplementation(async ({ items }) => ({
		items: items
			.slice(0, RERANKER_CAP)
			.map((item, index) => ({ item, index, score: scores[item.id] ?? 0.05 }))
			.sort((left, right) => right.score - left.score),
		confidence: 90,
	}));
}

async function search(query: string, limit = 5) {
	const { findRelevantArtifactsByTypesDetailed } = await import("./documents");
	return findRelevantArtifactsByTypesDetailed({
		userId: USER,
		query,
		types: ["normalized_document"],
		limit,
	});
}

async function idsFor(query: string, limit = 5): Promise<string[]> {
	return (await search(query, limit)).map((match) => match.artifact.id);
}

describe("document search order", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-documents-ranking-order-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		mockShortlistSemanticMatchesBySubject.mockReset();
		mockShortlistSemanticMatchesBySubject.mockResolvedValue([]);
		mockRerankItems.mockReset();
		mockRerankItems.mockResolvedValue(null);

		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });
		const now = new Date();
		db.insert(schema.users)
			.values({
				id: USER,
				email: "owner@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	});

	afterEach(async () => {
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

	it("puts the document that answers first when none of the query's words appear in it", async () => {
		addDocument({
			id: "garden-schedule",
			name: "Garden schedule.md",
			text: "Spring watering rota for the garden beds.",
			ageDays: 3,
		});
		addDocument({
			id: "lease-deposit-hu",
			name: "Bérleti szerződés.md",
			text: "A kaució visszafizetése a bérleti jogviszony megszűnésekor történik.",
			ageDays: 40,
		});
		setCosines({ "lease-deposit-hu": 0.82, "garden-schedule": 0.21 });

		expect(await idsFor("tenant deposit refund")).toEqual([
			"lease-deposit-hu",
			"garden-schedule",
		]);
	});

	it("does not let a few everyday words in common outrank a document that answers the question", async () => {
		// Three of the query's seven words ("notice", "for", "the") are in the rota.
		addDocument({
			id: "staff-rota",
			name: "Staff rota.md",
			text: "Staff notice board: the cleaning rota for the office.",
			ageDays: 5,
		});
		addDocument({
			id: "lease-termination-hu",
			name: "Bérleti szerződés felmondása.md",
			text: "A felmondási idő a bérleti szerződés megszüntetésekor hatvan nap.",
			ageDays: 60,
		});
		setCosines({ "lease-termination-hu": 0.84, "staff-rota": 0.31 });

		expect(
			await idsFor("notice period for ending the rental contract"),
		).toEqual(["lease-termination-hu", "staff-rota"]);
	});

	it("still puts a document that holds every word of the query before a look-alike that holds one", async () => {
		addDocument({
			id: "forecast-deck",
			name: "Forecast deck.md",
			text: "Quarterly revenue forecast assumptions for the board deck.",
			ageDays: 60,
		});
		addDocument({
			id: "revenue-overview",
			name: "Revenue overview.md",
			text: "How the business earns money from subscriptions and services.",
			ageDays: 2,
		});
		// A phrase out of a long document is often a worse match for the whole
		// document, in meaning, than a document about the same subject.
		setCosines({ "forecast-deck": 0.52, "revenue-overview": 0.78 });
		setReranker({ "forecast-deck": 0.35, "revenue-overview": 0.6 });

		expect(await idsFor("quarterly revenue forecast assumptions deck")).toEqual(
			["forecast-deck", "revenue-overview"],
		);
	});

	it("shows the reranker the most promising documents, not the first twelve that share a word", async () => {
		for (let n = 1; n <= 12; n += 1) {
			addDocument({
				id: `hit-${String(n).padStart(2, "0")}`,
				name: `Hit ${n}.md`,
				text: `Notes on alpha, number ${n}.`,
				ageDays: n,
			});
		}
		addDocument({
			id: "meaning",
			name: "Meaning.md",
			text: "Something worded in entirely different terms.",
			ageDays: 30,
		});
		setCosines({ meaning: 0.8 });
		setReranker({ meaning: 0.95 });

		const matches = await search("alpha beta gamma delta", 3);

		expect(mockRerankItems.mock.calls[0]?.[0].items[0]?.id).toBe("meaning");
		expect(matches[0]?.artifact.id).toBe("meaning");
		// The three signals travel on unchanged: the cross-conversation rule reads
		// them against its own thresholds.
		expect(matches[0]).toMatchObject({
			lexicalScore: 0,
			semanticScore: 0.8,
			rerankScore: 0.95,
		});
	});

	it("puts the more relevant of two old documents first, whichever was written later", async () => {
		addDocument({
			id: "recent-draft",
			name: "Forecast draft.md",
			text: "Quarterly revenue forecast, first draft.",
			ageDays: 2,
		});
		addDocument({
			id: "older-final",
			name: "Forecast final.md",
			text: "Quarterly revenue forecast, final numbers.",
			ageDays: 90,
		});
		setCosines({ "older-final": 0.8, "recent-draft": 0.4 });

		expect(await idsFor("quarterly revenue forecast")).toEqual([
			"older-final",
			"recent-draft",
		]);
	});

	it("puts the newer of two equally relevant documents first", async () => {
		addDocument({
			id: "older-copy",
			name: "Forecast copy.md",
			text: "Quarterly revenue forecast.",
			ageDays: 90,
		});
		addDocument({
			id: "newer-copy",
			name: "Forecast copy.md",
			text: "Quarterly revenue forecast.",
			ageDays: 2,
		});
		setCosines({ "older-copy": 0.6, "newer-copy": 0.6 });

		expect(await idsFor("quarterly revenue forecast")).toEqual([
			"newer-copy",
			"older-copy",
		]);
	});
});
