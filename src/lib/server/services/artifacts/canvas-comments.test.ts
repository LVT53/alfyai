import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	ALFY_REFUSED_MARKER,
	splitSkippedOps,
} from "$lib/shared/artifact-document/alfy-reply";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { boardOpsArraySchema } from "$lib/shared/artifacts/board-ops";
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

const {
	createArtifact,
	createComment,
	getArtifact,
	listComments,
	listVersions,
	runAlfyCommentReply,
} = await import("./index");
const { EDIT_ARTIFACT_CANVAS_EXAMPLE, editArtifactRuleClause } = await import(
	"../normal-chat-tools/artifact-tools/kind-prose"
);

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

// ── @Alfy on a board ────────────────────────────────────────────────────────
// The model answers with a note and (optionally) ops in the exact schema the
// edit tool advertises; the ops go through the one envelope as ONE Alfy
// version; the reply lands in the thread; a refused op is named in it.

function modelSays(payload: unknown): void {
	sendJsonControlMessageMock.mockResolvedValueOnce({
		text: typeof payload === "string" ? payload : JSON.stringify(payload),
		rawResponse: {},
		modelId: "model1",
		modelDisplayName: "Test Model",
	});
}

const NEVER_ABORTS = new AbortController().signal;

async function askAbout(
	anchor: Anchor,
	body = "@Alfy make this a checklist of three items",
) {
	const boardId = await createBoard();
	const thread = await createComment({
		userId: OWNER,
		artifactId: boardId,
		anchor,
		author: "user",
		body,
	});
	if (!thread) throw new Error("thread refused");
	return { boardId, thread };
}

function run(
	boardId: string,
	commentId: string,
	abortSignal: AbortSignal = NEVER_ABORTS,
	userId = OWNER,
) {
	return runAlfyCommentReply({
		userId,
		artifactId: boardId,
		commentId,
		abortSignal,
	});
}

const CHANGE_MUSEUM = {
	op: "update_node",
	id: "note-museum",
	data: { text: "Museum, 15:30" },
};

async function storedNode(boardId: string, id: string) {
	const artifact = await getArtifact({ userId: OWNER, artifactId: boardId });
	const board = JSON.parse(artifact?.body ?? "{}") as {
		nodes: { id: string; data: Record<string, unknown> }[];
	};
	return board.nodes.find((node) => node.id === id);
}

describe("@Alfy on a board: a change", () => {
	it("lands the model's ops as one Alfy version, and answers in the thread with its note", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "Moved the time to 15:30.", ops: [CHANGE_MUSEUM] });

		const result = await run(boardId, thread.id);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			outcome: "applied",
			applied: 1,
			refused: 0,
		});
		expect((await storedNode(boardId, "note-museum"))?.data.text).toBe(
			"Museum, 15:30",
		);
		const versions = await listVersions({ userId: OWNER, artifactId: boardId });
		expect(versions).toHaveLength(2);
		expect(versions[0]).toMatchObject({
			author: "alfy",
			summary: "Alfy's comment reply",
		});
		expect(result.value.version).toBe(versions[0].versionNumber);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies).toHaveLength(1);
		expect(root.replies[0]).toMatchObject({
			author: "alfy",
			body: "Moved the time to 15:30.",
		});
	});

	it("takes a whole-thread @Alfy on a reply: the change is answered under the thread's root", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR, "Is 14:00 right?");
		const reply = await createComment({
			userId: OWNER,
			artifactId: boardId,
			anchor: null,
			author: "user",
			body: "@Alfy no, make it 15:30",
			parentId: thread.id,
		});
		modelSays({ note: "Done, 15:30.", ops: [CHANGE_MUSEUM] });

		const result = await run(boardId, reply?.id ?? "");

		expect(result.ok && result.value.outcome).toBe("applied");
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies.map((item) => item.author)).toEqual(["user", "alfy"]);
	});

	it("answers a thread on a spot as well as one on a block", async () => {
		const { boardId, thread } = await askAbout(
			POINT_ANCHOR,
			"@Alfy add a note here saying tram 4",
		);
		modelSays({
			note: "Added a note.",
			ops: [
				{
					op: "add_node",
					node: {
						id: "note-tram",
						type: "sticky",
						position: { x: 320, y: -12 },
						data: { kind: "sticky", text: "Tram 4", tone: "yellow" },
					},
				},
			],
		});
		const result = await run(boardId, thread.id);
		expect(result.ok && result.value.outcome).toBe("applied");
		expect((await storedNode(boardId, "note-tram"))?.data.text).toBe("Tram 4");
	});

	it("writes nothing and asks nothing of the model for a comment on a block that is gone", async () => {
		const { boardId, thread } = await askAbout({
			kind: "node",
			nodeId: "deleted",
		});
		const result = await run(boardId, thread.id);
		expect(result.ok && result.value.outcome).toBe("refused");
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies[0].body).toBe(ALFY_REFUSED_MARKER);
	});

	it("keeps what landed and names what was refused, when only some of the ops could be applied", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({
			note: "Changed the time and the title.",
			ops: [
				CHANGE_MUSEUM,
				{ op: "update_node", id: "no-such-note", data: { text: "x" } },
			],
		});

		const result = await run(boardId, thread.id);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			outcome: "applied",
			applied: 1,
			refused: 1,
		});
		expect((await storedNode(boardId, "note-museum"))?.data.text).toBe(
			"Museum, 15:30",
		);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		const named = splitSkippedOps(root.replies[0].body);
		expect(named.text).toBe("Changed the time and the title.");
		expect(named.skipped).toEqual([
			{ target: "no-such-note", reason: "unknown_id" },
		]);
		// Alfy's own words are not lost to the marker.
		expect(root.replies[0].body).toContain("Changed the time and the title.");
	});
});

