// The same two reads against the REAL search tool (`research-web-tool.ts`, the one
// module a chat's own `research_web` runs through, ruling 57), with only the search
// provider's client stubbed. The service test above stubs the tool, so what it
// cannot show is that what the tool really answers — its compacted model payload —
// is what the service reads a snapshot from, and that the session it asks for is a
// cache of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import {
	cloneBoard,
	sampleBoard,
} from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const researchWebViaParallel = vi.fn();
vi.mock("$lib/server/services/parallel-search/research", () => ({
	researchWebViaParallel: (...args: unknown[]) =>
		researchWebViaParallel(...args),
}));
vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({
		parallelApiKey: "test-key",
		parallelBaseUrl: "https://parallel.invalid",
	}),
}));
vi.mock("$lib/server/services/analytics", () => ({
	recordParallelUsage: vi.fn(async () => {}),
}));

const { createArtifact } = await import("./index");
const { refreshCanvasLiveWeb, searchCanvasLiveWeb } = await import(
	"./canvas-web"
);
const { resetWebReadLimitForTests } = await import("./canvas-web-limit");
const { resetToolResultCacheForTests } = await import(
	"$lib/server/services/normal-chat-tools/tool-result-cache"
);

const OWNER = "user-owner";
const CONVERSATION = "conv-owner";

function groundedResult(query: string, urls: string[]) {
	return {
		query,
		queries: [{ query }],
		sources: urls.map((url, index) => ({
			id: `src-${index}`,
			title: `Result ${index} <b>bold</b>`,
			url,
			provider: "parallel",
			authorityClass: "primary",
			authorityScore: 0.8,
			snippet: `Snippet ${index}`,
			highlights: [],
			providerRank: index + 1,
			publishedAt: "2026-09-30",
			updatedAt: null,
		})),
		evidence: urls.map((url, index) => ({
			id: `ev-${index}`,
			sourceId: `src-${index}`,
			title: `Result ${index}`,
			url,
			provider: "parallel",
			quote: `Quote ${index}`,
			score: 0.7,
		})),
		answerBrief: { markdown: "Brief.", instructions: [] },
		diagnostics: {},
	};
}

async function board() {
	const created = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "canvas",
		title: "Board",
		body: boardJson(cloneBoard(sampleBoard())),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

beforeEach(() => {
	resetWebReadLimitForTests();
	resetToolResultCacheForTests();
	researchWebViaParallel.mockReset();
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
});

afterEach(() => {
	memory.close();
});

describe("a live-web read through the real search tool", () => {
	it("turns what the tool really answers into a snapshot: the sources it returned, as a board keeps them", async () => {
		researchWebViaParallel.mockResolvedValue(
			groundedResult("weather in Salzburg", [
				"https://example.com/a",
				"https://example.org/b",
			]),
		);
		const id = await board();

		const result = await refreshCanvasLiveWeb({
			userId: OWNER,
			artifactId: id,
			nodeId: "web-1",
			conversationId: null,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toMatchObject({
			kind: "liveweb",
			query: "weather in Salzburg",
			sources: [
				{
					id: "src-0",
					url: "https://example.com/a",
					provider: "parallel",
					authorityClass: "primary",
					authorityScore: 0.8,
					publishedAt: "2026-09-30",
					updatedAt: null,
					snippet: "Snippet 0",
				},
				{ id: "src-1", url: "https://example.org/b" },
			],
		});
		// The provider was asked the stored query, as one bare query.
		const [request] = researchWebViaParallel.mock.calls[0];
		expect(request).toEqual({ query: "weather in Salzburg" });
	});

	it("asks the provider again on every read, so a refresh is never the answer a chat cached", async () => {
		researchWebViaParallel.mockResolvedValue(
			groundedResult("weather in Salzburg", ["https://example.com/a"]),
		);
		const id = await board();

		for (let index = 0; index < 3; index += 1) {
			await refreshCanvasLiveWeb({
				userId: OWNER,
				artifactId: id,
				nodeId: "web-1",
				conversationId: null,
			});
		}
		await searchCanvasLiveWeb({
			userId: OWNER,
			artifactId: id,
			query: "weather in Salzburg",
			conversationId: null,
		});

		expect(researchWebViaParallel).toHaveBeenCalledTimes(4);
	});

	it("says the search failed, and shows nothing of why, when the provider throws", async () => {
		researchWebViaParallel.mockRejectedValue(
			new Error("401 from https://parallel.invalid with key test-key"),
		);
		const id = await board();

		const result = await searchCanvasLiveWeb({
			userId: OWNER,
			artifactId: id,
			query: "anything",
			conversationId: null,
		});

		expect(result).toEqual({ ok: false, reason: "refresh_failed" });
	});

	it("says no_results when the provider found nothing", async () => {
		researchWebViaParallel.mockResolvedValue(groundedResult("nothing", []));
		const id = await board();
		const result = await searchCanvasLiveWeb({
			userId: OWNER,
			artifactId: id,
			query: "nothing",
			conversationId: null,
		});
		expect(result).toEqual({ ok: false, reason: "no_results" });
	});
});
