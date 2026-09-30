// POST /api/artifacts/[id]/ops against a real in-memory database and two real
// users — no mocks past the database — because ownership is the thing under
// test: the route is thin, and what it must never do is reveal or write another
// user's board.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import {
	BOARD_OPS_EXAMPLE,
	type BoardOp,
} from "$lib/shared/artifacts/board-ops";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, listVersions } = await import(
	"$lib/server/services/artifacts"
);
const { POST } = await import("./+server");

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

function event(params: {
	artifactId: string;
	userId?: string | null;
	body?: unknown;
	conversationId?: string | null;
	contentLength?: number;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	const userId = params.userId === undefined ? OWNER : params.userId;
	return {
		params: { id: params.artifactId },
		url: new URL(
			`http://localhost/api/artifacts/${params.artifactId}/ops${query}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: {
			json: async () => {
				if (params.body === undefined) throw new SyntaxError("no body");
				return params.body;
			},
			headers: new Headers(
				params.contentLength === undefined
					? {}
					: { "content-length": String(params.contentLength) },
			),
		},
	} as never;
}

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
	return newest.id;
}

function versionCount(artifactId: string): number {
	return memory.db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifactId))
		.all().length;
}

function body(baseVersionId: string, ops: BoardOp[], summary = "Tidied") {
	return { baseVersionId, diff: { id: "diff-1", summary, ops } };
}

const moveNote: BoardOp = {
	op: "move",
	id: "note-museum",
	to: { x: 640, y: 120 },
};

describe("POST /api/artifacts/[id]/ops", () => {
	it("throws 401 with no authenticated user, before it reads anything (ruling 39)", async () => {
		const id = await createBoard();
		await expect(
			POST(
				event({ artifactId: id, userId: null, body: body("v", [moveNote]) }),
			),
		).rejects.toMatchObject({ status: 401 });
		expect(versionCount(id)).toBe(1);
	});

	it("answers { ok: true, versionId, version, applied, refused, changed } for a diff that lands", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const response = await POST(
			event({
				artifactId: id,
				body: body(base, BOARD_OPS_EXAMPLE, "Planned Sunday"),
			}),
		);

		expect(response.status).toBe(200);
		const answer = await response.json();
		expect(answer).toEqual({
			ok: true,
			versionId: await currentVersionId(id),
			version: 2,
			applied: BOARD_OPS_EXAMPLE.length,
			refused: [],
			changed: true,
		});
		expect(versionCount(id)).toBe(2);
	});

	// RV-3 Minor 6: the route is callable from a browser, so what it writes is the
	// caller's own change — never an "Alfy" version carrying the caller's free text
	// (the Versions popover shows Alfy's summaries as Alfy's words), and never the
	// review marker that makes an Alfy change wait for Keep or Undo.
	it("writes what a browser sends as the user's own version, with the ordinary summary, and starts no review", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const response = await POST(
			event({
				artifactId: id,
				body: body(base, BOARD_OPS_EXAMPLE, "Alfy tidied everything up"),
			}),
		);

		expect(response.status).toBe(200);
		const [newest] = memory.db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, id))
			.all()
			.sort((a, b) => b.versionNumber - a.versionNumber);
		expect(newest.versionNumber).toBe(2);
		expect(newest.author).toBe("user");
		expect(newest.summary).toBe("Edited");
		const [row] = memory.db
			.select({ metadataJson: schema.artifacts.metadataJson })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, id))
			.all();
		expect(JSON.parse(row.metadataJson ?? "{}")).not.toHaveProperty("review");
	});

	it("reports what it skipped, with each op's index, name, target and reason", async () => {
		const id = await createBoard();

		const response = await POST(
			event({
				artifactId: id,
				body: body(await currentVersionId(id), [
					{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
					moveNote,
				]),
			}),
		);

		expect(response.status).toBe(200);
		const answer = await response.json();
		expect(answer.applied).toBe(1);
		expect(answer.refused).toEqual([
			expect.objectContaining({
				index: 0,
				op: "move",
				id: "ghost",
				reason: "unknown_id",
				detail: expect.stringContaining("ghost"),
			}),
		]);
	});

	it("writes nothing, and says so, when every op is refused", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const response = await POST(
			event({
				artifactId: id,
				body: body(base, [{ op: "remove_node", id: "ghost" }]),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			versionId: base,
			version: 1,
			applied: 0,
			changed: false,
		});
		expect(versionCount(id)).toBe(1);
	});

	it("answers 409 { ok: false, reason: 'version_conflict', version } for a stale base version", async () => {
		const id = await createBoard();
		const stale = await currentVersionId(id);
		await POST(event({ artifactId: id, body: body(stale, [moveNote]) }));

		const response = await POST(
			event({ artifactId: id, body: body(stale, [moveNote]) }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "version_conflict",
			version: 2,
		});
		expect(versionCount(id)).toBe(2);
	});

	it("answers a foreign board and a missing one with byte-identical 404s, and writes nothing", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const foreign = await POST(
			event({ artifactId: id, userId: STRANGER, body: body(base, [moveNote]) }),
		);
		const missing = await POST(
			event({ artifactId: "does-not-exist", body: body(base, [moveNote]) }),
		);

		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		const foreignText = await foreign.text();
		expect(foreignText).toBe(await missing.text());
		expect(foreignText).toBe('{"ok":false,"reason":"not_found"}');
		expect(versionCount(id)).toBe(1);
	});

	it("reaches an incognito board only when it names the conversation it was made in", async () => {
		const id = await createBoard(INCOGNITO);
		const base = await currentVersionId(id, INCOGNITO);

		const without = await POST(
			event({ artifactId: id, body: body(base, [moveNote]) }),
		);
		expect(without.status).toBe(404);
		expect(versionCount(id)).toBe(1);

		const withIt = await POST(
			event({
				artifactId: id,
				conversationId: INCOGNITO,
				body: body(base, [moveNote]),
			}),
		);
		expect(withIt.status).toBe(200);
		expect(versionCount(id)).toBe(2);
	});

	it("answers 400 invalid_diff, naming the valid ops, for a diff it cannot read", async () => {
		const id = await createBoard();
		const base = await currentVersionId(id);

		const response = await POST(
			event({
				artifactId: id,
				body: {
					baseVersionId: base,
					diff: { id: "d", summary: "s", ops: [{ op: "move_node", id: "a" }] },
				},
			}),
		);

		expect(response.status).toBe(400);
		const answer = await response.json();
		expect(answer).toMatchObject({ ok: false, reason: "invalid_diff" });
		expect(answer.detail).toContain("add_frame, add_node, move");
		expect(versionCount(id)).toBe(1);
	});

	it("answers 400 invalid_diff when the body is not JSON at all", async () => {
		const id = await createBoard();
		const response = await POST(event({ artifactId: id }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			ok: false,
			reason: "invalid_diff",
		});
	});

	it("answers 400 unsupported_kind for a kind that has no ops branch", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Notes",
			body: "Hello.",
		});
		if (!created.ok) throw new Error(created.reason);
		const id = created.artifact.id;

		const response = await POST(
			event({
				artifactId: id,
				body: body(await currentVersionId(id), [moveNote]),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			ok: false,
			reason: "unsupported_kind",
		});
	});

	it("answers 413 for a request that says it is far larger than any diff, without reading it", async () => {
		const id = await createBoard();
		const json = vi.fn();
		const request = event({
			artifactId: id,
			body: body("v", [moveNote]),
			contentLength: 10 * 1024 * 1024,
		}) as unknown as { request: { json: () => unknown } };
		request.request.json = json;

		const response = await POST(request as never);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ ok: false, reason: "too_large" });
		expect(json).not.toHaveBeenCalled();
	});
});
