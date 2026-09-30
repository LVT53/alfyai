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
} from "$lib/server/services/artifacts";
import {
	BOARD_OP_NAMES,
	boardOpsArraySchema,
	validateBoardDiff,
} from "$lib/shared/artifacts/board-ops";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { parseCanvasCreateBody } from "./canvas-model";
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

	it("refuses a block the model may not make, names the five it may, and writes nothing", async () => {
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
		for (const kind of ["frame", "sticky", "text", "checklist", "chart"]) {
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