describe("@Alfy on a board: a block that was replaced", () => {
	// A note cannot change kind in place, so making one a list is a remove and an add: the
	// thread that asked must not be left on a block that is gone.
	const REPLACE_WITH_CHECKLIST = [
		{ op: "remove_node", id: "note-museum" },
		{
			op: "add_node",
			node: {
				id: "checklist-museum",
				type: "checklist",
				position: { x: 500, y: 60 },
				data: {
					kind: "checklist",
					label: "Museum, 14:00",
					items: [
						{ id: "m1", text: "Buy tickets", done: false },
						{ id: "m2", text: "Check opening hours", done: false },
						{ id: "m3", text: "Plan route", done: false },
					],
				},
			},
		},
	];

	it("moves the thread to the one block that took its place, so the comment stays where it was left", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "Made it a checklist.", ops: REPLACE_WITH_CHECKLIST });

		const result = await run(boardId, thread.id);

		expect(result.ok && result.value.outcome).toBe("applied");
		expect(await storedNode(boardId, "note-museum")).toBeUndefined();
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.anchor).toEqual({ kind: "node", nodeId: "checklist-museum" });
		expect(root.replies[0].body).toBe("Made it a checklist.");
	});

	it("leaves the thread where it is when the block it was on is not the one removed", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({
			note: "Added one beside it.",
			ops: [REPLACE_WITH_CHECKLIST[1]],
		});
		await run(boardId, thread.id);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.anchor).toEqual(NODE_ANCHOR);
	});

	it("does not guess when more than one block was added: which one took its place is not known", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		const second = {
			op: "add_node",
			node: {
				id: "note-extra",
				type: "sticky",
				position: { x: 700, y: 60 },
				data: { kind: "sticky", text: "Extra", tone: "plain" },
			},
		};
		modelSays({
			note: "Replaced it with two.",
			ops: [...REPLACE_WITH_CHECKLIST, second],
		});
		await run(boardId, thread.id);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.anchor).toEqual(NODE_ANCHOR);
	});

	it("does not follow a block that was only asked about, not changed", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "It is at 14:00." });
		await run(boardId, thread.id);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.anchor).toEqual(NODE_ANCHOR);
	});

	it("leaves a spot where it was left: a spot has no block to follow", async () => {
		const { boardId, thread } = await askAbout(POINT_ANCHOR, "@Alfy tidy up");
		modelSays({ note: "Done.", ops: REPLACE_WITH_CHECKLIST });
		await run(boardId, thread.id);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.anchor).toEqual(POINT_ANCHOR);
	});
});

describe("@Alfy on a board: no change", () => {
	it("answers a question with the note and writes no version", async () => {
		const { boardId, thread } = await askAbout(
			NODE_ANCHOR,
			"@Alfy what time is the museum?",
		);
		modelSays({ note: "It is at 14:00." });

		const result = await run(boardId, thread.id);

		expect(result.ok && result.value).toMatchObject({
			outcome: "answered",
			applied: 0,
			refused: 0,
			version: 1,
		});
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies[0].body).toBe("It is at 14:00.");
	});

	it("takes an empty ops list for no change too", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR, "@Alfy thoughts?");
		modelSays({ note: "Looks fine.", ops: [] });
		const result = await run(boardId, thread.id);
		expect(result.ok && result.value.outcome).toBe("answered");
	});

	it("does not call a highlight a change: it lands nothing on the board", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({
			note: "This is the one.",
			ops: [{ op: "highlight", ids: ["note-museum"] }],
		});
		const result = await run(boardId, thread.id);
		expect(result.ok && result.value.outcome).toBe("answered");
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
	});
});

