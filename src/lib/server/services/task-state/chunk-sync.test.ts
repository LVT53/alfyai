/**
 * Chunk sync against a real (in-memory) database.
 *
 * The interesting case is a large document. `splitIntoChunks` produces one row
 * per ~1.2 kB of text and every row binds 8 parameters, so a single
 * multi-values INSERT hits better-sqlite3's 32766-variable ceiling at 4096
 * rows — about 4.8 MB of text. That is well inside the 100 MB upload limit,
 * and it became reachable in Phase 1: the 34 code/text extensions that now
 * take the direct-text route (a .log, a .sql dump, a .json export) arrive as
 * one long string where before they failed inside MinerU.
 *
 * `createArtifact` commits the artifact row and only then syncs chunks, so the
 * throw used to leave an artifact with zero chunks behind — and its full
 * `contentText` is what the prompt pipeline then reads.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/config-store", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/config-store")
	>("$lib/server/config-store");
	return { ...actual, getSmallFileThreshold: () => 1024 };
});

const { syncArtifactChunks, MAX_ARTIFACT_CHUNKS } = await import(
	"./chunk-sync"
);
const { createArtifact } = await import(
	"$lib/server/services/knowledge/store/core"
);

const USER = "user-1";
const NOW = new Date("2026-09-20T10:00:00.000Z");

/**
 * Text that splits into more than `minChunks` chunks. Sentences, so
 * `splitIntoChunks` finds real boundaries instead of hard-cutting.
 */
