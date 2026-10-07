/**
 * Ruling 67 through the REAL tools (Feature 2 · Artifacts, RV-F I-1). The
 * `read_artifact` and `edit_artifact` called here are the two `createNormalChatTools`
 * hands the model: the real execution envelope, the real recorder, the real
 * database. The reader's saves are the ones the body route makes, which coalesce
 * into the newest version when it is theirs (ruling 47): the version's id stays,
 * its words change.
 *
 * `canvas-handlers.test.ts` saves with `coalesceUserEdits: false`, which the route
 * never does by default, so a guard that names the version the model read looked
 * sound there and was not: an edit judged against "the version I read" cannot tell
 * the board the model was shown from the one the reader has written over it since.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";
import {
	createArtifact,
	getArtifact,
	listVersions,
	saveCanvasBoard,
} from "$lib/server/services/artifacts";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { createNormalChatTools } from "../index";
import type { EditArtifactModelPayload } from "./edit";

const NOW = new Date("2026-10-07T09:00:00.000Z");
const READERS_WORDS = "Museum, 16:30 (the reader's)";
const ALFYS_WORDS = "Museum, 14:00 — Alfy's words";

let userId: string;
let conversationId: string;

beforeEach(() => {
	userId = `user-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	db.insert(users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(conversations)
		.values({
			id: conversationId,
			userId,
			title: "Trip",
			memoryIncognito: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

/** A board the reader left (author `user`, "Edited"): the newest version their own saves coalesce into. */
async function seedBoard(): Promise<string> {
	const made = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(sampleBoard()),
		author: "user",
		versionSummary: VERSION_SUMMARY.edited,
	});
	if (!made.ok) throw new Error(`setup: ${made.reason}`);
	return made.artifact.id;
}

async function storedBoard(artifactId: string): Promise<CanvasBody> {
	const record = await getArtifact({ userId, artifactId, conversationId });
	return JSON.parse(record?.body ?? "{}") as CanvasBody;
}

async function museumText(artifactId: string): Promise<string> {
	const node = (await storedBoard(artifactId)).nodes.find(
		(n) => n.id === "note-museum",
	);
	return node?.data.kind === "sticky" ? node.data.text : "";
}

async function versionIds(artifactId: string): Promise<string[]> {
	return (
		await listVersions({ userId, artifactId, conversationId, limit: 50 })
	).map((version) => version.id);
}

/** What the body route does with the reader's autosave: ruling 47's coalescing is its default. */
async function readerWrites(artifactId: string, text: string) {
	const board = await storedBoard(artifactId);
	const note = board.nodes.find((n) => n.id === "note-museum");
	if (!note) throw new Error("fixture");
	note.data = { kind: "sticky", text, tone: "mint" };
	const saved = await saveCanvasBoard({
		userId,
		artifactId,
		conversationId,
		body: JSON.stringify(board),
		author: "user",
		summary: VERSION_SUMMARY.edited,
		coalesceUserEdits: true,
	});
	if (!saved.ok) throw new Error(`setup: ${saved.reason}`);
}

/** One model turn's tools: the registry's own, with the recorder the turn would hold. */
function turn() {
	const { tools, getToolCalls } = createNormalChatTools({
		userId,
		conversationId,
		turnId: `turn-${randomUUID()}`,
	});
	const options = () => ({ toolCallId: `call-${randomUUID()}`, messages: [] });
	return {
		getToolCalls,
		read: (artifactId: string) =>
			tools.read_artifact.execute?.(
				{ artifactId, detail: "blocks" },
				options(),
			),
		edit: async (artifactId: string, ops: unknown[]) =>
			(await tools.edit_artifact.execute?.(
				{ artifactId, ops },
				options(),
			)) as EditArtifactModelPayload,
	};
}

const rewriteMuseum = {
	op: "update_node",
	id: "note-museum",
	data: { text: ALFYS_WORDS },
};
const moveLunch = { op: "move", id: "note-1", to: { x: 30, y: 70 } };

