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

/**
 * `MINERU_STRUCTURE_CHUNKING_ENABLED`. On by default; the flag-off case is
 * the rollback, and it must put the character chunker back exactly.
 */
let structureChunkingEnabled = true;
vi.mock("$lib/server/services/mineru/config", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/mineru/config")
	>("$lib/server/services/mineru/config");
	return {
		...actual,
		resolveMineruConfig: () => ({
			structureChunking: structureChunkingEnabled,
		}),
	};
});

const {
	syncArtifactChunks,
	chunkPlanSourceDigest,
	MAX_ARTIFACT_CHUNKS,
	CHUNK_CHAR_TARGET,
	CHUNK_CHAR_OVERLAP,
} = await import("./chunk-sync");
const { createArtifact } = await import(
	"$lib/server/services/knowledge/store/core"
);
const { parseMineruResultZip, planStructuredChunks } = await import(
	"$lib/server/services/mineru/result"
);
type ChunkPlanEntry = Awaited<ReturnType<typeof planStructuredChunks>>[number];

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
	structureChunkingEnabled = true;
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

function storedChunks(artifactId: string) {
	return memory.db
		.select({
			chunkIndex: schema.artifactChunks.chunkIndex,
			contentText: schema.artifactChunks.contentText,
			tokenEstimate: schema.artifactChunks.tokenEstimate,
			pageStart: schema.artifactChunks.pageStart,
			pageEnd: schema.artifactChunks.pageEnd,
		})
		.from(schema.artifactChunks)
		.where(eq(schema.artifactChunks.artifactId, artifactId))
		.all()
		.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * A real MinerU result, parsed the way the extractor parses it. The fixtures
 * are the contract for this whole migration, so the chunking tests plan
 * against the recorded bytes rather than against hand-written blocks —
 * `mineru/chunk-plan.test.ts` (P4-A) is where the planner's own rules live.
 */
async function fixturePlan(
	input: "pdf" | "xlsx",
	charTarget = CHUNK_CHAR_TARGET,
): Promise<{
	markdown: string;
	pageCount: number;
	tables: string[];
	plan: ChunkPlanEntry[];
	/** The tag `syncArtifactChunks` checks the plan against. */
	digest: string;
}> {
	const { result } = await parseMineruResultZip({
		zipPathAbsolute: `fixtures/mineru-v1/${input}/result.zip`,
		sourceFilename: `sample.${input}`,
	});
	return {
		markdown: result.markdown,
		pageCount: result.pageCount,
		tables: result.blocks
			.filter((block) => block.type === "table")
			.map((block) => block.text),
		plan: planStructuredChunks({
			blocks: result.blocks,
			charTarget,
			charOverlap: CHUNK_CHAR_OVERLAP,
		}),
		digest: chunkPlanSourceDigest(result.markdown),
	};
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
		expect(JSON.parse(row?.metadataJson ?? "{}").chunksTruncated).toBe(true);
	});
});

