import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import type { RuntimeConfig } from "$lib/server/config-store";
import { estimateTokenCount } from "$lib/utils/tokens";
import { estimateHistoryMessagesTokens } from "./conversation-history";

vi.mock("./turn-ledger", () => ({
	admitTurn: () => ({ status: "untracked" }),
	recordTurnAttempt: vi.fn(),
	settleTurn: vi.fn(),
}));
vi.mock("../connections/locality", async (original) => ({
	...(await original<typeof import("../connections/locality")>()),
	hasLocalDistillEnabled: async () => false,
}));
const mocks = vi.hoisted(() => ({
	createNormalChatTools: vi.fn(),
	resolveActiveCapabilities: vi.fn(),
	prepareOutboundChatContext: vi.fn(),
	resolveNormalChatModelRunProvider: vi.fn(),
	runStreamingNormalChatModelRun: vi.fn(),
	// No provider takes the "flatten" mode today, so a test that needs one says so
	// here; `null` leaves the real answer.
	historyMode: { value: null as "native" | "flatten" | null },
}));

vi.mock(
	"$lib/server/services/normal-chat-model/provider-compatibility",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("$lib/server/services/normal-chat-model/provider-compatibility")
			>();
		return {
			...actual,
			resolveHistoryToolMessagesMode: (
				...args: Parameters<typeof actual.resolveHistoryToolMessagesMode>
			) =>
				mocks.historyMode.value ??
				actual.resolveHistoryToolMessagesMode(...args),
		};
	},
);

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveActiveCapabilities: mocks.resolveActiveCapabilities,
}));

// Partial mock: the shared run helpers also take resolvePromptContextLimits
// and estimateOutboundPromptTokenTotal from this module, and those stay real.
vi.mock("$lib/server/services/normal-chat-context", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-context")
		>();
	return {
		...actual,
		// Each test hands back only the fields it reads. The real function always
		// returns the pictures of the message (none when there are none), and the
		// run reads them to describe the ones it sends.
		prepareOutboundChatContext: async (...args: unknown[]) => {
			const prepared = await mocks.prepareOutboundChatContext(...args);
			const uploads: Array<{
				number: number;
				name: string;
				image: unknown;
			}> = prepared?.currentImages ?? [];
			return {
				currentImages: [],
				// A test that names only the uploads gets the same pictures as the
				// message's labelled ones; one that names `turnPictureImages` (an open
				// picture, a card picture) overrides it.
				turnPictureImages: uploads.map(({ number, name, image }) => ({
					number,
					name,
					image,
				})),
				turnPictures: { pictures: [], byNumber: () => null, metadata: null },
				...prepared,
			};
		},
	};
});

vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-model")
		>();
	return {
		...actual,
		resolveNormalChatModelRunProvider: mocks.resolveNormalChatModelRunProvider,
		runStreamingNormalChatModelRun: mocks.runStreamingNormalChatModelRun,
		prepareNormalChatCompletionRun: (params: unknown) => ({
			runPlain: () => mocks.runStreamingNormalChatModelRun(params),
			stream: () => mocks.runStreamingNormalChatModelRun(params),
			getSnapshot: () => null,
		}),
	};
});

vi.mock("$lib/server/services/normal-chat-tools", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-tools")
		>();
	return {
		...actual,
		createNormalChatTools: mocks.createNormalChatTools,
	};
});

import { runStreamingNormalChatSendModel } from "./streaming-normal-chat-model-run";

const runtimeConfig = {
	requestTimeoutMs: 1_500,
	model1MaxModelContext: 10_000,
	model1TargetConstructedContext: 8_000,
	model1CompactionUiThreshold: 7_000,
	model1: {
		baseUrl: "https://openai-compatible.example/v1",
		apiKey: "model-1-secret",
		modelName: "gpt-4.1",
		displayName: "Model One",
		systemPrompt: "",
		maxTokens: 2048,
		reasoningEffort: "high",
		thinkingType: null,
	},
	model2: {
		baseUrl: "https://unused.example/v1",
		apiKey: "",
		modelName: "unused",
		displayName: "Unused",
		systemPrompt: "",
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
	},
} as RuntimeConfig;

async function* streamEvents() {
	yield { type: "text_delta" as const, text: "Answer" };
}

