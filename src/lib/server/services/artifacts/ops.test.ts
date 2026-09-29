// The ops envelope against a real in-memory database: ownership → load →
// base-version check → dispatch on kind → validate → ONE version row → answer.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	applyOp,
	BOARD_OPS_EXAMPLE,
	type BoardOp,
} from "$lib/shared/artifacts/board-ops";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { seedConversation, seedUser } from "./artifacts.test-helpers";
import { canvasBodyHash } from "./serialize/canvas";

let memory: InMemoryDatabase;
// A hook for the two-writers test: runs once, just before the envelope's own write.
let beforeEnvelopeWrite: (() => Promise<void>) | null = null;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("./record", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./record")>();
	return {
		...actual,
		updateArtifactBody: async (
			params: Parameters<typeof actual.updateArtifactBody>[0],
		) => {
			const hook = beforeEnvelopeWrite;
			beforeEnvelopeWrite = null;
			if (hook && params.author === "alfy") await hook();
			return actual.updateArtifactBody(params);
		},
	};
});

const {
	applyArtifactOps,
	createArtifact,
	getArtifact,
	listVersions,
	saveCanvasBoard,
} = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const OTHER_CONVERSATION = "conv-owner-other";
const INCOGNITO = "conv-incognito";

beforeEach(() => {
	memory = createInMemoryDatabase();
	beforeEnvelopeWrite = null;
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER_CONVERSATION, userId: OWNER });
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
		body: boardJson(sampleBoard()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

async function currentVersionId(
	artifactId: string,
	conversationId = CONVERSATION,
) {
	const [newest] = await listVersions({
		userId: OWNER,
		artifactId,
		conversationId,
		limit: 1,
	});
	if (!newest) throw new Error("no version");
	return newest.id;
}

function versionRows(artifactId: string) {
	return memory.db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifactId))
		.all()
		.sort((a, b) => a.versionNumber - b.versionNumber);
}

function storedBody(artifactId: string): string | null {
	return (
		memory.db
			.select({ contentText: schema.artifacts.contentText })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get()?.contentText ?? null
	);
}

function payload(baseVersionId: string, ops: BoardOp[], summary = "Tidied") {
	return { baseVersionId, diff: { id: "diff-1", summary, ops } };
}

async function apply(
	artifactId: string,
	body: unknown,
	options: { userId?: string; conversationId?: string | null } = {},
) {
	return applyArtifactOps({
		userId: options.userId ?? OWNER,
		artifactId,
		conversationId:
			options.conversationId === undefined
				? CONVERSATION
				: options.conversationId,
		payload: body,
	});
}

const moveNote: BoardOp = {
	op: "move",
	id: "note-museum",
	to: { x: 640, y: 120 },
};

describe("applyArtifactOps — a diff that lands", () => {
	it("persists an accepted diff as ONE Alfy version, with the diff's summary and the canonical body", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const result = await apply(
			id,
			payload(base, BOARD_OPS_EXAMPLE, "Planned Sunday"),
		);

		if (!result.ok) throw new Error(result.reason);
		expect(result.applied).toBe(BOARD_OPS_EXAMPLE.length);
		expect(result.refused).toEqual([]);
		expect(result.version).toBe(2);
		expect(result.changed).toBe(true);

		const rows = versionRows(id);
		expect(rows.map((r) => [r.versionNumber, r.author])).toEqual([
			[1, "user"],
			[2, "alfy"],
		]);
		expect(rows[1].id).toBe(result.versionId);
		expect(rows[1].summary).toBe("Planned Sunday");

		let expected = sampleBoard();
		for (const op of BOARD_OPS_EXAMPLE) expected = applyOp(expected, op);
		expect(rows[1].body).toBe(boardJson(expected));
		expect(storedBody(id)).toBe(boardJson(expected));
		expect(rows[1].bodyHash).toBe(canvasBodyHash(boardJson(expected)));
	});

	it("never merges into the user's own version: an Alfy change always appends", async () => {
		const id = await createBoard();
		const board = sampleBoard();
		board.viewport = { x: 1, y: 1, zoom: 1 };
		const saved = await saveCanvasBoard({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			body: JSON.stringify(board),
			author: "user",
			summary: "Edited",
			coalesceUserEdits: true,
		});
		expect(saved.ok).toBe(true);

		const result = await apply(
			id,
			payload(await currentVersionId(id), [moveNote]),
		);

		if (!result.ok) throw new Error(result.reason);
		expect(result.version).toBe(3);
		expect(versionRows(id).map((r) => r.author)).toEqual([
			"user",
			"user",
			"alfy",
		]);
	});

	it("applies the rest of a batch when one op is refused, and reports the refusal with its index", async () => {
		const id = await createBoard();

		const result = await apply(
			id,
			payload(await currentVersionId(id), [
				{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
				moveNote,
			]),
		);

		if (!result.ok) throw new Error(result.reason);
		expect(result.applied).toBe(1);
		expect(result.refused).toEqual([
			expect.objectContaining({
				index: 0,
				op: "move",
				id: "ghost",
				reason: "unknown_id",
			}),
		]);
		expect(versionRows(id)).toHaveLength(2);
		const body = JSON.parse(storedBody(id) ?? "{}");
		expect(
			body.nodes.find((n: { id: string }) => n.id === "note-museum").position,
		).toEqual({ x: 640, y: 120 });
	});
});