describe("structure-aware chunking", () => {
	it("writes the plan's page ranges onto the rows", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const { markdown, pageCount, plan, digest } = await fixturePlan("pdf");

		const result = await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});

		const stored = storedChunks(artifactId);
		expect(result.chunkCount).toBe(plan.length);
		expect(stored).toHaveLength(plan.length);
		expect(stored.map((row) => row.contentText)).toEqual(
			plan.map((entry) => entry.text),
		);
		// The recorded PDF is three physical pages of running-head-stripped
		// text, so a chunk of it spans real pages rather than page 1 twice.
		expect(pageCount).toBe(3);
		expect(stored[0].pageStart).toBe(1);
		expect(stored[stored.length - 1].pageEnd).toBe(3);
		for (const row of stored) {
			expect(row.tokenEstimate).toBeGreaterThan(0);
		}
	});

	it("keeps page ranges ordered and inside the document", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const { markdown, pageCount, plan, digest } = await fixturePlan("pdf", 120);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});

		const stored = storedChunks(artifactId);
		expect(stored.length).toBeGreaterThan(1);
		let previousStart = 0;
		for (const row of stored) {
			expect(row.pageStart).not.toBeNull();
			expect(row.pageEnd).not.toBeNull();
			const start = row.pageStart as number;
			const end = row.pageEnd as number;
			expect(start).toBeGreaterThanOrEqual(1);
			expect(end).toBeGreaterThanOrEqual(start);
			expect(end).toBeLessThanOrEqual(pageCount);
			// Chunks are emitted in reading order, so a chunk never starts on
			// an earlier page than the one before it.
			expect(start).toBeGreaterThanOrEqual(previousStart);
			previousStart = start;
		}
	});

	it("stores a table whole even when it is larger than the target", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		// The recorded PDF's GFM table is 125 characters wide. A 60-character
		// target is smaller than the table itself — exactly the case the
		// character chunker would have cut through the middle of.
		const { markdown, tables, plan, digest } = await fixturePlan("pdf", 60);
		expect(tables.length).toBeGreaterThan(0);
		expect(Math.max(...tables.map((table) => table.length))).toBeGreaterThan(
			60,
		);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});

		const stored = storedChunks(artifactId);
		for (const table of tables) {
			expect(
				stored.filter((row) => row.contentText.includes(table)),
				`table not stored whole: ${table.slice(0, 40)}…`,
			).toHaveLength(1);
		}
	});

	it("keeps the small-file bypass ahead of the plan", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		const result = await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: "One short page of text.",
			chunkPlan: [
				{
					chunkIndex: 0,
					text: "One short page of text.",
					pageStart: 1,
					pageEnd: 1,
				},
			],
		});

		expect(result.chunkCount).toBe(0);
		expect(countChunks(artifactId)).toBe(0);
	});

	it("falls back to the character chunker with the flag off", async () => {
		const planned = randomUUID();
		const unplanned = randomUUID();
		seedArtifact(planned);
		seedArtifact(unplanned);
		const { markdown, plan, digest } = await fixturePlan("pdf", 300);
		expect(plan.length).toBeGreaterThan(1);

		structureChunkingEnabled = false;
		await syncArtifactChunks({
			artifactId: planned,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});
		await syncArtifactChunks({
			artifactId: unplanned,
			userId: USER,
			contentText: markdown,
		});

		const withPlan = storedChunks(planned);
		const withoutPlan = storedChunks(unplanned);
		expect(withPlan.map((row) => row.contentText)).toEqual(
			withoutPlan.map((row) => row.contentText),
		);
		for (const row of withPlan) {
			expect(row.pageStart).toBeNull();
			expect(row.pageEnd).toBeNull();
		}
	});

	it("leaves both columns null on the character path", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: longText(10),
		});

		for (const row of storedChunks(artifactId)) {
			expect(row.pageStart).toBeNull();
			expect(row.pageEnd).toBeNull();
		}
	});

	it("re-syncing replaces a structured chunk set with a plain one", async () => {
		// Re-extraction rewrites the normalized artifact in place, so the same
		// artifact id goes from planned rows to unplanned ones (and back). No
		// row may survive that with a stale page range.
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const { markdown, plan, digest } = await fixturePlan("pdf", 300);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});
		const first = storedChunks(artifactId);
		expect(first.some((row) => row.pageStart !== null)).toBe(true);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
		});
		const second = storedChunks(artifactId);
		expect(second.every((row) => row.pageStart === null)).toBe(true);
		expect(second[0].chunkIndex).toBe(0);
	});

	it("is idempotent: the same plan twice yields the same rows", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const { markdown, plan, digest } = await fixturePlan("pdf", 300);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});
		const first = storedChunks(artifactId);
		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});

		expect(storedChunks(artifactId)).toEqual(first);
	});

	it("ignores a plan that was not derived from the text being stored", async () => {
		// The plan and the text arrive through different parameters and are
		// produced at different moments. Nothing checked that they agreed, so a
		// caller that rewrote one and forwarded a stale copy of the other would
		// store chunk text from one parse with PAGE NUMBERS from another — a
		// citation that is confidently wrong, with nothing in the data to show
		// it.
		const stale = randomUUID();
		const plain = randomUUID();
		seedArtifact(stale);
		seedArtifact(plain);
		const { markdown, plan } = await fixturePlan("pdf", 300);
		const otherText = `${markdown}\n\nA paragraph the plan has never seen.`;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await syncArtifactChunks({
			artifactId: stale,
			userId: USER,
			contentText: otherText,
			chunkPlan: plan,
			// The digest of the text the plan REALLY came from.
			chunkPlanSourceDigest: chunkPlanSourceDigest(markdown),
		});
		await syncArtifactChunks({
			artifactId: plain,
			userId: USER,
			contentText: otherText,
		});

		// One structured line, and no throw: the document is still readable, it
		// has just lost its page citations.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("[CHUNK_SYNC]");
		warn.mockRestore();

		const stored = storedChunks(stale);
		expect(stored.map((row) => row.contentText)).toEqual(
			storedChunks(plain).map((row) => row.contentText),
		);
		expect(result.chunkCount).toBe(stored.length);
		for (const row of stored) {
			expect(row.pageStart).toBeNull();
			expect(row.pageEnd).toBeNull();
		}
	});

	it("ignores a plan that carries no digest at all", async () => {
		// An untagged plan is by definition one nobody vouched for: the single
		// caller that builds plans tags them.
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const { markdown, plan } = await fixturePlan("pdf", 300);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: markdown,
			chunkPlan: plan,
		});

		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		for (const row of storedChunks(artifactId)) {
			expect(row.pageStart).toBeNull();
		}
	});

	it("drops a page range it cannot stand behind rather than storing it", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const body = "x".repeat(2000);

		await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText: body,
			chunkPlan: [{ chunkIndex: 0, text: body, pageStart: 0, pageEnd: 4 }],
			chunkPlanSourceDigest: chunkPlanSourceDigest(body),
		});

		const [row] = storedChunks(artifactId);
		expect(row.pageStart).toBeNull();
		expect(row.pageEnd).toBeNull();
	});

	it("stops a structured plan at the ceiling and says so", async () => {
		const artifactId = randomUUID();
		seedArtifact(artifactId);
		const plan = Array.from(
			{ length: MAX_ARTIFACT_CHUNKS + 500 },
			(_, index) => ({
				chunkIndex: index,
				text: `Planned block ${index}.`,
				pageStart: index + 1,
				pageEnd: index + 1,
			}),
		);
		// The plan is synthetic, so the text it claims to come from is too: the
		// ceiling is what this case is about, and a plan the sync would reject
		// as stale would never reach it.
		const contentText = plan.map((entry) => entry.text).join("\n\n");

		const result = await syncArtifactChunks({
			artifactId,
			userId: USER,
			contentText,
			chunkPlan: plan,
			chunkPlanSourceDigest: chunkPlanSourceDigest(contentText),
		});

		expect(result.truncated).toBe(true);
		expect(result.chunkCount).toBe(MAX_ARTIFACT_CHUNKS);
		expect(result.totalChunks).toBe(plan.length);
		expect(countChunks(artifactId)).toBe(MAX_ARTIFACT_CHUNKS);
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

	it("forwards a chunk plan to the sync", async () => {
		// The parameter name is the P4-B hand-off: `persist.ts` passes the plan
		// it built from the parsed blocks under exactly this key.
		const { markdown, plan, digest } = await fixturePlan("pdf", 300);
		const artifact = await createArtifact({
			userId: USER,
			type: "normalized_document",
			name: "sample.md",
			contentText: markdown,
			chunkPlan: plan,
			chunkPlanSourceDigest: digest,
		});

		const stored = storedChunks(artifact.id);
		expect(stored).toHaveLength(plan.length);
		expect(stored[0].pageStart).toBe(1);
	});
});
