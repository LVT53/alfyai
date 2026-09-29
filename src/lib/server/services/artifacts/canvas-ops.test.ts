// The Canvas's save seam, against a real in-memory database: a board a client
// sends is stored in its canonical form and hashed as stored (ruling 12), never
// as the client happened to write it.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	cloneBoard,
	sampleBoard,
} from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { seedConversation, seedUser } from "./artifacts.test-helpers";
import { canvasBodyHash } from "./serialize/canvas";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, getArtifact, saveCanvasBoard } = await import(
	"./index"
);

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

async function createBoard(conversationId = CONVERSATION) {
	const created = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "canvas",
		title: "Weekend board",
		body: boardJson(emptyCanvasBody()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

function versionRows(artifactId: string) {
	return memory.db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifactId))
		.all();
}

/** A board as a live client would send it: pretty-printed, library state written back, float noise on a position. */
function liveBoardFromClient(): string {
	const live = cloneBoard(sampleBoard()) as unknown as {
		nodes: Record<string, unknown>[];
	};
	live.nodes[1] = {
		...live.nodes[1],
		selected: true,
		dragging: false,
		measured: { width: 190, height: 84 },
	};
	live.nodes[2] = {
		...live.nodes[2],
		position: { x: 500.00000000000006, y: 60 },
	};
	return JSON.stringify(live, null, 2);
}

describe("saveCanvasBoard", () => {
	it("stores the canonical form, not the client's string, and hashes what it stored", async () => {
		const id = await createBoard();
		const result = await saveCanvasBoard({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			body: liveBoardFromClient(),
			author: "user",
			summary: "Edited",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const stored = await getArtifact({ userId: OWNER, artifactId: id });
		expect(stored?.body).toBe(boardJson(sampleBoard()));
		expect(stored?.body).not.toContain("selected");
		expect(result.bodyHash).toBe(canvasBodyHash(stored?.body ?? ""));
		expect(stored?.bodyHash).toBe(result.bodyHash);
		const newest = versionRows(id).sort(
			(a, b) => b.versionNumber - a.versionNumber,
		)[0];
		expect(newest.bodyHash).toBe(result.bodyHash);
		expect(newest.body).toBe(boardJson(sampleBoard()));
	});

	it("gives the same hash for the same board however the client wrote it", async () => {
		const a = await createBoard();
		const b = await createBoard();
		const save = (id: string, body: string) =>
			saveCanvasBoard({
				userId: OWNER,
				artifactId: id,
				conversationId: CONVERSATION,
				body,
				author: "user",
				summary: "Edited",
			});
		const first = await save(a, liveBoardFromClient());
		const second = await save(b, JSON.stringify(sampleBoard()));
		if (!first.ok || !second.ok) throw new Error("save failed");
		expect(first.bodyHash).toBe(second.bodyHash);
	});

	it("reports what it left out instead of hiding it", async () => {
		const id = await createBoard();
		const board = cloneBoard(sampleBoard());
		board.edges.push({ id: "dangling", source: "note-1", target: "ghost" });
		const result = await saveCanvasBoard({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			body: JSON.stringify(board),
			author: "user",
			summary: "Edited",
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.dropped).toEqual({ nodes: 0, edges: 1, annotations: 0 });
	});

	it("refuses a body that is not a board, and writes nothing", async () => {
		const id = await createBoard();
		const before = versionRows(id).length;
		for (const body of ["", "{not json", "[]", "null"]) {
			const result = await saveCanvasBoard({
				userId: OWNER,
				artifactId: id,
				conversationId: CONVERSATION,
				body,
				author: "user",
				summary: "Edited",
			});
			expect(result).toEqual({ ok: false, reason: "invalid_body" });
		}
		expect(versionRows(id)).toHaveLength(before);
	});

	it("refuses a board past its caps as too_large, and writes nothing", async () => {
		const id = await createBoard();
		const before = versionRows(id).length;
		const nodes = Array.from({ length: 401 }, (_, i) => ({
			id: `n${i}`,
			type: "text",
			position: { x: i, y: 0 },
			data: { kind: "text", text: "x" },
		}));
		const result = await saveCanvasBoard({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			body: JSON.stringify({ nodes }),
			author: "user",
			summary: "Edited",
		});
		expect(result).toEqual({ ok: false, reason: "too_large" });
		expect(versionRows(id)).toHaveLength(before);
	});

	it("answers not_found, and writes nothing, for another user's board and for one that does not exist", async () => {
		const id = await createBoard();
		const before = versionRows(id).length;
		const params = {
			body: JSON.stringify(sampleBoard()),
			author: "user" as const,
			summary: "Edited",
		};
		const foreign = await saveCanvasBoard({
			userId: STRANGER,
			artifactId: id,
			...params,
		});
		const missing = await saveCanvasBoard({
			userId: OWNER,
			artifactId: "does-not-exist",
			...params,
		});
		expect(foreign).toEqual({ ok: false, reason: "not_found" });
		expect(missing).toEqual({ ok: false, reason: "not_found" });
		expect(versionRows(id)).toHaveLength(before);
	});

	it("reaches an incognito board only from its own conversation", async () => {
		const id = await createBoard(INCOGNITO);
		const params = {
			userId: OWNER,
			artifactId: id,
			body: JSON.stringify(sampleBoard()),
			author: "user" as const,
			summary: "Edited",
		};
		expect(await saveCanvasBoard(params)).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(
			await saveCanvasBoard({ ...params, conversationId: CONVERSATION }),
		).toEqual({ ok: false, reason: "not_found" });
		const own = await saveCanvasBoard({ ...params, conversationId: INCOGNITO });
		expect(own.ok).toBe(true);
	});

	it("keeps the two-writers guards: a stale version is refused, and a user burst still coalesces", async () => {
		const id = await createBoard();
		const save = (body: string, expectVersion?: number) =>
			saveCanvasBoard({
				userId: OWNER,
				artifactId: id,
				conversationId: CONVERSATION,
				body,
				author: "user",
				summary: "Edited",
				expectVersion,
				coalesceUserEdits: true,
			});
		const first = await save(JSON.stringify(sampleBoard()), 1);
		if (!first.ok) throw new Error(first.reason);
		expect(first.version).toBe(2);
		// A second save in the same burst updates that version in place.
		const board = cloneBoard(sampleBoard());
		board.viewport = { x: 5, y: 5, zoom: 1 };
		const second = await save(JSON.stringify(board), 2);
		if (!second.ok) throw new Error(second.reason);
		expect(second.version).toBe(2);
		expect(versionRows(id)).toHaveLength(2);
		// A writer that still holds version 1 is refused.
		expect(await save(JSON.stringify(sampleBoard()), 1)).toEqual({
			ok: false,
			reason: "version_conflict",
		});
	});
});
