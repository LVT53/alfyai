/**
 * The Canvas entries in the three artifact tools' dispatch seams (Feature 2 ·
 * Artifacts, Slice 3, S3-T; decisions.md rulings 43, 50, 53, 62). Against a real,
 * migrated database like `document-handlers.test.ts`: create_artifact ->
 * read_artifact -> edit_artifact work end to end through the SAME registries the
 * model calls, and every refusal the model reads names what would have worked.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "$lib/server/db";
import { artifacts, conversations, users } from "$lib/server/db/schema";
import {
	createArtifact,
	getArtifact,
	getVersionBody,
	listVersions,
	saveCanvasBoard,
} from "$lib/server/services/artifacts";
import {
	BOARD_OP_NAMES,
	boardOpsArraySchema,
	validateBoardDiff,
} from "$lib/shared/artifacts/board-ops";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	defaultNodeWidth,
	estimatedNodeSize,
} from "$lib/shared/artifacts/canvas-blocks";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { plannedNodeSize } from "$lib/shared/artifacts/node-size";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { createKnownBoards, parseCanvasCreateBody } from "./canvas-model";
import { CREATE_ARTIFACT_HANDLERS, runCreateArtifactTool } from "./create";
import { buildEditArtifactModelInputSchema, runEditArtifactTool } from "./edit";
import {
	CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE,
	createArtifactBodyFormat,
	EDIT_ARTIFACT_CANVAS_EXAMPLE,
	editArtifactExampleClause,
	editArtifactOpsFieldDescription,
	editArtifactRuleClause,
} from "./kind-prose";
import { READ_ARTIFACT_HANDLERS, runReadArtifactTool } from "./read";

const NOW = new Date("2026-09-29T12:00:00.000Z");

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

function seedConversation(id: string, ownerId: string, incognito = false) {
	db.insert(conversations)
		.values({
			id,
			userId: ownerId,
			title: "Trip",
			memoryIncognito: incognito,
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

const CREATE_BODY = JSON.stringify(CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE);

async function createBoard(
	body: string = CREATE_BODY,
	overrides: { artifactId?: string; conversation?: string; user?: string } = {},
) {
	const result = await CREATE_ARTIFACT_HANDLERS.canvas?.({
		userId: overrides.user ?? userId,
		conversationId: overrides.conversation ?? conversationId,
		turnId: "turn-1",
		title: "Vienna weekend",
		body,
		language: "en",
		abortSignal: abortSignal(),
		artifactId: overrides.artifactId,
	});
	if (!result) throw new Error("no canvas create handler is registered");
	return result;
}

/** A board with every kind on it — including the five the model cannot make — stored as the user would have left it. */
async function seedBoard(board: CanvasBody = sampleBoard()) {
	const made = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(board),
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

async function versionCount(artifactId: string): Promise<number> {
	return (await listVersions({ userId, artifactId, conversationId, limit: 50 }))
		.length;
}

function runEdit(
	artifactId: string,
	input: { ops?: unknown[]; patches?: unknown[]; summary?: string },
	signal: AbortSignal = abortSignal(),
) {
	return runEditArtifactTool({
		userId,
		conversationId,
		turnId: "turn-1",
		artifactId,
		abortSignal: signal,
		...input,
	});
}

describe("create_artifact.canvas", () => {
	it("makes a board from its JSON: a canvas row, Alfy's first version, the canonical body and its hash", async () => {
		const result = await createBoard();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.title).toBe("Vienna weekend");

		const record = await getArtifact({
			userId,
			artifactId: result.value.artifactId,
			conversationId,
		});
		expect(record).toMatchObject({
			kind: "canvas",
			title: "Vienna weekend",
			conversationId,
			versionNumber: 1,
		});
		const parsed = parseCanvasCreateBody(CREATE_BODY);
		if (!parsed.ok) throw new Error(parsed.error);
		// Canonical: exactly what `boardJson` writes, not what the model typed.
		expect(record?.body).toBe(boardJson(parsed.body));
		expect(record?.bodyHash).toMatch(/^[0-9a-f]{64}$/);

		const [first] = await listVersions({
			userId,
			artifactId: result.value.artifactId,
			conversationId,
		});
		expect(first).toMatchObject({
			author: "alfy",
			summary: VERSION_SUMMARY.alfyFirstDraft,
			versionNumber: 1,
		});
		expect(
			await getVersionBody({
				userId,
				artifactId: result.value.artifactId,
				conversationId,
				versionId: first.id,
			}),
		).toBe(record?.body);
	});

	it("records what the turn made on the tool call: the id, the kind and the title the panel and the evidence read", async () => {
		const result = await runCreateArtifactTool({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactType: "canvas",
			title: "Vienna weekend",
			body: CREATE_BODY,
			language: "en",
			abortSignal: abortSignal(),
		});
		expect(result.modelPayload).toMatchObject({
			success: true,
			artifactType: "canvas",
			title: "Vienna weekend",
		});
		if (!result.modelPayload.success) return;
		expect(result.metadata).toEqual({
			ok: true,
			artifactId: result.modelPayload.artifactId,
			artifactKind: "canvas",
			artifactTitle: "Vienna weekend",
		});
		expect(result.outputSummary).toBe('Created Canvas "Vienna weekend"');
	});

	it("makes an empty board of {}", async () => {
		const result = await createBoard("{}");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const board = await storedBoard(result.value.artifactId);
		expect(board.nodes).toEqual([]);
		expect(board.edges).toEqual([]);
	});

	// Polish G2-A (Regenerate): the same handler, told which id to make it under.
	it("makes the board under the id it is given", async () => {
		const artifactId = `artifact-${randomUUID()}`;
		const result = await createBoard(CREATE_BODY, { artifactId });
		expect(result).toMatchObject({ ok: true, value: { artifactId } });
		expect(await getArtifact({ userId, artifactId })).toMatchObject({
			id: artifactId,
			kind: "canvas",
		});
	});

	it("writes nothing and refuses when the signal is already aborted (ruling 53)", async () => {
		const result = await CREATE_ARTIFACT_HANDLERS.canvas?.({
			userId,
			conversationId,
			turnId: "turn-1",
			title: "Vienna weekend",
			body: CREATE_BODY,
			language: "en",
			abortSignal: abortSignal(true),
		});
		expect(result?.ok).toBe(false);
		expect(
			db.select().from(artifacts).where(eq(artifacts.userId, userId)).all(),
		).toHaveLength(0);
	});

	it("refuses a block the model may not make, names the six it may, and writes nothing", async () => {
		const result = await createBoard(
			JSON.stringify({
				nodes: [
					{
						id: "m1",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
				],
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		for (const kind of [
			"frame",
			"sticky",
			"text",
			"checklist",
			"chart",
			"mermaid",
		]) {
			expect(result.reason).toContain(kind);
		}
		expect(result.reason).toContain('nodes[0] "m1"');
		expect(
			db.select().from(artifacts).where(eq(artifacts.userId, userId)).all(),
		).toHaveLength(0);
	});

	it("refuses a body that is not JSON, naming the shape and the way out", async () => {
		const result = await createBoard('{"nodes": [');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/not valid JSON/);
		expect(result.reason).toContain("edit_artifact");
	});

	it("does not make a board in a conversation the user does not have", async () => {
		const stranger = `user-${randomUUID()}`;
		const strangerConversation = `conv-${randomUUID()}`;
		seedUser(stranger);
		seedConversation(strangerConversation, stranger);
		const result = await createBoard(CREATE_BODY, {
			conversation: strangerConversation,
		});
		expect(result.ok).toBe(false);
		expect(
			db.select().from(artifacts).where(eq(artifacts.userId, userId)).all(),
		).toHaveLength(0);
	});

	it("the create body the description shows is a board the handler makes, with nothing refused", () => {
		const parsed = parseCanvasCreateBody(CREATE_BODY);
		expect(parsed.ok).toBe(true);
	});
});

describe("read_artifact.canvas", () => {
	async function read(artifactId: string, detail: "blocks" | "full") {
		return READ_ARTIFACT_HANDLERS.canvas?.({
			userId,
			conversationId,
			artifactId,
			title: "Weekend board",
			detail,
			abortSignal: abortSignal(),
		});
	}

	it("'blocks' lists every node and edge with the ids an op names", async () => {
		const artifactId = await seedBoard();
		const read_ = await read(artifactId, "blocks");
		const ids = (read_?.blocks ?? []).map((block) => block.id);
		for (const id of ["frame-a", "note-1", "todo-1", "map-1", "edge-1"]) {
			expect(ids).toContain(id);
		}
		expect(read_?.body).toBeUndefined();
	});

	it("'blocks' shows a diagram's source, which an edit of it is made from, and names a diagram by its kind when it has no name", async () => {
		const board = sampleBoard();
		board.nodes.push({
			id: "diagram-2",
			type: "mermaid",
			position: { x: 700, y: 1000 },
			data: { kind: "mermaid", code: "sequenceDiagram\n  A->>B: Hi" },
		});
		const artifactId = await seedBoard(board);
		const blocks = (await read(artifactId, "blocks"))?.blocks ?? [];
		expect(blocks.find((block) => block.id === "diagram-1")).toMatchObject({
			kind: "mermaid",
			label: "Release flow",
			code: "flowchart TD\n  A --> B",
		});
		expect(blocks.find((block) => block.id === "diagram-2")).toMatchObject({
			label: "sequenceDiagram",
			code: "sequenceDiagram\n  A->>B: Hi",
		});
		expect(
			blocks.find((block) => block.id === "diagram-1")?.height,
		).toBeGreaterThan(84);
	});

	it("'full' also returns the canonical board JSON", async () => {
		const artifactId = await seedBoard();
		const read_ = await read(artifactId, "full");
		expect(read_?.blocks?.length).toBeGreaterThan(0);
		expect(read_?.body).toBe((await getArtifact({ userId, artifactId }))?.body);
	});

	it("does nothing once the signal has fired", async () => {
		const artifactId = await seedBoard();
		const read_ = await READ_ARTIFACT_HANDLERS.canvas?.({
			userId,
			conversationId,
			artifactId,
			title: "Weekend board",
			detail: "blocks",
			abortSignal: abortSignal(true),
		});
		expect(read_).toEqual({});
	});

	it("through the tool: answers with the board's blocks, and the candidates for an id that is not here", async () => {
		const artifactId = await seedBoard();
		const ok = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId,
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		expect(ok.modelPayload).toMatchObject({
			success: true,
			artifactType: "canvas",
			title: "Weekend board",
		});

		const missing = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: "nope",
			abortSignal: abortSignal(),
		});
		expect(missing.modelPayload).toMatchObject({
			success: false,
			candidates: [{ artifactId, title: "Weekend board" }],
		});
	});

	it("through the tool, a 'full' read of a huge board is bounded (ruling 53), blocks and body alike", async () => {
		const board = sampleBoard();
		board.nodes = Array.from({ length: 8 }, (_, i) => ({
			id: `long-${i}`,
			type: "text" as const,
			position: { x: i * 10, y: 0 },
			data: { kind: "text" as const, text: `${"w ".repeat(9000)}${i}` },
		}));
		board.edges = [];
		board.annotations = [];
		const artifactId = await seedBoard(board);
		const result = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId,
			detail: "full",
			abortSignal: abortSignal(),
		});
		expect(result.modelPayload).toMatchObject({
			success: true,
			truncated: true,
		});
		if (result.modelPayload.success) {
			expect(result.modelPayload.body?.length).toBeLessThanOrEqual(100_100);
			expect(result.modelPayload.omittedChars).toBeGreaterThan(0);
		}
	});
});

