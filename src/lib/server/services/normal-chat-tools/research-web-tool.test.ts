import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParallelApiError } from "$lib/server/services/parallel-search/client";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import type { GroundedWebResult } from "$lib/server/services/parallel-search/types";
import {
	buildGroundedWebModelPayload,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
import {
	bindReadResultGrant,
	boundedWebReadFailure,
} from "./model-payload-budget";
import { createResearchWebTool } from "./research-web-tool";
import {
	compactModelPayload,
	createToolCallRecorder,
	type ToolCallRecorder,
} from "./shared";
import { resetToolResultCacheForTests } from "./tool-result-cache";

// research_web's rows say what happened from a reason code on the entry's
// metadata. The code rides beside the model's payload: what the model reads, the
// entry's outputSummary and its stored status are what they always were.

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		parallelApiKey: "parallel-key",
		parallelBaseUrl: "https://api.parallel.ai",
	})),
}));
vi.mock("$lib/server/services/analytics", () => ({
	recordParallelUsage: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/server/services/parallel-search/research", () => ({
	researchWebViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/parallel-search/fetch-url", () => ({
	fetchUrlViaParallel: vi.fn(),
}));

const researchWebViaParallelMock = vi.mocked(researchWebViaParallel);

const SOURCE = {
	id: "p0",
	provider: "parallel",
	title: "Page 0",
	url: "https://found.example/a",
	highlights: [],
	providerRank: 0,
	publishedAt: null,
	updatedAt: null,
	authorityClass: "standard",
	authorityScore: 50,
};

function groundedResult(params: {
	snippet?: string | null;
	withEvidence?: boolean;
	noSources?: boolean;
}): GroundedWebResult {
	const sources = params.noSources
		? []
		: [{ ...SOURCE, snippet: params.snippet ?? null }];
	return {
		query: "q",
		queries: [{ query: "q" }],
		sources,
		evidence:
			params.withEvidence && !params.noSources
				? [
						{
							id: "p0e0",
							sourceId: "p0",
							title: "Page 0",
							url: SOURCE.url,
							provider: "parallel",
							quote: "A quote.",
							score: 1,
						},
					]
				: [],
		answerBrief: {
			markdown: "Brief.",
			instructions: ["Answer only from these sources."],
		},
		diagnostics: {
			mode: "turbo",
			freshness: "auto",
			sourcePolicy: "general",
			plannedQueryCount: 1,
			directUrlCount: 0,
			fetchedSourceCount: sources.length,
			fusedSourceCount: sources.length,
			selectedSourceCount: sources.length,
			openedPageCount: 0,
			pageExtraction: {
				attemptedCount: 0,
				succeededCount: 0,
				cacheHitCount: 0,
				lowQualityCount: 0,
				blockedCount: 0,
				failedCount: 0,
				totalLatencyMs: 0,
			},
			evidenceCandidateCount: 0,
			exactEvidenceCandidateCount: 0,
			reranked: false,
			sourceReranked: false,
			fallbackReasons: [],
		},
	} as GroundedWebResult;
}

const GRANT = {
	kind: "admitted" as const,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "step",
	executionId: "e",
	proposalOrdinal: 0,
	maxPayloadTokens: 8_000,
	maxFailurePayloadTokens: 256,
};

function search(
	recorder: ToolCallRecorder,
	options: ToolExecutionOptions = { toolCallId: "call", messages: [] },
) {
	const tool = createResearchWebTool({
		userId: "user-1",
		conversationId: "conversation-1",
		turnId: "turn-1",
		recorder,
	});
	return tool.execute({ query: "current docs" }, options);
}

function granted(kind: "admitted" | "denied" = "admitted") {
	return bindReadResultGrant(
		{ toolCallId: "call", messages: [] },
		kind === "admitted"
			? GRANT
			: { ...GRANT, kind, maxPayloadTokens: 0, maxFailurePayloadTokens: 256 },
	);
}

beforeEach(() => {
	researchWebViaParallelMock.mockReset();
	resetToolResultCacheForTests();
});

