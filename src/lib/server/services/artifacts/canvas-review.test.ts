// A board's review state against a real in-memory database (ruling 63): what
// Alfy's change left waiting for the reader, that it survives a reload because
// it is derived from the versions and the marker on the artifact's own
// metadata, that Keep moves the marker, and that nobody else's board answers.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { BoardOp } from "$lib/shared/artifacts/board-ops";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	acknowledgeArtifactReview,
	applyArtifactOps,
	createArtifact,
	getArtifactReviewState,
	listArtifactsForConversation,
	listVersions,
	saveCanvasBoard,
} = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

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

const MOVE: BoardOp = { op: "move", id: "note-museum", to: { x: 700, y: 90 } };
const RETITLE: BoardOp = {
	op: "update_node",
	id: "text-1",
	data: { text: "Weekend plan (updated)" },
};
const HIGHLIGHT: BoardOp = { op: "highlight", ids: ["note-museum"] };

async function board(conversationId = CONVERSATION) {
	const created = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(sampleBoard()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

async function alfyChange(
	artifactId: string,
	ops: BoardOp[],
	summary = "Planned Sunday",
	conversationId: string | null = CONVERSATION,
) {
	const [newest] = await listVersions({
		userId: OWNER,
		artifactId,
		conversationId,
		limit: 1,
	});
	const result = await applyArtifactOps({
		userId: OWNER,
		artifactId,
		conversationId,
		payload: { baseVersionId: newest.id, diff: { id: "d", summary, ops } },
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
}

async function readerSaves(artifactId: string, ops: BoardOp[]) {
	const current = memory.db
		.select({ body: schema.artifacts.contentText })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.get();
	const parsed = JSON.parse(current?.body ?? "{}");
	// The reader moves one block: enough to be a version of their own.
	for (const op of ops) {
		if (op.op === "move") {
			const node = parsed.nodes.find((n: { id: string }) => n.id === op.id);
			node.position = op.to;
		}
	}
	const saved = await saveCanvasBoard({
		userId: OWNER,
		artifactId,
		conversationId: CONVERSATION,
		body: JSON.stringify(parsed),
		author: "user",
		summary: "Edited",
		coalesceUserEdits: false,
	});
	if (!saved.ok) throw new Error(saved.reason);
}

async function reviewOf(
	artifactId: string,
	options: { userId?: string; conversationId?: string | null } = {},
) {
	return getArtifactReviewState({
		userId: options.userId ?? OWNER,
		artifactId,
		conversationId:
			options.conversationId === undefined
				? CONVERSATION
				: options.conversationId,
	});
}

describe("what Alfy's change left for the reader, read again after a reload", () => {
	it("is nothing for a board Alfy never edited: no marker, so it is not a candidate", async () => {
		const id = await board();
		const result = await reviewOf(id);
		expect(result).toMatchObject({ ok: true, kind: "canvas" });
		if (!result.ok || result.kind !== "canvas") throw new Error("kind");
		expect(result.review.count).toBe(0);
	});

	it("is the blocks the change touched, with Undo offered and the version it goes back to", async () => {
		const id = await board();
		await alfyChange(id, [MOVE, RETITLE]);
		const result = await reviewOf(id);
		if (!result.ok || result.kind !== "canvas") throw new Error("kind");
		expect(result.review.touchedIds).toEqual(["note-museum", "text-1"]);
		expect(result.review.count).toBe(2);
		expect(result.review.changes[0]).toMatchObject({
			versionNumber: 2,
			summary: "Planned Sunday",
		});
		expect(result.review.undo).toEqual({ available: true, toVersion: 1 });
		expect(result.review.latestAlfyVersion).toBe(2);
	});

	it("does not wait for a highlight: it writes no version and no marker", async () => {
		const id = await board();
		const result = await alfyChange(id, [HIGHLIGHT]);
		expect(result.changed).toBe(false);
		const review = await reviewOf(id);
		if (!review.ok || review.kind !== "canvas") throw new Error("kind");
		expect(review.review.count).toBe(0);
	});

	it("keeps a change waiting while the reader works elsewhere, and stops offering Undo", async () => {
		const id = await board();
		await alfyChange(id, [MOVE]);
		await readerSaves(id, [{ op: "move", id: "todo-1", to: { x: 5, y: 5 } }]);
		const review = await reviewOf(id);
		if (!review.ok || review.kind !== "canvas") throw new Error("kind");
		expect(review.review.touchedIds).toEqual(["note-museum"]);
		expect(review.review.undo).toEqual({
			available: false,
			reason: "user_edited",
		});
	});
});

describe("Keep", () => {
	it("moves the marker past the change: a later read finds nothing waiting", async () => {
		const id = await board();
		await alfyChange(id, [MOVE]);
		const kept = await acknowledgeArtifactReview({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			throughVersion: 2,
		});
		if (!kept.ok || kept.kind !== "canvas") throw new Error("kind");
		expect(kept.review.count).toBe(0);

		const reload = await reviewOf(id);
		if (!reload.ok || reload.kind !== "canvas") throw new Error("kind");
		expect(reload.review.count).toBe(0);
		const row = memory.db
			.select({ metadataJson: schema.artifacts.metadataJson })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, id))
			.get();
		expect(JSON.parse(row?.metadataJson ?? "{}").review).toEqual({
			throughVersion: 2,
			keptBlockIds: [],
		});
	});

	it("never moves the marker past an Alfy version, whatever number it is asked for", async () => {
		const id = await board();
		await alfyChange(id, [MOVE]);
		await readerSaves(id, [{ op: "move", id: "todo-1", to: { x: 5, y: 5 } }]);
		const kept = await acknowledgeArtifactReview({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			throughVersion: 99,
		});
		if (!kept.ok || kept.kind !== "canvas") throw new Error("kind");
		const row = memory.db
			.select({ metadataJson: schema.artifacts.metadataJson })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, id))
			.get();
		// Version 3 is the reader's: the marker stays on Alfy's version 2.
		expect(JSON.parse(row?.metadataJson ?? "{}").review.throughVersion).toBe(2);
	});

	it("never moves the marker back, and leaves a change Alfy made after the Keep waiting", async () => {
		const id = await board();
		await alfyChange(id, [MOVE]);
		await acknowledgeArtifactReview({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			throughVersion: 2,
		});
		await alfyChange(id, [RETITLE], "Retitled");
		// A stale Keep for the first change must not swallow the second.
		const stale = await acknowledgeArtifactReview({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			throughVersion: 2,
		});
		if (!stale.ok || stale.kind !== "canvas") throw new Error("kind");
		expect(stale.review.touchedIds).toEqual(["text-1"]);
		expect(stale.review.changes[0].summary).toBe("Retitled");
	});
});

