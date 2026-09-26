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
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";
import { getArtifact, saveDocumentBody } from "$lib/server/services/artifacts";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import { CREATE_ARTIFACT_HANDLERS } from "./create";
import { EDIT_ARTIFACT_HANDLERS } from "./edit";
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
