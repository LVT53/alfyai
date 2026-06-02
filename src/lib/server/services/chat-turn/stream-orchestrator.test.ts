import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestActiveChatStreamStop } from "$lib/server/services/chat-turn/active-streams";
import { runChatStreamOrchestrator } from "./stream-orchestrator";
import type { ChatTurnPreflight } from "./types";

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		requestTimeoutMs: 30000,
		composerCommandRegistryEnabled: true,
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTargetModel: null,
		modelTimeoutFailoverTimeoutMs: 1000,
	})),
}));

vi.mock("$lib/server/services/conversations", () => ({
	touchConversation: vi.fn(() => Promise.resolve()),
}));

vi.mock("$lib/server/services/normal-chat-failover", () => ({
	isModelTimeoutError: vi.fn(() => false),
	resolveModelTimeoutFailoverTargetModelId: vi.fn(() => Promise.resolve(null)),
}));

vi.mock(
	"$lib/server/services/chat-turn/streaming-normal-chat-model-run",
	() => ({
		runStreamingNormalChatSendModel: vi.fn(),
	}),
);

vi.mock("$lib/server/services/chat-turn/plain-normal-chat-model-run", () => ({
	runPlainNormalChatSendModel: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
	listConversationMessagesForExport: vi.fn(() => Promise.resolve([])),
}));

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/chat-turn/finalize", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/chat-turn/finalize")
		>();
	return {
		...actual,
		persistAssistantEvidence: vi.fn(() => Promise.resolve()),
		persistAssistantTurnState: vi.fn(() =>
			Promise.resolve({
				activeWorkingSet: [],
				taskState: null,
				contextDebug: null,
				workCapsule: undefined,
			}),
		),
		persistUserTurnAttachments: vi.fn(() => Promise.resolve()),
		runPostTurnTasks: vi.fn(() => Promise.resolve()),
	};
});

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFilesForAssistantMessage: vi.fn(() => Promise.resolve([])),
	syncGeneratedFilesToMemory: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	assignFileProductionJobsToAssistantMessage: vi.fn(),
	listConversationFileProductionJobs: vi.fn(() => Promise.resolve([])),
	submitFileProductionIntake: vi.fn(() =>
		Promise.resolve({
			ok: true,
			status: 202,
			reused: false,
			job: { id: "job-recovered-1" },
		}),
	),
}));

vi.mock("$lib/utils/tokens", () => ({
	estimateTokenCount: vi.fn(() => 100),
}));

type NeutralStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_call"; callId: string; toolName: string; input: unknown }
	| { type: "tool_result"; callId: string; toolName: string; output: unknown }
	| { type: "tool_error"; callId: string; toolName: string; error: string }
	| {
			type: "usage";
			usage: {
				inputTokens?: number;
				outputTokens?: number;
				totalTokens?: number;
			};
	  }
	| {
			type: "finish";
			finishReason: string;
			rawFinishReason: string | undefined;
			model: {
				providerId: string;
				providerName: string;
				displayName: string;
				requestedModelName: string;
				responseModelName: string;
			};
	  }
	| { type: "error"; error: string };

const finishEvent: NeutralStreamEvent = {
	type: "finish",
	finishReason: "stop",
	rawFinishReason: "stop",
	model: {
		providerId: "model-1",
		providerName: "Model One",
		displayName: "Model One",
		requestedModelName: "model-1",
		responseModelName: "model-1",
	},
};

async function readSseResponse(response: Response): Promise<string[]> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("No readable stream");
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) chunks.push(line);
		}
	}
	if (buffer.trim()) chunks.push(buffer);
	return chunks;
}

function parseUiStreamParts(
	chunks: string[],
): Array<Record<string, unknown> | "[DONE]"> {
	return chunks.flatMap((chunk) =>
		chunk
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => {
				const data = line.slice("data: ".length);
				return data === "[DONE]"
					? "[DONE]"
					: (JSON.parse(data) as Record<string, unknown>);
			}),
	);
}

function uiDataParts<T extends Record<string, unknown>>(
	parts: Array<Record<string, unknown> | "[DONE]">,
	type: string,
): T[] {
	return parts
		.filter((part): part is Record<string, unknown> => part !== "[DONE]")
		.filter((part) => part.type === type)
		.map((part) => part.data as T);
}