describe("edit_artifact.canvas", () => {
	it("applies the description's own worked example with nothing refused, as one Alfy version", async () => {
		const artifactId = await seedBoard();
		const before = await versionCount(artifactId);
		const result = await runEdit(artifactId, {
			ops: [...EDIT_ARTIFACT_CANVAS_EXAMPLE.ops],
			summary: EDIT_ARTIFACT_CANVAS_EXAMPLE.summary,
		});
		expect(result.modelPayload).toMatchObject({
			success: true,
			artifactId,
			applied: EDIT_ARTIFACT_CANVAS_EXAMPLE.ops.length,
			refused: [],
		});
		expect(await versionCount(artifactId)).toBe(before + 1);
		const [newest] = await listVersions({ userId, artifactId, conversationId });
		expect(newest).toMatchObject({
			author: "alfy",
			summary: "Planned Sunday",
		});
		if (result.modelPayload.success) {
			expect(result.modelPayload.versionId).toBe(newest.id);
		}
		const board = await storedBoard(artifactId);
		expect(board.nodes.map((node) => node.id)).toEqual(
			expect.arrayContaining(["sun", "brunch"]),
		);
		expect(board.nodes.find((node) => node.id === "brunch")?.parentId).toBe(
			"sun",
		);
		expect(board.edges.map((edge) => edge.id)).toContain("e2");
		expect(
			board.nodes.find((node) => node.id === "note-museum")?.position,
		).toEqual({
			x: 500,
			y: 140,
		});
	});

	it("applies the half of a batch that can be applied, and names why the other half was not", async () => {
		const artifactId = await seedBoard();
		const result = await runEdit(artifactId, {
			ops: [
				{ op: "move", id: "note-museum", to: { x: 610, y: 70 } },
				{ op: "move", id: "note-lunch", to: { x: 1, y: 1 } },
				{
					op: "update_node",
					id: "text-1",
					data: { text: "Weekend in Vienna" },
				},
				{ op: "remove_edge", id: "edge-ghost" },
			],
			summary: "Tidied",
		});
		expect(result.modelPayload.success).toBe(true);
		if (!result.modelPayload.success) return;
		expect(result.modelPayload.applied).toBe(2);
		expect(result.modelPayload.refused).toHaveLength(2);
		const [first, second] = result.modelPayload.refused;
		expect(first).toMatchObject({
			opIndex: 1,
			target: "note-lunch",
			reason: "unknown_id",
		});
		// The refusal names the ids that exist, so the next guess is a real one.
		expect(first.detail).toContain("note-museum");
		expect(second).toMatchObject({ opIndex: 3, reason: "unknown_id" });
		expect(second.detail).toContain("edge-1");

		const board = await storedBoard(artifactId);
		expect(
			board.nodes.find((node) => node.id === "note-museum")?.position,
		).toEqual({
			x: 610,
			y: 70,
		});
		expect(
			(
				board.nodes.find((node) => node.id === "text-1")?.data as {
					text: string;
				}
			).text,
		).toBe("Weekend in Vienna");
	});

	it("says which ops were skipped in the run's own metadata, by index, for the panel", async () => {
		const artifactId = await seedBoard();
		const result = await runEdit(artifactId, {
			ops: [
				{ op: "move", id: "note-museum", to: { x: 1, y: 1 } },
				{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
			],
		});
		expect(result.metadata).toMatchObject({
			ok: true,
			artifactKind: "canvas",
			appliedCount: 1,
		});
		expect(JSON.parse(String(result.metadata.refusedBlocksJson))).toEqual([
			{ blockId: "ghost", reason: "unknown_id", opIndex: 1 },
		]);
	});

	it("fails, writing nothing, when every op is refused — and says what would have worked", async () => {
		const artifactId = await seedBoard();
		const before = await versionCount(artifactId);
		const result = await runEdit(artifactId, {
			ops: [
				{ op: "move", id: "nope", to: { x: 1, y: 1 } },
				{
					op: "add_node",
					node: {
						id: "x",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text: "t", tone: "plain" },
					},
				},
			],
		});
		expect(result.modelPayload.success).toBe(false);
		if (result.modelPayload.success) return;
		expect(result.modelPayload.error).toMatch(/Nothing was changed/);
		expect(result.modelPayload.refused).toHaveLength(2);
		const details = (result.modelPayload.refused ?? [])
			.map((item) => item.detail)
			.join(" ");
		expect(details).toContain("frame, sticky, text, checklist, chart");
		expect(details).toContain("Node ids:");
		expect(await versionCount(artifactId)).toBe(before);
		// The panel is told too, op by op, so it can name what Alfy left alone: the call
		// changed nothing, but "changed nothing" is not the whole story to the reader.
		expect(result.metadata).toMatchObject({
			ok: false,
			artifactKind: "canvas",
		});
		expect(JSON.parse(String(result.metadata.refusedBlocksJson))).toEqual([
			{ blockId: "nope", reason: "unknown_id", opIndex: 0 },
			{ blockId: "x", reason: "unknown_kind", opIndex: 1 },
		]);
	});

	it("names the valid ops and the blocks it may add when the ops cannot be read (the Document's dev incident, for the board)", async () => {
		const artifactId = await seedBoard();
		const before = await versionCount(artifactId);
		const result = await runEdit(artifactId, {
			ops: [{ op: "insert_node", id: "x" }],
		});
		expect(result.modelPayload.success).toBe(false);
		if (result.modelPayload.success) return;
		for (const name of BOARD_OP_NAMES) {
			expect(result.modelPayload.error).toContain(name);
		}
		expect(result.modelPayload.error).toContain("sticky: kind, text, tone");
		expect(result.modelPayload.error).toMatch(/Nothing was applied/);
		expect(await versionCount(artifactId)).toBe(before);
	});

	it("refuses patches on a board, naming ops", async () => {
		const artifactId = await seedBoard();
		const result = await runEdit(artifactId, {
			patches: [{ op: "replaceBlock" }],
		});
		expect(result.modelPayload.success).toBe(false);
		if (result.modelPayload.success) return;
		expect(result.modelPayload.error).toMatch(/ops/);
		for (const name of BOARD_OP_NAMES) {
			expect(result.modelPayload.error).toContain(name);
		}
	});

	it("writes nothing when the signal is already aborted (ruling 53)", async () => {
		const artifactId = await seedBoard();
		const before = await versionCount(artifactId);
		const result = await runEdit(
			artifactId,
			{ ops: [{ op: "move", id: "note-museum", to: { x: 9, y: 9 } }] },
			abortSignal(true),
		);
		expect(result.modelPayload.success).toBe(false);
		expect(await versionCount(artifactId)).toBe(before);
	});

	it("a highlight changes nothing on the board and writes no version, but is a success", async () => {
		const artifactId = await seedBoard();
		const before = await versionCount(artifactId);
		const newest = (
			await listVersions({ userId, artifactId, conversationId })
		)[0];
		const result = await runEdit(artifactId, {
			ops: [{ op: "highlight", ids: ["note-museum", "todo-1"] }],
		});
		expect(result.modelPayload).toMatchObject({
			success: true,
			applied: 1,
			versionId: newest.id,
		});
		expect(await versionCount(artifactId)).toBe(before);
	});

	it("removing a frame leaves what was inside it on the board, and removing a node takes its edges", async () => {
		const artifactId = await seedBoard();
		const result = await runEdit(artifactId, {
			ops: [
				{ op: "remove_node", id: "frame-a" },
				{ op: "remove_node", id: "text-1" },
			],
		});
		expect(result.modelPayload).toMatchObject({ success: true, applied: 2 });
		const board = await storedBoard(artifactId);
		const ids = board.nodes.map((node) => node.id);
		expect(ids).not.toContain("frame-a");
		expect(ids).toContain("note-1");
		expect(board.edges).toEqual([]);
	});

	it("adds one of the five kinds and moves, updates and removes the ones it cannot add", async () => {
		const artifactId = await seedBoard();
		const result = await runEdit(artifactId, {
			ops: [
				{ op: "move", id: "map-1", to: { x: 800, y: 900 } },
				{ op: "update_node", id: "app-1", data: { title: "Renamed" } },
				{ op: "remove_node", id: "photo-1" },
				{
					op: "add_node",
					node: {
						id: "todo-2",
						type: "checklist",
						position: { x: 10, y: 10 },
						data: {
							kind: "checklist",
							label: "Book",
							items: [{ id: "a", text: "Train", done: false }],
						},
					},
				},
			],
		});
		expect(result.modelPayload).toMatchObject({
			success: true,
			applied: 4,
			refused: [],
		});
	});

	describe("a diagram, and where what is added goes (ruling 74)", () => {
		const flow = (extra: Record<string, unknown> = {}) => ({
			op: "add_node",
			node: {
				id: "flow",
				type: "mermaid",
				data: {
					kind: "mermaid",
					code: "flowchart TD\n  A[Idea] --> B[Draft] --> C[Publish]",
				},
				...extra,
			},
		});

		it("adds a diagram, which is drawn by the chat's own component from the very source it wrote, and puts it on free ground", async () => {
			const artifactId = await seedBoard();
			const result = await runEdit(artifactId, { ops: [flow()] });
			expect(result.modelPayload).toMatchObject({
				success: true,
				applied: 1,
				refused: [],
			});
			const board = await storedBoard(artifactId);
			const added = board.nodes.find((node) => node.id === "flow");
			expect(added).toMatchObject({
				type: "mermaid",
				width: 480,
				data: {
					kind: "mermaid",
					code: "flowchart TD\n  A[Idea] --> B[Draft] --> C[Publish]",
				},
			});
			if (!added) throw new Error("the diagram was not added");
			const tall = plannedNodeSize(added);
			// It covers none of what was there: the sample board is full.
			for (const other of board.nodes.filter(
				(n) => n.id !== "flow" && !n.parentId,
			)) {
				const rect = { ...other.position, ...plannedNodeSize(other) };
				const across =
					Math.min(added.position.x + tall.width, rect.x + rect.width) -
					Math.max(added.position.x, rect.x);
				const down =
					Math.min(added.position.y + tall.height, rect.y + rect.height) -
					Math.max(added.position.y, rect.y);
				expect(across > 1 && down > 1, other.id).toBe(false);
			}
		});

		it("changes a diagram's source with update_node, and refuses one that would load an address", async () => {
			const artifactId = await seedBoard();
			const result = await runEdit(artifactId, {
				ops: [
					{
						op: "update_node",
						id: "diagram-1",
						data: { code: "flowchart LR\n  X --> Y --> Z" },
					},
					{
						op: "update_node",
						id: "diagram-1",
						data: {
							code: 'flowchart TD\n  A@{ img: "https://x.test/p.png", w: 60, h: 60 }',
						},
					},
				],
			});
			expect(result.modelPayload).toMatchObject({ success: true, applied: 1 });
			if (!result.modelPayload.success) return;
			expect(result.modelPayload.refused).toEqual([
				expect.objectContaining({ reason: "invalid_data", opIndex: 1 }),
			]);
			expect(result.modelPayload.refused[0].detail).toContain(
				"an image or icon shape",
			);
			const board = await storedBoard(artifactId);
			expect(board.nodes.find((n) => n.id === "diagram-1")?.data).toMatchObject(
				{
					code: "flowchart LR\n  X --> Y --> Z",
				},
			);
		});

		it("tells the model where the app put what it added, and says nothing of a block that went where it was told", async () => {
			const artifactId = await seedBoard();
			const result = await runEdit(artifactId, {
				ops: [
					{
						op: "add_node",
						node: {
							id: "beside",
							type: "sticky",
							near: "note-1",
							data: { kind: "sticky", text: "Next to lunch", tone: "mint" },
						},
					},
					{
						op: "add_node",
						node: {
							id: "told",
							type: "sticky",
							position: { x: 900, y: 1500 },
							data: { kind: "sticky", text: "Where I said", tone: "plain" },
						},
					},
				],
			});
			expect(result.modelPayload).toMatchObject({ success: true, applied: 2 });
			if (!result.modelPayload.success) return;
			const placed = result.modelPayload.placed ?? [];
			expect(placed.map((entry) => entry.id)).toEqual(["beside"]);
			expect(placed[0]).toMatchObject({ in: "frame-a" });
			const board = await storedBoard(artifactId);
			const beside = board.nodes.find((n) => n.id === "beside");
			expect(placed[0]).toMatchObject({
				x: beside?.position.x,
				y: beside?.position.y,
			});
		});

		it("puts a note next to the one it names, in its frame, and says where an id it does not have should have been", async () => {
			const artifactId = await seedBoard();
			const result = await runEdit(artifactId, {
				ops: [
					{
						op: "add_node",
						node: {
							id: "beside",
							type: "sticky",
							near: "note-1",
							data: { kind: "sticky", text: "Next to lunch", tone: "mint" },
						},
					},
					{
						op: "add_node",
						node: {
							id: "lost",
							type: "sticky",
							near: "no-such-note",
							data: { kind: "sticky", text: "Nowhere", tone: "plain" },
						},
					},
				],
			});
			expect(result.modelPayload).toMatchObject({ success: true, applied: 1 });
			if (!result.modelPayload.success) return;
			expect(result.modelPayload.refused[0]).toMatchObject({
				reason: "unknown_id",
				target: "no-such-note",
			});
			expect(result.modelPayload.refused[0].detail).toContain("note-1");
			const board = await storedBoard(artifactId);
			const beside = board.nodes.find((n) => n.id === "beside");
			expect(beside?.parentId).toBe("frame-a");
			expect(board.nodes.some((n) => n.id === "lost")).toBe(false);
		});

		it("grows a frame for the diagram it was asked to hold when the ground below is free, so the diagram is inside it", async () => {
			const board = sampleBoard();
			board.nodes = board.nodes.filter(
				(n) => n.id === "frame-a" || n.id === "note-1",
			);
			board.edges = [];
			const artifactId = await seedBoard(board);
			const result = await runEdit(artifactId, {
				ops: [flow({ parentId: "frame-a" })],
			});
			expect(result.modelPayload).toMatchObject({ success: true, applied: 1 });
			const stored = await storedBoard(artifactId);
			const frame = stored.nodes.find((n) => n.id === "frame-a");
			const added = stored.nodes.find((n) => n.id === "flow");
			expect(added?.parentId).toBe("frame-a");
			const size = plannedNodeSize(added as CanvasNode);
			expect((added?.position.x ?? 0) + size.width).toBeLessThanOrEqual(
				frame?.width ?? 0,
			);
			expect((added?.position.y ?? 0) + size.height).toBeLessThanOrEqual(
				frame?.height ?? 0,
			);
			expect(frame?.width).toBeGreaterThan(360);
		});

		it("leaves the frame as it is, and the diagram beside it, when what is below is in the way", async () => {
			const artifactId = await seedBoard();
			const result = await runEdit(artifactId, {
				ops: [flow({ parentId: "frame-a" })],
			});
			expect(result.modelPayload).toMatchObject({ success: true, applied: 1 });
			const stored = await storedBoard(artifactId);
			expect(
				stored.nodes.find((n) => n.id === "flow")?.parentId,
			).toBeUndefined();
			expect(stored.nodes.find((n) => n.id === "frame-a")?.height).toBe(300);
		});
	});

	it("reads the newest version itself: the model never quotes a version, and a user's save before the edit is not overwritten", async () => {
		const artifactId = await seedBoard();
		// The user saves through the body route's seam after the model's read.
		const { saveCanvasBoard } = await import("$lib/server/services/artifacts");
		const board = sampleBoard();
		board.nodes.push({
			id: "user-note",
			type: "sticky",
			position: { x: 5, y: 5 },
			data: { kind: "sticky", text: "mine", tone: "blue" },
		});
		const saved = await saveCanvasBoard({
			userId,
			artifactId,
			conversationId,
			body: boardJson(board),
			author: "user",
			summary: VERSION_SUMMARY.edited,
			expectVersion: 1,
		});
		expect(saved.ok).toBe(true);
		const result = await runEdit(artifactId, {
			ops: [{ op: "move", id: "note-museum", to: { x: 2, y: 2 } }],
		});
		expect(result.modelPayload.success).toBe(true);
		const after = await storedBoard(artifactId);
		expect(after.nodes.map((node) => node.id)).toContain("user-note");
	});

	it("never edits a board another conversation of the user made, or another user's — an unknown id names this conversation's own", async () => {
		const otherConversation = `conv-${randomUUID()}`;
		seedConversation(otherConversation, userId);
		const foreign = await createArtifact({
			userId,
			conversationId: otherConversation,
			kind: "canvas",
			title: "Elsewhere",
			body: boardJson(sampleBoard()),
			author: "user",
		});
		if (!foreign.ok) throw new Error("setup");
		const mine = await seedBoard();
		const result = await runEdit(foreign.artifact.id, {
			ops: [{ op: "move", id: "note-museum", to: { x: 1, y: 1 } }],
		});
		expect(result.modelPayload).toMatchObject({
			success: false,
			candidates: [{ artifactId: mine, title: "Weekend board" }],
		});
	});
});

