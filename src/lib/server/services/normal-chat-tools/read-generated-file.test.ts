/**
 * read_generated_file against a real (in-memory) database.
 *
 * The tool used to read only what THIS conversation produced. It now also
 * answers for the documents the user uploaded or linked here, and for the
 * rest of their Knowledge Library, with `from` windowing for long text and
 * `query` for the passages of one document about a topic. These tests pin
 * the lookup order (generated file → this conversation's documents →
 * library), the ambiguity contract (never fuzzy-pick), the window
 * arithmetic, the passage cap, and the per-turn cache.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asSchema } from "ai";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { writeMineruParseBundle } from "$lib/server/services/mineru/bundle";
import { parseMineruResultZip } from "$lib/server/services/mineru/result";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("$lib/server/services/task-state/control-model", () => ({
	canUseContextSummarizer: vi.fn(() => false),
	requestContextSummarizer: vi.fn(),
}));

const {
	buildReadGeneratedFileModelPayload,
	readGeneratedFileContent,
	readGeneratedFileExecutionInputSchema,
	readGeneratedFileInputSchema,
	sanitizeReadGeneratedFileInput,
	summarizeReadGeneratedFileResult,
} = await import("./read-generated-file");
const { deriveToolResultDigest } = await import("./tool-result-digest");

const USER = "user-1";
const OTHER_USER = "user-2";
const CONVERSATION = "conv-this";
const OTHER_CONVERSATION = "conv-other";
const NOW = new Date("2026-09-15T10:00:00.000Z");

function seedUser(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, userId: string) {
	memory.db
		.insert(schema.conversations)
		.values({ id, userId, title: id, createdAt: NOW, updatedAt: NOW })
		.run();
}

function seedArtifact(params: {
	type: "generated_output" | "normalized_document";
	name: string;
	contentText: string;
	conversationId?: string | null;
	userId?: string;
	metadata?: Record<string, unknown>;
	updatedAt?: Date;
	summary?: string;
}): string {
	const id = randomUUID();
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId: params.userId ?? USER,
			conversationId:
				params.conversationId === undefined
					? CONVERSATION
					: params.conversationId,
			type: params.type,
			retrievalClass: "durable",
			name: params.name,
			mimeType:
				params.type === "generated_output" ? "text/markdown" : "text/markdown",
			contentText: params.contentText,
			summary: params.summary ?? null,
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			createdAt: NOW,
			updatedAt: params.updatedAt ?? NOW,
		})
		.run();
	return id;
}

/**
 * The summary the writer derives from an artifact's own text
 * (`guessSummary`): whitespace collapsed, first 240 characters. For a
 * generated file that text is the memory wrapper, which is how the wrapper's
 * ids reach the model at all.
 */
function storedSummaryOf(contentText: string): string {
	return contentText.replace(/\s+/g, " ").trim().slice(0, 240);
}

function seedChunks(artifactId: string, texts: string[]) {
	memory.db
		.insert(schema.artifactChunks)
		.values(
			texts.map((contentText, chunkIndex) => ({
				id: `${artifactId}:${chunkIndex}`,
				artifactId,
				userId: USER,
				conversationId: CONVERSATION,
				chunkIndex,
				contentText,
				tokenEstimate: Math.ceil(contentText.length / 4),
				createdAt: NOW,
				updatedAt: NOW,
			})),
		)
		.run();
}

function read(
	overrides: Partial<Parameters<typeof readGeneratedFileContent>[0]> = {},
) {
	return readGeneratedFileContent({
		userId: USER,
		conversationId: CONVERSATION,
		...overrides,
	});
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(USER);
	seedUser(OTHER_USER);
	seedConversation(CONVERSATION, USER);
	seedConversation(OTHER_CONVERSATION, USER);
});

afterEach(() => {
	memory.close();
});

describe("readGeneratedFileContent — generated files (unchanged path)", () => {
	it("reads a file produced in this conversation and strips the memory wrapper", async () => {
		seedArtifact({
			type: "generated_output",
			name: "report.md",
			contentText:
				"Generated file: report.md\nFrom conversation conv-this\nExtracted file content:\n# Quarterly report\n\nRevenue grew.",
			metadata: { documentLabel: "Quarterly report", versionNumber: 2 },
		});

		const result = await read({ filename: "report.md" });

		expect(result.notFound).toBe(false);
		expect(result.ambiguous).toBe(false);
		expect(result.source).toBe("generated");
		expect(result.conversation).toBe("this");
		expect(result.filename).toBe("report.md");
		expect(result.documentLabel).toBe("Quarterly report");
		expect(result.versionNumber).toBe(2);
		expect(result.contentText).toBe("# Quarterly report\n\nRevenue grew.");
		expect(result.from).toBe(0);
		expect(result.to).toBe(result.contentLength);
		expect(result.hasMore).toBe(false);
		expect(result.nextFrom).toBeNull();
		expect(result.passages).toBeNull();
	});

	it("prefers a generated file over a document with the same name", async () => {
		seedArtifact({
			type: "generated_output",
			name: "notes.md",
			contentText: "generated body",
		});
		seedArtifact({
			type: "normalized_document",
			name: "notes.md",
			contentText: "uploaded body",
		});

		const result = await read({ filename: "notes.md" });

		expect(result.source).toBe("generated");
		expect(result.contentText).toBe("generated body");
	});

	it("does not let a generated file whose body merely mentions the title shadow the document itself", async () => {
		seedArtifact({
			type: "generated_output",
			name: "summary.md",
			contentText: "A short summary of the lease: deposit, term, pets.",
			metadata: { documentLabel: "Summary" },
		});
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "the lease itself",
			metadata: { normalizedFrom: "Lease.pdf" },
		});

		const byTitle = await read({ requestTitle: "Lease" });
		expect(byTitle.source).toBe("document");
		expect(byTitle.contentText).toBe("the lease itself");

		// Name and label matches on generated files still win outright.
		const byLabel = await read({ requestTitle: "Summary" });
		expect(byLabel.source).toBe("generated");

		// With no document to yield to, the body match is still honoured
		// ahead of the newest-file fallback.
		seedArtifact({
			type: "generated_output",
			name: "newest.md",
			contentText: "unrelated",
			updatedAt: new Date("2026-09-20T00:00:00.000Z"),
		});
		const bodyOnly = await read({ requestTitle: "pets" });
		expect(bodyOnly.source).toBe("generated");
		expect(bodyOnly.filename).toBe("summary.md");
	});

	it("still falls back to the newest generated file when nothing matches by name", async () => {
		seedArtifact({
			type: "generated_output",
			name: "older.md",
			contentText: "older",
			updatedAt: new Date("2026-09-01T00:00:00.000Z"),
		});
		seedArtifact({
			type: "generated_output",
			name: "newer.md",
			contentText: "newer",
			updatedAt: new Date("2026-09-10T00:00:00.000Z"),
		});

		const result = await read({ requestTitle: "no such title" });

		expect(result.source).toBe("generated");
		expect(result.filename).toBe("newer.md");
	});

	it("reports not found when the conversation has nothing", async () => {
		const result = await read({ filename: "missing.md" });

		expect(result.notFound).toBe(true);
		expect(result.contentText).toBeNull();
		expect(buildReadGeneratedFileModelPayload(result)).toMatchObject({
			found: false,
			filename: "missing.md",
		});
		expect(summarizeReadGeneratedFileResult(result)).toBe(
			"No matching file found.",
		);
	});
});