function longText(minChunks: number): string {
	// Every boundary `splitIntoChunks` looks for — a paragraph break, a line
	// break and all three sentence ends (". ", "? ", "! ") — appears here. It
	// searches BACKWARDS from each cut point with `lastIndexOf`, so a
	// separator it never finds makes every cut scan to the start of the
	// string; on a 5 MB input that alone takes about a minute.
	const paragraph =
		"The quarterly ledger reconciles. Does it match? It does! The bank statement agrees line by line.\n\n";
	// ~1.2 kB of consumed text per chunk (1400 target minus 220 overlap).
	const charsNeeded = minChunks * 1300;
	return paragraph.repeat(Math.ceil(charsNeeded / paragraph.length));
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	memory.db
		.insert(schema.users)
		.values({
			id: USER,
			email: `${USER}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

function seedArtifact(id: string): void {
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId: USER,
			type: "source_document",
			name: `${id}.txt`,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function countChunks(artifactId: string): number {
	return memory.db
		.select({ id: schema.artifactChunks.id })
		.from(schema.artifactChunks)
		.where(eq(schema.artifactChunks.artifactId, artifactId))
		.all().length;
}

describe("syncArtifactChunks", () => {
	it("stores every chunk of a document with more than 4096 of them", async () => {
		// 8 bound parameters per row against SQLITE_MAX_VARIABLE_NUMBER (32766)
		// means one statement can carry 4095 rows. This document needs more.
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			conversationId: null,
			contentText: longText(4200),
		});

		const stored = countChunks(artifactId);
		expect(stored).toBeGreaterThan(4096);

		// Indexes are contiguous from 0 — batching must not reorder or drop.
		const indexes = memory.db
			.select({ chunkIndex: schema.artifactChunks.chunkIndex })
			.from(schema.artifactChunks)
			.where(eq(schema.artifactChunks.artifactId, artifactId))
			.all()
			.map((row) => row.chunkIndex)
			.sort((a, b) => a - b);
		expect(indexes[0]).toBe(0);
		expect(indexes[indexes.length - 1]).toBe(stored - 1);
		expect(new Set(indexes).size).toBe(stored);
	});

	it("replaces the previous chunk set rather than adding to it", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: longText(10),
		});
		const first = countChunks(artifactId);
		expect(first).toBeGreaterThan(1);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: longText(4200),
		});
		expect(countChunks(artifactId)).toBeGreaterThan(first);
	});

	// The boundary search used to run `lastIndexOf(needle, end)` over the whole
	// prefix once per chunk, which is quadratic when the needle is absent. A
	// log has no sentence punctuation, so three of the five searches always
	// missed: 5 MB took 23 s of blocking CPU and 10 MB took 98 s. Windowing the
	// search makes it linear. This case is the shape that was slow, and it is
	// held to the default 5 s test timeout.
	it("chunks a log with no sentence punctuation without stalling", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const line =
			"2026-09-20T10:00:00.000Z INFO request id=abcd route=/api/chat status=200\n";
		const log = line.repeat(Math.ceil((5 * 1024 * 1024) / line.length));

		await syncArtifactChunks({ artifactId, userId: USER, contentText: log });

		expect(countChunks(artifactId)).toBeGreaterThan(4096);
	});

	it("cuts on the last boundary inside the window, not before the chunk", async () => {
		// Pins the windowed search against the whole-prefix one it replaced:
		// a paragraph break well inside the target window wins, and text with
		// no boundary at all is hard-cut at the target length.
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const paragraph = `${"word ".repeat(260)}\n\n`; // 1302 chars
		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: paragraph.repeat(4),
		});

		const stored = memory.db
			.select({
				chunkIndex: schema.artifactChunks.chunkIndex,
				contentText: schema.artifactChunks.contentText,
			})
			.from(schema.artifactChunks)
			.where(eq(schema.artifactChunks.artifactId, artifactId))
			.all()
			.sort((a, b) => a.chunkIndex - b.chunkIndex);

		expect(stored.length).toBeGreaterThan(1);
		// 1300 characters of words, cut at the paragraph break rather than
		// mid-word at 1400.
		expect(stored[0].contentText).toBe(paragraph.trim());
	});

	it("leaves no chunks behind when the text is below the bypass threshold", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: "short enough to store whole",
		});

		expect(countChunks(artifactId)).toBe(0);
	});
});

describe("the chunk ceiling", () => {
	it("chunks the largest admissible direct-text file in full", () => {
		// The ceiling is a safety net, not a product limit: 8 MiB is the
		// direct-text cap (`DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES`), and the
		// chunker advances 1180 characters per chunk, so the worst case must
		// still fit under the ceiling with room to spare.
		const worstCaseChunks = Math.ceil((8 * 1024 * 1024) / 1180);
		expect(worstCaseChunks).toBeLessThan(MAX_ARTIFACT_CHUNKS);
	});

	it("stops at the ceiling and says so instead of inserting silently", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		const result = await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: longText(MAX_ARTIFACT_CHUNKS + 500),
		});

		expect(result.truncated).toBe(true);
		expect(result.chunkCount).toBe(MAX_ARTIFACT_CHUNKS);
		expect(result.totalChunks).toBeGreaterThan(MAX_ARTIFACT_CHUNKS);
		expect(countChunks(artifactId)).toBe(MAX_ARTIFACT_CHUNKS);
	});

	it("reports no truncation for an ordinary document", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		const result = await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: longText(50),
		});

		expect(result.truncated).toBe(false);
		expect(result.totalChunks).toBe(result.chunkCount);
		expect(result.chunkCount).toBe(countChunks(artifactId));
	});

	it("records the truncation on the artifact rather than only in a log", async () => {
		// Retrieval covering only part of a document must be discoverable from
		// the artifact, not inferred from missing search hits.
		const artifact = await createArtifact({
			userId: USER,
			type: "source_document",
			name: "huge.log",
			contentText: longText(MAX_ARTIFACT_CHUNKS + 500),
		});

		expect(artifact.metadata?.chunksTruncated).toBe(true);
		expect(artifact.metadata?.chunkCount).toBe(MAX_ARTIFACT_CHUNKS);

		const [row] = memory.db
			.select({ metadataJson: schema.artifacts.metadataJson })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifact.id))
			.all();
		expect(
			JSON.parse(row?.metadataJson ?? "{}").chunksTruncated,
		).toBe(true);
	});
});

describe("createArtifact", () => {
	it("chunks a document that needs more than one insert statement", async () => {
		const artifact = await createArtifact({
			userId: USER,
			type: "source_document",
			name: "ledger.log",
			contentText: longText(4200),
		});

		expect(countChunks(artifact.id)).toBeGreaterThan(4096);
	});
});