describe("ruling 62: what the model is shown is what the handler parses", () => {
	const kinds = ["document", "app", "canvas"] as const;

	it("advertises the board vocabulary's own ops schema as `ops`, not a generic array", () => {
		const shown = z.toJSONSchema(
			buildEditArtifactModelInputSchema(kinds),
		) as unknown as {
			properties: { ops: Record<string, unknown> };
		};
		const wanted = z.toJSONSchema(boardOpsArraySchema) as Record<
			string,
			unknown
		>;
		// The field carries its own description and no `$schema` marker; the rest
		// is the vocabulary's array schema, key for key.
		const { description: _shown, ...ops } = shown.properties.ops;
		const { $schema: _marker, ...expected } = wanted;
		expect(ops).toEqual(expected);
		expect(JSON.stringify(ops)).toContain('"const":"add_frame"');
	});

	it("leaves `ops` a generic array while Canvas is not advertised", () => {
		const shown = z.toJSONSchema(
			buildEditArtifactModelInputSchema(["document", "app"]),
		) as unknown as { properties: { ops: Record<string, unknown> } };
		expect(JSON.stringify(shown.properties.ops)).not.toContain("add_frame");
		expect(shown.properties.ops).toMatchObject({ type: "array" });
	});

	it("names no op in prose that the schema does not have", () => {
		const kinds = ["canvas"] as const;
		const prose = [
			editArtifactRuleClause(kinds, "en"),
			editArtifactRuleClause(kinds, "hu"),
			editArtifactExampleClause(kinds, "en"),
			editArtifactExampleClause(kinds, "hu"),
			editArtifactOpsFieldDescription(kinds) ?? "",
			createArtifactBodyFormat(kinds),
		].join(" ");
		const mentioned = prose.match(/\b(?:add|remove|update)_[a-z]+\b/g) ?? [];
		expect(mentioned.length).toBeGreaterThan(0);
		for (const name of mentioned) {
			expect(BOARD_OP_NAMES as readonly string[], name).toContain(name);
		}
		// And every "op" a worked example sends is one of them.
		for (const op of EDIT_ARTIFACT_CANVAS_EXAMPLE.ops) {
			expect(BOARD_OP_NAMES as readonly string[]).toContain(op.op);
		}
	});

	// The first try at "make this note a checklist" is an update_node that
	// changes data.kind, which is refused; a rule that says so up front saves the
	// model that call, on the tool path and on the @Alfy comment path, which is
	// handed this very sentence.
	it("says, in both languages, that a block's kind cannot change and what to do instead", () => {
		const en = editArtifactRuleClause(kinds, "en");
		expect(en).toMatch(/kind cannot change/);
		expect(en).toMatch(/remove it and add a new one/);
		const hu = editArtifactRuleClause(kinds, "hu");
		expect(hu).toMatch(/típusa nem változtatható/);
		expect(hu).toMatch(/töröld/);
		expect(hu).toMatch(/adj hozzá/);
	});

	// RC-3 N1: a chart and a checklist are not a note's 190, and a chart is as tall
	// as its plot. The sentence is built from the numbers the board, the model's read
	// and the eval draw with, so a model that plans by it leaves room for what is
	// really drawn (a pie is square, so it is taller).
	it("says, in both languages, how wide a checklist and a chart are and how tall a chart is, from the numbers the board is drawn with", () => {
		const chart = (type: string) =>
			estimatedNodeSize({
				type: "chart",
				data: { kind: "chart", code: JSON.stringify({ type, data: {} }) },
			});
		const flat = chart("bar").height;
		const round = chart("pie").height;
		expect(round).toBeGreaterThan(flat);
		const checklist = defaultNodeWidth("checklist");
		const chartWidth = defaultNodeWidth("chart");
		const en = [
			editArtifactRuleClause(kinds, "en"),
			createArtifactBodyFormat(kinds),
		];
		for (const text of en) {
			expect(text).toContain(`a checklist ${checklist}`);
			expect(text).toContain(`a chart ${chartWidth}`);
			expect(text).toContain(`a chart is ${flat} tall (${round} for a pie`);
		}
		const hu = editArtifactRuleClause(kinds, "hu");
		expect(hu).toContain(`a feladatlista ${checklist}`);
		expect(hu).toContain(`a diagram ${chartWidth}`);
		expect(hu).toContain(`egy diagram ${flat} magas`);
		expect(hu).toContain(`${round}`);
	});

	// Ruling 74: a diagram is a block Alfy may add, and a block it adds is placed.
	it("says, in both languages, how wide a diagram is, and that a position left out is placed for it, from the numbers the board is drawn with", () => {
		const width = defaultNodeWidth("mermaid");
		for (const text of [
			editArtifactRuleClause(kinds, "en"),
			createArtifactBodyFormat(kinds),
		]) {
			expect(text).toContain(`a diagram ${width}`);
		}
		const en = editArtifactRuleClause(kinds, "en");
		expect(en).toMatch(/Leave position out and the block is placed for you/);
		expect(en).toMatch(/near/);
		expect(en).toMatch(/kept if free, else moved/);
		const hu = editArtifactRuleClause(kinds, "hu");
		expect(hu).toContain(`az ábra ${width}`);
		expect(hu).toMatch(/A pozíciót hagyd el/);
		expect(hu).toMatch(/near/);
		expect(hu).toMatch(/megmarad, ha szabad/);
	});

	it("parses through the advertised schema, and through the validator against a real board with nothing refused, a diagram, a chart written as an object, a note put near another and a frame with no place (ruling 62, ruling 74)", () => {
		const schema = buildEditArtifactModelInputSchema(kinds);
		const call = {
			artifactId: "a2",
			ops: [
				{
					op: "add_node",
					node: {
						id: "flow",
						type: "mermaid",
						data: {
							kind: "mermaid",
							label: "Release",
							code: "flowchart TD\n  A[Build] --> B{Green?}\n  B -->|yes| C[Ship]",
						},
					},
				},
				{
					op: "add_node",
					node: {
						id: "costs",
						type: "chart",
						parentId: "frame-a",
						data: {
							kind: "chart",
							code: {
								type: "bar",
								data: { labels: ["A"], datasets: [{ data: [1] }] },
							},
						},
					},
				},
				{
					op: "add_node",
					node: {
						id: "beside",
						type: "sticky",
						near: "note-museum",
						data: { kind: "sticky", text: "Beside the museum", tone: "mint" },
					},
				},
				{
					op: "add_frame",
					id: "sun",
					label: "Sunday",
					size: { width: 300, height: 200 },
				},
			],
			summary: "More on the board",
		};
		const parsed = schema.safeParse(call);
		expect(parsed.success, JSON.stringify(parsed)).toBe(true);
		const { refused, accepted } = validateBoardDiff(
			{ id: "d", summary: "x", ops: boardOpsArraySchema.parse(call.ops) },
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(4);
	});

	it("advertises, in the one schema the handler parses, a position that may be left out and a near beside it, on a frame as on a block", () => {
		const advertised = JSON.stringify(
			z.toJSONSchema(buildEditArtifactModelInputSchema(kinds)),
		);
		expect(advertised).toContain('"near"');
		expect(advertised).toContain(
			"Leave it out and the block is placed for you",
		);
		expect(advertised).toContain(
			"Leave it out and the frame is placed on free ground",
		);
		expect(advertised).toContain("```mermaid fence");
	});

	it("parses the edit example, whole, through the advertised schema — and its ops through the validator against a real board with zero refusals", () => {
		const schema = buildEditArtifactModelInputSchema(kinds);
		expect(schema.safeParse(EDIT_ARTIFACT_CANVAS_EXAMPLE).success).toBe(true);
		const ops = boardOpsArraySchema.parse(
			JSON.parse(JSON.stringify(EDIT_ARTIFACT_CANVAS_EXAMPLE.ops)),
		);
		const { accepted, refused } = validateBoardDiff(
			{ id: "example", summary: EDIT_ARTIFACT_CANVAS_EXAMPLE.summary, ops },
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(EDIT_ARTIFACT_CANVAS_EXAMPLE.ops.length);
	});
});

// RV-3 I6 / ruling 67: Alfy reads a board, the reader rewrites a note, and Alfy's
// update_node used to land on top of the reader's words (as a new version, with
// only Undo to get them back). The turn's own read of the board is the base: what
// the reader changed after it is refused `stale`, the rest applies. The turn's
// earlier tool calls reach the handler the way they reach a create handler (the
// recorder's entries), and Alfy's own edits move the base forward, so a model that
// reads once and edits twice is not refused for its own changes.
describe("edit_artifact.canvas — the reader's newer words (ruling 67)", () => {
	async function readerSaves(
		artifactId: string,
		change: (board: CanvasBody) => void,
	) {
		const board = await storedBoard(artifactId);
		change(board);
		const saved = await saveCanvasBoard({
			userId,
			artifactId,
			conversationId,
			body: JSON.stringify(board),
			author: "user",
			summary: VERSION_SUMMARY.edited,
			coalesceUserEdits: false,
		});
		if (!saved.ok) throw new Error(`setup: ${saved.reason}`);
	}

	function museum(board: CanvasBody) {
		const found = board.nodes.find((n) => n.id === "note-museum");
		if (!found) throw new Error("fixture");
		return found;
	}

	async function museumText(artifactId: string): Promise<string> {
		const data = museum(await storedBoard(artifactId)).data;
		return data.kind === "sticky" ? data.text : "";
	}

	function entryOf(
		name: "read_artifact" | "edit_artifact",
		artifactId: string,
		metadata: Record<string, string | number | boolean | null>,
	) {
		return {
			callId: `call-${name}`,
			name,
			input: { artifactId },
			status: "done" as const,
			metadata,
		};
	}

	function editWith(
		artifactId: string,
		sources: ReturnType<typeof entryOf>[],
		ops: unknown[],
	) {
		return runEditArtifactTool({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			abortSignal: abortSignal(),
			ops,
			turnContext: { sources },
		});
	}

	const rewriteMuseum = {
		op: "update_node",
		id: "note-museum",
		data: { text: "Museum, 14:00 — Alfy's words" },
	};

	it("puts the version it read on the tool call's record, and the model's answer stays free of it", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			detail: "blocks",
			abortSignal: abortSignal(),
		});
		const [newest] = await listVersions({
			userId,
			artifactId: id,
			conversationId,
			limit: 1,
		});
		expect(read.metadata.versionId).toBe(newest.id);
		expect(JSON.stringify(read.modelPayload)).not.toContain(newest.id);
	});

	it("refuses an update to a note the reader rewrote after the read, and keeps their words (the review's failing test)", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			abortSignal: abortSignal(),
		});
		await readerSaves(id, (board) => {
			museum(board).data = {
				kind: "sticky",
				text: "Museum, 16:30 (the reader's)",
				tone: "mint",
			};
		});
		const before = await versionCount(id);

		const result = await editWith(
			id,
			[entryOf("read_artifact", id, read.metadata)],
			[rewriteMuseum],
		);

		expect(result.modelPayload.success).toBe(false);
		if (result.modelPayload.success) return;
		expect(result.modelPayload.refused?.[0]).toMatchObject({
			target: "note-museum",
			reason: "stale",
			opIndex: 0,
		});
		expect(result.modelPayload.refused?.[0].detail).toMatch(/read_artifact/);
		expect(await museumText(id)).toBe("Museum, 16:30 (the reader's)");
		expect(await versionCount(id)).toBe(before);
	});

	it("applies the ops the reader did not touch, and tells the model which one it skipped and why", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			abortSignal: abortSignal(),
		});
		await readerSaves(id, (board) => {
			museum(board).data = {
				kind: "sticky",
				text: "Museum, 16:30 (the reader's)",
				tone: "mint",
			};
		});

		const result = await editWith(
			id,
			[entryOf("read_artifact", id, read.metadata)],
			[rewriteMuseum, { op: "move", id: "note-1", to: { x: 30, y: 70 } }],
		);

		expect(result.modelPayload).toMatchObject({
			success: true,
			applied: 1,
			refused: [{ target: "note-museum", reason: "stale", opIndex: 0 }],
		});
		expect(await museumText(id)).toBe("Museum, 16:30 (the reader's)");
		expect(
			(await storedBoard(id)).nodes.find((n) => n.id === "note-1")?.position,
		).toEqual({ x: 30, y: 70 });
	});

	it("applies to the current board when the turn has not read this board", async () => {
		const id = await seedBoard();
		await readerSaves(id, (board) => {
			museum(board).data = {
				kind: "sticky",
				text: "Museum, 16:30 (the reader's)",
				tone: "mint",
			};
		});
		const other = await seedBoard();
		const readOfAnother = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: other,
			abortSignal: abortSignal(),
		});
		const failedRead = entryOf("read_artifact", id, {
			ok: false,
			found: false,
		});

		for (const sources of [
			[],
			[entryOf("read_artifact", other, readOfAnother.metadata)],
			[failedRead],
		]) {
			const result = await editWith(id, sources, [rewriteMuseum]);
			expect(result.modelPayload.success).toBe(true);
			expect(await museumText(id)).toBe("Museum, 14:00 — Alfy's words");
			await readerSaves(id, (board) => {
				museum(board).data = {
					kind: "sticky",
					text: "Museum, 16:30 (the reader's)",
					tone: "mint",
				};
			});
		}
	});

	it("does not refuse a model for its own earlier edit: reading once and editing twice works", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			abortSignal: abortSignal(),
		});
		const sources = [entryOf("read_artifact", id, read.metadata)];
		const first = await editWith(id, sources, [
			{ op: "move", id: "note-museum", to: { x: 700, y: 90 } },
		]);
		expect(first.modelPayload.success).toBe(true);
		sources.push(entryOf("edit_artifact", id, first.metadata));

		const second = await editWith(id, sources, [
			rewriteMuseum,
			{ op: "move", id: "note-museum", to: { x: 720, y: 100 } },
		]);

		expect(second.modelPayload).toMatchObject({ success: true, applied: 2 });
		expect(await museumText(id)).toBe("Museum, 14:00 — Alfy's words");
	});

	it("still protects the reader's change when it landed between the read and Alfy's own first edit", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			abortSignal: abortSignal(),
		});
		const sources = [entryOf("read_artifact", id, read.metadata)];
		await readerSaves(id, (board) => {
			museum(board).data = {
				kind: "sticky",
				text: "Museum, 16:30 (the reader's)",
				tone: "mint",
			};
		});
		// Alfy's first edit touches something else and lands on top of the reader's version...
		const first = await editWith(id, sources, [
			{ op: "move", id: "note-1", to: { x: 30, y: 70 } },
		]);
		expect(first.modelPayload.success).toBe(true);
		sources.push(entryOf("edit_artifact", id, first.metadata));

		// ...which is not something Alfy has read, so its next edit is still judged
		// against the board it read.
		const second = await editWith(id, sources, [rewriteMuseum]);

		expect(second.modelPayload.success).toBe(false);
		expect(await museumText(id)).toBe("Museum, 16:30 (the reader's)");
	});
});

