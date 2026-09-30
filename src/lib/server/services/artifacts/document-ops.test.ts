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
import { EMPTY_TAB_ANCHOR_PLACEHOLDER } from "$lib/shared/artifact-document/blocks";
import type { PatchOp, PatchSet } from "$lib/shared/artifact-document/patch";
import { seedConversation, seedUser } from "./artifacts.test-helpers";
import {
	computePendingReviewBlocks,
	reviewMarkerPatchFor,
} from "./document-ops";

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
		// `"p1@2"`: kept as of version 2 — the same version that changed it, so
		// it is excluded (see the version-tie tests below for the opposite case).
		const pending = computePendingReviewBlocks(1, ["p1@2"], versions);
		expect(pending.map((p) => p.blockId)).toEqual(["p2"]);
	});

	it("a kept block id is tied to the version it was kept against — an older tie does not suppress a NEWER Alfy change to the same block", () => {
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
			// Alfy changes p1 again, after it was kept against version 2.
			{
				versionNumber: 3,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited again.\n\n<!--b:p2-->\nSecond, edited.",
			},
		];
		const pending = computePendingReviewBlocks(1, ["p1@2"], versions);
		expect(pending.map((p) => p.blockId).sort()).toEqual(["p1", "p2"]);
		const p1 = pending.find((p) => p.blockId === "p1");
		expect(p1?.alfyVersionNumber).toBe(3);
		expect(p1?.previousMarkdown).toBe("First, edited.");
	});

	it("a kept block id tied to the CURRENT version still suppresses it when Alfy has not touched it again", () => {
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
			// Only p2 changes again; p1's hash is identical to its version-2 self.
			{
				versionNumber: 3,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited.\n\n<!--b:p2-->\nSecond, edited again.",
			},
		];
		const pending = computePendingReviewBlocks(1, ["p1@2"], versions);
		expect(pending.map((p) => p.blockId)).toEqual(["p2"]);
	});

	it("a legacy or malformed kept entry with no parseable @version reads as version 0, so it never permanently suppresses a real Alfy change", () => {
		const versions = [
			{
				versionNumber: 1,
				author: "user" as const,
				body: "<!--b:p1-->\nFirst.",
			},
			{
				versionNumber: 2,
				author: "alfy" as const,
				body: "<!--b:p1-->\nFirst, edited.",
			},
		];
		const pending = computePendingReviewBlocks(1, ["p1"], versions);
		expect(pending.map((p) => p.blockId)).toEqual(["p1"]);
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

/** Same as `replaceBlockPatch`, but for several blocks in one Alfy version. */
function replaceBlocksPatch(
	edits: { blockId: string; baseHash: string; text: string }[],
): PatchSet {
	const ops: PatchOp[] = edits.map((edit) => ({
		opId: `op-${edit.blockId}`,
		kind: "replaceBlock",
		blockId: edit.blockId,
		baseHash: edit.baseHash,
		blockLabel: "block",
		text: edit.text,
	}));
	return {
		patchId: `patch-${edits.map((e) => e.blockId).join("-")}`,
		label: "Edited",
		ops,
	};
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

	it("a kept block that Alfy changes again is pending again after that edit (ruling 61 persistence)", async () => {
		const artifact = await createDocumentArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			title: "Trip plan",
			markdown: "First paragraph.\n\nSecond paragraph.",
			author: "user",
			summary: "Created",
		});
		const doc = await readDocumentForAlfy({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
		});
		const [b1, b2] = doc.blocks;
		if (!b1 || !b2) throw new Error("expected two blocks");

		// Alfy edit A (version 2): changes both blocks.
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlocksPatch([
				{ blockId: b1.blockId, baseHash: b1.hash, text: "First, edited." },
				{ blockId: b2.blockId, baseHash: b2.hash, text: "Second, edited." },
			]),
		});

		// Keep b1 only — b2 stays pending.
		const afterKeep = await acknowledgeDocumentReviewBlocks({
			userId: OWNER,
			artifactId: artifact.id,
			blockIds: [b1.blockId],
		});
		expect(afterKeep.ok && afterKeep.pending.map((p) => p.blockId)).toEqual([
			b2.blockId,
		]);

		// Alfy edit B (version 3): changes b1 again, the SAME block just kept.
		const docAfterA = await readDocumentForAlfy({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
		});
		const b1AfterA = docAfterA.blocks.find((b) => b.blockId === b1.blockId);
		if (!b1AfterA) throw new Error("b1 missing after edit A");
		await applyDocumentPatch({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
			patch: replaceBlockPatch(
				b1AfterA.blockId,
				b1AfterA.hash,
				"First, edited again.",
			),
		});

		// Reload: both b1 (re-pending, tied to version 3 now) and b2 (still
		// pending from version 2) show up — the bug was b1 staying silently
		// "reviewed" forever because its kept id carried no version.
		const state = await getDocumentReviewState({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
		});
		expect(state.ok && state.pending.map((p) => p.blockId).sort()).toEqual(
			[b1.blockId, b2.blockId].sort(),
		);
	});

	it("acknowledging a block id that is not currently pending is ignored, not stored verbatim", async () => {
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
			blockIds: ["not-a-real-pending-block"],
		});
		expect(result.ok && result.pending.map((p) => p.blockId)).toEqual([
			block.id,
		]);
		// Nothing was written: the fabricated id never reached storage, and the
		// genuinely pending block was never named, so the marker never moves.
		expect(readMetadata(artifact.id).review).toEqual({
			throughVersion: 1,
			keptBlockIds: [],
		});
	});
});

