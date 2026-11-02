// What a search for one kind of artifact returns when it is told to leave one
// conversation out (the turn's own, `excludeConversationId`).
//
// The leave-out was written into the WHERE as a raw `a IS NULL OR a <> b`, which
// drizzle does not put in parentheses inside `and(...)`: SQL read it as
// `(owner AND type AND conversation IS NULL) OR conversation <> b`, so every row
// that sat in some other conversation passed whatever its type, and whoever
// owned it. A search for normalized documents therefore met every earlier turn's
// answer and work capsule, and these quote the question they answered, so they
// outscored the uploaded file the question names and took every slot of the
// turn's top six: from the fourth identical question on, the project's file was
// never read (tests/e2e/live-evidence-metadata.spec.ts, "still shows both after a
// reload", failed one repeat in two).
//
// A real migrated SQLite file: the claim is about the SQL, which a mocked
// `drizzle-orm` cannot show (documents.test.ts mocks it).

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("$lib/server/services/tei-embedder", () => ({
	canUseTeiEmbedder: vi.fn(() => false),
	embedTexts: vi.fn(),
	embedText: vi.fn(),
}));

let dbPath: string;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const USER = "owner";
const OTHER = "someone-else";
const CURRENT = "conv-current";
const EARLIER = "conv-earlier";
const THEIRS = "conv-theirs";
const QUESTION = "Summarise what Hotel Motto booking.txt says about the stay.";

type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

function seedBase(db: SeedDb) {
	for (const [id, email] of [
		[USER, "owner@example.com"],
		[OTHER, "other@example.com"],
	] as const) {
		db.insert(schema.users)
			.values({
				id,
				email,
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}
	for (const [id, userId] of [
		[CURRENT, USER],
		[EARLIER, USER],
		[THEIRS, OTHER],
	] as const) {
		db.insert(schema.conversations)
			.values({ id, userId, title: id, createdAt: NOW, updatedAt: NOW })
			.run();
	}
}

function seedArtifact(
	db: SeedDb,
	params: {
		id: string;
		userId?: string;
		conversationId: string | null;
		type: "normalized_document" | "generated_output" | "work_capsule";
		name: string;
		contentText: string;
	},
) {
	db.insert(schema.artifacts)
		.values({
			id: params.id,
			userId: params.userId ?? USER,
			conversationId: params.conversationId,
			type: params.type,
			retrievalClass: "durable",
			name: params.name,
			mimeType: "text/markdown",
			sizeBytes: params.contentText.length,
			contentText: params.contentText,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/** The upload the question names, an earlier turn's answer and work capsule (both quote the question), and a stranger's document. */
function seedLibrary() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedBase(db);
	seedArtifact(db, {
		id: "the-file",
		conversationId: null,
		type: "normalized_document",
		name: "Hotel Motto booking.md",
		contentText: "Hotel Motto, Vienna. Two nights, 12-14 October.",
	});
	seedArtifact(db, {
		id: "earlier-answer",
		conversationId: EARLIER,
		type: "generated_output",
		name: `${QUESTION} result`,
		contentText: `${QUESTION} Two nights at Hotel Motto.`,
	});
	seedArtifact(db, {
		id: "earlier-capsule",
		conversationId: EARLIER,
		type: "work_capsule",
		name: `${QUESTION} workflow capsule`,
		contentText: `${QUESTION} Read Hotel Motto booking.txt.`,
	});
	seedArtifact(db, {
		id: "their-file",
		userId: OTHER,
		conversationId: THEIRS,
		type: "normalized_document",
		name: "Hotel Motto booking.md",
		contentText: "Hotel Motto, Vienna. Someone else's two nights.",
	});
	sqlite.close();
}

async function idsFor(
	types: Array<"normalized_document" | "generated_output">,
	/** The conversation to leave out; `null` leaves none out. */
	leaveOut: string | null = CURRENT,
): Promise<string[]> {
	const { findRelevantArtifactsByTypesDetailed } = await import("./documents");
	const matches = await findRelevantArtifactsByTypesDetailed({
		userId: USER,
		query: QUESTION,
		types,
		limit: 18,
		...(leaveOut ? { excludeConversationId: leaveOut } : {}),
	});
	return matches.map((match) => match.artifact.id).sort();
}

describe("a search that leaves one conversation out", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-documents-exclude-conversation-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedLibrary();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("returns only documents when asked for documents, not the answers and capsules of other conversations that quote the question", async () => {
		expect(await idsFor(["normalized_document"])).toEqual(["the-file"]);
	});

	it("returns only answers when asked for answers, not capsules or documents", async () => {
		expect(await idsFor(["generated_output"])).toEqual(["earlier-answer"]);
	});

	it("returns only the kinds asked for, and only the person's own rows, whatever conversation another person's sit in", async () => {
		const found = await idsFor(["normalized_document", "generated_output"]);
		expect(found).not.toContain("their-file");
		expect(found).toEqual(["earlier-answer", "the-file"]);
	});

	it("still leaves out the conversation it is told to, and still finds a row that sits in none", async () => {
		const sqlite = new Database(dbPath);
		const db = drizzle(sqlite, { schema });
		seedArtifact(db, {
			id: "this-turns-own",
			conversationId: CURRENT,
			type: "normalized_document",
			name: "Hotel Motto booking from this chat.md",
			contentText: "Hotel Motto, Vienna. Attached to this very chat.",
		});
		sqlite.close();

		expect(await idsFor(["normalized_document"])).toEqual(["the-file"]);
		// Told to leave out nothing, the chat's own row is found too.
		expect(await idsFor(["normalized_document"], null)).toEqual([
			"the-file",
			"this-turns-own",
		]);
	});
});
