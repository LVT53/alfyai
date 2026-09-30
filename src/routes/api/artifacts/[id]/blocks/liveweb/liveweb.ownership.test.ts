// A new web search from a board's Insert menu through the real route, service and
// database. The board only gives the search its scope: another user's board, a
// missing one and an incognito chat's board read from outside that chat answer
// alike, and what is searched is the query in the body, judged by the service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const executeResearch = vi.fn();
vi.mock("$lib/server/services/normal-chat-tools/research-web-tool", () => ({
	createResearchWebTool: () => ({ execute: executeResearch }),
}));

const { createArtifact } = await import("$lib/server/services/artifacts");
const { resetWebReadLimitForTests } = await import(
	"$lib/server/services/artifacts/canvas-web-limit"
);
const { POST } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const NORMAL = "conv-normal";
const INCOGNITO = "conv-incognito";
const STRANGER_CHAT = "conv-stranger";

const ANSWER = {
	success: true,
	sources: [
		{
			id: "s1",
			title: "Result",
			url: "https://example.com/r",
			provider: "parallel",
			authorityClass: "primary",
			authorityScore: 0.9,
			publishedAt: null,
			updatedAt: null,
		},
	],
};

function event(params: {
	artifactId: string;
	userId: string | null;
	conversationId?: string | null;
	body?: unknown;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	const url = `http://localhost/api/artifacts/${params.artifactId}/blocks/liveweb${query}`;
	return {
		params: { id: params.artifactId },
		url: new URL(url),
		request: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params.body ?? { query: "cork weather" }),
		}),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

async function board(conversationId: string, userId = OWNER) {
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Board",
		body: boardJson(emptyCanvasBody()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

beforeEach(() => {
	resetWebReadLimitForTests();
	executeResearch.mockReset();
	executeResearch.mockResolvedValue(ANSWER);
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: NORMAL, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CHAT, userId: STRANGER });
});

afterEach(() => {
	memory.close();
});

describe("POST /api/artifacts/[id]/blocks/liveweb, against the real scope", () => {
	it("searches for the reader's query, answers the snapshot and writes nothing", async () => {
		const id = await board(NORMAL);
		const versions = memory.db
			.select()
			.from(schema.artifactVersions)
			.all().length;

		const response = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				body: { query: "  cork weather  " },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				kind: "liveweb",
				query: "cork weather",
				sources: [{ url: "https://example.com/r" }],
			},
		});
		expect(executeResearch.mock.calls[0][0]).toEqual({ query: "cork weather" });
		expect(memory.db.select().from(schema.artifactVersions).all()).toHaveLength(
			versions,
		);
	});

	it("answers another user's board exactly as a missing id, byte for byte, whatever the query, and searches nothing", async () => {
		const theirs = await board(STRANGER_CHAT, STRANGER);

		const foreign = await POST(event({ artifactId: theirs, userId: OWNER }));
		const missing = await POST(
			event({ artifactId: "no-such-board", userId: OWNER }),
		);
		const foreignBadQuery = await POST(
			event({ artifactId: theirs, userId: OWNER, body: { query: "" } }),
		);

		expect(foreign.status).toBe(404);
		expect(await foreign.text()).toBe(await missing.text());
		expect(foreignBadQuery.status).toBe(404);
		expect(executeResearch).not.toHaveBeenCalled();
	});

	it("keeps an incognito chat's board to that chat", async () => {
		const id = await board(INCOGNITO);
		expect((await POST(event({ artifactId: id, userId: OWNER }))).status).toBe(
			404,
		);
		expect(
			(
				await POST(
					event({ artifactId: id, userId: OWNER, conversationId: NORMAL }),
				)
			).status,
		).toBe(404);
		expect(executeResearch).not.toHaveBeenCalled();
		expect(
			(
				await POST(
					event({ artifactId: id, userId: OWNER, conversationId: INCOGNITO }),
				)
			).status,
		).toBe(200);
	});

	it("refuses a query a block could not keep with a 400 and searches nothing", async () => {
		const id = await board(NORMAL);
		for (const query of ["", "   ", "x".repeat(501), "a\nb", 42, null]) {
			const response = await POST(
				event({ artifactId: id, userId: OWNER, body: { query } }),
			);
			expect(response.status, String(query)).toBe(400);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "invalid_query",
			});
		}
		expect(executeResearch).not.toHaveBeenCalled();
	});

	it("gives only web addresses back, and a 422 when nothing is left", async () => {
		const id = await board(NORMAL);
		executeResearch.mockResolvedValue({
			success: true,
			sources: [{ ...ANSWER.sources[0], url: "javascript:alert(1)" }],
		});
		const response = await POST(event({ artifactId: id, userId: OWNER }));
		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "no_results",
		});
	});

	it("answers 429 with a Retry-After once the reader has searched too often", async () => {
		const id = await board(NORMAL);
		let last: Response | null = null;
		for (let index = 0; index < 11; index += 1) {
			last = await POST(event({ artifactId: id, userId: OWNER }));
		}
		expect(last?.status).toBe(429);
		expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
	});
});