describe("readGeneratedFileContent — documents", () => {
	it("reads a document uploaded to this conversation by its uploaded filename", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "# Lease\n\nThe deposit is two months' rent.",
			metadata: { normalizedFrom: "Lease.pdf" },
		});

		const result = await read({ filename: "lease.PDF" });

		expect(result.notFound).toBe(false);
		expect(result.source).toBe("document");
		expect(result.conversation).toBe("this");
		expect(result.filename).toBe("Lease.pdf");
		expect(result.contentText).toBe(
			"# Lease\n\nThe deposit is two months' rent.",
		);
		expect(buildReadGeneratedFileModelPayload(result)).toMatchObject({
			found: true,
			source: "document",
			conversation: "this",
			filename: "Lease.pdf",
			hasMore: false,
		});
	});

	it("matches the normalized artifact name too", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "body",
			metadata: { normalizedFrom: "Lease.pdf" },
		});

		expect((await read({ filename: "lease.md" })).source).toBe("document");
		expect((await read({ requestTitle: "lease" })).source).toBe("document");
	});

	it("falls back to the user's Knowledge Library when this conversation has no match", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "handbook.md",
			contentText: "Library handbook body",
			conversationId: OTHER_CONVERSATION,
			metadata: { normalizedFrom: "Employee Handbook.docx" },
		});
		seedArtifact({
			type: "normalized_document",
			name: "orphan.md",
			contentText: "Unattached body",
			conversationId: null,
		});

		const handbook = await read({ filename: "employee handbook.docx" });
		expect(handbook.source).toBe("document");
		expect(handbook.conversation).toBe("library");
		expect(handbook.filename).toBe("Employee Handbook.docx");
		expect(handbook.contentText).toBe("Library handbook body");

		const orphan = await read({ filename: "orphan.md" });
		expect(orphan.conversation).toBe("library");
		expect(orphan.contentText).toBe("Unattached body");
	});

	it("prefers this conversation's copy over a library copy of the same name", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "this conversation's lease",
			metadata: { normalizedFrom: "Lease.pdf" },
		});
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "library lease",
			conversationId: OTHER_CONVERSATION,
			metadata: { normalizedFrom: "Lease.pdf" },
		});

		const result = await read({ filename: "Lease.pdf" });

		expect(result.ambiguous).toBe(false);
		expect(result.conversation).toBe("this");
		expect(result.contentText).toBe("this conversation's lease");
	});

	it("accepts a unique case-insensitive contains match", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "2026-q3-board-deck.md",
			contentText: "deck body",
			metadata: { normalizedFrom: "2026 Q3 Board Deck.pptx" },
		});
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "lease body",
		});

		const result = await read({ filename: "board deck" });

		expect(result.source).toBe("document");
		expect(result.filename).toBe("2026 Q3 Board Deck.pptx");
	});

	it("refuses a contains match on a needle shorter than three characters", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "annual-report.md",
			contentText: "the only document",
		});

		expect((await read({ filename: "a" })).notFound).toBe(true);
		expect((await read({ filename: "re" })).notFound).toBe(true);
		expect((await read({ filename: "rep" })).source).toBe("document");
	});

	it("returns ambiguous with candidates, and no content, when two documents match equally", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText: "flat A lease",
			conversationId: OTHER_CONVERSATION,
			metadata: { normalizedFrom: "Lease.pdf" },
			updatedAt: new Date("2026-09-02T00:00:00.000Z"),
		});
		seedArtifact({
			type: "normalized_document",
			name: "lease (1).md",
			contentText: "flat B lease",
			conversationId: null,
			metadata: { normalizedFrom: "Lease.pdf" },
			updatedAt: new Date("2026-09-03T00:00:00.000Z"),
		});

		const result = await read({ filename: "Lease.pdf" });

		expect(result.notFound).toBe(false);
		expect(result.ambiguous).toBe(true);
		expect(result.contentText).toBeNull();
		expect(result.passages).toBeNull();
		expect(result.candidates).toEqual([
			{
				filename: "Lease.pdf",
				updatedAt: "2026-09-03T00:00:00.000Z",
				conversation: "library",
			},
			{
				filename: "Lease.pdf",
				updatedAt: "2026-09-02T00:00:00.000Z",
				conversation: "library",
			},
		]);

		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload).toMatchObject({
			found: false,
			ambiguous: true,
			candidates: result.candidates,
		});
		expect(payload).not.toHaveProperty("content");
		expect(summarizeReadGeneratedFileResult(result)).toBe(
			'Several files match "Lease.pdf": Lease.pdf, Lease.pdf.',
		);
	});

	it("never fuzzy-picks between two contains matches", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "lease-2025.md",
			contentText: "old",
		});
		seedArtifact({
			type: "normalized_document",
			name: "lease-2026.md",
			contentText: "new",
		});

		const result = await read({ filename: "lease" });

		expect(result.ambiguous).toBe(true);
		expect(result.candidates.map((candidate) => candidate.filename)).toEqual([
			"lease-2025.md",
			"lease-2026.md",
		]);
	});

	it("never reads another user's documents", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "secret.md",
			contentText: "not yours",
			userId: OTHER_USER,
			conversationId: null,
		});

		const result = await read({ filename: "secret.md" });

		expect(result.notFound).toBe(true);
	});

	it("ignores documents that are not durable", async () => {
		const id = seedArtifact({
			type: "normalized_document",
			name: "draft.md",
			contentText: "pending",
			conversationId: null,
		});
		memory.sqlite
			.prepare(
				"UPDATE artifacts SET retrieval_class = 'ephemeral' WHERE id = ?",
			)
			.run(id);

		const result = await read({ filename: "draft.md" });

		expect(result.notFound).toBe(true);
	});
});

describe("readGeneratedFileContent — `from` windowing", () => {
	const HEAD = "h".repeat(24_000);
	const TAIL = `TAIL-MARKER-${"t".repeat(2_000)}`;
	const LONG = `${HEAD}${TAIL}`;

	it("serves the first 24,000 characters by default and says where to continue", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "long.md",
			contentText: LONG,
		});

		const result = await read({ filename: "long.md" });

		expect(result.contentLength).toBe(LONG.length);
		expect(result.contentText).toBe(HEAD);
		expect(result.from).toBe(0);
		expect(result.to).toBe(24_000);
		expect(result.hasMore).toBe(true);
		expect(result.nextFrom).toBe(24_000);

		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload).toMatchObject({
			found: true,
			from: 0,
			to: 24_000,
			hasMore: true,
			nextFrom: 24_000,
			truncated: true,
			contentLength: LONG.length,
		});
		expect(String(payload.content)).toContain(
			`Call again with from: 24000 to continue.`,
		);
		expect(summarizeReadGeneratedFileResult(result)).toContain(
			"chars 0–24000, more from 24000",
		);
	});

	it("continues from `from` and stops saying hasMore at the end", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "long.md",
			contentText: LONG,
		});

		const result = await read({ filename: "long.md", from: 24_000 });

		expect(result.contentText).toBe(TAIL);
		expect(result.from).toBe(24_000);
		expect(result.to).toBe(LONG.length);
		expect(result.hasMore).toBe(false);
		expect(result.nextFrom).toBeNull();
		expect(buildReadGeneratedFileModelPayload(result)).toMatchObject({
			content: TAIL,
			truncated: false,
			hasMore: false,
			nextFrom: null,
		});
	});

	it("clamps a `from` past the end to an empty window and says so", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "short.md",
			contentText: "short body",
		});

		const result = await read({ filename: "short.md", from: 10_000 });

		expect(result.notFound).toBe(false);
		expect(result.from).toBe(10);
		expect(result.to).toBe(10);
		expect(result.contentText).toBe("");
		expect(result.hasMore).toBe(false);

		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload).toMatchObject({ found: true, from: 10, to: 10 });
		expect(payload).not.toHaveProperty("content");
		expect(String(payload.note)).toContain("past the end");

		// Exactly at the end behaves the same way.
		const atEnd = await read({ filename: "short.md", from: 10 });
		expect(String(buildReadGeneratedFileModelPayload(atEnd).note)).toContain(
			"past the end",
		);
	});

	it("never splits a surrogate pair on the window boundary", async () => {
		const body = `${"h".repeat(23_999)}😀${"t".repeat(50)}`;
		seedArtifact({
			type: "normalized_document",
			name: "emoji.md",
			contentText: body,
		});

		const first = await read({ filename: "emoji.md" });
		expect(first.contentText?.endsWith("😀")).toBe(true);
		expect(first.to).toBe(24_001);
		expect(first.nextFrom).toBe(24_001);

		const rest = await read({ filename: "emoji.md", from: first.nextFrom });
		expect(rest.contentText).toBe("t".repeat(50));
		expect(`${first.contentText}${rest.contentText}`).toBe(body);
	});
});

describe("readGeneratedFileContent — `query` passages", () => {
	const CHUNKS = [
		"# Deposits\n\nClause 1: the deposit is two months' rent, held in a scheme.",
		"Clause 2: the deposit is returned within ten days of the end of the term.",
		"Clause 3: deductions from the deposit require an itemised statement.",
		"# Pets\n\nClause 4: no pets without written consent.",
		"Clause 5: the deposit clause survives termination.",
		"Clause 6: the deposit is not rent and cannot be set against arrears.",
	];

	function seedLease(): string {
		const contentText = CHUNKS.join("\n\n");
		const id = seedArtifact({
			type: "normalized_document",
			name: "lease.md",
			contentText,
			metadata: {
				normalizedFrom: "Lease.pdf",
				outline: [
					{ level: 1, title: "Deposits", offset: 0, preview: "" },
					{
						level: 1,
						title: "Pets",
						offset: contentText.indexOf("# Pets"),
						preview: "",
					},
				],
			},
		});
		seedChunks(id, CHUNKS);
		return id;
	}

	it("returns at most three passages of that one document, anchored to chunk, offset and section", async () => {
		seedLease();
		const contentText = CHUNKS.join("\n\n");

		const result = await read({ filename: "Lease.pdf", query: "deposit" });

		expect(result.notFound).toBe(false);
		expect(result.contentText).toBeNull();
		expect(result.query).toBe("deposit");
		expect(result.passages).toHaveLength(3);
		// Five chunks mention the deposit; the cap keeps the three best, and
		// with equal lexical scores the document order wins.
		expect(result.passages?.map((passage) => passage.chunkIndex)).toEqual([
			0, 1, 2,
		]);
		for (const passage of result.passages ?? []) {
			expect(passage.charOffset).toBe(
				contentText.indexOf(CHUNKS[passage.chunkIndex]),
			);
			expect(passage.section).toBe("Deposits");
			expect(passage.hasMore).toBe(true);
			expect(passage.nextFrom).toBe(
				(passage.charOffset ?? 0) + CHUNKS[passage.chunkIndex].length,
			);
			expect(passage.text).toContain("deposit");
		}
		// The document holds more chunks than the three returned.
		expect(result.hasMore).toBe(true);

		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload).toMatchObject({
			found: true,
			query: "deposit",
			passageCount: 3,
			hasMore: true,
		});
		expect(payload).not.toHaveProperty("content");
		expect(payload).not.toHaveProperty("page");
		expect(summarizeReadGeneratedFileResult(result)).toBe(
			`Found "Lease.pdf" (${contentText.length} chars): 3 passage(s) for "deposit".`,
		);
		// The history digest replays what was read, not just that it was.
		expect(deriveToolResultDigest(payload)).toContain("Clause 1");
	});

	it("labels a passage with the nearest preceding heading", async () => {
		seedLease();

		const result = await read({ filename: "Lease.pdf", query: "pets" });

		expect(result.passages?.[0]?.chunkIndex).toBe(3);
		expect(result.passages?.[0]?.section).toBe("Pets");
	});

	it("returns no passages, with a note, when nothing in the file matches", async () => {
		seedLease();

		const result = await read({ filename: "Lease.pdf", query: "parking" });

		expect(result.notFound).toBe(false);
		expect(result.passages).toEqual([]);
		expect(result.hasMore).toBe(true);

		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload).toMatchObject({ found: true, passageCount: 0 });
		expect(String(payload.note)).toContain("No passage");
		expect(summarizeReadGeneratedFileResult(result)).toContain(
			'0 passage(s) for "parking"',
		);
	});

	it("serves a truncated passage verbatim so nextFrom continues exactly where it stopped", async () => {
		// One passage gets the whole 3,600-char budget; exceed it.
		const chunk = `Deposit terms.\n\n${"The deposit clause repeats.  \n".repeat(130)}`;
		expect(chunk.length).toBeGreaterThan(3600);
		const contentText = `${chunk}\n\nUnrelated tail.`;
		const id = seedArtifact({
			type: "normalized_document",
			name: "long-lease.md",
			contentText,
		});
		seedChunks(id, [chunk, "Unrelated tail."]);

		const result = await read({ filename: "long-lease.md", query: "deposit" });

		expect(result.passages).toHaveLength(1);
		const passage = result.passages?.[0];
		expect(passage?.charOffset).toBe(0);
		// A verbatim prefix: whitespace intact, no ellipsis.
		expect(passage?.text).toBe(chunk.slice(0, passage?.text.length));
		expect(passage?.text.length).toBeLessThan(chunk.length);
		expect(passage?.hasMore).toBe(true);
		expect(passage?.nextFrom).toBe(passage?.text.length);

		const continued = await read({
			filename: "long-lease.md",
			from: passage?.nextFrom ?? undefined,
		});
		expect(`${passage?.text}${continued.contentText}`).toBe(contentText);
	});

	it("maps a chunk offset back through CRLF line endings", async () => {
		const contentText =
			"Intro line.\r\n\r\nSecond line about the deposit.\r\nThird.\r\n\r\nFourth.";
		const id = seedArtifact({
			type: "normalized_document",
			name: "crlf.md",
			contentText,
		});
		// chunk-sync normalizes CRLF before slicing.
		seedChunks(id, [
			"Intro line.",
			"Second line about the deposit.\nThird.",
			"Fourth.",
		]);

		const result = await read({ filename: "crlf.md", query: "deposit" });

		const passage = result.passages?.[0];
		expect(passage?.chunkIndex).toBe(1);
		expect(passage?.charOffset).toBe(contentText.indexOf("Second line"));
		expect(passage?.hasMore).toBe(true);
		// Both ends are mapped: the CRLF inside the passage counts too.
		expect(
			contentText.slice(passage?.charOffset ?? 0, passage?.nextFrom ?? 0),
		).toBe("Second line about the deposit.\r\nThird.");
		expect(contentText.slice(passage?.nextFrom ?? 0)).toBe("\r\n\r\nFourth.");
	});

	it("does not leak the memory wrapper when a generated file is queried", async () => {
		const wrapper =
			"Generated file: notes.md\nFrom conversation conv-other\nAssistant said: here are your notes\nExtracted file content:\n# Notes\n\nThe deposit is two months' rent.";
		const id = seedArtifact({
			type: "generated_output",
			name: "notes.md",
			contentText: wrapper,
		});
		// createArtifact chunks the wrapper text as stored, header included.
		seedChunks(id, [wrapper]);

		const result = await read({ filename: "notes.md", query: "deposit" });

		expect(result.source).toBe("generated");
		expect(result.passages).toHaveLength(1);
		expect(result.passages?.[0]?.text).toBe(
			"# Notes\n\nThe deposit is two months' rent.",
		);
		expect(result.passages?.[0]?.charOffset).toBe(0);
		expect(JSON.stringify(result.passages)).not.toContain("conv-other");
	});

	it("treats an unchunked document as a single passage", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "memo.md",
			contentText: "A short memo about the parking allocation.",
		});

		const result = await read({ filename: "memo.md", query: "parking" });

		expect(result.passages).toHaveLength(1);
		expect(result.passages?.[0]).toMatchObject({
			chunkIndex: 0,
			charOffset: 0,
			section: null,
			hasMore: false,
			nextFrom: null,
		});
		expect(result.hasMore).toBe(false);
	});
});