// RV-F I-1 / ruling 47: the reader's own saves within ten minutes are written INTO
// their newest version, so the version the model read can hold newer words under
// the same id. A turn that holds the words it was shown judges against those.
// (`canvas-stale-read.test.ts` runs the same through the real tools.)
describe("edit_artifact.canvas — the words the turn holds (ruling 67 × ruling 47)", () => {
	async function readerWritesCoalesced(artifactId: string, text: string) {
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

	async function museumWords(artifactId: string): Promise<string> {
		const data = (await storedBoard(artifactId)).nodes.find(
			(n) => n.id === "note-museum",
		)?.data;
		return data?.kind === "sticky" ? data.text : "";
	}

	async function newestBody(artifactId: string): Promise<string | null> {
		const [newest] = await listVersions({
			userId,
			artifactId,
			conversationId,
			limit: 1,
		});
		return newest
			? getVersionBody({
					userId,
					artifactId,
					conversationId,
					versionId: newest.id,
				})
			: null;
	}

	const rewriteMuseum = {
		op: "update_node",
		id: "note-museum",
		data: { text: "Museum, 14:00 — Alfy's words" },
	};
	const moveLunch = { op: "move", id: "note-1", to: { x: 30, y: 70 } };

	/** One turn: a read that fills the store, then the edit's own context. */
	async function turnThatRead(artifactId: string) {
		const knownBoards = createKnownBoards();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId,
			turnContext: { knownBoards },
			abortSignal: abortSignal(),
		});
		const sources = [
			{
				callId: "call-read",
				name: "read_artifact",
				input: { artifactId },
				status: "done" as const,
				metadata: read.metadata,
			},
		];
		return {
			knownBoards,
			read,
			edit: (ops: unknown[]) =>
				runEditArtifactTool({
					userId,
					conversationId,
					turnId: "turn-1",
					artifactId,
					abortSignal: abortSignal(),
					ops,
					turnContext: { sources, knownBoards },
				}),
		};
	}

	it("keeps the stored words a read showed, word for word, and puts them on neither the model's answer nor the record", async () => {
		const id = await seedBoard();
		const stored = (
			await getArtifact({ userId, artifactId: id, conversationId })
		)?.body;
		const knownBoards = createKnownBoards();

		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			detail: "blocks",
			turnContext: { knownBoards },
			abortSignal: abortSignal(),
		});

		expect(stored).toBeTruthy();
		expect(knownBoards.get(id)).toBe(stored);
		expect(JSON.stringify(read.modelPayload)).not.toContain(stored ?? "?");
		expect(JSON.stringify(read.metadata)).not.toContain("Lunch at the market");
		expect(JSON.stringify(read.metadata)).not.toContain('"nodes"');
	});

	it("refuses the note the reader rewrote even though the version id the read named is still the newest", async () => {
		const id = await seedBoard();
		const turn = await turnThatRead(id);
		await readerWritesCoalesced(id, "Museum, 16:30 (the reader's)");
		// The id the read recorded is the newest version's, as it was.
		const [newest] = await listVersions({
			userId,
			artifactId: id,
			conversationId,
			limit: 1,
		});
		expect(newest.id).toBe(turn.read.metadata.versionId);

		const result = await turn.edit([rewriteMuseum, moveLunch]);

		expect(result.modelPayload).toMatchObject({
			success: true,
			applied: 1,
			refused: [{ target: "note-museum", reason: "stale", opIndex: 0 }],
		});
		expect(await museumWords(id)).toBe("Museum, 16:30 (the reader's)");
	});

	it("moves what it knows forward to the version its own edit made, when the edit landed on the board it knew", async () => {
		const id = await seedBoard();
		const turn = await turnThatRead(id);
		const readWords = turn.knownBoards.get(id);

		const edited = await turn.edit([moveLunch]);

		expect(edited.modelPayload.success).toBe(true);
		expect(turn.knownBoards.get(id)).toBe(await newestBody(id));
		expect(turn.knownBoards.get(id)).not.toBe(readWords);
	});

	it("leaves what it knows where it was when its edit landed on top of words it never read", async () => {
		const id = await seedBoard();
		const turn = await turnThatRead(id);
		const readWords = turn.knownBoards.get(id);
		await readerWritesCoalesced(id, "Museum, 16:30 (the reader's)");

		const edited = await turn.edit([moveLunch]);

		expect(edited.modelPayload.success).toBe(true);
		expect(turn.knownBoards.get(id)).toBe(readWords);
		expect(await newestBody(id)).not.toBe(readWords);
	});

	it("does not move what it knows for an edit that changed nothing", async () => {
		const id = await seedBoard();
		const turn = await turnThatRead(id);
		const readWords = turn.knownBoards.get(id);
		const versions = await versionCount(id);

		const highlighted = await turn.edit([{ op: "highlight", ids: ["note-1"] }]);

		expect(highlighted.modelPayload.success).toBe(true);
		expect(await versionCount(id)).toBe(versions);
		expect(turn.knownBoards.get(id)).toBe(readWords);
	});

	it("falls back to the version it read for a board the turn no longer holds the words of", async () => {
		const id = await seedBoard();
		const read = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: id,
			abortSignal: abortSignal(),
		});
		// A save that starts a version of its own, which the version id can judge.
		const board = await storedBoard(id);
		const note = board.nodes.find((n) => n.id === "note-museum");
		if (!note) throw new Error("fixture");
		note.data = {
			kind: "sticky",
			text: "Museum, 16:30 (the reader's)",
			tone: "mint",
		};
		const saved = await saveCanvasBoard({
			userId,
			artifactId: id,
			conversationId,
			body: JSON.stringify(board),
			author: "user",
			summary: VERSION_SUMMARY.edited,
			coalesceUserEdits: false,
		});
		if (!saved.ok) throw new Error(`setup: ${saved.reason}`);

		const result = await runEditArtifactTool({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId: id,
			abortSignal: abortSignal(),
			ops: [rewriteMuseum],
			turnContext: {
				sources: [
					{
						callId: "call-read",
						name: "read_artifact",
						input: { artifactId: id },
						status: "done" as const,
						metadata: read.metadata,
					},
				],
				knownBoards: createKnownBoards(),
			},
		});

		expect(result.modelPayload.success).toBe(false);
		expect(await museumWords(id)).toBe("Museum, 16:30 (the reader's)");
	});
});