describe("edit_artifact on a board, through the real tools (ruling 67 × ruling 47)", () => {
	it("refuses an update to a note the reader rewrote after the read, though their save coalesced into the version the model read", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		const [readVersion] = await versionIds(id);

		await readerWrites(id, READERS_WORDS);
		// The premise: the reader's save is written INTO the version the model read.
		expect(await versionIds(id)).toEqual([readVersion]);

		const result = await alfy.edit(id, [rewriteMuseum, moveLunch]);

		expect(result).toMatchObject({
			success: true,
			applied: 1,
			refused: [{ target: "note-museum", reason: "stale", opIndex: 0 }],
		});
		expect(await museumText(id)).toBe(READERS_WORDS);
		expect(
			(await storedBoard(id)).nodes.find((n) => n.id === "note-1")?.position,
		).toEqual({ x: 30, y: 70 });
	});

	it("writes nothing when the only op was on the note the reader rewrote", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		await readerWrites(id, READERS_WORDS);
		const before = await versionIds(id);

		const result = await alfy.edit(id, [rewriteMuseum]);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.refused?.[0]).toMatchObject({
			target: "note-museum",
			reason: "stale",
		});
		expect(await museumText(id)).toBe(READERS_WORDS);
		expect(await versionIds(id)).toEqual(before);
	});

	it("still protects the reader's words when their save coalesced before the model's first edit, which was about something else", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		await readerWrites(id, READERS_WORDS);

		// The first edit lands on top of the reader's words. It is not something the
		// model has read, so what they wrote is still unseen by it...
		const first = await alfy.edit(id, [moveLunch]);
		expect(first.success).toBe(true);

		// ...and the next edit is still judged against the board it read.
		const second = await alfy.edit(id, [rewriteMuseum]);

		expect(second.success).toBe(false);
		expect(await museumText(id)).toBe(READERS_WORDS);
	});

	it("protects words the reader wrote after the model's own edit, too", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		const first = await alfy.edit(id, [moveLunch]);
		expect(first.success).toBe(true);

		// The newest version is Alfy's now, so this save is a version of its own.
		await readerWrites(id, READERS_WORDS);
		const second = await alfy.edit(id, [rewriteMuseum]);

		expect(second.success).toBe(false);
		expect(await museumText(id)).toBe(READERS_WORDS);
	});

	it("does not refuse the model for its own earlier edit: reading once and editing twice works", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		const first = await alfy.edit(id, [
			{ op: "move", id: "note-museum", to: { x: 700, y: 90 } },
		]);
		expect(first.success).toBe(true);

		const second = await alfy.edit(id, [
			rewriteMuseum,
			{ op: "move", id: "note-museum", to: { x: 720, y: 100 } },
		]);

		expect(second).toMatchObject({ success: true, applied: 2 });
		expect(await museumText(id)).toBe(ALFYS_WORDS);
	});

	it("judges against the board it read last: reading again takes in what the reader wrote", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		await readerWrites(id, READERS_WORDS);
		await alfy.read(id);

		const result = await alfy.edit(id, [rewriteMuseum]);

		expect(result).toMatchObject({ success: true, applied: 1 });
		expect(await museumText(id)).toBe(ALFYS_WORDS);
	});

	it("applies to the board as it is when the turn has not read it (the one-change review is the safeguard)", async () => {
		const id = await seedBoard();
		await readerWrites(id, READERS_WORDS);

		const result = await turn().edit(id, [rewriteMuseum]);

		expect(result).toMatchObject({ success: true, applied: 1 });
		expect(await museumText(id)).toBe(ALFYS_WORDS);
	});

	it("keeps the words it read out of the tool calls the turn records", async () => {
		const id = await seedBoard();
		const alfy = turn();
		await alfy.read(id);
		await alfy.edit(id, [moveLunch]);

		const metadata = JSON.stringify(
			alfy.getToolCalls().map((call) => call.metadata),
		);
		expect(metadata).not.toContain("Lunch at the market");
		expect(metadata).not.toContain("Museum, 14:00");
		expect(metadata).not.toContain('"nodes"');
	});
});