describe("readGeneratedFileContent — per-turn cache", () => {
	it("answers a repeat call for the same file, window and query inside one turn from cache", async () => {
		const id = seedArtifact({
			type: "normalized_document",
			name: "cached.md",
			contentText: "first body",
		});
		const turnId = `turn-${randomUUID()}`;

		const first = await read({ filename: "cached.md", turnId });
		expect(first.contentText).toBe("first body");

		// A different window is a different key, not a stale hit.
		const differentWindow = await read({
			filename: "cached.md",
			turnId,
			from: 6,
		});
		expect(differentWindow).not.toBe(first);
		expect(differentWindow.contentText).toBe("body");

		// Rewrite the text without touching updatedAt: the same turn keeps
		// seeing what it already read, a later turn sees the new text.
		memory.sqlite
			.prepare("UPDATE artifacts SET content_text = ? WHERE id = ?")
			.run("second body", id);

		const again = await read({ filename: "cached.md", turnId });
		expect(again).toBe(first);
		expect(again.contentText).toBe("first body");

		const nextTurn = await read({
			filename: "cached.md",
			turnId: `turn-${randomUUID()}`,
		});
		expect(nextTurn.contentText).toBe("second body");
	});

	it("bypasses the cache when no turn id is given", async () => {
		const id = seedArtifact({
			type: "normalized_document",
			name: "uncached.md",
			contentText: "first body",
		});

		expect((await read({ filename: "uncached.md" })).contentText).toBe(
			"first body",
		);
		memory.sqlite
			.prepare("UPDATE artifacts SET content_text = ? WHERE id = ?")
			.run("second body", id);
		expect((await read({ filename: "uncached.md" })).contentText).toBe(
			"second body",
		);
	});
});

describe("sanitizeReadGeneratedFileInput", () => {
	it("keeps the new fields in a safe shape and drops junk", () => {
		expect(
			sanitizeReadGeneratedFileInput({
				filename: "  lease.pdf ",
				from: 24_000.7,
				query: "  deposit  ",
			}),
		).toEqual({ filename: "lease.pdf", from: 24000, query: "deposit" });
		expect(
			sanitizeReadGeneratedFileInput({
				requestTitle: "Report",
				from: -3,
				query: "   ",
			}),
		).toEqual({ requestTitle: "Report", from: 0 });
		expect(
			sanitizeReadGeneratedFileInput({
				from: Number.NaN,
				query: 42,
			} as unknown as Record<string, unknown>),
		).toEqual({});
	});

	it("records an honoured `page` in the tool-call log", () => {
		expect(sanitizeReadGeneratedFileInput({ page: 4.6 })).toEqual({ page: 4 });
		expect(sanitizeReadGeneratedFileInput({ page: 0 })).toEqual({});
	});
});

// ── `page`, and the prompt prefix it must not disturb ──────────

/**
 * The advertised input schema, serialised exactly the way a request does it,
 * re-frozen in slice P6-D with `page` advertised.
 *
 * Tool schemas travel inside the CACHED prompt prefix. Advertising `page`
 * costs 165 bytes here (538 → 703), which evicts every 1600-token cache block
 * from that offset on — the one-time cost the OQ5 ruling schedules for this
 * release, together with every other model-facing change of this migration. A
 * failure here is not a test to update: it means another eviction is about to
 * ship.
 */
const FROZEN_READ_GENERATED_FILE_JSON_SCHEMA =
	'{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"filename":{"type":"string","minLength":1},"requestTitle":{"type":"string","minLength":1},"from":{"description":"Character offset to continue from. Pass the previous result\'s nextFrom to read the next window.","type":"integer","minimum":0,"maximum":9007199254740991},"query":{"description":"Instead of the text window, return up to 3 passages of this one file about the query.","type":"string","minLength":1,"maxLength":300},"page":{"description":"1-based page to start at, for a paged document. `query` and `from` take precedence.","type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false}';

describe("the tool schema the model is sent", () => {
	it("is byte-identical to the frozen P6-D serialisation", () => {
		expect(
			JSON.stringify(asSchema(readGeneratedFileInputSchema).jsonSchema),
		).toBe(FROZEN_READ_GENERATED_FILE_JSON_SCHEMA);
	});

	it("advertises `page` last, after the four older fields", () => {
		// Order matters for the prefix: appending keeps every cache block
		// before `page` intact, inserting would not.
		const properties = (
			asSchema(readGeneratedFileInputSchema).jsonSchema as {
				properties: Record<string, unknown>;
			}
		).properties;
		expect(Object.keys(properties)).toEqual([
			"filename",
			"requestTitle",
			"from",
			"query",
			"page",
		]);
	});

	it("lets a well-formed `page` through both schemas", () => {
		expect(readGeneratedFileInputSchema.parse({ from: 1, page: 3 })).toEqual({
			from: 1,
			page: 3,
		});
		expect(
			readGeneratedFileExecutionInputSchema.parse({ from: 1, page: 3 }),
		).toEqual({ from: 1, page: 3 });
	});

	it("drops a malformed `page` instead of failing the call", () => {
		// Advertising the parameter did not make it strict: a model that sends
		// `page: 0` still gets its file, just without the page jump. The
		// advertised schema is now the one the SDK validates against, so the
		// tolerance has to hold there too.
		for (const schema of [
			readGeneratedFileInputSchema,
			readGeneratedFileExecutionInputSchema,
		]) {
			expect(schema.parse({ page: 0 }).page).toBeUndefined();
			expect(schema.parse({ page: "two" }).page).toBeUndefined();
		}
	});

	it("strips a key it does not advertise", () => {
		// The loose object Phase 4 used to smuggle `page` through forwarded
		// every invented key as well; a strict object does not.
		expect(
			readGeneratedFileInputSchema.parse({ from: 1, pageNumber: 3 }),
		).toEqual({ from: 1 });
	});
});