describe("@Alfy on a board: when the model gets it wrong", () => {
	it("tells the model what was wrong and what would have worked, once, and takes the corrected answer", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({
			note: "Done.",
			ops: [{ op: "update_node", id: "the-museum", data: { text: "x" } }],
		});
		modelSays({ note: "Done, 15:30.", ops: [CHANGE_MUSEUM] });

		const result = await run(boardId, thread.id);

		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(2);
		// The second ask carries the refusal, which names what was addressed and why it failed.
		const [secondMessage] = sendJsonControlMessageMock.mock.calls[1];
		expect(secondMessage).toContain(
			"Nothing was changed: every op was refused",
		);
		expect(secondMessage).toContain("the-museum");
		expect(result.ok && result.value.outcome).toBe("applied");
		expect((await storedNode(boardId, "note-museum"))?.data.text).toBe(
			"Museum, 15:30",
		);
	});

	it("names the valid ops when the answer is not the schema at all, and corrects in one step", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "Done.", ops: [{ op: "rename", id: "note-museum" }] });
		modelSays({ note: "Done, 15:30.", ops: [CHANGE_MUSEUM] });

		const result = await run(boardId, thread.id);

		const [secondMessage] = sendJsonControlMessageMock.mock.calls[1];
		for (const name of ["update_node", "add_node", "move", "remove_node"]) {
			expect(secondMessage).toContain(name);
		}
		expect(result.ok && result.value.outcome).toBe("applied");
	});

	it("gives up after the one correction, and says it left the board as it was", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays("not json at all");
		modelSays({
			note: "x",
			ops: [{ op: "update_node", id: "gone", data: { text: "x" } }],
		});

		const result = await run(boardId, thread.id);

		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(2);
		expect(result.ok && result.value.outcome).toBe("refused");
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies[0].body).toBe(ALFY_REFUSED_MARKER);
	});

	it("answers as refused, not with silence, when the model cannot be reached", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		sendJsonControlMessageMock.mockRejectedValueOnce(new Error("down"));
		const result = await run(boardId, thread.id);
		expect(result.ok && result.value.outcome).toBe("refused");
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);
	});
});

describe("@Alfy on a board: what the model is told", () => {
	it("gets the board as read_artifact gives it, the thread, and the tool's own words for the ops", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR, "@Alfy tidy this");
		await createComment({
			userId: OWNER,
			artifactId: boardId,
			anchor: null,
			author: "alfy",
			body: "Earlier, Alfy said this.",
			parentId: thread.id,
		});
		modelSays({ note: "Fine." });

		await run(boardId, thread.id);

		const [message, , options] = sendJsonControlMessageMock.mock.calls[0];
		expect(message).toBe("@Alfy tidy this");
		const prompt: string = options.systemPrompt;
		// The board: ids the ops must name, and the block the comment is on.
		expect(prompt).toContain('"id":"note-museum"');
		expect(prompt).toContain("Museum, 14:00");
		expect(prompt).toContain("Lunch at the market");
		expect(prompt).toContain("note-museum");
		// The thread, both voices.
		expect(prompt).toContain("Earlier, Alfy said this.");
		// The tool's own edit rule and worked example, not a second wording.
		expect(prompt).toContain(editArtifactRuleClause(["canvas"], "en"));
		expect(prompt).toContain(JSON.stringify(EDIT_ARTIFACT_CANVAS_EXAMPLE.ops));
		expect(options.thinkingMode).toBe("off");
		// A note a person reads: it names no temperature, so it takes the family
		// sampling profile through the control transport.
		expect(options.temperature).toBeUndefined();
	});

	it("describes a spot as a spot, not a block", async () => {
		const { boardId, thread } = await askAbout(
			POINT_ANCHOR,
			"@Alfy what goes here?",
		);
		modelSays({ note: "A stop." });
		await run(boardId, thread.id);
		const prompt: string =
			sendJsonControlMessageMock.mock.calls[0][2].systemPrompt;
		expect(prompt).toContain("320.5");
		expect(prompt).toContain("not on any block");
	});

	it("advertises the ops with the SAME schema the answer is validated with (ruling 62): the edit tool's array, unchanged", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "ok" });
		await run(boardId, thread.id);
		const jsonSchema = sendJsonControlMessageMock.mock.calls[0][2].jsonSchema;
		expect(jsonSchema.name).toBe("alfy_canvas_comment_reply");
		// The tool's own schema, less only what says nothing: the `$schema` header and a
		// record's `propertyNames: {type: "string"}`, which a local model's grammar
		// compiler refuses (measured live) and which restates that keys are strings.
		const advertisedByTheTool = JSON.parse(
			JSON.stringify(z.toJSONSchema(boardOpsArraySchema))
				.replace(/"\$schema":"[^"]*",?/g, "")
				.replace(/,"propertyNames":\{"type":"string"\}/g, "")
				.replace(/"propertyNames":\{"type":"string"\},?/g, ""),
		);
		expect(jsonSchema.schema.properties.ops).toEqual(advertisedByTheTool);
		// And nothing else is missing from it: the same ops, the same op names.
		expect(JSON.stringify(jsonSchema.schema)).not.toContain("propertyNames");
		expect(JSON.stringify(jsonSchema.schema)).toContain(
			'"const":"update_node"',
		);
		expect(jsonSchema.schema.required).toEqual(["note"]);
	});

	it("says at most 40 ops in what it advertises, as the edit tool does", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays({ note: "ok" });
		await run(boardId, thread.id);
		const ops =
			sendJsonControlMessageMock.mock.calls[0][2].jsonSchema.schema.properties
				.ops;
		expect(ops.maxItems).toBe(40);
	});

	it("bounds a very large board: blocks are shown in order until the cap, and the rest are counted", async () => {
		const many = sampleBoard();
		many.nodes = Array.from({ length: 900 }, (_, index) => ({
			id: `n${index}`,
			type: "sticky" as const,
			position: { x: index, y: 0 },
			data: {
				kind: "sticky" as const,
				text: "x".repeat(200),
				tone: "yellow" as const,
			},
		}));
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "canvas",
			title: "Big",
			body: boardJson(many),
			author: "user",
			versionSummary: "Created",
		});
		if (!created.ok) throw new Error(created.reason);
		const thread = await createComment({
			userId: OWNER,
			artifactId: created.artifact.id,
			anchor: { kind: "node", nodeId: "n0" },
			author: "user",
			body: "@Alfy hi",
		});
		modelSays({ note: "hi" });
		await run(created.artifact.id, thread?.id ?? "");
		const prompt: string =
			sendJsonControlMessageMock.mock.calls[0][2].systemPrompt;
		expect(prompt.length).toBeLessThan(60_000);
		expect(prompt).toMatch(/\d+ more blocks? (are )?not shown/);
	});
});

