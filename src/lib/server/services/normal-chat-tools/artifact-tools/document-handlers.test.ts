/**
 * The Document entries in the three artifact tools' dispatch seams (Feature
 * 2 · Artifacts, Slice 1, Task T4 — landed once Slice 5a's seam and ruling
 * 53's abort/read-bound/per-turn-cap follow-up merged). Against a real,
 * migrated database, like `tests/integration/artifact-document.test.ts`: the
 * point of this file is that create_artifact → read_artifact → edit_artifact
 * work end to end through the SAME registries the model actually calls, and
 * that "your words win" survives the trip through this seam, not just
 * through `document-ops.ts` directly.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	conversations,
	users,
} from "$lib/server/db/schema";
import { getArtifact, saveDocumentBody } from "$lib/server/services/artifacts";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import { CREATE_ARTIFACT_HANDLERS } from "./create";
import { EDIT_ARTIFACT_HANDLERS, runEditArtifactTool } from "./edit";
import { READ_ARTIFACT_HANDLERS } from "./read";

const NOW = new Date("2026-09-26T12:00:00.000Z");

let userId: string;
let conversationId: string;

function seedUser(id: string) {
	db.insert(users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, ownerId: string) {
	db.insert(conversations)
		.values({
			id,
			userId: ownerId,
			title: "Trip",
			memoryIncognito: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

beforeEach(() => {
	userId = `user-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	seedUser(userId);
	seedConversation(conversationId, userId);
});

function abortSignal(aborted = false): AbortSignal {
	const controller = new AbortController();
	if (aborted) controller.abort();
	return controller.signal;
}

describe("create_artifact.document", () => {
	it("creates a document with mint-before-hash ids and reports the title back", async () => {
		const handler = CREATE_ARTIFACT_HANDLERS.document;
		expect(handler).toBeDefined();

		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Saturday plan",
			body: "# Saturday\n\nMuseum in the morning.",
			language: "en",
			abortSignal: abortSignal(),
		});

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.value.title).toBe("Saturday plan");
			expect(result.value.artifactId.length).toBeGreaterThan(0);
		}
	});

	it("writes nothing and refuses when the signal is already aborted", async () => {
		const handler = CREATE_ARTIFACT_HANDLERS.document;
		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Should not exist",
			body: "text",
			language: "en",
			abortSignal: abortSignal(true),
		});
		expect(result?.ok).toBe(false);
	});
});

describe("read_artifact.document", () => {
	async function createDoc(markdown: string) {
		const created = await CREATE_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Saturday plan",
			body: markdown,
			language: "en",
			abortSignal: abortSignal(),
		});
		if (!created?.ok) throw new Error("setup: create failed");
		return created.value.artifactId;
	}

	it("returns marker-free blocks with blockId/kind/label/hash/text", async () => {
		const artifactId = await createDoc("# Saturday\n\nMuseum in the morning.");
		const handler = READ_ARTIFACT_HANDLERS.document;

		const result = await handler?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(),
		});

		expect(result?.blocks?.length).toBeGreaterThan(0);
		expect(result?.body).toBeUndefined();
		for (const block of result?.blocks ?? []) {
			expect(String(block.text)).not.toContain("<!--b:");
			expect(String(block.blockId).length).toBeGreaterThan(0);
			expect(String(block.hash).length).toBeGreaterThan(0);
		}
	});

	it("'full' detail also concatenates the blocks into one body string", async () => {
		const artifactId = await createDoc("First paragraph.\n\nSecond paragraph.");
		const handler = READ_ARTIFACT_HANDLERS.document;

		const result = await handler?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "full",
			abortSignal: abortSignal(),
		});

		expect(result?.body).toContain("First paragraph.");
		expect(result?.body).toContain("Second paragraph.");
	});
});

describe("edit_artifact.document", () => {
	async function createDoc(markdown: string) {
		const created = await CREATE_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Saturday plan",
			body: markdown,
			language: "en",
			abortSignal: abortSignal(),
		});
		if (!created?.ok) throw new Error("setup: create failed");
		return created.value.artifactId;
	}

	it("applies a well-formed replaceBlock patch and returns a real versionId", async () => {
		const artifactId = await createDoc("First paragraph.");
		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [block] = read?.blocks ?? [];

		const handler = EDIT_ARTIFACT_HANDLERS.document;
		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			title: "Saturday plan",
			patches: [
				{
					op: "replaceBlock",
					blockId: block?.blockId,
					baseHash: block?.hash,
					text: "Alfy's rewrite.",
				},
			],
			abortSignal: abortSignal(),
		});

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.value.applied).toBe(1);
			expect(result.value.refused).toHaveLength(0);
			expect(result.value.versionId.length).toBeGreaterThan(0);
		}
	});

	it("rejects a malformed patch (missing baseHash) without touching the document", async () => {
		const artifactId = await createDoc("First paragraph.");
		const handler = EDIT_ARTIFACT_HANDLERS.document;

		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			title: "Saturday plan",
			patches: [{ op: "replaceBlock", blockId: "p1", text: "x" }],
			abortSignal: abortSignal(),
		});

		expect(result?.ok).toBe(false);
	});

	// [trap] "your words win", proven through the SAME seam the model calls —
	// not just through document-ops.ts directly (tests/integration and
	// editor-server-refusal.test.ts already prove the engine and the real
	// editor; this proves the TOOL adapter passes the guard through intact,
	// with the right refusal reason AND the block's real current label).
	it("refuses block_changed after a user edit, naming the CURRENT label, not a stale one", async () => {
		const artifactId = await createDoc("Original text.");
		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [block] = read?.blocks ?? [];

		// The user edits the same block directly after Alfy's read.
		const artifact = await getArtifact({ userId, artifactId, conversationId });
		const parsed = parseDocument(artifact?.body ?? "", { mint: false });
		const edited = parsed.blocks.map((b) =>
			b.id === block?.blockId
				? { ...b, markdown: "The user changed this." }
				: b,
		);
		await saveDocumentBody({
			userId,
			artifactId,
			body: { markdown: serializeDocument(edited), tabs: [] },
			author: "user",
			summary: "the user's edit",
		});

		const handler = EDIT_ARTIFACT_HANDLERS.document;
		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			title: "Saturday plan",
			patches: [
				{
					op: "replaceBlock",
					blockId: block?.blockId,
					baseHash: block?.hash,
					text: "Alfy's stale change",
				},
			],
			abortSignal: abortSignal(),
		});

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.value.applied).toBe(0);
			expect(result.value.refused).toHaveLength(1);
			expect(result.value.refused[0].reason).toBe("block_changed");
			// The label names what is REALLY there now, not the pre-edit label.
			expect(result.value.refused[0].label).toContain("changed");
		}
	});

	it("writes nothing when the signal is already aborted", async () => {
		const artifactId = await createDoc("First paragraph.");
		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [block] = read?.blocks ?? [];

		const handler = EDIT_ARTIFACT_HANDLERS.document;
		const result = await handler?.({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			title: "Saturday plan",
			patches: [
				{
					op: "replaceBlock",
					blockId: block?.blockId,
					baseHash: block?.hash,
					text: "nope",
				},
			],
			abortSignal: abortSignal(true),
		});

		expect(result?.ok).toBe(false);
	});
});

// RV-1A (independent review of Slice 1): red before its fix; the review file
// (docs/plans/claude-at-home-2/review-1a.md) quotes the failing line.
describe("RV-1A: edit_artifact's tool-call metadata names each refused op", () => {
	it("tells the applied op from the refused one when both touch the same block", async () => {
		const created = await CREATE_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			language: "en",
			turnId: "turn-1",
			title: "Saturday plan",
			body: "Book the flight to Vienna.",
			abortSignal: abortSignal(),
		});
		if (!created?.ok) throw new Error("setup: create failed");
		const artifactId = created.value.artifactId;
		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const block = read?.blocks?.[0] as { blockId: string; hash: string };

		const run = await runEditArtifactTool({
			userId,
			conversationId,
			turnId: "turn-2",
			artifactId,
			patches: [
				{
					op: "replaceRange",
					blockId: block.blockId,
					baseHash: block.hash,
					find: "Rome",
					text: "Paris",
				},
				{
					op: "replaceRange",
					blockId: block.blockId,
					baseHash: block.hash,
					find: "Vienna",
					text: "Budapest",
				},
			],
			summary: "Fix the destination",
			abortSignal: abortSignal(),
		});

		// The open panel rebuilds its marks from exactly these two fields.
		expect(run.metadata.appliedCount).toBe(1);
		expect(JSON.parse(String(run.metadata.refusedBlocksJson))).toEqual([
			{ blockId: block.blockId, reason: "find_not_found", opIndex: 0 },
		]);
	});
});

describe("RV-1A: read_artifact on a Document writes nothing once aborted", () => {
	it("records no snapshot after the signal fired (ruling 53: a handler checks it before any write)", async () => {
		const created = await CREATE_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			language: "en",
			turnId: "turn-1",
			title: "Saturday plan",
			body: "First paragraph.",
			abortSignal: abortSignal(),
		});
		if (!created?.ok) throw new Error("setup: create failed");
		const artifactId = created.value.artifactId;

		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Saturday plan",
			detail: "blocks",
			abortSignal: abortSignal(true),
		});

		expect(read?.blocks).toBeUndefined();
		expect(
			db
				.select({ id: artifactKv.id })
				.from(artifactKv)
				.where(eq(artifactKv.artifactId, artifactId))
				.all(),
		).toEqual([]);
	});
});

// Ruling 47 through the SAME seam the model calls: every Alfy change always
// appends a new version, never merges into the latest one — proven here at
// the create_artifact/read_artifact/edit_artifact registry level, not just
// through document-ops.ts (tests/integration/artifact-document.test.ts) or
// updateArtifactBody directly (record.test.ts). A dev incident reported the
// stored body moving to the edited text while `artifact_versions` still held
// only one row; these pin the version count and each row's author/body so a
// regression here fails loudly instead of only showing up as a lost History
// entry.
describe("ruling 47: edit_artifact always appends, through the tool-handler seam", () => {
	function rawContentText(artifactId: string): string {
		return (
			db
				.select({ contentText: artifacts.contentText })
				.from(artifacts)
				.where(eq(artifacts.id, artifactId))
				.get()?.contentText ?? ""
		);
	}

	function versionRows(artifactId: string) {
		return db
			.select({
				versionNumber: artifactVersions.versionNumber,
				author: artifactVersions.author,
				body: artifactVersions.body,
			})
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, artifactId))
			.orderBy(artifactVersions.versionNumber)
			.all();
	}

	async function createDoc(markdown: string) {
		const created = await CREATE_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Vienna weekend packing checklist",
			body: markdown,
			language: "en",
			abortSignal: abortSignal(),
		});
		if (!created?.ok) throw new Error("setup: create failed");
		return created.value.artifactId;
	}

	it("create_artifact -> read_artifact -> edit_artifact with a valid patch appends v2; v1's body is untouched", async () => {
		const artifactId = await createDoc("Alpha.\n\nBeta.");
		const originalBody = rawContentText(artifactId);

		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Vienna weekend packing checklist",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [block] = read?.blocks ?? [];

		const result = await EDIT_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			turnId: "turn-2",
			artifactId,
			title: "Vienna weekend packing checklist",
			patches: [
				{
					op: "replaceBlock",
					blockId: block?.blockId,
					baseHash: block?.hash,
					text: "Alpha, edited by Alfy.",
				},
			],
			abortSignal: abortSignal(),
		});
		expect(result?.ok).toBe(true);

		const rows = versionRows(artifactId);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			versionNumber: 1,
			author: "alfy",
			body: originalBody,
		});
		expect(rows[1].versionNumber).toBe(2);
		expect(rows[1].author).toBe("alfy");
		expect(rows[1].body).toContain("Alpha, edited by Alfy.");
		// v1's body must never move once v2 exists.
		expect(rows[0].body).toBe(originalBody);
	});

	it("a stale-body retry inside the guarded write still appends exactly one new version per edit", async () => {
		const artifactId = await createDoc("Alpha.\n\nBeta.");
		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Vienna weekend packing checklist",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [alpha, beta] = read?.blocks ?? [];

		// Two edit_artifact calls landing together (the AI SDK runs a step's
		// tool calls concurrently): the second write to actually land finds the
		// body it read is now stale and must re-read/re-apply/re-write inside
		// applyDocumentPatch's guarded loop (de36f4ce) rather than clobbering
		// the first edit or minting two versions for one logical call.
		const [first, second] = await Promise.all([
			EDIT_ARTIFACT_HANDLERS.document?.({
				userId,
				conversationId,
				turnId: "turn-2",
				artifactId,
				title: "Vienna weekend packing checklist",
				patches: [
					{
						op: "replaceBlock",
						blockId: alpha?.blockId,
						baseHash: alpha?.hash,
						text: "Alpha changed.",
					},
				],
				abortSignal: abortSignal(),
			}),
			EDIT_ARTIFACT_HANDLERS.document?.({
				userId,
				conversationId,
				turnId: "turn-2",
				artifactId,
				title: "Vienna weekend packing checklist",
				patches: [
					{
						op: "replaceBlock",
						blockId: beta?.blockId,
						baseHash: beta?.hash,
						text: "Beta changed.",
					},
				],
				abortSignal: abortSignal(),
			}),
		]);

		expect(first?.ok && first.value.applied).toBe(1);
		expect(second?.ok && second.value.applied).toBe(1);

		// v1 (create) + one version per edit_artifact call — never fewer (a
		// clobber) and never more (a retry double-appending).
		const rows = versionRows(artifactId);
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.author)).toEqual(["alfy", "alfy", "alfy"]);
		const finalBody = rawContentText(artifactId);
		expect(finalBody).toContain("Alpha changed.");
		expect(finalBody).toContain("Beta changed.");
	});

	it("a user's save followed by an Alfy edit appends a version of its own — it never merges into the user's", async () => {
		const artifactId = await createDoc("Alpha.\n\nBeta.");

		const userSave = await saveDocumentBody({
			userId,
			artifactId,
			conversationId,
			body: { markdown: "Alpha, as the user wrote it.\n\nBeta.", tabs: [] },
			author: "user",
			summary: "Edited",
			coalesceUserEdits: true,
		});
		expect(userSave.ok && userSave.version).toBe(2);

		const read = await READ_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			artifactId,
			title: "Vienna weekend packing checklist",
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const beta = read?.blocks?.[1];

		const edit = await EDIT_ARTIFACT_HANDLERS.document?.({
			userId,
			conversationId,
			turnId: "turn-2",
			artifactId,
			title: "Vienna weekend packing checklist",
			patches: [
				{
					op: "replaceBlock",
					blockId: beta?.blockId,
					baseHash: beta?.hash,
					text: "Beta, edited by Alfy.",
				},
			],
			abortSignal: abortSignal(),
		});
		expect(edit?.ok).toBe(true);

		const rows = versionRows(artifactId);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatchObject({ versionNumber: 2, author: "user" });
		expect(rows[1].body).toContain("Alpha, as the user wrote it.");
		expect(rows[2]).toMatchObject({ versionNumber: 3, author: "alfy" });
		expect(rows[2].body).toContain("Beta, edited by Alfy.");
	});
});