describe("readGeneratedFileContent — page mode", () => {
	let bundleUser: string;
	let sourceArtifactId: string;
	let normalizedArtifactId: string;
	let markdown: string;
	let pages: ReadonlyArray<{ page: number; start: number; end: number }>;

	async function seedParsedDocument(): Promise<void> {
		const { result } = await parseMineruResultZip({
			zipPathAbsolute: join(
				process.cwd(),
				"fixtures",
				"mineru-v1",
				"pdf",
				"result.zip",
			),
			jobTier: "basic",
			sourceFilename: "sample.pdf",
		});
		markdown = result.markdown;
		pages = result.pages;

		sourceArtifactId = randomUUID();
		memory.db
			.insert(schema.artifacts)
			.values({
				id: sourceArtifactId,
				userId: bundleUser,
				conversationId: CONVERSATION,
				type: "source_document",
				retrievalClass: "durable",
				name: "sample.pdf",
				mimeType: "application/pdf",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		normalizedArtifactId = seedArtifact({
			type: "normalized_document",
			name: "sample.md",
			contentText: markdown,
			userId: bundleUser,
			// `pageCountKind` rides every structured parse (`persist.ts`), and
			// page mode now refuses to name a page without it — a `declared`
			// DOCX count or a `logical` CSV count is not a page anyone can turn
			// to, and reporting one is an invention, not a citation.
			metadata: {
				normalizedFrom: "sample.pdf",
				pageCount: result.pageCount,
				pageCountKind: result.pageCountKind,
			},
		});
		memory.db
			.insert(schema.artifactLinks)
			.values({
				id: randomUUID(),
				userId: bundleUser,
				artifactId: normalizedArtifactId,
				relatedArtifactId: sourceArtifactId,
				conversationId: CONVERSATION,
				linkType: "derived_from",
				createdAt: NOW,
			})
			.run();

		await writeMineruParseBundle({
			userId: bundleUser,
			sourceArtifactId,
			zipPathAbsolute: join(
				process.cwd(),
				"fixtures",
				"mineru-v1",
				"pdf",
				"result.zip",
			),
			result,
			maxBytes: 33_554_432,
		});
	}

	function readPage(
		overrides: Partial<Parameters<typeof readGeneratedFileContent>[0]> = {},
	) {
		return readGeneratedFileContent({
			userId: bundleUser,
			conversationId: CONVERSATION,
			filename: "sample.pdf",
			...overrides,
		});
	}

	beforeEach(async () => {
		bundleUser = `rgf-page-${randomUUID()}`;
		seedUser(bundleUser);
		// This block's user needs to OWN the conversation its documents sit in.
		// Artifact reach is decided by the ownership scope — the set of the
		// user's own conversations — and a user with no conversation row holds
		// nothing through one, which is true of the library and now of this
		// tool's document tier as well.
		memory.db
			.update(schema.conversations)
			.set({ userId: bundleUser })
			.where(eq(schema.conversations.id, CONVERSATION))
			.run();
		await seedParsedDocument();
	});

	afterEach(async () => {
		await rm(join(process.cwd(), "data", "knowledge", bundleUser), {
			recursive: true,
			force: true,
		}).catch(() => undefined);
	});

	it("starts the window at the requested page", async () => {
		const result = await readPage({ page: 2 });

		expect(pages).toHaveLength(3);
		expect(result.page).toBe(2);
		expect(result.pageCount).toBe(3);
		expect(result.from).toBe(pages[1].start);
		expect(result.from).toBeGreaterThan(0);
		expect(result.contentText).toBe(markdown.slice(pages[1].start));
		expect(result.pageNote).toBeNull();
	});

	it("reads page one from the start", async () => {
		const result = await readPage({ page: 1 });

		expect(result.page).toBe(1);
		expect(result.from).toBe(0);
	});

	it("lets `query` win over `page`", async () => {
		const result = await readPage({ page: 3, query: "Northland" });

		expect(result.passages).not.toBeNull();
		expect(result.page).toBeNull();
	});

	it("lets an explicit `from` win over `page`", async () => {
		const result = await readPage({ page: 3, from: 0 });

		expect(result.from).toBe(0);
		expect(result.page).toBeNull();
	});

	it("answers a page past the end with the end-of-content note", async () => {
		const result = await readPage({ page: 99 });

		expect(result.from).toBe(result.contentLength);
		expect(result.pageNote).toBeNull();
		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload.note).toContain("at or past the end");
		expect(payload.pageCount).toBe(3);
	});

	it("tells the model when a document has no page information", async () => {
		seedArtifact({
			type: "normalized_document",
			name: "plain.md",
			contentText: "A document that was never parsed with structure.",
			userId: bundleUser,
		});

		const result = await readPage({ filename: "plain.md", page: 2 });

		expect(result.page).toBeNull();
		expect(result.pageCount).toBeNull();
		expect(result.from).toBe(0);
		expect(result.pageNote).toContain("no page information");
		const payload = buildReadGeneratedFileModelPayload(result);
		expect(payload.note).toBe(result.pageNote);
		expect(payload.page).toBeUndefined();
	});

	it("says nothing about pages when none was asked for", async () => {
		const payload = buildReadGeneratedFileModelPayload(await readPage({}));

		expect(payload.page).toBeUndefined();
		expect(payload.pageCount).toBeUndefined();
		expect(payload.note).toBeUndefined();
	});

	it("carries the page range of every passage", async () => {
		const chunked = seedArtifact({
			type: "normalized_document",
			name: "chunked.md",
			contentText: "Northland on two.\n\nSouthland on five.",
			userId: bundleUser,
		});
		memory.db
			.insert(schema.artifactChunks)
			.values([
				{
					id: `${chunked}:0`,
					artifactId: chunked,
					userId: bundleUser,
					conversationId: CONVERSATION,
					chunkIndex: 0,
					contentText: "Northland on two.",
					tokenEstimate: 5,
					pageStart: 2,
					pageEnd: 2,
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: `${chunked}:1`,
					artifactId: chunked,
					userId: bundleUser,
					conversationId: CONVERSATION,
					chunkIndex: 1,
					contentText: "Southland on five.",
					tokenEstimate: 5,
					pageStart: 5,
					pageEnd: 6,
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();

		const result = await readPage({
			filename: "chunked.md",
			query: "Northland",
		});

		expect(result.passages?.[0]).toMatchObject({ pageStart: 2, pageEnd: 2 });
	});

	it("refuses to name a page for a kind that has none", async () => {
		// `artifacts.ts` already refused to CITE a `declared` DOCX count or a
		// `logical` CSV count — "p. 1" there is an invention, not a citation —
		// but this path reported one anyway, and the summary said "p." for it.
		memory.db
			.update(schema.artifacts)
			.set({
				metadataJson: JSON.stringify({
					normalizedFrom: "sample.pdf",
					pageCount: 3,
					pageCountKind: "declared",
				}),
			})
			.where(eq(schema.artifacts.id, normalizedArtifactId))
			.run();

		const result = await readPage({ page: 2 });

		expect(result.page).toBeNull();
		expect(result.pageCount).toBeNull();
		expect(result.pageUnit).toBeNull();
		expect(result.from).toBe(0);
		expect(result.pageNote).toBeTruthy();
		expect(summarizeReadGeneratedFileResult(result)).not.toContain("p. ");
	});

	it("names slides for a deck and sheets for a workbook", async () => {
		for (const [kind, word] of [
			["slide", "slide"],
			["sheet", "sheet"],
			["physical", "p."],
		] as const) {
			memory.db
				.update(schema.artifacts)
				.set({
					metadataJson: JSON.stringify({
						normalizedFrom: "sample.pdf",
						pageCount: 3,
						pageCountKind: kind,
					}),
				})
				.where(eq(schema.artifacts.id, normalizedArtifactId))
				.run();

			const result = await readPage({ page: 2 });
			expect(result.page).toBe(2);
			expect(summarizeReadGeneratedFileResult(result)).toContain(
				`from ${word} 2`,
			);
		}
	});

	it("keys the per-turn cache on the page", async () => {
		const first = await readPage({ page: 1, turnId: "turn-1" });
		const second = await readPage({ page: 3, turnId: "turn-1" });

		expect(first.from).toBe(0);
		expect(second.from).toBe(pages[2].start);
	});
});

/**
 * The read-back blocker (live, 2026-09-21).
 *
 * `read_generated_file({ filename })` resolved its target by matching
 * `artifacts.name`, and the SQL pre-filtered on an exact name, so:
 *
 *  - a DOCUMENT-SOURCE file was unreachable by its own filename (that
 *    artifact is named after the document TITLE), and the pre-filter emptied
 *    the row set, so even the newest-file fallback could not fire — the model
 *    got "No matching file found.", concluded it had lied, publicly retracted
 *    a true statement and produced the file a second time;
 *  - a file produced in THIS turn had no artifact at all yet (the memory sync
 *    is deferred until the assistant message is assigned), so the same-turn
 *    read-back returned nothing;
 *  - a patched file's NEW version had no artifact yet while the OLD one did,
 *    so the read-back served the stale v1.
 *
 * The filename the model produced now resolves against `chat_generated_files`
 * first. These tests pin that, the version rule, the truthful "text pending"
 * answer for a binary the ledger has not read back yet, and ownership.
 */
describe("readGeneratedFileContent — the filename the model produced", () => {
	const CHAT_FILES_DIR = join(process.cwd(), "data", "chat-files");
	const writtenFiles: string[] = [];

	async function seedChatFile(params: {
		filename: string;
		content: string | Buffer;
		mimeType: string;
		createdAt?: Date;
		conversationId?: string;
		userId?: string;
	}): Promise<string> {
		const id = randomUUID();
		const conversationId = params.conversationId ?? CONVERSATION;
		const extension = params.filename.split(".").pop() ?? "bin";
		const storagePath = join(conversationId, `${id}.${extension}`);
		const absolute = join(CHAT_FILES_DIR, storagePath);
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		await mkdir(dirname(absolute), { recursive: true });
		const buffer = Buffer.isBuffer(params.content)
			? params.content
			: Buffer.from(params.content, "utf8");
		await writeFile(absolute, buffer);
		writtenFiles.push(absolute);

		memory.db
			.insert(schema.chatGeneratedFiles)
			.values({
				id,
				conversationId,
				userId: params.userId ?? USER,
				filename: params.filename,
				mimeType: params.mimeType,
				sizeBytes: buffer.length,
				storagePath,
				createdAt: params.createdAt ?? NOW,
			})
			.run();
		return id;
	}

	function seedFileProductionJob(params: {
		id: string;
		chatFileIds: string[];
		userId?: string;
		conversationId?: string;
	}) {
		memory.db
			.insert(schema.fileProductionJobs)
			.values({
				id: params.id,
				conversationId: params.conversationId ?? CONVERSATION,
				userId: params.userId ?? USER,
				title: "job",
				status: "succeeded",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		memory.db
			.insert(schema.fileProductionJobFiles)
			.values(
				params.chatFileIds.map((chatGeneratedFileId, sortOrder) => ({
					id: randomUUID(),
					jobId: params.id,
					chatGeneratedFileId,
					sortOrder,
					createdAt: NOW,
				})),
			)
			.run();
	}

	/** The wrapper `chat-files.ts` writes; the last section is the only part a
	 * readback ever rewrites. */
	function memoryWrapper(filename: string, extracted: string | null): string {
		const head = [
			`Generated file: ${filename}`,
			"File type: application/pdf",
			`Generated in conversation: ${CONVERSATION}`,
		].join("\n");
		return extracted
			? `${head}\n\nExtracted file content:\n${extracted}`
			: `${head}\n\nExtracted file content: No readable text could be extracted from this file. Use the filename, file type, and surrounding chat context when continuing it.`;
	}

	afterEach(async () => {
		await Promise.all(
			writtenFiles.splice(0).map((file) => rm(file, { force: true })),
		);
	});

	const DOCUMENT_MARKDOWN =
		"# Tobacco Cost Breakdown\n\nMonthly spend: 42 EUR.\n\nPouch price: 6.10 EUR.";
	const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

	it("finds a document-source PDF by its produced filename, with the artifact present", async () => {
		const fileId = await seedChatFile({
			filename: "tobacco-cost-breakdown.pdf",
			content: PDF_BYTES,
			mimeType: "application/pdf",
		});
		// The artifact is named after the DOCUMENT TITLE, which is exactly why
		// the old name-matching path could never find it.
		seedArtifact({
			type: "generated_output",
			name: "Tobacco Cost Breakdown - Monthly Spend and Pouch Prices",
			contentText: DOCUMENT_MARKDOWN,
			metadata: {
				generatedDocumentSource: {
					version: 1,
					title: "Tobacco Cost Breakdown",
				},
				fileProductionJobId: "job-1",
				originalChatFileId: fileId,
				sourceChatFileId: fileId,
				generatedDocumentRenderedChatFileIds: [fileId],
				documentLabel: "Tobacco Cost Breakdown",
				versionNumber: 1,
			},
		});

		const result = await read({ filename: "tobacco-cost-breakdown.pdf" });

		expect(result.notFound).toBe(false);
		expect(result.filename).toBe("tobacco-cost-breakdown.pdf");
		expect(result.source).toBe("generated");
		expect(result.contentText).toBe(DOCUMENT_MARKDOWN);
		expect(buildReadGeneratedFileModelPayload(result)).toMatchObject({
			found: true,
			filename: "tobacco-cost-breakdown.pdf",
		});
	});

	it("finds a document-source PDF in the SAME turn, before the artifact is linked", async () => {
		// Mid-job: the source artifact exists (it carries the rendered Markdown)
		// but its rendered chat files have not been attached yet, so nothing in
		// its metadata names this file. The job row is the link.
		const fileId = await seedChatFile({
			filename: "tobacco-cost-breakdown.pdf",
			content: PDF_BYTES,
			mimeType: "application/pdf",
		});
		seedFileProductionJob({ id: "job-2", chatFileIds: [fileId] });
		seedArtifact({
			type: "generated_output",
			name: "Tobacco Cost Breakdown - Monthly Spend and Pouch Prices",
			contentText: DOCUMENT_MARKDOWN,
			metadata: {
				generatedDocumentSource: {
					version: 1,
					title: "Tobacco Cost Breakdown",
				},
				generatedDocumentSourceStatus: "pending",
				fileProductionJobId: "job-2",
			},
		});

		const result = await read({ filename: "tobacco-cost-breakdown.pdf" });

		expect(result.notFound).toBe(false);
		expect(result.textPending).toBe(false);
		expect(result.contentText).toBe(DOCUMENT_MARKDOWN);
	});

	// `file_production_job_files` has no `user_id` of its own, so the job-id
	// lookup was scoped only by the ids its caller happened to pass. That was
	// safe by construction and nowhere else — the one place in this module
	// where the tenancy invariant rode on an argument instead of on SQL. It now
	// joins `file_production_jobs` and requires the job to be this user's, so a
	// job row belonging to somebody else contributes nothing even when a chat
	// file points at it.
	it("ignores a job row that belongs to another user", async () => {
		const fileId = await seedChatFile({
			filename: "tobacco-cost-breakdown.pdf",
			content: PDF_BYTES,
			mimeType: "application/pdf",
		});
		seedUser("intruder");
		seedConversation("conv-intruder", "intruder");
		seedFileProductionJob({
			id: "job-foreign",
			chatFileIds: [fileId],
			userId: "intruder",
			conversationId: "conv-intruder",
		});
		// This user's own artifact happens to name the same job id. Without the
		// join it is reached through the foreign job row and its text is served
		// for a file the job never produced.
		seedArtifact({
			type: "generated_output",
			name: "Tobacco Cost Breakdown - Monthly Spend and Pouch Prices",
			contentText: DOCUMENT_MARKDOWN,
			metadata: {
				generatedDocumentSource: {
					version: 1,
					title: "Tobacco Cost Breakdown",
				},
				generatedDocumentSourceStatus: "pending",
				fileProductionJobId: "job-foreign",
			},
		});

		const result = await read({ filename: "tobacco-cost-breakdown.pdf" });

		expect(result.notFound).toBe(false);
		expect(result.contentText).not.toBe(DOCUMENT_MARKDOWN);
	});

	it("reads an inline_text file produced in this turn straight off disk", async () => {
		// No artifact at all: the memory sync has not run yet.
		await seedChatFile({
			filename: "release-notes.md",
			content: "# Release notes\n\n- First cut.",
			mimeType: "text/markdown",
		});

		const result = await read({ filename: "release-notes.md" });

		expect(result.notFound).toBe(false);
		expect(result.contentText).toBe("# Release notes\n\n- First cut.");
		// No artifact link, so no settled version number. It is the newest file
		// of that name, and that is all the tool may claim: counting this
		// conversation's same-named files answered v1 for a file whose family
		// already had a v1 somewhere else.
		expect(result.versionNumber).toBeNull();
		expect(result.versionPending).toBe(true);
		expect(buildReadGeneratedFileModelPayload(result).versionNumber).toBe(
			"latest",
		);
		expect(summarizeReadGeneratedFileResult(result)).toContain("latest");
		expect(result.mimeType).toBe("text/markdown");
	});

	it("tells the truth about a program-mode PDF whose readback is still queued", async () => {
		const fileId = await seedChatFile({
			filename: "chart.pdf",
			content: PDF_BYTES,
			mimeType: "application/pdf",
		});
		const artifactId = seedArtifact({
			type: "generated_output",
			name: "chart.pdf",
			contentText: memoryWrapper("chart.pdf", null),
			metadata: {
				generatedFile: true,
				originalChatFileId: fileId,
				generatedFilename: "chart.pdf",
				versionNumber: 1,
			},
		});

		const pending = await read({ filename: "chart.pdf" });

		expect(pending.notFound).toBe(false);
		expect(pending.textPending).toBe(true);
		expect(pending.contentText).toBeNull();
		expect(pending.sizeBytes).toBe(PDF_BYTES.length);
		const payload = buildReadGeneratedFileModelPayload(pending);
		expect(payload).toMatchObject({ found: true, textPending: true });
		expect(String(payload.note)).toContain("chart.pdf");
		expect(summarizeReadGeneratedFileResult(pending)).not.toBe(
			"No matching file found.",
		);

		// …and once the readback sink has filled the wrapper's last section in.
		memory.db
			.update(schema.artifacts)
			.set({
				contentText: memoryWrapper("chart.pdf", "Quarterly chart, 3 series."),
			})
			.where(eq(schema.artifacts.id, artifactId))
			.run();

		const ready = await read({ filename: "chart.pdf" });
		expect(ready.textPending).toBe(false);
		expect(ready.contentText).toBe("Quarterly chart, 3 series.");
	});

	it("returns the newest version of a filename, never the stale previous one", async () => {
		const v1 = await seedChatFile({
			filename: "release-notes.md",
			content: "# Release notes\n\n- First cut.",
			mimeType: "text/markdown",
			createdAt: new Date("2026-09-15T10:00:00.000Z"),
		});
		seedArtifact({
			type: "generated_output",
			name: "release-notes.md",
			contentText:
				"Generated file: release-notes.md\n\nExtracted file content:\n# Release notes\n\n- First cut.",
			metadata: {
				generatedFile: true,
				originalChatFileId: v1,
				generatedFilename: "release-notes.md",
				versionNumber: 1,
			},
		});

		// The patch lands: v2 is on disk, and its artifact does not exist yet.
		await seedChatFile({
			filename: "release-notes.md",
			content: "# Release notes\n\n- First cut.\n- Second cut.",
			mimeType: "text/markdown",
			createdAt: new Date("2026-09-15T10:01:00.000Z"),
		});

		const result = await read({ filename: "release-notes.md" });

		expect(result.contentText).toBe(
			"# Release notes\n\n- First cut.\n- Second cut.",
		);
		// The RANKING is the point of this test and is unchanged: the newest
		// file wins over the one that carries a version number. The LABEL is
		// "latest" until the link lands, because the number the sync will
		// settle on depends on versions that may live in other conversations.
		expect(result.versionNumber).toBeNull();
		expect(result.versionPending).toBe(true);
		expect(summarizeReadGeneratedFileResult(result)).toContain("latest");
	});

	it("matches case-insensitively and by stem", async () => {
		await seedChatFile({
			filename: "Quarterly-Report.md",
			content: "# Quarterly report",
			mimeType: "text/markdown",
		});

		const caseInsensitive = await read({ filename: "quarterly-report.md" });
		expect(caseInsensitive.contentText).toBe("# Quarterly report");

		const byStem = await read({ filename: "Quarterly-Report.pdf" });
		expect(byStem.contentText).toBe("# Quarterly report");
	});

	// A stem match is the weakest tier there is — same basename, different
	// extension — and it must not shadow a document the user UPLOADED under
	// exactly the name that was asked for.
	it("prefers an uploaded document named exactly as asked over a generated file's stem match", async () => {
		await seedChatFile({
			filename: "contract.md",
			content: "the summary the assistant wrote",
			mimeType: "text/markdown",
		});
		seedArtifact({
			type: "normalized_document",
			name: "contract.md",
			contentText: "the contract the user uploaded",
			metadata: { normalizedFrom: "contract.pdf" },
		});

		const result = await read({ filename: "contract.pdf" });

		expect(result.source).toBe("document");
		expect(result.contentText).toBe("the contract the user uploaded");
	});

	it("still answers a stem match from the generated file when no such upload exists", async () => {
		await seedChatFile({
			filename: "contract.md",
			content: "the summary the assistant wrote",
			mimeType: "text/markdown",
		});

		const result = await read({ filename: "contract.pdf" });

		expect(result.source).toBe("generated");
		expect(result.contentText).toBe("the summary the assistant wrote");
	});

	// An exact filename still wins outright — the reordering above only moved
	// the STEM tier.
	it("keeps an exactly named generated file ahead of an uploaded document", async () => {
		await seedChatFile({
			filename: "notes.md",
			content: "generated notes",
			mimeType: "text/markdown",
		});
		seedArtifact({
			type: "normalized_document",
			name: "notes.md",
			contentText: "uploaded notes",
		});

		const result = await read({ filename: "notes.md" });

		expect(result.source).toBe("generated");
		expect(result.contentText).toBe("generated notes");
	});

	// The wrapper is bookkeeping — the chat-file id, the conversation id, the
	// prior-version list and a 900-char excerpt of a DIFFERENT turn's answer.
	// `resolveBestContent` fell back to the whole of it whenever the extracted
	// section was still the "no text yet" sentence, so a requestTitle call on a
	// pending binary handed the model internal ids and unrelated text and let
	// it read them as the file's contents.
	it("never returns the memory wrapper as content on the requestTitle path", async () => {
		const fileId = await seedChatFile({
			filename: "chart.pdf",
			content: PDF_BYTES,
			mimeType: "application/pdf",
		});
		const wrapper = [
			"Generated file: chart.pdf",
			"File type: application/pdf",
			`Chat file id: ${fileId}`,
			`Generated in conversation: ${CONVERSATION}`,
			"Generated file version: v1",
			"",
			"Assistant response context:",
			"Here is the quarterly chart you asked about last week.",
			"",
			"Extracted file content: No readable text could be extracted from this file. Use the filename, file type, and surrounding chat context when continuing it.",
		].join("\n");
		seedArtifact({
			type: "generated_output",
			name: "chart.pdf",
			contentText: wrapper,
			metadata: {
				generatedFile: true,
				originalChatFileId: fileId,
				generatedFilename: "chart.pdf",
				documentLabel: "Quarterly chart",
				versionNumber: 1,
			},
		});

		const result = await read({ requestTitle: "Quarterly chart" });

		expect(result.notFound).toBe(false);
		expect(result.textPending).toBe(true);
		expect(result.contentText).toBeNull();
		// The facts come from the stored file, not from the wrapper.
		expect(result.sizeBytes).toBe(PDF_BYTES.length);
		expect(result.mimeType).toBe("application/pdf");
		expect(result.versionNumber).toBe(1);

		const payload = JSON.stringify(buildReadGeneratedFileModelPayload(result));
		expect(payload).not.toContain(fileId);
		expect(payload).not.toContain(CONVERSATION);
		expect(payload).not.toContain("Assistant response context");
		expect(payload).not.toContain("No readable text could be extracted");
	});

	// The `origin` clause is careful to say nothing but "from an earlier
	// conversation" — no conversation id, no other filename. The SUMMARY went
	// straight past it: it is `guessSummary` over the wrapper's head, so it
	// carried the other conversation's id and the chat-file id of a file this
	// conversation cannot open. The wrapper is model-visible content, and the
	// returned summary is now rebuilt from a redacted copy of it.
	it("discloses no other conversation's ids on a cross-conversation read-back", async () => {
		const otherFileId = await seedChatFile({
			filename: "budget.md",
			content: "# Budget\n\nNumbers here.",
			mimeType: "text/markdown",
			conversationId: OTHER_CONVERSATION,
		});
		const wrapper = [
			"Generated file: budget.md",
			"File type: text/markdown",
			`Chat file id: ${otherFileId}`,
			`Generated in conversation: ${OTHER_CONVERSATION}`,
			"Generated file version: v2",
			"",
			"Recent prior versions:",
			`- v1 from 2026-09-01T10:00:00.000Z in conversation ${OTHER_CONVERSATION}: an earlier budget`,
			"",
			"Extracted file content:",
			"# Budget\n\nNumbers here.",
		].join("\n");
		seedArtifact({
			type: "generated_output",
			name: "budget.md",
			contentText: wrapper,
			summary: storedSummaryOf(wrapper),
			conversationId: OTHER_CONVERSATION,
			metadata: {
				generatedFile: true,
				originalChatFileId: otherFileId,
				generatedFilename: "budget.md",
				documentFamilyId: "family-budget",
				documentLabel: "budget.md",
				versionNumber: 2,
			},
		});

		const result = await read({ filename: "budget.md" });

		expect(result.notFound).toBe(false);
		expect(result.conversation).toBe("library");
		const payload = JSON.stringify(buildReadGeneratedFileModelPayload(result));
		expect(payload).not.toContain(otherFileId);
		expect(payload).not.toContain(OTHER_CONVERSATION);
		// No conversation id of any shape, anywhere in the serialised payload.
		expect(payload).not.toMatch(/conv-[a-z0-9]/i);
		// The clause that IS allowed to say where it came from still does.
		expect(payload).toContain("from an earlier conversation");
	});

	// A version list that outlives the versions it names. The wrapper is
	// written once and never revised, so it goes on offering "v1 from …" for
	// a file whose conversation the user deleted — beside a label built from
	// the versions that survive, which says the opposite.
	it("lists no prior version the user can no longer open", async () => {
		const fileId = await seedChatFile({
			filename: "plan.md",
			content: "# Plan v2",
			mimeType: "text/markdown",
		});
		const wrapper = [
			"Generated file: plan.md",
			"File type: text/markdown",
			`Chat file id: ${fileId}`,
			`Generated in conversation: ${CONVERSATION}`,
			"Generated file version: v2",
			"",
			"Recent prior versions:",
			"- v1 from 2026-09-01T10:00:00.000Z: the first plan",
			"",
			"Extracted file content:",
			"# Plan v2",
		].join("\n");
		seedArtifact({
			type: "generated_output",
			name: "plan.md",
			contentText: wrapper,
			summary: storedSummaryOf(wrapper),
			metadata: {
				generatedFile: true,
				originalChatFileId: fileId,
				generatedFilename: "plan.md",
				documentFamilyId: "family-plan",
				documentLabel: "plan.md",
				versionNumber: 2,
			},
		});
		// v1's own artifact, orphaned by the deletion of the conversation that
		// held it — `artifacts.conversation_id` is `ON DELETE SET NULL`.
		seedArtifact({
			type: "generated_output",
			name: "plan.md",
			contentText: "Generated file: plan.md\n\nExtracted file content:\n# Plan",
			conversationId: null,
			metadata: {
				generatedFile: true,
				documentFamilyId: "family-plan",
				documentLabel: "plan.md",
				versionNumber: 1,
			},
		});

		const result = await read({ filename: "plan.md" });

		expect(result.versionNumber).toBe(2);
		expect(result.versionCount).toBe(1);
		// The label and the list agree: one version, and it is this one.
		expect(summarizeReadGeneratedFileResult(result)).toContain(
			"earlier versions no longer available",
		);
		expect(result.summary).not.toContain("v1 from");
		expect(result.summary).not.toContain("Recent prior versions");
		expect(result.summary).not.toContain("the first plan");
	});

	it("leaves the summary byte-identical when nothing had to be taken out", async () => {
		const fileId = await seedChatFile({
			filename: "steady.md",
			content: "# Steady",
			mimeType: "text/markdown",
		});
		const wrapper = [
			"Generated file: steady.md",
			"File type: text/markdown",
			`Chat file id: ${fileId}`,
			`Generated in conversation: ${CONVERSATION}`,
			"Generated file version: v1",
			"",
			"Extracted file content:",
			"# Steady",
		].join("\n");
		const summary = storedSummaryOf(wrapper);
		seedArtifact({
			type: "generated_output",
			name: "steady.md",
			contentText: wrapper,
			summary,
			metadata: {
				generatedFile: true,
				originalChatFileId: fileId,
				generatedFilename: "steady.md",
				documentLabel: "steady.md",
				versionNumber: 1,
			},
		});

		const result = await read({ filename: "steady.md" });

		expect(result.conversation).toBe("this");
		// Its own conversation's id and its own chat file's id are not a
		// disclosure, and the stored bytes come back untouched.
		expect(result.summary).toBe(summary);
		expect(result.summary).toContain(`Chat file id: ${fileId}`);
	});

	it("still returns a document-source artifact's raw Markdown, which has no wrapper", async () => {
		seedArtifact({
			type: "generated_output",
			name: "Tobacco Cost Breakdown - Monthly Spend and Pouch Prices",
			contentText: DOCUMENT_MARKDOWN,
			metadata: {
				generatedDocumentSource: {
					version: 1,
					title: "Tobacco Cost Breakdown",
				},
				documentLabel: "Tobacco Cost Breakdown",
			},
		});

		const result = await read({ requestTitle: "Tobacco Cost Breakdown" });

		expect(result.textPending).toBe(false);
		expect(result.contentText).toBe(DOCUMENT_MARKDOWN);
	});

	it("lists this conversation's filenames as candidates on a genuine miss", async () => {
		await seedChatFile({
			filename: "release-notes.md",
			content: "# Release notes",
			mimeType: "text/markdown",
		});

		const result = await read({ filename: "realease-notes.md" });

		expect(result.notFound).toBe(true);
		expect(result.candidates.map((candidate) => candidate.filename)).toContain(
			"release-notes.md",
		);
	});

	it("never reads another user's file, however it is asked for", async () => {
		seedConversation("conv-foreign", OTHER_USER);
		await seedChatFile({
			filename: "foreign.md",
			content: "another user",
			mimeType: "text/markdown",
			conversationId: "conv-foreign",
			userId: OTHER_USER,
		});
		await seedChatFile({
			filename: "mine.md",
			content: "this user",
			mimeType: "text/markdown",
			conversationId: OTHER_CONVERSATION,
		});

		// Ownership is a `user_id` term in every query, never a filter applied
		// after the rows come back, so the cross-conversation fallback cannot
		// widen it.
		const otherUser = await read({ filename: "foreign.md" });
		expect(otherUser.notFound).toBe(true);

		const fromForeign = await readGeneratedFileContent({
			userId: OTHER_USER,
			conversationId: "conv-foreign",
			filename: "mine.md",
		});
		expect(fromForeign.notFound).toBe(true);
	});

	it("reads a forked conversation's copied file back by filename", async () => {
		// A fork copies the chat file row (new id, new conversation) and rewrites
		// the copied artifact's `originalChatFileId` to point at it.
		seedConversation("conv-fork", USER);
		const copiedFileId = await seedChatFile({
			filename: "release-notes.md",
			content: "# Release notes\n\n- First cut.",
			mimeType: "text/markdown",
			conversationId: "conv-fork",
		});
		seedArtifact({
			type: "generated_output",
			name: "release-notes.md",
			conversationId: "conv-fork",
			contentText:
				"Generated file: release-notes.md\n\nExtracted file content:\n# Release notes\n\n- First cut.",
			metadata: {
				generatedFile: true,
				originalChatFileId: copiedFileId,
				sourceChatFileId: copiedFileId,
				generatedFilename: "release-notes.md",
				versionNumber: 1,
			},
		});

		const result = await readGeneratedFileContent({
			userId: USER,
			conversationId: "conv-fork",
			filename: "release-notes.md",
		});

		expect(result.notFound).toBe(false);
		expect(result.contentText).toBe("# Release notes\n\n- First cut.");
	});

	/**
	 * A generated file's document family and version number are per user and
	 * per filename ACROSS conversations, deliberately: "if the conversation is
	 * about continuing a file it should be able to pick it up, just like how it
	 * can pick up past made files." So the first `release-notes.md` of a fresh
	 * conversation really is v3, and the label was right all along — what was
	 * missing is that the tools could not reach the file the label refers to.
	 * `read_generated_file` answered "no matching file" for a document it had
	 * just called the third version of.
	 */
	describe("picking a file up from an earlier conversation", () => {
		/** Seeds v1 in the other conversation, with the family metadata. */
		async function seedEarlierVersion(params: {
			filename: string;
			content: string;
			mimeType: string;
			familyId?: string;
			versionNumber?: number;
			userId?: string;
			conversationId?: string;
		}) {
			const fileId = await seedChatFile({
				filename: params.filename,
				content: params.content,
				mimeType: params.mimeType,
				conversationId: params.conversationId ?? OTHER_CONVERSATION,
				userId: params.userId,
				createdAt: new Date("2026-09-10T10:00:00.000Z"),
			});
			seedArtifact({
				type: "generated_output",
				name: `${params.filename} generated file`,
				conversationId: params.conversationId ?? OTHER_CONVERSATION,
				userId: params.userId,
				contentText: `Generated file: ${params.filename}\n\nExtracted file content:\n${params.content}`,
				metadata: {
					generatedFile: true,
					originalChatFileId: fileId,
					generatedFilename: params.filename,
					documentFamilyId: params.familyId ?? "family-release-notes",
					documentLabel: params.filename,
					versionNumber: params.versionNumber ?? 1,
				},
			});
			return fileId;
		}

		it("reads a markdown file made in another conversation", async () => {
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- First cut.",
				mimeType: "text/markdown",
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.notFound).toBe(false);
			expect(result.source).toBe("generated");
			expect(result.conversation).toBe("library");
			expect(result.filename).toBe("release-notes.md");
			expect(result.contentText).toBe("# Release notes\n\n- First cut.");
		});

		// Incognito is a promise the UI makes in plain words — "Incognito ·
		// nothing here is remembered", and the sidebar marks the chat "not
		// remembered". Before cross-conversation pickup, a file made in an
		// incognito chat could not surface anywhere else, so the promise held
		// by construction. Now it can: `chat_generated_files` carries no
		// incognito flag and the lookup never joins `conversations`, so the
		// same user's next chat can read the file by name and is told it came
		// "from an earlier conversation". Incognito must gate the file the way
		// it gates the memory pipeline.
		it("never reads a file out of an incognito conversation", async () => {
			memory.db
				.update(schema.conversations)
				.set({ memoryIncognito: true })
				.where(eq(schema.conversations.id, OTHER_CONVERSATION))
				.run();
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Secret.",
				mimeType: "text/markdown",
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.notFound).toBe(true);
			expect(result.contentText ?? null).toBeNull();
		});

		it("does not even name an incognito conversation's file as a candidate", async () => {
			memory.db
				.update(schema.conversations)
				.set({ memoryIncognito: true })
				.where(eq(schema.conversations.id, OTHER_CONVERSATION))
				.run();
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Secret.",
				mimeType: "text/markdown",
			});

			// A miss hands the model up to four filenames from elsewhere. An
			// incognito filename is still the content of an incognito chat.
			const result = await read({ filename: "no-such-file.md" });

			expect(result.notFound).toBe(true);
			expect(
				(result.candidates ?? []).map((candidate) => candidate.filename),
			).not.toContain("release-notes.md");
		});

		// DELIBERATELY RE-PINNED. This fixture seeds a single artifact stamped
		// v2, with no v1 row anywhere, and used to assert "of 2" — because the
		// count was the highest version NUMBER in the family rather than a count
		// of anything. It was extrapolating a v1 that had never existed as a
		// row. The count now answers the question the clause actually asks, so
		// one reachable version reads as one.
		it("says where it came from, and how many versions there are", async () => {
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Second cut.",
				mimeType: "text/markdown",
				versionNumber: 2,
			});

			const result = await read({ filename: "release-notes.md" });
			const payload = buildReadGeneratedFileModelPayload(result);

			expect(result.versionNumber).toBe(2);
			expect(result.versionCount).toBe(1);
			expect(payload.origin).toBe(
				"from an earlier conversation, v2, earlier versions no longer available",
			);
			expect(summarizeReadGeneratedFileResult(result)).toContain(
				"v2, earlier versions no longer available, from an earlier conversation",
			);

			// One short clause and nothing else: no conversation id, no other
			// conversation's title, no other filename.
			const rendered = JSON.stringify(payload);
			expect(rendered).not.toContain(OTHER_CONVERSATION);
			expect(rendered).not.toContain("conv-");
		});

		// "v3 of 3" is a promise that three versions exist to look at. The count
		// was the highest `versionNumber` in the family whatever had happened to
		// the artifacts since, and `artifacts.conversation_id` is SET NULL on
		// delete — so a user who deleted the conversations holding v1 and v2 was
		// still told "of 3", about two files nothing can open, and the count
		// asserted the existence of content they had deleted.
		it("counts only the versions the user can still open", async () => {
			// v1 in a conversation that has since been deleted.
			seedConversation("conv-deleted", USER);
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- First cut.",
				mimeType: "text/markdown",
				versionNumber: 1,
				conversationId: "conv-deleted",
			});
			memory.db
				.delete(schema.conversations)
				.where(eq(schema.conversations.id, "conv-deleted"))
				.run();
			// v3 survives, elsewhere.
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Third cut.",
				mimeType: "text/markdown",
				versionNumber: 3,
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.versionNumber).toBe(3);
			expect(result.versionCount).toBe(1);
			// The stored version number is kept — it is what the file IS — and
			// the clause says what is actually there instead of claiming "of 3".
			expect(buildReadGeneratedFileModelPayload(result).origin).toBe(
				"from an earlier conversation, v3, earlier versions no longer available",
			);
		});

		it("does not count a version held only by an incognito conversation", async () => {
			seedConversation("conv-secret", USER);
			memory.db
				.update(schema.conversations)
				.set({ memoryIncognito: true })
				.where(eq(schema.conversations.id, "conv-secret"))
				.run();
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Secret cut.",
				mimeType: "text/markdown",
				versionNumber: 2,
				conversationId: "conv-secret",
			});
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Third cut.",
				mimeType: "text/markdown",
				versionNumber: 3,
			});

			const result = await read({ filename: "release-notes.md" });

			// A count that included the incognito version would tell the model
			// that chat produced something, which is the fact incognito hides.
			expect(result.versionCount).toBe(1);
		});

		it("still says `of N` when every version is reachable", async () => {
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- First cut.",
				mimeType: "text/markdown",
				versionNumber: 1,
			});
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Second cut.",
				mimeType: "text/markdown",
				versionNumber: 2,
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.versionNumber).toBe(2);
			expect(result.versionCount).toBe(2);
			expect(buildReadGeneratedFileModelPayload(result).origin).toBe(
				"from an earlier conversation, v2 of 2",
			);
		});

		it("says nothing about origin for a file from this conversation", async () => {
			await seedChatFile({
				filename: "here.md",
				content: "# Here",
				mimeType: "text/markdown",
			});

			const payload = buildReadGeneratedFileModelPayload(
				await read({ filename: "here.md" }),
			);
			expect(payload.origin).toBeUndefined();
			expect(payload.conversation).toBe("this");
		});

		it("lets this conversation's file win over an older one elsewhere", async () => {
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# Release notes\n\n- Old cut.",
				mimeType: "text/markdown",
			});
			await seedChatFile({
				filename: "release-notes.md",
				content: "# Release notes\n\n- New cut.",
				mimeType: "text/markdown",
				createdAt: new Date("2026-09-14T10:00:00.000Z"),
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.conversation).toBe("this");
			expect(result.contentText).toBe("# Release notes\n\n- New cut.");
		});

		it("reads a document-source PDF made in another conversation", async () => {
			// The artifact of a document_source job is named after the DOCUMENT
			// and its `contentText` IS the rendered Markdown, so this is the path
			// that had to keep working across conversations too.
			const fileId = await seedChatFile({
				filename: "tobacco-cost-breakdown.pdf",
				content: Buffer.from("%PDF-1.7 not really a pdf"),
				mimeType: "application/pdf",
				conversationId: OTHER_CONVERSATION,
				createdAt: new Date("2026-09-10T10:00:00.000Z"),
			});
			seedArtifact({
				type: "generated_output",
				name: "Tobacco Cost Breakdown — September",
				conversationId: OTHER_CONVERSATION,
				contentText: DOCUMENT_MARKDOWN,
				metadata: {
					generatedFile: true,
					generatedDocumentSource: { title: "Tobacco Cost Breakdown" },
					originalChatFileId: fileId,
					documentFamilyId: "family-tobacco",
					documentLabel: "Tobacco Cost Breakdown",
					versionNumber: 1,
				},
			});

			const result = await read({ filename: "tobacco-cost-breakdown.pdf" });

			expect(result.conversation).toBe("library");
			expect(result.textPending).toBe(false);
			expect(result.contentText).toBe(DOCUMENT_MARKDOWN);
		});

		it("tells the truth about a read-back binary from another conversation", async () => {
			// A binary whose text the extraction ledger has not written yet: the
			// file exists, so "no matching file" would be a lie, and the note has
			// to say so exactly as it does for this conversation's own files.
			await seedChatFile({
				filename: "quarterly.xlsx",
				content: Buffer.from("PK not really a workbook"),
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				conversationId: OTHER_CONVERSATION,
				createdAt: new Date("2026-09-10T10:00:00.000Z"),
			});

			const result = await read({ filename: "quarterly.xlsx" });

			expect(result.notFound).toBe(false);
			expect(result.conversation).toBe("library");
			expect(result.textPending).toBe(true);
			expect(result.sizeBytes).toBeGreaterThan(0);
		});

		it("cannot reach a deleted conversation's file", async () => {
			seedConversation("conv-doomed", USER);
			await seedChatFile({
				filename: "doomed.md",
				content: "# Doomed",
				mimeType: "text/markdown",
				conversationId: "conv-doomed",
			});
			expect((await read({ filename: "doomed.md" })).notFound).toBe(false);

			// Deleting a conversation is a real DELETE and the chat-file rows
			// cascade with it, so the file is gone rather than merely hidden.
			memory.db
				.delete(schema.conversations)
				.where(eq(schema.conversations.id, "conv-doomed"))
				.run();

			const result = await read({ filename: "doomed.md" });
			expect(result.notFound).toBe(true);
			expect(
				result.candidates.map((candidate) => candidate.filename),
			).not.toContain("doomed.md");
		});

		it("lists this conversation's names first, then a few from elsewhere", async () => {
			await seedChatFile({
				filename: "release-notes.md",
				content: "# Here",
				mimeType: "text/markdown",
			});
			await seedEarlierVersion({
				filename: "release-notes-draft.md",
				content: "# There",
				mimeType: "text/markdown",
			});
			await seedChatFile({
				filename: "totally-unrelated.csv",
				content: "a,b\n1,2",
				mimeType: "text/csv",
				conversationId: OTHER_CONVERSATION,
				createdAt: new Date("2026-09-11T10:00:00.000Z"),
			});

			// A misspelling, which is what a miss usually is.
			const result = await read({ filename: "relase-notes-draught.md" });

			expect(result.notFound).toBe(true);
			// This conversation's names come first…
			expect(result.candidates[0]).toMatchObject({
				filename: "release-notes.md",
				conversation: "this",
			});
			// …then, separated by `conversation`, the user's recent files of the
			// kind that was asked for. The `.csv` is not one of them.
			const elsewhere = result.candidates.filter(
				(candidate) => candidate.conversation === "library",
			);
			expect(elsewhere.map((candidate) => candidate.filename)).toEqual([
				"release-notes-draft.md",
			]);
			// Names only — nothing about where they live.
			for (const candidate of result.candidates) {
				expect(JSON.stringify(candidate)).not.toContain("conv-");
			}
		});

		// A miss fires precisely when the user referred to none of these files,
		// so "your four most recent spreadsheets from other chats" was an
		// unprompted disclosure of names the model then reads aloud. Names are
		// content. Only names that are plausibly the one asked for qualify.
		// Forking a conversation copies each chat file with the SAME filename and
		// the SAME `created_at`, so from a THIRD conversation the original and
		// the copy tie on recency. The comparator used to return 0 there and the
		// winner was whatever order SQLite happened to yield — harmless while
		// the bytes are identical, a coin toss over the user's content once
		// either side is edited.
		describe("a fork's copy against its original", () => {
			const FORK_CONVERSATION = "conv-fork";
			const SHARED_CREATED_AT = new Date("2026-09-10T10:00:00.000Z");

			async function seedForkPair(params: { forkContent: string }) {
				// The fork's conversation is minted AFTER the original's.
				memory.db
					.insert(schema.conversations)
					.values({
						id: FORK_CONVERSATION,
						userId: USER,
						title: FORK_CONVERSATION,
						createdAt: new Date("2026-09-12T10:00:00.000Z"),
						updatedAt: new Date("2026-09-12T10:00:00.000Z"),
					})
					.run();
				await seedChatFile({
					filename: "release-notes.md",
					content: "# Release notes\n\n- Original.",
					mimeType: "text/markdown",
					conversationId: OTHER_CONVERSATION,
					createdAt: SHARED_CREATED_AT,
				});
				await seedChatFile({
					filename: "release-notes.md",
					content: params.forkContent,
					mimeType: "text/markdown",
					conversationId: FORK_CONVERSATION,
					// `conversation-forks.ts` copies the source file's timestamp.
					createdAt: SHARED_CREATED_AT,
				});
			}

			it("is a harmless tie at fork time, and resolves to the original", async () => {
				// Byte-identical, which is what makes the tie safe: whichever
				// side wins, the user gets the same document.
				await seedForkPair({ forkContent: "# Release notes\n\n- Original." });

				const result = await read({ filename: "release-notes.md" });

				expect(result.contentText).toBe("# Release notes\n\n- Original.");
			});

			it("is deterministic rather than whatever SQLite yields", async () => {
				await seedForkPair({ forkContent: "# Release notes\n\n- Original." });

				// Same answer every time, not merely the same answer once.
				const answers = new Set<string | null | undefined>();
				for (let attempt = 0; attempt < 5; attempt += 1) {
					answers.add(
						(await read({ filename: "release-notes.md" })).contentText,
					);
				}
				expect(answers.size).toBe(1);
			});

			it("hands back the diverged side once either one is edited", async () => {
				await seedForkPair({ forkContent: "# Release notes\n\n- Original." });
				// The fork is worked on: a new version lands with a newer
				// timestamp, and step 1 of the comparator settles it.
				await seedChatFile({
					filename: "release-notes.md",
					content: "# Release notes\n\n- Diverged in the fork.",
					mimeType: "text/markdown",
					conversationId: FORK_CONVERSATION,
					createdAt: new Date("2026-09-15T10:00:00.000Z"),
				});

				const result = await read({ filename: "release-notes.md" });

				expect(result.contentText).toBe(
					"# Release notes\n\n- Diverged in the fork.",
				);
			});
		});

		it("offers nothing from elsewhere when no name is similar", async () => {
			await seedEarlierVersion({
				filename: "quarterly-budget.md",
				content: "# Budget",
				mimeType: "text/markdown",
			});
			await seedChatFile({
				filename: "holiday-photos-list.md",
				content: "# Photos",
				mimeType: "text/markdown",
				conversationId: OTHER_CONVERSATION,
				createdAt: new Date("2026-09-11T10:00:00.000Z"),
			});

			const result = await read({ filename: "release-notes.md" });

			expect(result.notFound).toBe(true);
			expect(result.candidates).toEqual([]);
		});

		it("still offers a near-miss of the same stem from elsewhere", async () => {
			await seedEarlierVersion({
				filename: "release-notes.md",
				content: "# There",
				mimeType: "text/markdown",
			});

			// Same stem, different extension — the ruling's first rule.
			const result = await read({ filename: "release notes.pdf" });

			expect(
				(result.candidates ?? []).map((candidate) => candidate.filename),
			).toContain("release-notes.md");
		});

		it("names at most three from elsewhere", async () => {
			for (const suffix of ["a", "b", "c", "d", "e"]) {
				await seedChatFile({
					filename: `release-notes-${suffix}.md`,
					content: `# ${suffix}`,
					mimeType: "text/markdown",
					conversationId: OTHER_CONVERSATION,
					createdAt: new Date(
						`2026-09-1${suffix === "a" ? 1 : 2}T10:00:00.000Z`,
					),
				});
			}

			const result = await read({ filename: "release-notes.md" });

			expect(
				(result.candidates ?? []).filter(
					(candidate) => candidate.conversation === "library",
				),
			).toHaveLength(3);
		});

		it("offers no other user's name as a candidate", async () => {
			seedConversation("conv-foreign", OTHER_USER);
			await seedChatFile({
				filename: "release-notes.md",
				content: "# Foreign",
				mimeType: "text/markdown",
				conversationId: "conv-foreign",
				userId: OTHER_USER,
			});

			const result = await read({ filename: "relase-notes.md" });
			expect(result.notFound).toBe(true);
			expect(result.candidates).toEqual([]);
		});
	});
});
