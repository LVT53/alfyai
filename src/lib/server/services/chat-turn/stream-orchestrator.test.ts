import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendToStreamBuffer,
	clearStreamBuffer,
	getOrCreateStreamBuffer,
	getStreamBuffer,
	registerActiveChatStream,
	requestActiveChatStreamStop,
	subscribeToStream,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile";
import {
	createContextPreparationStageTimelineMark,
	SERVER_STREAM_TIMELINE_MARKS,
	STREAM_TIMELINE_PAYLOAD_VERSION,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import {
	runChatStreamOrchestrator,
	startStartedResetGenerationFact,
} from "./stream-orchestrator";
import type {
	AdmittedChatTurn,
	ChatTurnPreflight,
	ChatTurnPreparationResult,
	ChatTurnRequestError,
	SkillPromptContext,
} from "./types";

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
	isModelRateLimitError: vi.fn(() => false),
	resolveProviderRateLimitFallback: vi.fn(() => Promise.resolve(null)),
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

vi.mock("$lib/server/services/memory-profile", () => ({
	getCurrentMemoryResetGeneration: vi.fn(() => Promise.resolve(0)),
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

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	buildSkillSystemPromptAppendix: vi.fn(() => undefined),
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
		providerId: "model1",
		providerName: "Model One",
		displayName: "Model One",
		requestedModelName: "model1",
		responseModelName: "model1",
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

async function readNextSseChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
	const { done, value } = await reader.read();
	if (done || !value) {
		throw new Error("Expected another SSE chunk");
	}
	return new TextDecoder().decode(value);
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
		modelId: "model1",
		modelDisplayName: "Model One",
		skipPersistUserMessage: false,
		attachmentIds: [],
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "auto",
		thinkingMode: "auto",
		forceWebSearch: false,
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		depthMetadata: {
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			modelId: "model1",
			modelDisplayName: "Model One",
			timing: {
				totalMs: 4,
				classifierAttempts: 0,
				classifierSource: "deterministic_fast_path",
				appliedProfile: "standard",
			},
		},
		...overrides,
	};
}

function createAdmittedTurn(
	overrides: Partial<ChatTurnPreflight> = {},
): AdmittedChatTurn {
	const turn = createTurn(overrides);
	const {
		depthMetadata: _depthMetadata,
		skillPromptContext: _skillPromptContext,
		...admitted
	} = turn;
	return admitted as unknown as AdmittedChatTurn;
}

function createSkillPromptContext(
	overrides: Partial<SkillPromptContext> = {},
): SkillPromptContext {
	return {
		source: "pending_skill",
		skillId: "skill-1",
		skillOwnership: "user",
		skillKind: "user_skill",
		skillDisplayName: "Skill One",
		skillDescription: "A focused test skill",
		skillInstructions: "Follow the skill.",
		durationPolicy: "next_message",
		questionPolicy: "none",
		notesPolicy: "none",
		sourceScope: "current_conversation",
		skillVersion: 1,
		linkedSources: [],
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
			contextTraceSections: undefined,
		},
		modelId: "model1",
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

function runAdmittedStreamWithPreparationFailure(params: {
	error: ChatTurnRequestError;
	turn?: Partial<ChatTurnPreflight>;
}) {
	const prepareTurn = vi.fn(
		async (): Promise<ChatTurnPreparationResult> => ({
			ok: false,
			error: params.error,
		}),
	);
	const response = runChatStreamOrchestrator({
		user: {
			id: "u1",
			displayName: "User",
			email: "u@test.com",
		},
		turn: createAdmittedTurn(params.turn),
		prepareTurn,
		upstreamMessage: "Hello",
		downstreamAbortSignal: new AbortController().signal,
		requestStartTime: Date.now(),
	});

	return { response, prepareTurn };
}

function expectTerminalRequestErrorParts(
	chunks: string[],
	expectedPayload: Record<string, unknown>,
) {
	const parts = parseUiStreamParts(chunks);
	const errorIndex = parts.findIndex(
		(part) => part !== "[DONE]" && part.type === "data-stream-error",
	);
	expect(errorIndex).toBeGreaterThanOrEqual(0);
	expect(parts.slice(errorIndex)).toEqual([
		expect.objectContaining({
			type: "data-stream-error",
			transient: true,
			data: expect.objectContaining(expectedPayload),
		}),
		{ type: "finish", finishReason: "error" },
		"[DONE]",
	]);
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
	const {
		assignFileProductionJobsToAssistantMessage,
		listConversationFileProductionJobs,
		submitFileProductionIntake,
	} = await import("$lib/server/services/file-production");
	const { estimateTokenCount } = await import("$lib/utils/tokens");
	const { buildSkillSystemPromptAppendix } = await import(
		"$lib/server/services/skills/prompt-context"
	);

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
	(
		assignFileProductionJobsToAssistantMessage as ReturnType<typeof vi.fn>
	).mockResolvedValue(undefined);
	(
		listConversationFileProductionJobs as ReturnType<typeof vi.fn>
	).mockResolvedValue([]);
	(submitFileProductionIntake as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		status: 202,
		reused: false,
		job: { id: "job-recovered-1" },
	});
	(estimateTokenCount as ReturnType<typeof vi.fn>).mockReturnValue(100);
	(buildSkillSystemPromptAppendix as ReturnType<typeof vi.fn>).mockReturnValue(
		undefined,
	);
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
						modelId: "model1",
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
				modelId: "model1",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("opens the stream and reports preparation activity before deferred turn preparation resolves", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { buildSkillSystemPromptAppendix } = await import(
			"$lib/server/services/skills/prompt-context"
		);
		const skillPromptContext = createSkillPromptContext();
		const preparedTurn = createTurn({
			conversationId: "deferred-prep-conv",
			streamId: "deferred-prep-stream",
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model One",
			},
			skillPromptContext,
		});
		let resolvePreparation!: (value: ChatTurnPreparationResult) => void;
		let preparationSettled = false;
		const deferredPreparation = new Promise<ChatTurnPreparationResult>(
			(resolve) => {
				resolvePreparation = (value) => {
					preparationSettled = true;
					resolve(value);
				};
			},
		);
		const prepareTurn = vi.fn(() => deferredPreparation);
		(
			buildSkillSystemPromptAppendix as ReturnType<typeof vi.fn>
		).mockReturnValueOnce("skill appendix");
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Prepared answer" },
				finishEvent,
			]),
		);

		const response = runChatStreamOrchestrator({
			user: {
				id: "u1",
				displayName: "User",
				email: "u@test.com",
			},
			turn: createAdmittedTurn({
				conversationId: "deferred-prep-conv",
				streamId: "deferred-prep-stream",
			}),
			prepareTurn,
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		const initialChunks = [
			await readNextSseChunk(reader),
			await readNextSseChunk(reader),
		].join("\n\n");

		expect(initialChunks).toContain(":");
		expect(initialChunks).toContain("context-preparing");
		expect(initialChunks).not.toContain("depth-selected");
		expect(prepareTurn).toHaveBeenCalledTimes(1);
		expect(preparationSettled).toBe(false);
		expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();

		resolvePreparation({ ok: true, value: preparedTurn });
		const remainingChunks: string[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) remainingChunks.push(new TextDecoder().decode(value));
		}
		const remainingBody = remainingChunks.join("");

		expect(remainingBody).toContain("depth-selected");
		expect(remainingBody).toContain("Prepared answer");
		expect(buildSkillSystemPromptAppendix).toHaveBeenCalledWith(
			skillPromptContext,
		);
		expect(runStreamingNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				depthMetadata: preparedTurn.depthMetadata,
				systemPromptAppendix: "skill appendix",
			}),
		);
	});

	it("emits attachment readiness preparation failures as structured terminal stream frames", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const error: ChatTurnRequestError = {
			status: 409,
			error: "Some attachments are still being processed.",
			code: "attachments_not_ready",
			attachmentIds: ["attachment-1", "attachment-2"],
		};
		const { response, prepareTurn } = runAdmittedStreamWithPreparationFailure({
			error,
			turn: {
				conversationId: "attachment-prep-failure-conv",
				streamId: "attachment-prep-failure-stream",
				attachmentIds: ["attachment-1", "attachment-2"],
			},
		});

		const chunks = await readSseResponse(response);

		expect(prepareTurn).toHaveBeenCalledTimes(1);
		expectTerminalRequestErrorParts(chunks, {
			code: "attachments_not_ready",
			status: 409,
			message: "Some attachments are still being processed.",
			error: "Some attachments are still being processed.",
			attachmentIds: ["attachment-1", "attachment-2"],
		});
		expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("emits pending skill preparation failures as structured terminal stream frames", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const error: ChatTurnRequestError = {
			status: 409,
			error: "Another skill session is already active.",
			code: "active_skill_session_conflict",
		};
		const { response } = runAdmittedStreamWithPreparationFailure({
			error,
			turn: {
				conversationId: "skill-prep-failure-conv",
				streamId: "skill-prep-failure-stream",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Skill One",
				},
			},
		});

		const chunks = await readSseResponse(response);

		expectTerminalRequestErrorParts(chunks, {
			code: "active_skill_session_conflict",
			status: 409,
			message: "Another skill session is already active.",
			error: "Another skill session is already active.",
		});
		expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("emits generic depth preparation failures as structured terminal stream frames", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const error: ChatTurnRequestError = {
			status: 422,
			error: "Reasoning Depth could not be resolved for this model.",
			code: "reasoning_depth_unavailable",
		};
		const { response } = runAdmittedStreamWithPreparationFailure({
			error,
			turn: {
				conversationId: "depth-prep-failure-conv",
				streamId: "depth-prep-failure-stream",
				reasoningDepth: "max",
			},
		});

		const chunks = await readSseResponse(response);

		expectTerminalRequestErrorParts(chunks, {
			code: "reasoning_depth_unavailable",
			status: 422,
			message: "Reasoning Depth could not be resolved for this model.",
			error: "Reasoning Depth could not be resolved for this model.",
		});
		expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("broadcasts preparation failure terminal frames before clearing the reconnect buffer", async () => {
		const streamId = "prep-failure-listener-stream";
		const conversationId = "prep-failure-listener-conv";
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		let resolvePreparation!: (value: ChatTurnPreparationResult) => void;
		const deferredPreparation = new Promise<ChatTurnPreparationResult>(
			(resolve) => {
				resolvePreparation = resolve;
			},
		);
		const prepareTurn = vi.fn(() => deferredPreparation);
		const response = runChatStreamOrchestrator({
			user: {
				id: "u1",
				displayName: "User",
				email: "u@test.com",
			},
			turn: createAdmittedTurn({ conversationId, streamId }),
			prepareTurn,
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");
		await readNextSseChunk(reader);
		await readNextSseChunk(reader);

		const listenerChunks: string[] = [];
		expect(
			subscribeToStream({ streamId, userId: "u1", conversationId }, (chunk) =>
				listenerChunks.push(chunk),
			),
		).toBe(true);

		resolvePreparation({
			ok: false,
			error: {
				status: 403,
				error: "Composer Command Registry is disabled.",
				code: "composer_commands_disabled",
			},
		});
		while (!(await reader.read()).done) {
			/* drain */
		}

		expect(listenerChunks.join("")).toContain('"type":"data-stream-error"');
		expect(listenerChunks.join("")).toContain(
			'"code":"composer_commands_disabled"',
		);
		expect(
			getStreamBuffer({ streamId, userId: "u1", conversationId }),
		).toBeNull();
		expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
	});

	it("starts the Memory Reset Generation fact with an immediate rejection handler", async () => {
		const startedError = new Error("reset generation failed");
		let rejectStartedGeneration!: (reason: unknown) => void;
		const startedGeneration = new Promise<number>((_resolve, reject) => {
			rejectStartedGeneration = reject;
		});
		const catchSpy = vi.spyOn(startedGeneration, "catch");
		(
			getCurrentMemoryResetGeneration as ReturnType<typeof vi.fn>
		).mockReturnValueOnce(startedGeneration);

		const fact = startStartedResetGenerationFact("u1");

		expect(getCurrentMemoryResetGeneration).toHaveBeenCalledWith("u1");
		expect(fact).toBe(startedGeneration);
		expect(catchSpy).toHaveBeenCalledWith(expect.any(Function));

		rejectStartedGeneration(startedError);
		await expect(fact).rejects.toBe(startedError);
	});

	it("does not let a slow file-production start snapshot block context/model startup", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { listConversationFileProductionJobs } = await import(
			"$lib/server/services/file-production"
		);
		let resolveSnapshot!: (jobs: Array<{ id: string }>) => void;
		let snapshotResolved = false;
		const slowSnapshot = new Promise<Array<{ id: string }>>((resolve) => {
			resolveSnapshot = (jobs) => {
				snapshotResolved = true;
				resolve(jobs);
			};
		});
		(
			listConversationFileProductionJobs as ReturnType<typeof vi.fn>
		).mockReturnValueOnce(slowSnapshot);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({
			conversationId: "slow-snapshot-conv",
			streamId: "slow-snapshot-stream",
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		try {
			const initialChunks = [
				await readNextSseChunk(reader),
				await readNextSseChunk(reader),
			].join("\n\n");

			expect(initialChunks).toContain(":");
			expect(initialChunks).toContain("context-preparing");
			expect(listConversationFileProductionJobs).toHaveBeenCalledWith(
				"u1",
				"slow-snapshot-conv",
			);
			await vi.waitFor(
				() => expect(runStreamingNormalChatSendModel).toHaveBeenCalled(),
				{ timeout: 100 },
			);
		} finally {
			if (!snapshotResolved) {
				resolveSnapshot([]);
			}
			await reader.cancel().catch(() => undefined);
		}
	});

	it("handles a rejected hot file-production start snapshot when no file tool runs", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const {
			assignFileProductionJobsToAssistantMessage,
			listConversationFileProductionJobs,
		} = await import("$lib/server/services/file-production");
		(
			listConversationFileProductionJobs as ReturnType<typeof vi.fn>
		).mockReturnValueOnce(Promise.reject(new Error("snapshot failed")));
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({
			conversationId: "rejected-snapshot-conv",
			streamId: "rejected-snapshot-stream",
		});
		const chunks = await readSseResponse(response);

		expect(chunks.join("\n\n")).toContain("Hi");
		expect(assignFileProductionJobsToAssistantMessage).not.toHaveBeenCalled();
	});

	it("emits response activity milestones for depth, context preparation, and drafting", async () => {
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

		const response = runStream({
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model One",
			},
		});
		const chunks = await readSseResponse(response);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "depth-selected",
					kind: "depth",
					status: "done",
					detail: "maximum",
				}),
				expect.objectContaining({
					id: "context-preparing",
					kind: "context",
					status: "running",
				}),
				expect.objectContaining({
					id: "context-ready",
					kind: "context",
					status: "done",
				}),
				expect.objectContaining({
					id: "drafting-answer",
					kind: "drafting",
					status: "running",
				}),
			]),
		);
	});

	it("stores the original stream Reasoning depth in the reconnect buffer while running", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		let releaseEvents!: (events: NeutralStreamEvent[]) => void;
		const eventsReady = new Promise<NeutralStreamEvent[]>((resolve) => {
			releaseEvents = resolve;
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([], {
				stream: (async function* () {
					for (const event of await eventsReady) {
						yield event;
					}
				})(),
			}),
		);

		const response = runStream({
			streamId: "depth-buffer-stream",
			reasoningDepth: "max",
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model One",
			},
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		await expect(reader.read()).resolves.toMatchObject({ done: false });

		expect(
			getStreamBuffer({
				streamId: "depth-buffer-stream",
				userId: "u1",
				conversationId: "test-conv",
			}),
		).toMatchObject({
			userMessage: "Hello",
			reasoningDepth: "max",
		});

		releaseEvents([{ type: "text_delta", text: "Done" }, finishEvent]);
		while (!(await reader.read()).done) {
			/* drain */
		}
	});

	it("reconnects to an active stream without preparing or starting a model run", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const ownerController = new AbortController();
		registerActiveChatStream({
			streamId: "active-reconnect-stream",
			userId: "u1",
			conversationId: "active-reconnect-conv",
			controller: ownerController,
		});
		getOrCreateStreamBuffer({
			streamId: "active-reconnect-stream",
			userId: "u1",
			conversationId: "active-reconnect-conv",
			userMessage: "Hello",
			reasoningDepth: "auto",
		});
		appendToStreamBuffer("active-reconnect-stream", "token", {
			text: "Already streaming",
		});
		const prepareTurn = vi.fn(async (): Promise<ChatTurnPreparationResult> => {
			throw new Error("Preparation must not run for active reconnects");
		});

		try {
			const response = runChatStreamOrchestrator({
				user: {
					id: "u1",
					displayName: "User",
					email: "u@test.com",
				},
				turn: createAdmittedTurn({
					conversationId: "active-reconnect-conv",
					streamId: "active-reconnect-stream",
				}),
				prepareTurn,
				upstreamMessage: "Hello",
				downstreamAbortSignal: new AbortController().signal,
				requestStartTime: Date.now(),
				isReconnect: true,
			});
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing response body");

			const firstChunk = await readNextSseChunk(reader);

			expect(firstChunk).toContain(":");
			expect(prepareTurn).not.toHaveBeenCalled();
			expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();

			await reader.cancel().catch(() => undefined);
		} finally {
			clearStreamBuffer("active-reconnect-stream");
			unregisterActiveChatStream("active-reconnect-stream", ownerController);
		}
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
			createNeutralStreamingResult(
				[
					{
						type: "reasoning_delta",
						text: "Thinking through the answer before drafting.",
					},
					{ type: "text_delta", text: "Hi" },
					finishEvent,
				],
				{
					prepared: {
						contextStatus: null,
						taskState: null,
						contextDebug: null,
						contextTraceSections: undefined,
						contextPreparationTimings: [
							{
								stageId: "plan",
								activityClass: "planning",
								status: "done",
								startedAt: 10,
								completedAt: 15,
								durationMs: 5,
							},
							{
								stageId: "prompt_budget",
								activityClass: "budgeting",
								status: "done",
								startedAt: 20,
								completedAt: 31,
								durationMs: 11,
							},
						],
					},
				},
			),
		);

		const preparedTurn = createTurn();
		const prepareTurn = vi.fn(
			async (): Promise<ChatTurnPreparationResult> => ({
				ok: true,
				value: preparedTurn,
			}),
		);
		const response = runChatStreamOrchestrator({
			user: {
				id: "u1",
				displayName: "User",
				email: "u@test.com",
			},
			turn: createAdmittedTurn(),
			prepareTurn,
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
			routePhaseTimings: {
				[SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE]: 1,
				[SERVER_STREAM_TIMELINE_MARKS.CAPACITY]: 2,
				[SERVER_STREAM_TIMELINE_MARKS.ADMISSION]: 3,
			},
		});

		const chunks = await readSseResponse(response);
		const body = chunks.join("\n\n");
		const partTypes = parseUiStreamParts(chunks)
			.filter((part): part is Record<string, unknown> => part !== "[DONE]")
			.map((part) => part.type);
		const metadataPayload = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-stream-metadata",
		)[0];
		const serverTimeline =
			metadataPayload.serverTimeline as StreamTimelineTerminalPayload;
		const phaseTimingLog = infoSpy.mock.calls.find(
			([message]) => message === "[CHAT_STREAM] phase_timing",
		);

		expect(body).not.toContain("event:");
		expect(new Set(partTypes)).toEqual(
			new Set([
				"text-start",
				"text-delta",
				"text-end",
				"data-response-activity",
				"data-stream-metadata",
				"reasoning-start",
				"reasoning-delta",
				"reasoning-end",
				"finish",
			]),
		);
		expect(serverTimeline).toEqual({
			version: STREAM_TIMELINE_PAYLOAD_VERSION,
			server: expect.objectContaining({
				[SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE]: 1,
				[SERVER_STREAM_TIMELINE_MARKS.CAPACITY]: 2,
				[SERVER_STREAM_TIMELINE_MARKS.ADMISSION]: 3,
				[SERVER_STREAM_TIMELINE_MARKS.PRELUDE]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.TURN_PREPARATION]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.DEPTH_SELECTION]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: expect.any(Number),
				[createContextPreparationStageTimelineMark("plan")]: 5,
				[createContextPreparationStageTimelineMark("prompt_budget")]: 11,
				[SERVER_STREAM_TIMELINE_MARKS.END]: expect.any(Number),
			}),
		});
		expect(serverTimeline.server).not.toHaveProperty("preflight");
		expect(phaseTimingLog?.[1]).toEqual(
			expect.objectContaining({
				conversationId: "test-conv",
				streamId: "test-stream",
				route_parse_ms: expect.any(Number),
				admission_ms: expect.any(Number),
				prelude_ms: expect.any(Number),
				turn_preparation_ms: expect.any(Number),
				depth_selection_ms: expect.any(Number),
				model_stream_request_ms: expect.any(Number),
				first_upstream_event_ms: expect.any(Number),
				first_thinking_ms: expect.any(Number),
				first_visible_token_ms: expect.any(Number),
				context_preparation_primary_plan_ms: 5,
				context_preparation_primary_prompt_budget_ms: 11,
				end_ms: expect.any(Number),
			}),
		);
		expect(phaseTimingLog?.[1]).not.toHaveProperty("preflight_ms");
		expect(prepareTurn).toHaveBeenCalledTimes(1);
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
			}),
		);
		expect(endPayload).not.toHaveProperty("contextStatus");
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

	it("recovers with non-stream fallback when a socket terminates after a completed non-file tool", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { runPlainNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/plain-normal-chat-model-run"
		);
		const { persistAssistantEvidence } = await import(
			"$lib/server/services/chat-turn/finalize"
		);
		const recorderEntry = {
			callId: "call-research",
			name: "research_web",
			input: { query: "pasted url" },
			status: "done",
			outputSummary: "Web research returned 1 source and 1 evidence snippet.",
			sourceType: "web",
			candidates: [
				{
					id: "source-1",
					title: "Fetched page",
					url: "https://example.com/page",
					sourceType: "web",
					material: true,
				},
			],
			metadata: {
				ok: true,
				evidenceReady: true,
				sourceCount: 1,
				evidenceCount: 1,
			},
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[
					{
						type: "tool_call",
						callId: "call-research",
						toolName: "research_web",
						input: { query: "pasted url" },
					},
					{
						type: "tool_result",
						callId: "call-research",
						toolName: "research_web",
						output: { success: true },
					},
					{ type: "error", error: "socket terminated" },
				],
				{
					normalChatToolCalls: [recorderEntry],
					prepared: {
						contextStatus: null,
						taskState: null,
						contextDebug: null,
						contextTraceSections: undefined,
						contextPreparationTimings: [
							{
								stageId: "plan",
								activityClass: "planning",
								status: "done",
								startedAt: 10,
								completedAt: 13,
								durationMs: 3,
							},
						],
					},
				},
			),
		);
		(runPlainNormalChatSendModel as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				text: "Recovered answer from fetched page.",
				contextStatus: null,
				taskState: null,
				contextDebug: null,
				providerUsage: null,
				normalChatToolCalls: [],
				modelId: "model1",
				modelDisplayName: "Model One",
				contextPreparationTimings: [
					{
						stageId: "plan",
						activityClass: "planning",
						status: "done",
						startedAt: 20,
						completedAt: 27,
						durationMs: 7,
					},
				],
			},
		);

		const response = runStream();
		const chunks = await readSseResponse(response);
		const body = chunks.join("\n\n");
		const metadataPayload = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-stream-metadata",
		)[0];
		const serverTimeline =
			metadataPayload.serverTimeline as StreamTimelineTerminalPayload;

		expect(runPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				disableTools: true,
				systemPromptAppendix: expect.stringContaining(
					"previous streaming attempt completed these tool calls",
				),
			}),
		);
		expect(body).toContain("Recovered answer from fetched page.");
		expect(body).not.toContain("data-stream-error");
		expect(serverTimeline.server).toEqual(
			expect.objectContaining({
				[createContextPreparationStageTimelineMark("plan")]: 3,
				[createContextPreparationStageTimelineMark("plan", {
					type: "fallback",
					attempt: 1,
				})]: 7,
			}),
		);
		expect(persistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCalls: expect.arrayContaining([
					expect.objectContaining({
						name: "research_web",
						status: "done",
						metadata: expect.objectContaining({
							evidenceReady: true,
						}),
					}),
				]),
			}),
		);
	});

	it("emits provider error events after completed non-file tools without non-stream fallback", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { runPlainNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/plain-normal-chat-model-run"
		);
		const recorderEntry = {
			callId: "call-research-provider-error",
			name: "research_web",
			input: { query: "provider error after tool" },
			status: "done",
			outputSummary: "Web research returned 1 source.",
			sourceType: "web",
			candidates: [
				{
					id: "source-provider-error",
					title: "Fetched page",
					url: "https://example.com/provider-error",
					sourceType: "web",
					material: true,
				},
			],
			metadata: {
				ok: true,
				evidenceReady: true,
				sourceCount: 1,
				evidenceCount: 1,
			},
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[
					{
						type: "tool_call",
						callId: "call-research-provider-error",
						toolName: "research_web",
						input: { query: "provider error after tool" },
					},
					{
						type: "tool_result",
						callId: "call-research-provider-error",
						toolName: "research_web",
						output: { success: true },
					},
					{
						type: "error",
						error: "Provider rejected the model response after tool use.",
					},
				],
				{ normalChatToolCalls: [recorderEntry] },
			),
		);
		(runPlainNormalChatSendModel as ReturnType<typeof vi.fn>).mockResolvedValue(
			{
				text: "Unexpected fallback answer.",
				contextStatus: null,
				taskState: null,
				contextDebug: null,
				providerUsage: null,
				normalChatToolCalls: [],
				modelId: "model1",
				modelDisplayName: "Model One",
			},
		);

		const response = runStream({
			conversationId: "provider-error-after-tool-conv",
			streamId: "provider-error-after-tool-stream",
		});
		const chunks = await readSseResponse(response);
		const parts = parseUiStreamParts(chunks);

		expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
		expect(parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "data-stream-error",
					transient: true,
					data: expect.objectContaining({
						code: "backend_failure",
					}),
				}),
				{ type: "finish", finishReason: "error" },
				"[DONE]",
			]),
		);
		expect(chunks.join("\n\n")).not.toContain("Unexpected fallback answer.");
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
		expect(
			uiDataParts<Record<string, unknown>>(
				parseUiStreamParts([remainingBody]),
				"data-stream-metadata",
			)[0].serverTimeline,
		).toEqual({
			version: STREAM_TIMELINE_PAYLOAD_VERSION,
			server: expect.objectContaining({
				[SERVER_STREAM_TIMELINE_MARKS.PRELUDE]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST]: expect.any(Number),
				[SERVER_STREAM_TIMELINE_MARKS.END]: expect.any(Number),
			}),
		});
	});

	it("completes stream-closed-without-finish responses with terminal server timeline metadata", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([{ type: "text_delta", text: "Partial" }]),
		);

		const response = runStream({
			conversationId: "closed-without-finish-conv",
			streamId: "closed-without-finish-stream",
		});
		const chunks = await readSseResponse(response);
		const metadataPayload = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-stream-metadata",
		)[0];

		expect(metadataPayload).toMatchObject({
			streamClosedWithoutFinish: true,
			serverTimeline: {
				version: STREAM_TIMELINE_PAYLOAD_VERSION,
				server: expect.objectContaining({
					[SERVER_STREAM_TIMELINE_MARKS.PRELUDE]: expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST]:
						expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]:
						expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]:
						expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.END]: expect.any(Number),
				}),
			},
		});
	});

	it("keeps explicit stop semantics when upstream closes cleanly after abort", async () => {
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
					yield { type: "text_delta", text: "Partial answer" };
					await new Promise<void>((resolve) => {
						markStreamListening();
						params.signal?.addEventListener("abort", () => resolve(), {
							once: true,
						});
					});
				})(),
			});
		});

		const response = runStream({
			conversationId: "stop-clean-conv",
			streamId: "stop-clean-stream",
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing response body");

		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
		await streamListening;
		const stopped = requestActiveChatStreamStop({
			streamId: "stop-clean-stream",
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
		expect(remainingBody).toContain('"wasStopped":true');
		expect(remainingBody).not.toContain("streamClosedWithoutFinish");
	});

	it("does not start a main stream when registry registration rejects the stream id", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const otherUserController = new AbortController();
		registerActiveChatStream({
			streamId: "colliding-main-stream",
			userId: "other-user",
			controller: otherUserController,
			conversationId: "other-conversation",
		});

		try {
			const response = runStream({
				conversationId: "u1-conversation",
				streamId: "colliding-main-stream",
			});
			const body = await response.text();

			expect(body).toBe("");
			expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
			expect(
				getStreamBuffer({
					streamId: "colliding-main-stream",
					userId: "u1",
					conversationId: "u1-conversation",
				}),
			).toBeNull();
			expect(otherUserController.signal.aborted).toBe(false);
		} finally {
			unregisterActiveChatStream("colliding-main-stream", otherUserController);
		}
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
				depthMetadata: {
					requested: "auto",
					appliedProfile: "standard",
					fallback: false,
					modelId: "model1",
					modelDisplayName: "Model One",
					appliedEffort: {
						dimensions: ["provider_reasoning", "tool_steps"],
						providerReasoning: {
							thinkingMode: "auto",
							reasoningEffort: "low",
							supported: true,
							constrained: false,
						},
						tools: {
							maxToolSteps: 14,
							maxWebSources: 6,
							sourceExpansion: false,
						},
					},
				},
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
				expect.objectContaining({
					evidenceStatus: "pending",
					modelDisplayName: "Model One",
					depthMetadata: expect.objectContaining({
						requested: "auto",
						appliedProfile: "standard",
						fallback: false,
						appliedEffort: expect.objectContaining({
							providerReasoning: expect.objectContaining({
								reasoningEffort: "low",
							}),
							tools: expect.objectContaining({
								maxToolSteps: 14,
								maxWebSources: 6,
							}),
						}),
					}),
				}),
			);
		});
		expect(upstreamSignal?.aborted).toBe(false);
	});
});