describe("runStreamingNormalChatSendModel", () => {
	beforeEach(() => {
		mocks.createNormalChatTools.mockReset();
		mocks.resolveActiveCapabilities.mockReset();
		mocks.prepareOutboundChatContext.mockReset();
		mocks.resolveNormalChatModelRunProvider.mockReset();
		mocks.runStreamingNormalChatModelRun.mockReset();
		mocks.historyMode.value = null;
		mocks.resolveActiveCapabilities.mockResolvedValue(new Set());
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __testTool: true },
				produce_file: { __testTool: true },
				read_generated_file: { __testTool: true },
			},
			getToolCalls: () => [],
		});
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "provider-secret",
			maxOutputTokens: 4096,
			maxModelContext: 1234,
			targetConstructedContext: 345,
			compactionUiThreshold: 678,
			reasoningEffort: "medium",
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
		});
		mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
	});

	it("prepares prompt context with provider limits and force-web prefetch before returning the stream", async () => {
		const prefetchedToolCalls = [
			{
				callId: "server-prefetch:research_web:test",
				name: "research_web",
				input: { query: "What changed today?" },
				status: "done" as const,
				outputSummary: "Server-prefetched 1 web source.",
				sourceType: "web" as const,
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue:
				"## Current Web Research\n\nEvidence\n\n## Current User Message\nWhat changed today?",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			forceWebSearch: true,
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "What changed today?",
				sessionId: "conv-1",
				modelId: "provider:provider-1",
				forceWebSearch: true,
				contextLimits: {
					maxModelContext: 1234,
					targetConstructedContext: 345,
					compactionUiThreshold: 678,
				},
				logLabel: "provider request",
			}),
		);
		expect(result.prepared.contextStatus).toEqual({ status: "ready" });
		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: expect.stringContaining("## Current Web Research"),
							},
						],
					},
				],
			}),
		);
	});

	// The stream's completion step reads the applied instruction scopes off
	// this snapshotted context, so the slice the streaming run hands back has
	// to carry them. Re-deriving them at completion would risk recording a
	// scope whose section the prompt did not contain.
	it("carries the applied instruction scopes on the streamed prepared context", async () => {
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			instructionsApplied: { personal: true },
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "How long is the flight?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
		});

		expect(result.prepared.instructionsApplied).toEqual({ personal: true });
	});

	it("appends prefetchedToolMessages AFTER the current user message in the outbound messages", async () => {
		const prefetchedToolMessages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						input: { urls: ["https://example.com/source"] },
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						output: { type: "json" as const, value: { success: true } },
					},
				],
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "What does this page say? https://example.com/source",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			prefetchedToolMessages,
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What does this page say? https://example.com/source",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "What does this page say? https://example.com/source",
							},
						],
					},
					...prefetchedToolMessages,
				],
			}),
		);
	});

	it("sends the prepared pictures as image parts after the text of the current user message", async () => {
		const image = {
			base64: "QUJD",
			mediaType: "image/jpeg" as const,
			width: 64,
			height: 48,
			estimatedTokens: 6,
		};
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "What is in these?",
			turnGuidance: "## Turn Guidance\nBe brief.",
			systemPrompt: "Prepared system prompt",
			contextStatus: { status: "ready" },
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			currentImages: [
				{ number: 1, artifactId: "a-1", name: "room.jpg", image },
				{ number: 2, artifactId: "a-2", name: "sofa.jpg", image },
			],
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What is in these?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "What is in these?\n\n## Turn Guidance\nBe brief.",
							},
							{ type: "text", text: "Picture 1: room.jpg" },
							{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
							{ type: "text", text: "Picture 2: sofa.jpg" },
							{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
						],
					},
				],
			}),
		);
	});

	it("counts the pictures in the full-prompt estimate it hands back", async () => {
		const send = async (currentImages: unknown[]) => {
			mocks.prepareOutboundChatContext.mockResolvedValue({
				inputValue: "What is in these?",
				systemPrompt: "Prepared system prompt",
				contextStatus: { status: "ready" },
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				currentImages,
			});
			mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
			return runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "What is in these?",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
			});
		};
		const picture = {
			artifactId: "a-1",
			name: "room.jpg",
			image: {
				base64: "QUJD",
				mediaType: "image/jpeg",
				width: 64,
				height: 48,
				estimatedTokens: 1_900,
			},
		};

		const without = await send([]);
		const withPicture = await send([picture]);

		expect(
			(withPicture.prepared.estimatedPromptTokens ?? 0) -
				(without.prepared.estimatedPromptTokens ?? 0),
		).toBe(1_900);
	});

	// The line that says Alfy is looking at the pictures (vision/AGENTS.md): one
	// response-activity entry with how many pictures the model is sent, said once
	// the context is prepared and before the model is called, so the person sees
	// it while the model reads the message. A turn with no pictures says nothing.
	describe("saying that it is looking at the pictures", () => {
		const image = {
			base64: "QUJD",
			mediaType: "image/jpeg" as const,
			width: 64,
			height: 48,
			estimatedTokens: 6,
		};
		const pictures = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				artifactId: `a-${index}`,
				name: `private-name-${index}.jpg`,
				image,
			}));

		async function send(
			currentImages: unknown[],
			onResponseActivity?: (entry: unknown) => void,
		) {
			mocks.prepareOutboundChatContext.mockImplementation(async (params) => {
				// The context preparation reports its stages through the same
				// callback, so the order of the two kinds of entry is visible.
				params.onContextPreparationActivity?.({
					stageId: "prompt_budget",
					status: "done",
				});
				return {
					inputValue: "What is in these?",
					systemPrompt: "Prepared system prompt",
					contextStatus: { status: "ready" },
					taskState: null,
					contextDebug: null,
					contextTraceSections: [],
					currentImages,
				};
			});
			return runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "What is in these?",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
				onResponseActivity,
			});
		}

		it("emits one viewing_images entry with the number of pictures, before it calls the model", async () => {
			const order: string[] = [];
			const activity: unknown[] = [];
			mocks.runStreamingNormalChatModelRun.mockImplementation(() => {
				order.push("model call");
				return streamEvents();
			});

			await send(pictures(2), (entry) => {
				activity.push(entry);
				order.push("activity");
			});

			expect(
				activity.filter(
					(entry) => (entry as { kind: string }).kind === "viewing_images",
				),
			).toEqual([
				{
					id: "viewing-images",
					kind: "viewing_images",
					status: "running",
					count: 2,
				},
			]);
			// After the preparation's own entry, before the call to the model.
			expect(order).toEqual(["activity", "activity", "model call"]);
			expect((activity[0] as { kind: string }).kind).toBe("context");
			expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledTimes(1);
		});

		it("counts the pictures the model is sent, one for one picture", async () => {
			const onResponseActivity = vi.fn();

			await send(pictures(1), onResponseActivity);

			const viewing = onResponseActivity.mock.calls
				.map(([entry]) => entry)
				.filter((entry) => entry.kind === "viewing_images");
			expect(viewing).toHaveLength(1);
			expect(viewing[0].count).toBe(1);
		});

		it("counts every picture sent: an open picture and a marked copy with no upload beside them", async () => {
			mocks.prepareOutboundChatContext.mockResolvedValue({
				inputValue: "Make it warmer",
				systemPrompt: "Prepared system prompt",
				contextStatus: { status: "ready" },
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				// No upload: the message holds the open picture and the marked copy.
				currentImages: [],
				turnPictureImages: [
					{ number: 1, name: "Cosy living room (open in the panel)", image },
					{
						number: 2,
						name: "Picture 1 with the user's marks: A = red box",
						image,
					},
				],
			});
			const onResponseActivity = vi.fn();

			await runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "Make it warmer",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
				onResponseActivity,
			});

			const viewing = onResponseActivity.mock.calls
				.map(([entry]) => entry)
				.filter((entry) => entry.kind === "viewing_images");
			expect(viewing).toHaveLength(1);
			expect(viewing[0].count).toBe(2);
			const [{ messages }] = mocks.runStreamingNormalChatModelRun.mock
				.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
			expect(messages[0].content).toEqual([
				{ type: "text", text: "Make it warmer" },
				{
					type: "text",
					text: "Picture 1: Cosy living room (open in the panel)",
				},
				{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
				{
					type: "text",
					text: "Picture 2: Picture 1 with the user's marks: A = red box",
				},
				{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
			]);
		});

		it("says nothing for a turn with no pictures", async () => {
			const onResponseActivity = vi.fn();

			await send([], onResponseActivity);

			expect(
				onResponseActivity.mock.calls.map(([entry]) => entry.kind),
			).not.toContain("viewing_images");
		});

		it("carries only the count: no name, no description, no diagnostics", async () => {
			const onResponseActivity = vi.fn();

			await send(pictures(3), onResponseActivity);

			const viewing = onResponseActivity.mock.calls
				.map(([entry]) => entry)
				.find((entry) => entry.kind === "viewing_images");
			expect(Object.keys(viewing).sort()).toEqual([
				"count",
				"id",
				"kind",
				"status",
			]);
			expect(JSON.stringify(viewing)).not.toContain("private-name");
		});

		it("sends the same pictures to the model whether or not anyone listens", async () => {
			await send(pictures(2));

			const [{ messages }] = mocks.runStreamingNormalChatModelRun.mock
				.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
			expect(
				messages[0].content.filter(
					(part) => (part as { type: string }).type === "image",
				),
			).toHaveLength(2);
		});
	});

	it("does not force a named first-step tool choice for forced web search (guidance carries it instead)", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			forceWebSearch: true,
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				firstStepToolChoice: undefined,
			}),
		);
	});

	it("does not force a first-step tool choice when forceWebSearch is false", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({ firstStepToolChoice: undefined }),
		);
	});

	it("does not force a first-step tool choice when research_web is unavailable, even with forceWebSearch", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				produce_file: { __testTool: true },
			},
			getToolCalls: () => [],
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "What changed today?",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			forceWebSearch: true,
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({ firstStepToolChoice: undefined }),
		);
	});

	it("forwards typed context preparation activity without exposing stage labels as response activity text", async () => {
		const contextPreparationActivity = vi.fn();
		const responseActivity = vi.fn();
		mocks.prepareOutboundChatContext.mockImplementation(async (params) => {
			params.onContextPreparationActivity?.({
				stageId: "plan",
				status: "started",
			});
			params.onContextPreparationActivity?.({
				stageId: "plan",
				status: "done",
			});
			params.onContextPreparationActivity?.({
				stageId: "prompt_budget",
				status: "started",
			});
			params.onContextPreparationActivity?.({
				stageId: "prompt_budget",
				status: "done",
			});
			return {
				inputValue: "Prepared user prompt",
				systemPrompt: "Prepared system prompt",
				contextStatus: undefined,
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				contextLimits: {
					maxModelContext: 10_000,
					compactionUiThreshold: 7_000,
					targetConstructedContext: 8_000,
				},
			};
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			onContextPreparationActivity: contextPreparationActivity,
			onResponseActivity: responseActivity,
		});

		expect(
			contextPreparationActivity.mock.calls.map(([activity]) => activity),
		).toEqual([
			{ stageId: "plan", status: "started" },
			{ stageId: "plan", status: "done" },
			{ stageId: "prompt_budget", status: "started" },
			{ stageId: "prompt_budget", status: "done" },
		]);
		expect(responseActivity.mock.calls.map(([entry]) => entry)).toEqual([
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "planning",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "planning",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "budgeting",
			},
			{
				id: "context-preparing",
				kind: "context",
				status: "done",
				contextPreparationClass: "budgeting",
			},
		]);
		expect(
			responseActivity.mock.calls.map(([entry]) => entry.id),
		).not.toContain("plan");
		expect(
			responseActivity.mock.calls.map(([entry]) => entry.id),
		).not.toContain("prompt_budget");
		expect(responseActivity.mock.calls.every(([entry]) => !entry.label)).toBe(
			true,
		);
		expect(responseActivity.mock.calls.every(([entry]) => !entry.detail)).toBe(
			true,
		);
	});

	it("exposes context-preparation timings without passing them to provider transport", async () => {
		const contextPreparationTimings = [
			{
				stageId: "plan" as const,
				activityClass: "planning" as const,
				status: "done" as const,
				startedAt: 10,
				completedAt: 15,
				durationMs: 5,
			},
			{
				stageId: "prompt_budget" as const,
				activityClass: "budgeting" as const,
				status: "done" as const,
				startedAt: 20,
				completedAt: 28,
				durationMs: 8,
			},
		];
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			contextPreparationTimings,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(result.prepared.contextPreparationTimings).toEqual(
			contextPreparationTimings,
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				contextPreparationTimings: expect.anything(),
			}),
		);
	});

	it("passes normal chat tools and the prepared output token budget into the streaming model run", async () => {
		const tools = {
			research_web: { __testTool: true },
			produce_file: { __testTool: true },
			read_generated_file: { __testTool: true },
		};
		mocks.createNormalChatTools.mockReturnValue({
			tools,
			getToolCalls: () => [],
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			outputTokenBudget: {
				configuredMaxTokens: 4096,
				effectiveMaxTokens: 777,
				outputReserve: 777,
				outputReserveClamped: true,
			},
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Create a downloadable PDF report",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.createNormalChatTools).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "normal-chat-turn-1",
			requestText: "Create a downloadable PDF report",
			// No language here: the tool catalogue is English whatever the person
			// writes, and nothing guesses one from the message.
			enabledConnectionCapabilities: new Set(),
			modelId: "model1",
			// The turn's queue of pictures a tool wants the model to see.
			turnPictures: expect.objectContaining({ byNumber: expect.any(Function) }),
			stepImages: expect.objectContaining({
				push: expect.any(Function),
				drain: expect.any(Function),
			}),
			// The streaming run is the one that can stop a reply to ask the person.
			canPause: true,
		});
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools,
				maxOutputTokens: 777,
				maxToolSteps: 20,
			}),
		);
	});

	it("exposes the files tool when the connections resolver reports the files capability enabled", async () => {
		mocks.resolveActiveCapabilities.mockResolvedValue(new Set(["files"]));
		mocks.createNormalChatTools.mockImplementation((ctx) => ({
			tools: {
				research_web: { __testTool: true },
				...(ctx.enabledConnectionCapabilities?.has("files")
					? { files: { __testTool: true } }
					: {}),
			},
			getToolCalls: () => [],
		}));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.resolveActiveCapabilities).toHaveBeenCalledWith(
			"user-1",
			undefined,
		);
		expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: new Set(["files"]),
			}),
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: expect.objectContaining({
					files: { __testTool: true },
				}),
			}),
		);
	});

	it("hides the files tool when the connections resolver reports no enabled capabilities", async () => {
		mocks.resolveActiveCapabilities.mockResolvedValue(new Set());
		mocks.createNormalChatTools.mockImplementation((ctx) => ({
			tools: {
				research_web: { __testTool: true },
				...(ctx.enabledConnectionCapabilities?.has("files")
					? { files: { __testTool: true } }
					: {}),
			},
			getToolCalls: () => [],
		}));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
		});

		expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: new Set(),
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.tools).not.toHaveProperty("files");
	});

	it("passes the request's enabledConnectionCapabilities through to resolveActiveCapabilities (fail-closed narrowing)", async () => {
		// The resolver itself enforces fail-closed intersection; this test only
		// asserts the model-run wires the request-parsed selection through to
		// it verbatim rather than e.g. always requesting the full served set.
		mocks.resolveActiveCapabilities.mockResolvedValue(new Set(["files"]));
		mocks.createNormalChatTools.mockImplementation((ctx) => ({
			tools: {
				research_web: { __testTool: true },
				...(ctx.enabledConnectionCapabilities?.has("files")
					? { files: { __testTool: true } }
					: {}),
				...(ctx.enabledConnectionCapabilities?.has("calendar")
					? { calendar: { __testTool: true } }
					: {}),
			},
			getToolCalls: () => [],
		}));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "model1",
			createTurnId: () => "normal-chat-turn-1",
			enabledConnectionCapabilities: ["files", "calendar"],
		});

		expect(mocks.resolveActiveCapabilities).toHaveBeenCalledWith("user-1", [
			"files",
			"calendar",
		]);
		// The resolver (mocked here) only returned "files" — simulating the
		// server-side fail-closed narrowing that drops an unserved "calendar" —
		// so the calendar tool must not be exposed even though it was requested.
		const toolsArg =
			mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0]?.tools;
		expect(toolsArg).toHaveProperty("files");
		expect(toolsArg).not.toHaveProperty("calendar");
	});

	it("keeps file-production tools registered for ordinary prose streaming requests (stable tool set)", async () => {
		const tools = {
			research_web: { __testTool: true },
			memory_context: { __testTool: true },
			produce_file: { __testTool: true },
			read_generated_file: { __testTool: true },
		};
		mocks.createNormalChatTools.mockReturnValue({
			tools,
			getToolCalls: () => [],
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message:
				"Draft a concise engineering decision memo with Context, Decision, Consequences, and Rollout sections.",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					research_web: { __testTool: true },
					memory_context: { __testTool: true },
					produce_file: { __testTool: true },
					read_generated_file: { __testTool: true },
				},
			}),
		);
	});

	it("applies resolved depth effort before the streaming model run", async () => {
		const depthMetadata = {
			requested: "thorough" as const,
			appliedProfile: "maximum" as const,
			fallback: false,
			signals: {
				groundingNeed: "required" as const,
				contextBreadth: "broad" as const,
				outputRoom: "expanded" as const,
				toolUse: "source_heavy" as const,
			},
		};
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			outputTokenBudget: {
				configuredMaxTokens: 4096,
				effectiveMaxTokens: 3500,
				outputReserve: 3500,
				outputReserveClamped: true,
			},
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Investigate the current options with sources.",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			depthMetadata,
		});

		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextLimits: {
					maxModelContext: 1234,
					targetConstructedContext: 345,
					compactionUiThreshold: 678,
				},
				modelConfig: expect.objectContaining({
					maxTokens: 4096,
				}),
				reasoningDepthEffort: expect.objectContaining({
					maxToolSteps: 28,
					webSourceBudget: {
						maxSources: 12,
						sourceExpansion: true,
					},
				}),
			}),
		);
		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 3500,
				maxToolSteps: 28,
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toEqual({
			fireworks: { reasoningEffort: "medium" },
		});
		expect(result.depthMetadata?.appliedEffort).toMatchObject({
			grounding: {
				guidance: "strict",
				externalEvidence: "required",
			},
			tools: {
				maxToolSteps: 28,
				maxWebSources: 12,
				sourceExpansion: true,
			},
		});
	});

	it("leaves tool choice automatic for explicit file requests after removing produce_file auto-force", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Please create a downloadable PDF report for me",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic when a file request needs project context first", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message:
				"Could you please generate a pdf report with the content from AlmaLinux Server project folder? I want it to be detailed and long.",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("leaves tool choice automatic for non-file chat requests", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Explain how PDF generation works",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.not.objectContaining({
				toolChoice: expect.anything(),
			}),
		);
	});

	it("omits streaming reasoning options when capability evidence rejects reasoning controls", async () => {
		mocks.resolveNormalChatModelRunProvider.mockResolvedValue({
			id: "provider-1",
			name: "fireworks",
			displayName: "Fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			modelName: "accounts/fireworks/models/kimi-k2p6",
			apiKey: "provider-secret",
			maxOutputTokens: 4096,
			reasoningEffort: "medium",
			capabilities: createModelCapabilitySet({
				reasoningControls: {
					state: "not_detected",
					source: "probe",
				},
			}),
		});

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Hello",
			conversationId: "conv-1",
			modelId: "provider:provider-1",
			thinkingMode: "on",
		});

		expect(mocks.runStreamingNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resolveProviderOptions: expect.any(Function),
			}),
		);
		const call = mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0];
		expect(call.resolveProviderOptions(call.provider)).toBeUndefined();
	});

	it("exposes prefetched and recorded tool calls while filtering failed calls from the final evidence-ready set", async () => {
		const prefetchedToolCalls = [
			{
				callId: "server-prefetch:research_web:test",
				name: "research_web",
				input: { query: "What changed today?" },
				status: "done" as const,
				outputSummary: "Server-prefetched 1 web source.",
				sourceType: "web" as const,
			},
		];
		const normalChatToolCalls = [
			{
				callId: "call-produce-file-1",
				name: "produce_file",
				input: { requestTitle: "Quarterly report" },
				status: "done" as const,
				outputSummary: "File production job job-1 queued with status pending.",
				sourceType: "tool" as const,
				metadata: {
					jobId: "job-1",
					jobStatus: "pending",
				},
			},
			{
				callId: "call-produce-file-failed",
				name: "produce_file",
				input: { requestTitle: "Failed report" },
				status: "done" as const,
				outputSummary: "File production intake failed",
				sourceType: "tool" as const,
				metadata: {
					ok: false,
					evidenceReady: false,
					intakeStatus: 500,
				},
			},
		];
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __testTool: true },
				produce_file: { __testTool: true },
				read_generated_file: { __testTool: true },
			},
			getToolCalls: () => normalChatToolCalls,
		});
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "Prepared user prompt",
			systemPrompt: "Prepared system prompt",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
			prefetchedToolCalls,
		});

		const result = await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Create a downloadable PDF report",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(result.prefetchedToolCalls).toEqual(prefetchedToolCalls);
		expect(result.getNormalChatToolCalls()).toEqual(normalChatToolCalls);
		expect(result.getToolCalls()).toEqual([
			...prefetchedToolCalls,
			normalChatToolCalls[0],
		]);
	});

	// Issue 8.1 — resolveActiveCapabilities used to only be resolved right
	// before createNormalChatTools, after prepareOutboundChatContext already
	// ran, so the context-preparation pipeline's proactive_connector_context
	// stage had no way to know the turn's active capabilities. It is now
	// resolved once, ahead of context prep, and the SAME resolved Set is
	// reused for both call sites.
	it("resolves active capabilities once and passes the same set into both context prep and tool creation", async () => {
		mocks.resolveActiveCapabilities.mockResolvedValue(new Set(["calendar"]));

		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Do I have any meetings today?",
			conversationId: "conv-1",
			modelId: "model1",
		});

		expect(mocks.resolveActiveCapabilities).toHaveBeenCalledTimes(1);
		expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
			expect.objectContaining({
				activeConnectionCapabilities: new Set(["calendar"]),
			}),
		);
		expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: new Set(["calendar"]),
			}),
		);
	});

	// A tool that wants the model to see a picture (the photos tool, for Immich
	// thumbnails) queues it, and the model run hands it over in the next step:
	// they have to be the same queue, and a turn's own.
	it("gives the tools and the model run the one queue of the turn's pictures", async () => {
		await runStreamingNormalChatSendModel({
			userId: "user-1",
			runtimeConfig,
			message: "Which of my beach photos is the sharpest?",
			conversationId: "conv-1",
			modelId: "model1",
		});

		const toolsQueue =
			mocks.createNormalChatTools.mock.calls[0]?.[0].stepImages;
		const runQueue =
			mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0].stepImages;
		expect(toolsQueue).toBeDefined();
		expect(typeof toolsQueue.push).toBe("function");
		expect(typeof toolsQueue.drain).toBe("function");
		expect(runQueue).toBe(toolsQueue);
	});

	// "Ask me first": the streaming run is the one run that can stop a reply to
	// wait for the person. The turn needs three things back from it to save the
	// reply as a paused segment: what was asked, what the run said and read, and
	// what it was given before it ran.
	describe("pausing to ask the person", () => {
		const ask = {
			questionId: "q-1",
			toolCallId: "call-ask",
			questions: [
				{
					question: "Which one?",
					options: [{ label: "A", recommended: true }, { label: "B" }],
				},
			],
		};
		const prefetchedToolMessages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						input: { urls: ["https://example.com/source"] },
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						output: { type: "json" as const, value: { success: true } },
					},
				],
			},
		];
		let recordedAsk: typeof ask | null;

		beforeEach(() => {
			recordedAsk = null;
			mocks.createNormalChatTools.mockReturnValue({
				tools: { research_web: { __testTool: true } },
				getToolCalls: () => [],
				getTurnAsk: () => recordedAsk,
			});
		});

		it("lets the streaming run pause, and returns the turn's ask, its response messages and the continuation it was given", async () => {
			mocks.prepareOutboundChatContext.mockResolvedValue({
				inputValue: "What does this page say? https://example.com/source",
				systemPrompt: "Prepared system prompt",
				contextStatus: { status: "ready" },
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				prefetchedToolMessages,
			});

			const result = await runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "What does this page say? https://example.com/source",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
			});

			// the tools are told the run can stop to wait
			expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
				expect.objectContaining({ canPause: true }),
			);
			// the page the server fetched before the model ran
			expect(result.continuationGiven).toEqual(prefetchedToolMessages);
			// nothing asked, nothing said yet
			expect(result.getTurnAsk()).toBeNull();
			expect(result.getResponseMessages()).toEqual([]);

			// Exact response capture now comes from the retained completion snapshot, not SDK finish callbacks.
			expect(
				mocks.runStreamingNormalChatModelRun.mock.calls[0]?.[0].completionPolicy
					.onSnapshot,
			).toBeTypeOf("function");

			// the tool recorded the question
			recordedAsk = ask;
			expect(result.getTurnAsk()).toEqual(ask);
		});

		it("hands an empty continuation to a turn that prefetched nothing", async () => {
			const result = await runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "Plan my week",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
			});

			expect(result.continuationGiven).toEqual([]);
		});
	});

	// "Ask me first": a reply that asked goes on from the continuation saved with
	// its question (docs/plans/ask-me-first, Plan's calls 20 and 22): the reply so
	// far and the person's answer, after the person's message and whatever the
	// server fetched before the model ran.
	describe("carrying on from a saved continuation", () => {
		const prefetchedToolMessages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						input: { urls: ["https://example.com/source"] },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "server-prefetch:fetch_url:abc",
						toolName: "fetch_url",
						output: { type: "json", value: { success: true } },
					},
				],
			},
		];
		const continuation: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-cal",
						toolName: "calendar",
						input: { action: "list_events" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-cal",
						toolName: "calendar",
						output: {
							type: "json",
							value: { events: [{ title: "Dentist with Dr. Kovacs" }] },
						},
					},
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Which one?" },
					{
						type: "tool-call",
						toolCallId: "call-ask",
						toolName: "ask_user",
						input: {
							questions: [
								{
									question: "Which colour?",
									options: [{ label: "White" }, { label: "Grey" }],
								},
							],
						},
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-ask",
						toolName: "ask_user",
						output: { type: "json", value: { status: "answered" } },
					},
				],
			},
		];
		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "Redo the room" }],
		};

		beforeEach(() => {
			mocks.prepareOutboundChatContext.mockResolvedValue({
				inputValue: "Redo the room",
				systemPrompt: "Prepared system prompt",
				contextStatus: { status: "ready" },
				taskState: null,
				contextDebug: null,
				contextTraceSections: [],
				prefetchedToolMessages,
			});
			mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
		});

		function send(
			extra: Partial<
				Parameters<typeof runStreamingNormalChatSendModel>[0]
			> = {},
		) {
			mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
			return runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "Redo the room",
				conversationId: "conv-1",
				modelId: "provider:provider-1",
				...extra,
			});
		}

		function sentMessages(): ModelMessage[] {
			return mocks.runStreamingNormalChatModelRun.mock.calls.at(-1)?.[0]
				.messages;
		}

		it("puts the continuation after the current message and the prefetched exchange", async () => {
			const result = await send({ continuationMessages: continuation });

			expect(sentMessages()).toEqual([
				userMessage,
				...prefetchedToolMessages,
				...continuation,
			]);
			// what a reply that asks again is captured from: everything the model was
			// given after the person's message
			expect(result.continuationGiven).toEqual([
				...prefetchedToolMessages,
				...continuation,
			]);
		});

		it("sends an ordinary turn the messages it always sent", async () => {
			const result = await send();

			expect(sentMessages()).toEqual([userMessage, ...prefetchedToolMessages]);
			expect(result.continuationGiven).toEqual(prefetchedToolMessages);
		});

		// Review Focus 4: a long first segment (a big page read before the question)
		// is in the continuation the resume sends, so the figure the context ring
		// shows when the provider reports none must count it.
		it("counts the continuation in the prompt estimate", async () => {
			const without = await send();
			const withContinuation = await send({
				continuationMessages: continuation,
			});

			expect(
				(withContinuation.prepared.estimatedPromptTokens ?? 0) -
					(without.prepared.estimatedPromptTokens ?? 0),
			).toBe(estimateHistoryMessagesTokens(continuation, estimateTokenCount));
		});

		it("retains canonical messages and refuses unsupported lossy destination folding", async () => {
			mocks.historyMode.value = "flatten";
			await send({ continuationMessages: continuation });
			expect(sentMessages().slice(-continuation.length)).toEqual(continuation);
			const params =
				mocks.runStreamingNormalChatModelRun.mock.calls.at(-1)?.[0];
			const adapter = await params.completionPolicy.forAttempt({
				provider: params.provider,
				modelId: params.modelId,
				phase: "working",
				attemptId: "fold-attempt",
				toolsAllowed: false,
				snapshot: {},
			});
			expect(
				adapter.projectContext({
					snapshot: { steps: [], pendingImageEntries: [] },
					system: params.system,
					messages: sentMessages(),
					provider: params.provider,
				}),
			).toBeNull();
		});

		it("leaves the continuation as messages for a provider that takes them", async () => {
			mocks.historyMode.value = "native";

			await send({ continuationMessages: continuation });

			expect(sentMessages().slice(-continuation.length)).toEqual(continuation);
		});

		it("does not ask the gate itself for a provider that takes tool messages: the model run decides for each attempt", async () => {
			const gate = vi.fn((messages: ModelMessage[]) => messages);

			await send({
				continuationMessages: continuation,
				gateMessagesForAttempt: gate,
			});

			expect(gate).not.toHaveBeenCalled();
			expect(
				mocks.runStreamingNormalChatModelRun.mock.calls.at(-1)?.[0]
					.gateMessagesForAttempt,
			).toBe(gate);
		});

		it("hands the history cut and the prefetch skip to context preparation, and the provenance to the tools", async () => {
			const resumeProvenance = {
				userTexts: ["use https://typed.example/a"],
				priorResults: [],
			};

			await send({
				continuationMessages: continuation,
				historyBeforeMessageId: "message-asked",
				skipWebPrefetch: true,
				resumeProvenance,
			});

			expect(mocks.prepareOutboundChatContext).toHaveBeenCalledWith(
				expect.objectContaining({
					historyBeforeMessageId: "message-asked",
					skipWebPrefetch: true,
				}),
			);
			expect(mocks.createNormalChatTools).toHaveBeenCalledWith(
				expect.objectContaining({ resumeProvenance, canPause: true }),
			);
		});

		it("asks nothing extra of an ordinary turn", async () => {
			await send();

			const prepared = mocks.prepareOutboundChatContext.mock.calls.at(-1)?.[0];
			expect(prepared.historyBeforeMessageId).toBeUndefined();
			expect(prepared.skipWebPrefetch).toBeUndefined();
			expect(
				mocks.createNormalChatTools.mock.calls.at(-1)?.[0],
			).not.toHaveProperty("resumeProvenance");
		});
	});

	it("does not share a queue between two turns", async () => {
		for (let turn = 0; turn < 2; turn += 1) {
			mocks.runStreamingNormalChatModelRun.mockReturnValue(streamEvents());
			await runStreamingNormalChatSendModel({
				userId: "user-1",
				runtimeConfig,
				message: "Which photo is sharpest?",
				conversationId: "conv-1",
				modelId: "model1",
			});
		}

		const [first, second] = mocks.createNormalChatTools.mock.calls.map(
			(call) => call[0].stepImages,
		);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
	});
});
