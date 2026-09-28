// Ruling 61's first point: a pending Alfy change survives a reload.
// `computePendingReviewBlocks` is pure (no DB) — tested directly with
// hand-built version rows. `getDocumentReviewState`/
// `acknowledgeDocumentReviewBlocks` are tested against a real in-memory DB,
// the same shape every other artifacts-service suite uses, for ownership,
// incognito and the marker's own bootstrap-on-first-Alfy-edit write.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { PatchOp, PatchSet } from "$lib/shared/artifact-document/patch";
import { seedConversation, seedUser } from "./artifacts.test-helpers";
import { computePendingReviewBlocks } from "./document-ops";

// ---------------------------------------------------------------------------
// computePendingReviewBlocks — pure, no DB.
// ---------------------------------------------------------------------------

describe("computePendingReviewBlocks", () => {
	it("no marker yet: nothing is pending", () => {
		const pending = computePendingReviewBlocks(
			0,
			[],
			[{ versionNumber: 1, author: "user", body: "<!--b:p1-->\nHello." }],
		);
		expect(pending).toEqual([]);
	});

	it("the artifact's own creation is never pending, even when Alfy wrote it", () => {
		// A marker sitting right at version 1 (the creation) can never see a
		// parent to diff version 1 against — `ordered` (versionNumber >
		// throughVersion) is empty.
		const pending = computePendingReviewBlocks(
			1,
			[],
			[{ versionNumber: 1, author: "alfy", body: "<!--b:p1-->\nHello." }],
		);
		expect(pending).toEqual([]);
	});

	it("one Alfy version past the marker: the changed block is pending, with the parent's own text to undo to", () => {
		const pending = computePendingReviewBlocks(
			1,
			[],
			[
				{ versionNumber: 1, author: "user", body: "<!--b:p1-->\nHello." },
				{ versionNumber: 2, author: "alfy", body: "<!--b:p1-->\nHello there." },
			],
		);
		expect(pending).toEqual([
			{
				blockId: "p1",
				blockLabel: "Hello there.",
				previousMarkdown: "Hello.",
				isNewBlock: false,
				alfyVersionNumber: 2,
			},
		]);
	});

	it("multiple Alfy versions touching different blocks: both are pending, ordered by which version made them", () => {
		const pending = computePendingReviewBlocks(
			1,
			[],
			[
				{
					versionNumber: 1,
					author: "user",
					body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond.",
				},
				{
					versionNumber: 2,
					author: "alfy",
					body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond.",
				},
				{
					versionNumber: 3,
					author: "alfy",
					body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond, edited.",
				},
			],
		);
		expect(pending.map((p) => p.blockId)).toEqual(["p1", "p2"]);
		expect(pending[0]).toMatchObject({ blockId: "p1", alfyVersionNumber: 2 });
		expect(pending[1]).toMatchObject({ blockId: "p2", alfyVersionNumber: 3 });
	});

	it("partial keep: an already-kept block id drops out, the other stays pending", () => {
		const versions = [
			{
				versionNumber: 1,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond.",
			},
			{
				versionNumber: 2,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond, edited.",
			},
		];
		const pending = computePendingReviewBlocks(1, ["p1"], versions);
		expect(pending.map((p) => p.blockId)).toEqual(["p2"]);
	});

	it("a user edit to the same block in a later version acknowledges it automatically", () => {
		const versions = [
			{
				versionNumber: 1,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst.",
			},
			{
				versionNumber: 2,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited by Alfy.",
			},
			{
				versionNumber: 3,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst, edited by the user instead.",
			},
		];
		const pending = computePendingReviewBlocks(1, [], versions);
		expect(pending).toEqual([]);
	});

	it("a block deleted in a later version is excluded — nothing left to review", () => {
		const versions = [
			{
				versionNumber: 1,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nSecond.",
			},
			{
				versionNumber: 2,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond.",
			},
			// The user deletes exactly the block Alfy changed (p1); p2 was never
			// touched by Alfy and stays out of the pending set either way.
			{
				versionNumber: 3,
				author: "user" as const,
				body: "<!--b:p2-->\nSecond.",
			},
		];
		const pending = computePendingReviewBlocks(1, [], versions);
		expect(pending).toEqual([]);
	});

	it("a block Alfy added (no parent counterpart) is pending as a new block, undo-by-delete", () => {
		const versions = [
			{
				versionNumber: 1,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst.",
			},
			{
				versionNumber: 2,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst.\n\n<!--b:p2-->\nA new section.",
			},
		];
		const pending = computePendingReviewBlocks(1, [], versions);
		expect(pending).toEqual([
			{
				blockId: "p2",
				blockLabel: "A new section.",
				previousMarkdown: "",
				isNewBlock: true,
				alfyVersionNumber: 2,
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// getDocumentReviewState / acknowledgeDocumentReviewBlocks — real DB.
// ---------------------------------------------------------------------------

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	acknowledgeDocumentReviewBlocks,
	applyDocumentPatch,
	createDocumentArtifact,
	getDocumentReviewState,
	readDocumentForAlfy,
} = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

function readMetadata(artifactId: string): Record<string, unknown> {
	const row = memory.db
		.select({ metadataJson: schema.artifacts.metadataJson })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.get();
	return row?.metadataJson ? JSON.parse(row.metadataJson) : {};
}

async function createDocument(conversationId = CONVERSATION) {
	const artifact = await createDocumentArtifact({
		userId: OWNER,
		conversationId,
		title: "Trip plan",
		markdown: "First paragraph.",
		author: "user",
		summary: "Created",
	});
	return artifact;
}

/**
 * `readDocumentForAlfy` first — exactly the real flow (Alfy reads before it
 * patches) — so the patch snapshot it writes is what `applyPatchSet` checks
 * the op's `baseHash` against; a `replaceBlock` op built straight from the
 * artifact's OWN stored body (never read) is refused `block_unseen`, the same
 * way `patch.test.ts` documents.
 */
async function readFirstBlock(
	artifactId: string,
	conversationId?: string,
): Promise<{ id: string; hash: string }> {
	const doc = await readDocumentForAlfy({
		userId: OWNER,
		artifactId,
		conversationId,
	});
	const [block] = doc.blocks;
	if (!block) throw new Error("document has no blocks");
	return { id: block.blockId, hash: block.hash };
}

function replaceBlockPatch(
	blockId: string,
	baseHash: string,
	text: string,
): PatchSet {
	const op: PatchOp = {
		opId: `op-${blockId}-${text}`,
		kind: "replaceBlock",
		blockId,
		baseHash,
		blockLabel: "block",
		text,
	};
	return { patchId: `patch-${blockId}-${text}`, label: "Edited", ops: [op] };
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
});

afterEach(() => {
	memory.close();
});

describe("getDocumentReviewState", () => {
	it("no marker yet on a freshly created document: nothing pending", async () => {
		const artifact = await createDocument();
		const result = await getDocumentReviewState({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(result).toEqual({ ok: true, pending: [] });
	});

	it("a foreign or missing artifact 404s the same way", async () => {
		const artifact = await createDocument();
		const foreign = await getDocumentReviewState({
			userId: STRANGER,
			artifactId: artifact.id,
		});
		const missing = await getDocumentReviewState({
			userId: OWNER,
			artifactId: "does-not-exist",
		});
		expect(foreign).toEqual({ ok: false, reason: "not_found" });
		expect(missing).toEqual({ ok: false, reason: "not_found" });
	});

	it("an incognito artifact is invisible without its own conversation named, visible with it", async () => {
		const artifact = await createDocument(INCOGNITO);
		const withoutScope = await getDocumentReviewState({
			userId: OWNER,
			artifactId: artifact.id,
		});
		const withScope = await getDocumentReviewState({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: INCOGNITO,
		});
		expect(withoutScope).toEqual({ ok: false, reason: "not_found" });
		expect(withScope).toEqual({ ok: true, pending: [] });
	});

	it("an Alfy edit writes the marker on the first landing, and the changed block shows up as pending", async () => {
		const artifact = await createDocument();
		expect(readMetadata(artifact.id).review).toBeUndefined();
		const block = await readFirstBlock(artifact.id);

		const patched = await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlockPatch(block.id, block.hash, "First, edited."),
		});
		expect(patched.ok).toBe(true);

		// The marker is the version BEFORE this Alfy edit — the creation (v1).
		expect(readMetadata(artifact.id).review).toEqual({
			throughVersion: 1,
			keptBlockIds: [],
		});

		const state = await getDocumentReviewState({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) throw new Error("unreachable");
		expect(state.pending).toHaveLength(1);
		expect(state.pending[0]).toMatchObject({
			blockId: block.id,
			isNewBlock: false,
			alfyVersionNumber: 2,
		});
	});

	it("a second Alfy edit does not move an already-bootstrapped marker", async () => {
		const artifact = await createDocument();
		const block = await readFirstBlock(artifact.id);
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlockPatch(block.id, block.hash, "First, edited."),
		});
		const afterFirst = readMetadata(artifact.id).review;

		// Alfy reads again before its second edit — a fresh snapshot of the
		// now-edited body, exactly like the real tool-call flow.
		const blockAgain = await readFirstBlock(artifact.id);
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlockPatch(
				blockAgain.id,
				blockAgain.hash,
				"First, edited again.",
			),
		});
		expect(readMetadata(artifact.id).review).toEqual(afterFirst);
	});
});

describe("acknowledgeDocumentReviewBlocks", () => {
	it("keeping the only pending block empties the pending set, advances the marker, and clears the kept list", async () => {
		const artifact = await createDocument();
		const block = await readFirstBlock(artifact.id);
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlockPatch(block.id, block.hash, "First, edited."),
		});

		const result = await acknowledgeDocumentReviewBlocks({
			userId: OWNER,
			artifactId: artifact.id,
			blockIds: [block.id],
		});
		expect(result).toEqual({ ok: true, pending: [] });
		expect(readMetadata(artifact.id).review).toEqual({
			throughVersion: 2,
			keptBlockIds: [],
		});
	});

	it("a foreign artifact 404s the same way as a missing one", async () => {
		const artifact = await createDocument();
		const foreign = await acknowledgeDocumentReviewBlocks({
			userId: STRANGER,
			artifactId: artifact.id,
			blockIds: ["p1"],
		});
		const missing = await acknowledgeDocumentReviewBlocks({
			userId: OWNER,
			artifactId: "does-not-exist",
			blockIds: ["p1"],
		});
		expect(foreign).toEqual({ ok: false, reason: "not_found" });
		expect(missing).toEqual({ ok: false, reason: "not_found" });
	});

	it("an incognito artifact only acknowledges through its own conversation", async () => {
		const artifact = await createDocument(INCOGNITO);
		const block = await readFirstBlock(artifact.id, INCOGNITO);
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: INCOGNITO,
			patch: replaceBlockPatch(block.id, block.hash, "First, edited."),
		});
		const withoutScope = await acknowledgeDocumentReviewBlocks({
			userId: OWNER,
			artifactId: artifact.id,
			blockIds: [block.id],
		});
		expect(withoutScope).toEqual({ ok: false, reason: "not_found" });

		const withScope = await acknowledgeDocumentReviewBlocks({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: INCOGNITO,
			blockIds: [block.id],
		});
		expect(withScope).toEqual({ ok: true, pending: [] });
	});
});
