/**
 * The eval's Canvas tools answer as the app's do (decisions.md ruling 62): each
 * answer the simulator gives the model is compared, call for call, with what the
 * REAL tool answers for the same call against a real, migrated database. A
 * difference here is an eval measuring a model against tools the app does not
 * have.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";
import { createArtifact } from "$lib/server/services/artifacts";
import {
	buildCreateArtifactInputSchema,
	runCreateArtifactTool,
} from "$lib/server/services/normal-chat-tools/artifact-tools/create";
import {
	editArtifactInputSchema,
	runEditArtifactTool,
} from "$lib/server/services/normal-chat-tools/artifact-tools/edit";
import { runReadArtifactTool } from "$lib/server/services/normal-chat-tools/artifact-tools/read";
import { compactModelPayload } from "$lib/server/services/normal-chat-tools/shared";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { loadFixtureBoard } from "./canvas";
import { createCanvasTools } from "./canvas-tools";

const NOW = new Date("2026-09-29T12:00:00.000Z");
// One id per test: every test seeds its own board in the same database.
let ART = "";
const TITLE = "Vienna weekend";

let userId: string;
let conversationId: string;

beforeEach(() => {
	ART = randomUUID();
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

async function seed(board: CanvasBody): Promise<void> {
	const made = await createArtifact({
		userId,
		conversationId,
		id: ART,
		kind: "canvas",
		title: TITLE,
		body: boardJson(board),
		author: "user",
	});
	if (!made.ok) throw new Error("setup");
}

const signal = () => new AbortController().signal;

/** Ids the two sides mint for themselves are not part of what the model is told about the board. */
function comparable(payload: unknown): unknown {
	return JSON.parse(
		JSON.stringify(payload, (key, value) =>
			key === "versionId" ? "<version>" : value,
		),
	);
}

function editTools(board: CanvasBody) {
	return createCanvasTools({
		board,
		artifactId: ART,
		title: TITLE,
		allowCreate: false,
	});
}

async function realEdit(input: {
	ops?: unknown[];
	patches?: unknown[];
	summary?: string;
	artifactId?: string;
}) {
	const result = await runEditArtifactTool({
		userId,
		conversationId,
		turnId: "turn-1",
		artifactId: input.artifactId ?? ART,
		ops: input.ops,
		patches: input.patches,
		summary: input.summary,
		abortSignal: signal(),
	});
	return comparable(compactModelPayload(result.modelPayload));
}

const move = (id: string, x: number, y: number) => ({
	op: "move",
	id,
	to: { x, y },
});

describe("the eval's read answers as read_artifact does", () => {
	it.each([
		"blocks",
		"full",
		undefined,
	] as const)("a board, detail %s", async (detail) => {
		const board = loadFixtureBoard("vienna-messy");
		await seed(board);
		const real = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: ART,
			detail,
			abortSignal: signal(),
		});
		const args = { artifactId: ART, ...(detail ? { detail } : {}) };
		expect(
			comparable(
				JSON.parse(editTools(board).answer("read_artifact", args) ?? ""),
			),
		).toEqual(comparable(compactModelPayload(real.modelPayload)));
	});

	it("an id that is not here, with the conversation's own candidates", async () => {
		const board = loadFixtureBoard("vienna-tidy");
		await seed(board);
		const real = await runReadArtifactTool({
			userId,
			conversationId,
			artifactId: "nope",
			abortSignal: signal(),
		});
		expect(
			JSON.parse(
				editTools(board).answer("read_artifact", { artifactId: "nope" }) ?? "",
			),
		).toEqual(compactModelPayload(real.modelPayload));
	});
});