function createTurn(
	overrides: Partial<ChatTurnPreflight> = {},
): ChatTurnPreflight {
	return {
		conversationId: "test-conv",
		normalizedMessage: "Hello",
		streamId: "test-stream",
		modelId: "model-1",
		modelDisplayName: "Model One",
		skipPersistUserMessage: false,
		attachmentIds: [],
		thinkingMode: "auto",
		activeDocumentArtifactId: null,
		attachmentTraceId: null,
		...overrides,
	};
}

function createNeutralStreamingResult(
	events: NeutralStreamEvent[],
	overrides: Record<string, unknown> = {},
) {
	const normalChatToolCalls =
		(overrides.normalChatToolCalls as unknown[] | undefined) ?? [];
	return {
		prepared: {
			contextStatus: null,
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: undefined,
		},
		modelId: "model-1",
		modelDisplayName: "Model One",
		stream: (async function* () {
			for (const event of events) {
				yield event;
			}
		})(),
		prefetchedToolCalls: [],
		getNormalChatToolCalls: () => normalChatToolCalls,
		getToolCalls: () => normalChatToolCalls,
		...overrides,
	};
}

function runStream(overrides: Partial<ChatTurnPreflight> = {}) {
	return runChatStreamOrchestrator({
		user: {
			id: "u1",
			displayName: "User",
			email: "u@test.com",
		},
		turn: createTurn(overrides),
		upstreamMessage: "Hello",
		downstreamAbortSignal: new AbortController().signal,
		requestStartTime: Date.now(),
	});
}

async function resetCompletionMocks() {
	const { touchConversation } = await import(
		"$lib/server/services/conversations"
	);
	const { createMessage, listConversationMessagesForExport } = await import(
		"$lib/server/services/messages"
	);
	const {
		persistAssistantEvidence,
		persistAssistantTurnState,
		persistUserTurnAttachments,
		runPostTurnTasks,
	} = await import("$lib/server/services/chat-turn/finalize");
	const { getChatFilesForAssistantMessage, syncGeneratedFilesToMemory } =
		await import("$lib/server/services/chat-files");
	const { submitFileProductionIntake } = await import(
		"$lib/server/services/file-production"
	);
	const { estimateTokenCount } = await import("$lib/utils/tokens");

	(touchConversation as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(createMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
		id: "msg-1",
	});
	(
		listConversationMessagesForExport as ReturnType<typeof vi.fn>
	).mockResolvedValue([]);
	(persistUserTurnAttachments as ReturnType<typeof vi.fn>).mockResolvedValue(
		undefined,
	);
	(persistAssistantTurnState as ReturnType<typeof vi.fn>).mockResolvedValue({
		activeWorkingSet: [],
		taskState: null,
		contextDebug: null,
		workCapsule: undefined,
	});
	(persistAssistantEvidence as ReturnType<typeof vi.fn>).mockResolvedValue(
		undefined,
	);
	(runPostTurnTasks as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(
		getChatFilesForAssistantMessage as ReturnType<typeof vi.fn>
	).mockResolvedValue([]);
	(syncGeneratedFilesToMemory as ReturnType<typeof vi.fn>).mockResolvedValue(
		undefined,
	);
	(submitFileProductionIntake as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		status: 202,
		reused: false,
		job: { id: "job-recovered-1" },
	});
	(estimateTokenCount as ReturnType<typeof vi.fn>).mockReturnValue(100);
}