describe("the count on the chat's card, the list's row and the count button", () => {
	it("is on a board Alfy changed, is 0 once it is kept, and is absent for a board Alfy never edited", async () => {
		const edited = await board();
		const untouched = await board();
		await alfyChange(edited, [MOVE, RETITLE]);

		const before = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});
		const rowOf = (rows: typeof before, id: string) =>
			rows.find((row) => row.id === id);
		expect(rowOf(before, edited)?.pendingReviewCount).toBe(2);
		expect(rowOf(before, untouched)?.pendingReviewCount).toBeUndefined();

		await acknowledgeArtifactReview({
			userId: OWNER,
			artifactId: edited,
			conversationId: CONVERSATION,
			throughVersion: 2,
		});
		const after = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});
		expect(rowOf(after, edited)?.pendingReviewCount).toBe(0);
	});
});

describe("who may ask", () => {
	it("answers a foreign board and a missing one alike", async () => {
		const id = await board();
		await alfyChange(id, [MOVE]);
		const foreign = await reviewOf(id, { userId: STRANGER });
		const missing = await reviewOf("no-such-board");
		expect(foreign).toEqual({ ok: false, reason: "not_found" });
		expect(missing).toEqual({ ok: false, reason: "not_found" });
		const keep = await acknowledgeArtifactReview({
			userId: STRANGER,
			artifactId: id,
			conversationId: CONVERSATION,
			throughVersion: 2,
		});
		expect(keep).toEqual({ ok: false, reason: "not_found" });
		// And the stranger's Keep changed nothing.
		const still = await reviewOf(id);
		if (!still.ok || still.kind !== "canvas") throw new Error("kind");
		expect(still.review.count).toBe(1);
	});

	it("reads an incognito conversation's board only from that conversation", async () => {
		const id = await board(INCOGNITO);
		await alfyChange(id, [MOVE], "Planned", INCOGNITO);
		expect(await reviewOf(id, { conversationId: null })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await reviewOf(id, { conversationId: CONVERSATION })).toEqual({
			ok: false,
			reason: "not_found",
		});
		const inside = await reviewOf(id, { conversationId: INCOGNITO });
		expect(inside.ok).toBe(true);
	});
});