describe("research_web names what happened", () => {
	describe("without a result budget", () => {
		it("names a search service that answered with an error, and the model reads the same", async () => {
			const message = "Parallel search failed: 503 Service Unavailable down";
			researchWebViaParallelMock.mockRejectedValueOnce(
				new ParallelApiError(message, 503),
			);
			const recorder = createToolCallRecorder();

			const returned = await search(recorder);

			expect(returned).toEqual({ success: false, error: message });
			const [entry] = recorder.getEntries();
			expect(entry.status).toBe("done");
			expect(entry.outputSummary).toBe(message);
			expect(entry.metadata).toMatchObject({
				ok: false,
				evidenceReady: false,
				error: message,
				reasonCode: "search_unavailable",
			});
		});

		it("names nothing for any other failure: the row says its own fallback", async () => {
			researchWebViaParallelMock.mockRejectedValueOnce(
				new Error("something else broke"),
			);
			const recorder = createToolCallRecorder();

			await search(recorder);

			const [entry] = recorder.getEntries();
			expect(entry.metadata).not.toHaveProperty("reasonCode");
		});

		it("names a search that found nothing, and the payload and summary are what they were", async () => {
			const result = groundedResult({ noSources: true });
			researchWebViaParallelMock.mockResolvedValueOnce(result);
			const recorder = createToolCallRecorder();

			const returned = await search(recorder);

			expect(returned).toEqual(
				compactModelPayload(buildGroundedWebModelPayload(result)),
			);
			const [entry] = recorder.getEntries();
			expect(entry.outputSummary).toBe(summarizeGroundedWebResult(result));
			expect(entry.status).toBe("done");
			expect(entry.metadata).toMatchObject({
				ok: true,
				reasonCode: "nothing_found",
			});
		});

		it("names nothing for a search that found a source with something to read", async () => {
			researchWebViaParallelMock.mockResolvedValueOnce(
				groundedResult({ snippet: "A snippet.", withEvidence: true }),
			);
			const recorder = createToolCallRecorder();

			await search(recorder);

			const [entry] = recorder.getEntries();
			expect(entry.metadata).not.toHaveProperty("reasonCode");
		});
	});

	describe("with a result budget (the way a turn runs it)", () => {
		it("names a search that found nothing and keeps the code when the budget records its fixed failure", async () => {
			researchWebViaParallelMock.mockResolvedValueOnce(
				groundedResult({ noSources: true }),
			);
			const recorder = createToolCallRecorder();

			const returned = await search(recorder, granted());

			// What the model reads is the budget's own fixed failure, as before.
			expect(returned).toEqual(boundedWebReadFailure("research_web"));
			const [entry] = recorder.getEntries();
			expect(entry.status).toBe("failed");
			expect(entry.outputSummary).toBe(
				boundedWebReadFailure("research_web").hint,
			);
			expect(entry.metadata).toMatchObject({
				ok: false,
				bounded: true,
				coverage: "none",
				reasonCode: "nothing_found",
			});
		});

		it("names nothing for a search with something to read", async () => {
			researchWebViaParallelMock.mockResolvedValueOnce(
				groundedResult({ snippet: "A snippet.", withEvidence: true }),
			);
			const recorder = createToolCallRecorder();

			const returned = (await search(recorder, granted())) as {
				success: boolean;
			};

			expect(returned.success).toBe(true);
			const [entry] = recorder.getEntries();
			expect(entry.status).toBe("done");
			expect(entry.metadata).not.toHaveProperty("reasonCode");
		});

		it("names a search service that answered with an error, through the budget's fixed failure", async () => {
			researchWebViaParallelMock.mockRejectedValueOnce(
				new ParallelApiError("Parallel search failed: 500 boom", 500),
			);
			const recorder = createToolCallRecorder();

			const returned = await search(recorder, granted());

			expect(returned).toEqual(boundedWebReadFailure("research_web"));
			const [entry] = recorder.getEntries();
			expect(entry.metadata).toMatchObject({
				ok: false,
				reasonCode: "search_unavailable",
			});
		});

		it("names a search the turn's reading budget refused as reading_budget_used", async () => {
			const recorder = createToolCallRecorder();

			const returned = await search(recorder, granted("denied"));

			expect(researchWebViaParallelMock).not.toHaveBeenCalled();
			expect(returned).toEqual(boundedWebReadFailure("research_web"));
			const [entry] = recorder.getEntries();
			expect(entry.status).toBe("failed");
			expect(entry.metadata).toMatchObject({
				ok: false,
				reasonCode: "reading_budget_used",
			});
		});
	});
});