// ---------------------------------------------------------------------------
// readDocumentForAlfy — the empty-tab placeholder never reaches Alfy
// (rd/review-2-5.md's fix-agent-B finding 7, verified by fix agent C).
// `appendEmptyTabSection` (document-editor.ts) writes a zero-width space as a
// brand-new, still-untouched tab's anchor paragraph — real content to the
// STORED body (it must survive `saveDocumentBody`'s own re-canonicalisation,
// or the whole-document tab bug returns), but `read_artifact` should show
// Alfy the empty section it visibly is, not one invisible character.
// ---------------------------------------------------------------------------

describe("readDocumentForAlfy — the empty-tab placeholder", () => {
	it("strips the zero-width-space placeholder from a still-empty new tab's block text", async () => {
		const artifact = await createDocumentArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			title: "Trip plan",
			markdown: `First paragraph.\n\n${EMPTY_TAB_ANCHOR_PLACEHOLDER}`,
			author: "user",
			summary: "Created",
		});

		const doc = await readDocumentForAlfy({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
		});

		expect(doc.blocks).toHaveLength(2);
		expect(doc.blocks[0].text).toBe("First paragraph.");
		expect(doc.blocks[1].text).toBe("");
		expect(JSON.stringify(doc)).not.toContain(EMPTY_TAB_ANCHOR_PLACEHOLDER);
	});

	it("only strips the exact placeholder character, leaving real text (and a placeholder mixed into real text) alone", async () => {
		const artifact = await createDocumentArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			title: "Trip plan",
			markdown: `Booked${EMPTY_TAB_ANCHOR_PLACEHOLDER} the hotel already.`,
			author: "user",
			summary: "Created",
		});

		const doc = await readDocumentForAlfy({
			userId: OWNER,
			artifactId: artifact.id,
			conversationId: CONVERSATION,
		});

		expect(doc.blocks[0].text).toBe("Booked the hotel already.");
	});
});

// RV-3 Minor 7: the review marker's bootstrap was written twice (the Document's
// patch and the board's ops envelope). One function says when an Alfy write
// starts a review and what it writes.
describe("reviewMarkerPatchFor — the marker the first Alfy write leaves behind (ruling 61)", () => {
	it("names the version the write lands on top of when the artifact has no marker yet", () => {
		expect(reviewMarkerPatchFor(null, 4)).toEqual({
			review: { throughVersion: 4, keptBlockIds: [] },
		});
		expect(reviewMarkerPatchFor({ title: "Plan" } as never, 1)).toEqual({
			review: { throughVersion: 1, keptBlockIds: [] },
		});
	});

	it("leaves a marker that exists alone, and reads a malformed one as no marker at all", () => {
		expect(
			reviewMarkerPatchFor(
				{ review: { throughVersion: 2, keptBlockIds: ["b@3"] } } as never,
				5,
			),
		).toBeUndefined();
		for (const review of [
			{ throughVersion: 0, keptBlockIds: [] },
			{ throughVersion: "2", keptBlockIds: [] },
			"nope",
			null,
		]) {
			expect(reviewMarkerPatchFor({ review } as never, 5)).toEqual({
				review: { throughVersion: 5, keptBlockIds: [] },
			});
		}
	});
});
