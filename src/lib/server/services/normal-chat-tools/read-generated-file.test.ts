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
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			createdAt: NOW,
			updatedAt: params.updatedAt ?? NOW,
		})
		.run();
	return id;
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
	}) {
		memory.db
			.insert(schema.fileProductionJobs)
			.values({
				id: params.id,
				conversationId: CONVERSATION,
				userId: USER,
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
		expect(result.versionNumber).toBe(1);
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
		expect(result.versionNumber).toBe(2);
		expect(summarizeReadGeneratedFileResult(result)).toContain("v2");
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

	it("never reads a file of another conversation or another user", async () => {
		await seedChatFile({
			filename: "secret.md",
			content: "other conversation",
			mimeType: "text/markdown",
			conversationId: OTHER_CONVERSATION,
		});
		seedConversation("conv-foreign", OTHER_USER);
		await seedChatFile({
			filename: "foreign.md",
			content: "another user",
			mimeType: "text/markdown",
			conversationId: "conv-foreign",
			userId: OTHER_USER,
		});

		const otherConversation = await read({ filename: "secret.md" });
		expect(otherConversation.notFound).toBe(true);
		expect(otherConversation.candidates).toEqual([]);

		const otherUser = await read({ filename: "foreign.md" });
		expect(otherUser.notFound).toBe(true);

		// …and the foreign conversation's own owner cannot reach across either.
		const fromForeign = await readGeneratedFileContent({
			userId: OTHER_USER,
			conversationId: "conv-foreign",
			filename: "secret.md",
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
});
