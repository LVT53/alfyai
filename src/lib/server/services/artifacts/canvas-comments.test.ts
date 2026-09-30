import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

// Comments on a Canvas: what intake accepts (a board places node and point
// anchors, never a Document's text anchor) and the `@Alfy` reply's board branch.
// The comment table, the scope and the thread rules are the shared layer's
// (comments.test.ts); only what is a board's own is asserted here.

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

// The hook's own model call: the SAME `sendJsonControlMessage` seam the
// Document's reply uses, never a second one.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

const recordControlModelUsageMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../analytics", () => ({
	recordControlModelUsage: recordControlModelUsageMock,
}));

const { createArtifact, createComment, listComments } = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";

const NODE_ANCHOR: Anchor = { kind: "node", nodeId: "note-museum" };
const POINT_ANCHOR: Anchor = { kind: "point", x: 320.5, y: -12 };
const TEXT_ANCHOR: Anchor = {
	kind: "text",
	blockId: "b1",
	quote: "Naschmarkt",
	prefix: "then the ",
	suffix: ", and",
};

beforeEach(() => {
	sendJsonControlMessageMock.mockReset();
	recordControlModelUsageMock.mockClear();
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
});

afterEach(() => {
	memory.close();
});

async function createBoard(): Promise<string> {
	const created = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(sampleBoard()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

async function createDocument(): Promise<string> {
	const created = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "document",
		title: "Saturday plan",
		body: "Naschmarkt, then the Secession",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

function post(artifactId: string, anchor: Anchor | null, userId = OWNER) {
	return createComment({
		userId,
		artifactId,
		anchor,
		author: "user",
		body: "Is this still the plan?",
	});
}

describe("comment intake on a Canvas", () => {
	it("keeps a node anchor and a point anchor, and reads them back as they were placed", async () => {
		const boardId = await createBoard();
		const onNode = await post(boardId, NODE_ANCHOR);
		const onSpot = await post(boardId, POINT_ANCHOR);
		expect(onNode?.anchor).toEqual(NODE_ANCHOR);
		expect(onSpot?.anchor).toEqual(POINT_ANCHOR);
		const listed = await listComments({ userId: OWNER, artifactId: boardId });
		expect(listed.map((thread) => thread.anchor)).toEqual([
			NODE_ANCHOR,
			POINT_ANCHOR,
		]);
	});

	it("refuses a text anchor on a board: a Document's anchor is not one a board can place", async () => {
		const boardId = await createBoard();
		expect(await post(boardId, TEXT_ANCHOR)).toBeNull();
		expect(await post(boardId, null)).toBeNull();
		expect(await listComments({ userId: OWNER, artifactId: boardId })).toEqual(
			[],
		);
	});

	it("still lets a reply through: a reply has no anchor of its own, its thread has", async () => {
		const boardId = await createBoard();
		const root = await post(boardId, NODE_ANCHOR);
		const reply = await createComment({
			userId: OWNER,
			artifactId: boardId,
			anchor: null,
			author: "user",
			body: "Thanks",
			parentId: root?.id,
		});
		expect(reply?.parentId).toBe(root?.id);
	});

	it("keeps a text anchor and a node anchor on the same artifact without collision, on a Document", async () => {
		const documentId = await createDocument();
		expect(await post(documentId, TEXT_ANCHOR)).not.toBeNull();
		expect(await post(documentId, NODE_ANCHOR)).not.toBeNull();
		const listed = await listComments({
			userId: OWNER,
			artifactId: documentId,
		});
		expect(listed.map((thread) => thread.anchor?.kind)).toEqual([
			"text",
			"node",
		]);
	});

	it("refuses a comment on another user's board, as it would a board that is not there", async () => {
		const boardId = await createBoard();
		expect(await post(boardId, NODE_ANCHOR, STRANGER)).toBeNull();
		expect(await post("no-such-board", NODE_ANCHOR)).toBeNull();
	});
});