describe("applyArtifactOps — a diff that changes nothing writes nothing", () => {
	it("leaves the board untouched when every op is refused, and says which version it is still at", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);
		const before = storedBody(id);

		const result = await apply(
			id,
			payload(base, [
				{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
				{ op: "remove_node", id: "phantom" },
			]),
		);

		if (!result.ok) throw new Error(result.reason);
		expect(result.applied).toBe(0);
		expect(result.changed).toBe(false);
		expect(result.refused).toHaveLength(2);
		expect(result.version).toBe(1);
		expect(result.versionId).toBe(base);
		expect(versionRows(id)).toHaveLength(1);
		expect(storedBody(id)).toBe(before);
	});

	it("writes no version for a diff that only points at nodes, or moves one to where it already is", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const pointing = await apply(
			id,
			payload(base, [{ op: "highlight", ids: ["text-1", "note-museum"] }]),
		);
		const staying = await apply(
			id,
			payload(base, [{ op: "move", id: "note-museum", to: { x: 500, y: 60 } }]),
		);

		for (const result of [pointing, staying]) {
			if (!result.ok) throw new Error(result.reason);
			expect(result.applied).toBe(1);
			expect(result.changed).toBe(false);
			expect(result.version).toBe(1);
			expect(result.versionId).toBe(base);
		}
		expect(versionRows(id)).toHaveLength(1);
	});
});

describe("applyArtifactOps — two writers, one board", () => {
	it("refuses a diff against a stale baseVersionId with a conflict that carries the current version", async () => {
		const id = await createBoard();
		const stale = await currentVersionId(id);
		const board = sampleBoard();
		board.viewport = { x: 9, y: 9, zoom: 2 };
		await saveCanvasBoard({
			userId: OWNER,
			artifactId: id,
			conversationId: CONVERSATION,
			body: JSON.stringify(board),
			author: "user",
			summary: "Edited",
		});

		const result = await apply(id, payload(stale, [moveNote]));

		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: 2,
		});
		expect(versionRows(id)).toHaveLength(2);
	});

	it("answers a base version that was never this board's the same way", async () => {
		const id = await createBoard();
		const result = await apply(id, payload("not-a-version", [moveNote]));
		expect(result).toMatchObject({
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: 1,
		});
	});

	it("does not write over a save that lands between its read and its write", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);
		const interfering = sampleBoard();
		interfering.viewport = { x: 77, y: 77, zoom: 1 };
		beforeEnvelopeWrite = async () => {
			await saveCanvasBoard({
				userId: OWNER,
				artifactId: id,
				conversationId: CONVERSATION,
				body: JSON.stringify(interfering),
				author: "user",
				summary: "Edited",
			});
		};

		const result = await apply(id, payload(base, [moveNote]));

		expect(result).toEqual({
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: 2,
		});
		// The interfering save stands; the diff wrote nothing over it.
		expect(versionRows(id).map((r) => r.author)).toEqual(["user", "user"]);
		expect(JSON.parse(storedBody(id) ?? "{}").viewport).toEqual({
			x: 77,
			y: 77,
			zoom: 1,
		});
	});
});