describe("stream-orchestrator SSE contract", () => {
	beforeEach(async () => {
		vi.resetAllMocks();
		await resetCompletionMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits AI SDK UI message parts from neutral model stream events", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream();
		const chunks = await readSseResponse(response);
		const body = chunks.join("\n\n");
		const parts = parseUiStreamParts(chunks);

		expect(chunks[0]).toContain(": ");
		expect(chunks[0]).not.toContain("event:");
		expect(body).not.toContain("event: token");
		expect(body).not.toContain("event: end");
		expect(parts).toEqual(
			expect.arrayContaining([
				{ type: "text-start", id: "answer" },
				{ type: "text-delta", id: "answer", delta: "Hi" },
				{ type: "text-end", id: "answer" },
				expect.objectContaining({
					type: "data-stream-metadata",
					transient: true,
					data: expect.objectContaining({
						responseTokenCount: 100,
						modelId: "model-1",
					}),
				}),
				{ type: "finish", finishReason: "stop" },
				"[DONE]",
			]),
		);
		expect(runStreamingNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "u1",
				message: "Hello",
				conversationId: "test-conv",
				modelId: "model-1",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("logs provider-neutral stream timing without emitting timing SSE events", async () => {
		const infoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const { getConfig } = await import("$lib/server/config-store");
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		(getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			requestTimeoutMs: 30000,
			composerCommandRegistryEnabled: true,
			contextDiagnosticsDebug: true,
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runChatStreamOrchestrator({
			user: {
				id: "u1",
				displayName: "User",
				email: "u@test.com",
			},
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
			routePhaseTimings: { route_parse: 1, capacity: 2, preflight: 3 },
		});

		const chunks = await readSseResponse(response);
		const body = chunks.join("\n\n");
		const partTypes = parseUiStreamParts(chunks)
			.filter((part): part is Record<string, unknown> => part !== "[DONE]")
			.map((part) => part.type);
		const phaseTimingLog = infoSpy.mock.calls.find(
			([message]) => message === "[CHAT_STREAM] phase_timing",
		);

		expect(body).not.toContain("event:");
		expect(new Set(partTypes)).toEqual(
			new Set([
				"text-start",
				"text-delta",
				"text-end",
				"data-stream-metadata",
				"finish",
			]),
		);
		expect(phaseTimingLog?.[1]).toEqual(
			expect.objectContaining({
				conversationId: "test-conv",
				streamId: "test-stream",
				route_parse_ms: expect.any(Number),
				prelude_ms: expect.any(Number),
				model_stream_request_ms: expect.any(Number),
				first_upstream_event_ms: expect.any(Number),
				first_visible_token_ms: expect.any(Number),
				end_ms: expect.any(Number),
			}),
		);
	});

	it("propagates prepared context into finalization and end payload", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { persistAssistantTurnState } = await import(
			"$lib/server/services/chat-turn/finalize"
		);
		const prepared = {
			contextStatus: { mode: "constructed", tokenCount: 12 },
			taskState: { id: "task-1", title: "Plan" },
			contextDebug: {
				activeTaskId: "task-1",
				activeTaskObjective: "Plan",
				taskLocked: false,
				routingStage: "deterministic",
				routingConfidence: 0.9,
				verificationStatus: "passed",
				selectedEvidence: [],
				selectedEvidenceBySource: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
			honchoContext: { source: "live" },
			honchoSnapshot: { summary: "Snapshot" },
			contextTraceSections: [{ title: "Trace", items: [] }],
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[{ type: "text_delta", text: "Prepared answer" }, finishEvent],
				{ prepared },
			),
		);

		const response = runStream();
		const chunks = await readSseResponse(response);
		const parts = parseUiStreamParts(chunks);
		const endPayload = uiDataParts<Record<string, unknown>>(
			parts,
			"data-stream-metadata",
		)[0];

		expect(persistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				contextStatus: prepared.contextStatus,
				initialTaskState: prepared.taskState,
				initialContextDebug: prepared.contextDebug,
				honchoContext: prepared.honchoContext,
				honchoSnapshot: prepared.honchoSnapshot,
			}),
		);
		expect(endPayload.contextStatus).toEqual(prepared.contextStatus);
	});

	it("maps AI SDK tool call and result events to recorder-backed tool_call SSE metadata", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const recorderEntry = {
			callId: "call-1",
			name: "research_web",
			input: { query: "SvelteKit docs" },
			status: "done",
			outputSummary: "Found current SvelteKit docs.",
			sourceType: "web",
			candidates: [
				{
					id: "candidate-1",
					title: "SvelteKit Docs",
					sourceType: "web",
					selected: true,
				},
			],
			metadata: { ok: true, evidenceReady: true },
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[
					{
						type: "tool_call",
						callId: "call-1",
						toolName: "research_web",
						input: { query: "SvelteKit docs" },
					},
					{
						type: "tool_result",
						callId: "call-1",
						toolName: "research_web",
						output: { ok: true },
					},
					{ type: "text_delta", text: "Answer" },
					finishEvent,
				],
				{ normalChatToolCalls: [recorderEntry] },
			),
		);

		const response = runStream();
		const chunks = await readSseResponse(response);
		const toolPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-tool-call",
		);

		expect(toolPayloads).toEqual([
			expect.objectContaining({
				callId: "call-1",
				name: "research_web",
				input: { query: "SvelteKit docs" },
				status: "running",
			}),
			expect.objectContaining({
				callId: "call-1",
				name: "research_web",
				input: { query: "SvelteKit docs" },
				status: "done",
				outputSummary: "Found current SvelteKit docs.",
				sourceType: "web",
				candidates: recorderEntry.candidates,
				metadata: { ok: true, evidenceReady: true },
			}),
		]);
	});

	it("emits failed tool events as not evidence-ready", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { persistAssistantEvidence } = await import(
			"$lib/server/services/chat-turn/finalize"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{
					type: "tool_call",
					callId: "call-failed",
					toolName: "research_web",
					input: { query: "broken" },
				},
				{
					type: "tool_error",
					callId: "call-failed",
					toolName: "research_web",
					error: "Tool failed",
				},
				{ type: "text_delta", text: "Answer without tool evidence" },
				finishEvent,
			]),
		);

		const response = runStream();
		const chunks = await readSseResponse(response);
		const doneToolPayload = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-tool-call",
		).find((payload) => payload.status === "done");

		expect(doneToolPayload).toEqual(
			expect.objectContaining({
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "Tool failed",
				},
			}),
		);
		expect(persistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCalls: expect.arrayContaining([
					expect.objectContaining({
						status: "done",
						metadata: expect.objectContaining({
							ok: false,
							evidenceReady: false,
						}),
					}),
				]),
			}),
		);
	});

	it("maps provider usage events into persisted analytics", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { persistAssistantTurnState } = await import(
			"$lib/server/services/chat-turn/finalize"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{
					type: "usage",
					usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
				},
				{ type: "text_delta", text: "Usage answer" },
				finishEvent,
			]),
		);

		const response = runStream();
		await readSseResponse(response);

		expect(persistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				analytics: expect.objectContaining({
					providerUsage: {
						promptTokens: 11,
						completionTokens: 7,
						totalTokens: 18,
						source: "provider",
					},
				}),
			}),
		);
	});

	it("completes as stopped and aborts upstream on explicit stop", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		let upstreamSignal: AbortSignal | undefined;
		let markStreamListening!: () => void;
		const streamListening = new Promise<void>((resolve) => {
			markStreamListening = resolve;
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockImplementation(async (params: { signal?: AbortSignal }) => {
			upstreamSignal = params.signal;
			return createNeutralStreamingResult([], {
				stream: (async function* () {
					await new Promise((_resolve, reject) => {
						markStreamListening();
						params.signal?.addEventListener(
							"abort",
							() => {
								const error = new Error("upstream aborted");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true },
						);
					});
				})(),
			});
		});

		const response = runStream({
			conversationId: "stop-conv",
			streamId: "stop-stream",
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
		await streamListening;
		const stopped = requestActiveChatStreamStop({
			streamId: "stop-stream",
			userId: "u1",
		});
		const remainingChunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) remainingChunks.push(value);
		}
		const remainingBody = remainingChunks
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");

		expect(stopped).toBe(true);
		expect(upstreamSignal?.aborted).toBe(true);
		expect(remainingBody).toContain('"type":"data-stream-metadata"');
		expect(remainingBody).toContain('"wasStopped":true');
	});

	it("keeps upstream running after passive downstream cancellation", async () => {
		const { createMessage } = await import("$lib/server/services/messages");
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		let upstreamSignal: AbortSignal | undefined;
		let releaseEvents!: (events: NeutralStreamEvent[]) => void;
		const eventsReady = new Promise<NeutralStreamEvent[]>((resolve) => {
			releaseEvents = resolve;
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockImplementation(async (params: { signal?: AbortSignal }) => {
			upstreamSignal = params.signal;
			return createNeutralStreamingResult([], {
				stream: (async function* () {
					for (const event of await eventsReady) {
						yield event;
					}
				})(),
			});
		});

		const response = runStream({
			conversationId: "passive-disconnect-conv",
			streamId: "passive-disconnect-stream",
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
		await reader.cancel();
		expect(upstreamSignal?.aborted).toBe(false);

		releaseEvents([{ type: "text_delta", text: "Still running" }, finishEvent]);
		await vi.waitFor(() => {
			expect(createMessage).toHaveBeenCalledWith(
				"passive-disconnect-conv",
				"assistant",
				"Still running",
				undefined,
				undefined,
				{ evidenceStatus: "pending", modelDisplayName: "Model One" },
			);
		});
		expect(upstreamSignal?.aborted).toBe(false);
	});
});