describe("@Alfy on a board: scope, abort and cost", () => {
	it("is a not_found for another user's board, and asks nothing", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		const result = await run(boardId, thread.id, NEVER_ABORTS, STRANGER);
		expect(result).toEqual({ ok: false, reason: "not_found" });
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("is a not_found for a comment that is not on this board", async () => {
		const { boardId } = await askAbout(NODE_ANCHOR);
		expect(await run(boardId, "no-such-comment")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("does nothing when the caller is already gone", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		const result = await run(boardId, thread.id, AbortSignal.abort());
		expect(result).toEqual({ ok: false, reason: "aborted" });
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
	});

	it("writes nothing when the caller goes while the model is thinking, and still records the cost of the call", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		const controller = new AbortController();
		sendJsonControlMessageMock.mockImplementationOnce(async () => {
			controller.abort();
			return {
				text: JSON.stringify({ note: "late", ops: [CHANGE_MUSEUM] }),
				rawResponse: {},
				modelId: "model1",
				modelDisplayName: "Test Model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			};
		});

		const result = await run(boardId, thread.id, controller.signal);

		expect(result).toEqual({ ok: false, reason: "aborted" });
		expect(
			await listVersions({ userId: OWNER, artifactId: boardId }),
		).toHaveLength(1);
		expect((await storedNode(boardId, "note-museum"))?.data.text).toBe(
			"Museum, 14:00",
		);
		const [root] = await listComments({ userId: OWNER, artifactId: boardId });
		expect(root.replies).toHaveLength(0);
		expect(recordControlModelUsageMock).toHaveBeenCalledTimes(1);
		expect(recordControlModelUsageMock.mock.calls[0][0]).toMatchObject({
			userId: OWNER,
			feature: "artifact_comment_alfy",
			totalTokens: 15,
		});
	});

	it("records the cost of every call it made, corrections included", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		modelSays("garbage");
		modelSays({ note: "ok", ops: [CHANGE_MUSEUM] });
		await run(boardId, thread.id);
		expect(recordControlModelUsageMock).toHaveBeenCalledTimes(2);
	});

	it("leaves the artifact's comment count and the other threads alone", async () => {
		const { boardId, thread } = await askAbout(NODE_ANCHOR);
		await createComment({
			userId: OWNER,
			artifactId: boardId,
			anchor: POINT_ANCHOR,
			author: "user",
			body: "another thread",
		});
		modelSays({ note: "ok" });
		await run(boardId, thread.id);
		const roots = await listComments({ userId: OWNER, artifactId: boardId });
		expect(roots).toHaveLength(2);
		expect(roots[1].replies).toHaveLength(0);
	});
});