describe("applyArtifactOps — whose board, and what kind", () => {
	it("answers not_found, and writes nothing, for another user's board and for an id that does not exist", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const foreign = await apply(id, payload(base, [moveNote]), {
			userId: STRANGER,
		});
		const missing = await apply("does-not-exist", payload(base, [moveNote]));

		expect(foreign).toEqual({ ok: false, status: 404, reason: "not_found" });
		expect(missing).toEqual(foreign);
		expect(versionRows(id)).toHaveLength(1);
	});

	it("reaches an incognito board only from its own conversation, and never writes into it from another", async () => {
		const id = await createBoard(INCOGNITO);
		const base = await currentVersionId(id, INCOGNITO);

		const bare = await apply(id, payload(base, [moveNote]), {
			conversationId: null,
		});
		const other = await apply(id, payload(base, [moveNote]), {
			conversationId: OTHER_CONVERSATION,
		});
		expect(bare).toEqual({ ok: false, status: 404, reason: "not_found" });
		expect(other).toEqual(bare);
		expect(versionRows(id)).toHaveLength(1);

		const own = await apply(id, payload(base, [moveNote]), {
			conversationId: INCOGNITO,
		});
		expect(own.ok).toBe(true);
		expect(versionRows(id)).toHaveLength(2);
	});

	it("refuses a kind that has no ops branch with a 400, never a silent success", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Notes",
			body: "Hello.",
		});
		if (!created.ok) throw new Error(created.reason);
		const id = created.artifact.id;

		const result = await apply(
			id,
			payload(await currentVersionId(id), [moveNote]),
		);

		expect(result).toMatchObject({
			ok: false,
			status: 400,
			reason: "unsupported_kind",
		});
		expect(versionRows(id)).toHaveLength(1);
	});
});

describe("applyArtifactOps — a diff that cannot be read", () => {
	it("answers 400 invalid_diff, naming the valid ops, and writes nothing", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const result = await apply(id, {
			baseVersionId: base,
			diff: { id: "d", summary: "s", ops: [{ op: "move_node", id: "a" }] },
		});

		expect(result).toMatchObject({
			ok: false,
			status: 400,
			reason: "invalid_diff",
		});
		if (!result.ok)
			expect(result.detail).toContain("add_frame, add_node, move");
		expect(versionRows(id)).toHaveLength(1);
	});

	it("answers 400 invalid_diff for a payload that is not an envelope", async () => {
		const id = await createBoard();
		for (const bad of [
			null,
			"x",
			[],
			{},
			{ diff: {} },
			{ baseVersionId: "v" },
		]) {
			const result = await apply(id, bad);
			expect(result).toMatchObject({
				ok: false,
				status: 400,
				reason: "invalid_diff",
			});
		}
		expect(versionRows(id)).toHaveLength(1);
	});

	it("answers 400 invalid_diff for an empty batch and for a batch over the op cap", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);
		expect(await apply(id, payload(base, []))).toMatchObject({
			status: 400,
			reason: "invalid_diff",
		});
		const many = Array.from({ length: 41 }, () => moveNote);
		expect(await apply(id, payload(base, many))).toMatchObject({
			status: 400,
			reason: "invalid_diff",
		});
		expect(versionRows(id)).toHaveLength(1);
	});
});

describe("applyArtifactOps — a board it cannot read is not a reason to lose the diff", () => {
	it("starts from an empty board when the stored body is not a board, and the old body stays in history", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "canvas",
			title: "Broken",
			body: "{not json",
			author: "user",
		});
		if (!created.ok) throw new Error(created.reason);
		const id = created.artifact.id;

		const result = await apply(
			id,
			payload(await currentVersionId(id), [
				{
					op: "add_node",
					node: {
						id: "fresh",
						type: "text",
						position: { x: 0, y: 0 },
						data: { kind: "text", text: "Fresh start" },
					},
				},
			]),
		);

		if (!result.ok) throw new Error(result.reason);
		expect(result.applied).toBe(1);
		const rows = versionRows(id);
		expect(rows[0].body).toBe("{not json");
		expect(JSON.parse(rows[1].body).nodes).toHaveLength(1);
		expect(
			(await getArtifact({ userId: OWNER, artifactId: id }))?.bodyHash,
		).toBe(rows[1].bodyHash);
	});
});