describe("the eval's edit answers as edit_artifact does", () => {
	const scenarios: Array<
		[
			string,
			{
				ops?: unknown[];
				patches?: unknown[];
				summary?: string;
				artifactId?: string;
			},
		]
	> = [
		[
			"a batch that lands whole",
			{
				ops: [
					{ op: "remove_node", id: "museum" },
					{
						op: "add_edge",
						edge: { id: "e3", source: "lunch", target: "walk" },
					},
				],
				summary: "Removed the museum",
			},
		],
		[
			"a batch that lands in part, and names why the rest did not",
			{
				ops: [
					move("lunch", 5, 5),
					move("ghost", 1, 1),
					{ op: "remove_edge", id: "nope" },
				],
			},
		],
		[
			"a batch in which every op is refused",
			{ ops: [move("ghost", 1, 1), { op: "highlight", ids: ["nowhere"] }] },
		],
		[
			"a highlight, which lands and changes nothing",
			{ ops: [{ op: "highlight", ids: ["lunch", "walk"] }] },
		],
		[
			"ops the schema cannot read",
			{
				ops: [
					{ op: "delete_node", id: "museum" },
					{ op: "connect", from: "a", to: "b" },
				],
			},
		],
		[
			"a block the model may not add",
			{
				ops: [
					{
						op: "add_node",
						node: {
							id: "m",
							type: "map",
							position: { x: 0, y: 0 },
							data: { kind: "sticky", text: "x", tone: "plain" },
						},
					},
				],
			},
		],
		["patches for a board", { patches: [{ op: "replaceBlock" }] }],
		["both patches and ops", { patches: [{}], ops: [move("lunch", 1, 1)] }],
		["neither", {}],
		[
			"an id that is not the board's",
			{ ops: [move("lunch", 1, 1)], artifactId: "other" },
		],
	];

	it.each(scenarios)("%s", async (_name, input) => {
		const board = loadFixtureBoard("vienna-tidy");
		await seed(board);
		const real = await realEdit(input);
		const gate = editArtifactInputSchema.safeParse({
			artifactId: input.artifactId ?? ART,
			...input,
		});
		expect(gate.success, "the scenarios stay inside the tool's own gate").toBe(
			true,
		);
		const simulated = comparable(
			JSON.parse(
				editTools(board).answer("edit_artifact", {
					artifactId: input.artifactId ?? ART,
					...input,
				}) ?? "",
			),
		);
		expect(simulated).toEqual(real);
	});

	it("tells the tool's own gate's message for an empty ops list, a missing id and a summary that is too long, as the tool does", () => {
		for (const input of [
			{ artifactId: ART, ops: [] },
			{ ops: [move("lunch", 1, 1)] },
			{ artifactId: ART, ops: [move("lunch", 1, 1)], summary: "x".repeat(201) },
		]) {
			const real = editArtifactInputSchema.safeParse(input);
			const simulated = JSON.parse(
				editTools(loadFixtureBoard("vienna-tidy")).answer(
					"edit_artifact",
					input,
				) ?? "",
			);
			expect(real.success).toBe(false);
			expect(simulated.error).toBe(real.error?.issues[0]?.message);
		}
	});

	it("goes on from the board a change left: the next read and the next edit see it", async () => {
		const board = loadFixtureBoard("vienna-tidy");
		const tools = editTools(board);
		tools.answer("edit_artifact", {
			artifactId: ART,
			ops: [move("lunch", 300, 300)],
		});
		const read = JSON.parse(
			tools.answer("read_artifact", { artifactId: ART, detail: "blocks" }) ??
				"",
		);
		expect(
			read.blocks.find((b: { id: string }) => b.id === "lunch"),
		).toMatchObject({ x: 300, y: 300 });
		expect(tools.writes()).toBe(1);
	});
});

describe("the eval's create answers as create_artifact does", () => {
	const createTools = () =>
		createCanvasTools({
			board: null,
			artifactId: "unused",
			title: "",
			allowCreate: true,
		});

	async function realCreate(body: string, title = TITLE) {
		const result = await runCreateArtifactTool({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactType: "canvas",
			title,
			body,
			language: "en",
			abortSignal: signal(),
		});
		return JSON.parse(
			JSON.stringify(compactModelPayload(result.modelPayload), (key, value) =>
				key === "artifactId" ? "<id>" : value,
			),
		);
	}

	function simulatedCreate(body: string, title = TITLE) {
		return JSON.parse(
			JSON.stringify(
				JSON.parse(
					createTools().answer("create_artifact", {
						artifactType: "canvas",
						title,
						body,
					}) ?? "",
				),
				(key, value) => (key === "artifactId" ? "<id>" : value),
			),
		);
	}

	const board = JSON.stringify({
		nodes: [
			{
				id: "f",
				type: "frame",
				position: { x: 0, y: 0 },
				data: { kind: "frame", label: "Sat", width: 300, height: 200 },
			},
			{
				id: "n",
				type: "sticky",
				parentId: "f",
				position: { x: 10, y: 50 },
				data: { kind: "sticky", text: "Museum", tone: "mint" },
			},
		],
		edges: [],
	});

	it.each([
		["a board", board],
		["an empty board", "{}"],
		["a body that is not JSON", '{"nodes": ['],
		[
			"a block the model may not make",
			JSON.stringify({
				nodes: [
					{
						id: "m",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
				],
			}),
		],
		[
			"an edge among the nodes",
			JSON.stringify({ nodes: [{ id: "e1", source: "a", target: "b" }] }),
		],
	])("%s", async (_name, body) => {
		expect(simulatedCreate(body)).toEqual(await realCreate(body));
	});

	it("a blank title, which the row itself refuses", async () => {
		expect(simulatedCreate(board, " ")).toEqual(await realCreate(board, " "));
	});

	it("the tool's own gate's messages for a missing title and a missing body", () => {
		for (const input of [
			{ artifactType: "canvas", body: "{}" },
			{ artifactType: "canvas", title: "T" },
			{ artifactType: "canvas", title: "T", body: "" },
			{ artifactType: "canvas", title: "x".repeat(201), body: "{}" },
		]) {
			const real = buildCreateArtifactInputSchema().safeParse(input);
			const simulated = JSON.parse(
				createTools().answer("create_artifact", input) ?? "",
			);
			expect(real.success).toBe(false);
			expect(simulated.error).toBe(real.error?.issues[0]?.message);
		}
	});

	it("goes on from the board it made: the next read and edit are about it", () => {
		const tools = createTools();
		const made = JSON.parse(
			tools.answer("create_artifact", {
				artifactType: "canvas",
				title: "T",
				body: board,
			}) ?? "",
		);
		expect(made).toMatchObject({
			success: true,
			artifactType: "canvas",
			title: "T",
		});
		const read = JSON.parse(
			tools.answer("read_artifact", {
				artifactId: made.artifactId,
				detail: "blocks",
			}) ?? "",
		);
		expect(read.blocks.map((b: { id: string }) => b.id)).toEqual(["f", "n"]);
		const edited = JSON.parse(
			tools.answer("edit_artifact", {
				artifactId: made.artifactId,
				ops: [move("n", 20, 60)],
			}) ?? "",
		);
		expect(edited).toMatchObject({ success: true, applied: 1 });
	});
});
