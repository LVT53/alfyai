// GET and POST /api/artifacts/[id]/review for a board, against a real in-memory
// database and two real users (ruling 63): the pending change is recomputed on
// every read, Keep moves the marker, and the answer for a foreign board is the
// answer for a missing one, byte for byte. A Document's answers are unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import type { BoardOp } from "$lib/shared/artifacts/board-ops";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { applyArtifactOps, createArtifact, listVersions } = await import(
	"$lib/server/services/artifacts"
);
const { GET, POST } = await import("./+server");

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
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	const userId = params.userId === undefined ? OWNER : params.userId;
	return {
		params: { id: params.artifactId },
		url: new URL(
			`http://localhost/api/artifacts/${params.artifactId}/review${query}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: {
			json: async () => {
				if (params.body === undefined) throw new SyntaxError("no body");
				return params.body;
			},
		},
	} as never;
}

async function boardWithAlfyChange(
	ops: BoardOp[] = [{ op: "move", id: "note-museum", to: { x: 700, y: 90 } }],
	conversationId = CONVERSATION,
) {
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
	const id = created.artifact.id;
	const [newest] = await listVersions({
		userId: OWNER,
		artifactId: id,
		conversationId,
		limit: 1,
	});
	const applied = await applyArtifactOps({
		userId: OWNER,
		artifactId: id,
		conversationId,
		payload: {
			baseVersionId: newest.id,
			diff: { id: "d", summary: "Planned Sunday", ops },
		},
	});
	if (!applied.ok) throw new Error(applied.reason);
	return id;
}

describe("GET /api/artifacts/[id]/review on a board", () => {
	it("answers what waits for the reader, as one change, with its Undo", async () => {
		const id = await boardWithAlfyChange();
		const response = await GET(
			event({ artifactId: id, conversationId: CONVERSATION }),
		);
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload).toMatchObject({
			ok: true,
			kind: "canvas",
			review: {
				count: 1,
				touchedIds: ["note-museum"],
				latestAlfyVersion: 2,
				undo: {
					available: true,
					toVersion: 1,
					toVersionId: expect.any(String),
				},
			},
		});
		expect(payload.review.changes[0].summary).toBe("Planned Sunday");
	});

	it("answers 401 without a session", async () => {
		const id = await boardWithAlfyChange();
		const attempt = GET(event({ artifactId: id, userId: null }));
		await expect(attempt).rejects.toMatchObject({ status: 401 });
	});

	it("answers a foreign board exactly as a missing one", async () => {
		const id = await boardWithAlfyChange();
		const foreign = await GET(event({ artifactId: id, userId: STRANGER }));
		const missing = await GET(event({ artifactId: "no-such-board" }));
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		const foreignBody = await foreign.text();
		expect(foreignBody).toBe(await missing.text());
		expect(foreignBody).toBe('{"ok":false,"reason":"not_found"}');
	});

	it("reads an incognito conversation's board only with its own conversation id", async () => {
		const id = await boardWithAlfyChange(undefined, INCOGNITO);
		expect((await GET(event({ artifactId: id }))).status).toBe(404);
		expect(
			(await GET(event({ artifactId: id, conversationId: CONVERSATION })))
				.status,
		).toBe(404);
		expect(
			(await GET(event({ artifactId: id, conversationId: INCOGNITO }))).status,
		).toBe(200);
	});
});

describe("POST /api/artifacts/[id]/review on a board (Keep)", () => {
	it("moves the marker past the change it was shown", async () => {
		const id = await boardWithAlfyChange();
		const response = await POST(
			event({
				artifactId: id,
				conversationId: CONVERSATION,
				body: { throughVersion: 2 },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			kind: "canvas",
			review: { count: 0 },
		});
		const again = await GET(
			event({ artifactId: id, conversationId: CONVERSATION }),
		);
		expect((await again.json()).review.count).toBe(0);
	});

	it("keeps nothing for a stranger, and says the same as for a missing board", async () => {
		const id = await boardWithAlfyChange();
		const response = await POST(
			event({ artifactId: id, userId: STRANGER, body: { throughVersion: 2 } }),
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('{"ok":false,"reason":"not_found"}');
		const still = await GET(
			event({ artifactId: id, conversationId: CONVERSATION }),
		);
		expect((await still.json()).review.count).toBe(1);
	});

	it("reads a body that is not JSON as nothing to keep", async () => {
		const id = await boardWithAlfyChange();
		const response = await POST(
			event({ artifactId: id, conversationId: CONVERSATION }),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).review.count).toBe(1);
	});
});

describe("a Document keeps its own answers", () => {
	it("answers { ok, pending } as before", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Plan",
			body: "# Plan\n\nBook the hotel.",
			author: "user",
			versionSummary: "Created",
		});
		if (!created.ok) throw new Error(created.reason);
		const response = await GET(
			event({ artifactId: created.artifact.id, conversationId: CONVERSATION }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, pending: [] });
	});
});

describe("a kind with no review", () => {
	it("answers like a missing id", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "app",
			title: "Splitter",
			body: "<!doctype html><html><body>Hi</body></html>",
			author: "alfy",
			versionSummary: "Alfy wrote the first draft",
		});
		if (!created.ok) throw new Error(created.reason);
		const response = await GET(
			event({ artifactId: created.artifact.id, conversationId: CONVERSATION }),
		);
		expect(response.status).toBe(404);
	});
});
