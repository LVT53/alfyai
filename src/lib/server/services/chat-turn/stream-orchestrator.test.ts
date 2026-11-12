import { streamTextDeltaEvent as journalTextFrame } from "./stream";

vi.mock("./completion-lifetime", () => ({
	observeCompletionTurn: async () => null,
}));

import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	broadcastStreamChunk,
	clearStreamBuffer,
	getOrCreateStreamBuffer,
	getStreamBuffer,
	isStreamActive,
	registerActiveChatStream,
	requestActiveChatStreamStop,
	subscribeToStream,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile/reset-generation";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import {
	createContextPreparationStageTimelineMark,
	SERVER_STREAM_TIMELINE_MARKS,
	STREAM_TIMELINE_PAYLOAD_VERSION,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import { TURN_FINALIZATION_WINDOW_MS } from "$lib/shared/normal-chat-completion";
import type {
	NormalChatOutputEvent,
	NormalChatOutputRole,
} from "$lib/shared/normal-chat-output";
import { type AskResumeInput, capturedProvenanceResults } from "./ask-capture";
import {
	runChatStreamOrchestrator,
	type StreamOrchestratorOptions,
	startStartedResetGenerationFact,
} from "./stream-orchestrator";
import type {
	AdmittedChatTurn,
	AppliedSkillContext,
	ChatTurnPreflight,
	ChatTurnPreparationResult,
	ChatTurnRequestError,
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

// The watchdog cuts a turn off at the model deadline (requestTimeoutMs above)
// plus the finalization window: the instant the hang tests below advance to.
// The engine itself is still given the model deadline (turn-deadline-
// finalization.test.ts).
const TURN_BOUND_MS = 30_000 + TURN_FINALIZATION_WINDOW_MS;

vi.mock("$lib/server/services/conversations", () => ({
	touchConversation: vi.fn(() => Promise.resolve()),
	// A stopped turn asks whether its conversation is still there before it
	// saves anything; resetCompletionMocks() says it is.
	getConversation: vi.fn(),
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

// The store of the questions Alfy asks (tested on a real database in
// ask-questions.test.ts). Down here, the orchestrator tests assert what the turn
// asks of it: the sweep at its start, the stamp of a paused reply, the discard
// of a question no reply was saved with. resetCompletionMocks() sets the
// defaults after every vi.resetAllMocks().
vi.mock("$lib/server/services/chat-turn/ask-questions", () => ({
	stampAskQuestion: vi.fn(),
	discardAskQuestion: vi.fn(),
	discardStaleAskQuestions: vi.fn(),
	// a resume gives its question back when it ends unsaved and settles it when its
	// segment is saved
	releaseAskQuestion: vi.fn(),
	settleAskQuestion: vi.fn(),
}));

// P2 — the instant-acknowledgment control call is mocked at this seam so the
// SSE-contract tests below stay deterministic and never attempt a real
// control-model call. resetCompletionMocks() below re-establishes the
// default (null — "no acknowledgment fired") after every vi.resetAllMocks();
// individual tests override it to exercise the wiring.
vi.mock("$lib/server/services/chat-turn/turn-acknowledgment", () => ({
	resolveTurnAcknowledgment: vi.fn(),
}));

// P3b — the reasoning-phase classifier is mocked at this seam too, mirroring
// P2's turn-acknowledgment mock above: a real session would attempt a
// control-model call the SSE-contract tests below must never make.
// resetCompletionMocks() below establishes the default (a no-op session that
// samples nothing and returns no steps); individual tests override it via a
// fresh `await import(...)` to exercise the wiring, exactly like
// resolveTurnAcknowledgment above.
vi.mock("$lib/server/services/chat-turn/thought-step-classifier", () => ({
	createThoughtStepClassifierSession: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
	listConversationMessagesForExport: vi.fn(() => Promise.resolve([])),
	// The bounded prior-turn window stream-completion reads for the follow-up
	// suggester; empty here (these tests never assert on the chips).
	listMessageWindow: vi.fn(() =>
		Promise.resolve({ messages: [], hasMoreBefore: false }),
	),
	// The answer a resume's segment writes into the call of the row that asked.
	updateAssistantToolCallResult: vi.fn(),
	// What the turn's language lookup reads (chat-turn/reply-language.ts):
	// nothing on record here.
	getLastConversationLanguage: vi.fn(async () => null),
	getPreviousUserMessageText: vi.fn(async () => null),
}));

// The small call that names the conversation's language after the reply: down
// here, so the deterministic chain is what these tests meet.
vi.mock("$lib/server/services/chat-turn/conversation-language", () => ({
	readConversationLanguage: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
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

// The post-turn side effects now live in ./finalize-steps, which finalize.ts
// (kept real here) calls in its single ordered sequence. Seam at that module
// boundary rather than injecting overrides through completeStreamTurn params.
// Post-turn prompt usage write for the context usage ring. Passthrough
// here: the orchestrator contract tests only care that the prepared context
// status reaches finalize and the terminal payload, not the DB write.
vi.mock("$lib/server/services/chat-turn/context-usage", () => ({
	recordCompletedTurnContextUsage: vi.fn(
		async (params: { contextStatus: unknown }) => params.contextStatus,
	),
}));

// The activity rows a turn's tool calls leave are not what these tests are
// about, and the messages they would point at are mocked: left real, each write
// fails its foreign key and logs. Plain functions, so vi.resetAllMocks() leaves them.
vi.mock("$lib/server/services/activity-events", () => ({
	recordToolCallActivityEvents: async () => undefined,
	recordSkillUseActivityEvent: async () => undefined,
	recordTurnOriginActivityEvent: async () => undefined,
}));

vi.mock("$lib/server/services/chat-turn/finalize-steps", () => ({
	nameConversationAfterTurn: vi.fn(),
	// a stopped turn records only its analytics instead of the turn state
	recordAssistantTurnAnalytics: vi.fn(() => Promise.resolve()),
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
}));

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

// Issue 7.5 — startPendingWriteIdsAtStartFact's sibling snapshot to
// the turn-start fact. Mocked here (rather than left
// pointed at the real $lib/server/db default) so the "does not block
// startup" / "degrades on rejection" robustness tests below can control it
// directly. File association uses exact current producer IDs, not a snapshot.
vi.mock("$lib/server/services/connections/pending-writes", () => ({
	listPendingWritesForConversation: vi.fn(() => Promise.resolve([])),
	assignPendingWritesToAssistantMessage: vi.fn(),
}));

vi.mock("$lib/utils/tokens", () => ({
	estimateTokenCount: vi.fn(() => 100),
}));

type NeutralStreamEvent =
	import("../normal-chat-model").StreamingNormalChatModelRunEvent;

const finishEvent: NeutralStreamEvent = {
	type: "finish",
	finishReason: "stop",
	rawFinishReason: "stop",
	model: {
		modelId: "model1",
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
		modelId: "model1" as const,
		modelDisplayName: "Model One",
		skipPersistUserMessage: false,
		turnOrigin: "send",
		attachmentIds: [],
		pictureRefs: [],
		imageMarks: null,
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "thorough",
		thinkingMode: "auto",
		forceWebSearch: false,
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		depthMetadata: {
			requested: "thorough",
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
		appliedSkill: _appliedSkill,
		...admitted
	} = turn;
	return admitted as unknown as AdmittedChatTurn;
}

function createAppliedSkillContext(
	overrides: Partial<AppliedSkillContext> = {},
): AppliedSkillContext {
	return {
		skillId: "skill-1",
		skillOwnership: "user",
		skillKind: "user_skill",
		skillDisplayName: "Skill One",
		instructionsEnvelope:
			'Skill "Skill One" instructions — apply these for the rest of this turn:\n\nFollow the skill.',
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
		completionTurn: {
			segmentId: "fixture-segment",
			finish: async () => {},
			getSnapshot: () => ({
				segmentId: "fixture-segment",
				events: [],
				completion: {
					version: 1,
					turnId: "fixture-turn",
					segmentId: "fixture-segment",
					phase: "working",
					outcome: overrides.fixtureOutcome ?? "answered",
					stopCause: "natural_stop",
					workingStopCause: "natural_stop",
					closingAttempted: false,
				},
			}),
		},
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
		// A run that asked the person says so through getTurnAsk, and hands over
		// what it said and read (getResponseMessages) after what it was given
		// (continuationGiven): a test of a pause overrides them.
		getTurnAsk: () => null,
		getResponseMessages: () => [],
		continuationGiven: [],
		...overrides,
	};
}

function createWatchdogStreamingResult(
	events: NeutralStreamEvent[],
	overrides: Record<string, unknown> = {},
) {
	const normalChatToolCalls =
		(overrides.normalChatToolCalls as
			| import("../messages-types").ToolCallEntry[]
			| undefined) ?? [];
	return {
		completionTurn: {
			segmentId: "fixture-segment",
			finish: async () => {},
			getSnapshot: () => ({
				version: 1 as const,
				fidelity: "exact" as const,
				turnId: "fixture-turn",
				original: {
					providerId: "model1",
					providerBaseUrl: "https://fixture.invalid",
					modelName: "model1",
					messages: [],
				},
				steps: [],
				prepared: { maxOutputTokens: 1024 },
				pendingImageEntries: [],
				executions: [],
				usage: [],
				sequence: 0,
				nextAttempt: 0,
				workingSteps: 0,
				closingSegments: [],
				deadlineAt: 30000,
				totalTimeoutMs: 30000,
				segmentId: "fixture-segment",
				events: [],
				completion: {
					version: 1 as const,
					turnId: "fixture-turn",
					segmentId: "fixture-segment",
					phase: "working" as const,
					outcome: (overrides.fixtureOutcome ??
						"answered") as import("$lib/shared/normal-chat-completion").NormalChatCompletion["outcome"],
					stopCause: "natural_stop" as const,
					workingStopCause: "natural_stop" as const,
					closingAttempted: false,
				},
			}),
		},
		prepared: {
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: undefined,
		},
		modelId: "model1" as const,
		resolvedProviderId: "model1",
		modelDisplayName: "Model One",
		stream: (async function* () {
			for (const event of events) {
				yield event;
			}
		})(),
		prefetchedToolCalls: [],
		getNormalChatToolCalls: () => normalChatToolCalls,
		getToolCalls: () => normalChatToolCalls,
		// A run that asked the person says so through getTurnAsk, and hands over
		// what it said and read (getResponseMessages) after what it was given
		// (continuationGiven): a test of a pause overrides them.
		getTurnAsk: () => null,
		getResponseMessages: () => [],
		continuationGiven: [],
		...overrides,
	};
}

function runStream(
	overrides: Partial<ChatTurnPreflight> = {},
	user: Partial<StreamOrchestratorOptions["user"]> = {},
) {
	return runChatStreamOrchestrator({
		user: {
			id: "u1",
			displayName: "User",
			email: "u@test.com",
			...user,
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
	const { getConversation, touchConversation } = await import(
		"$lib/server/services/conversations"
	);
	const { createMessage, listConversationMessagesForExport } = await import(
		"$lib/server/services/messages"
	);
	const {
		persistAssistantEvidence,
		persistAssistantTurnState,
		persistUserTurnAttachments,
		recordAssistantTurnAnalytics,
		runPostTurnTasks,
	} = await import("$lib/server/services/chat-turn/finalize-steps");
	const { getChatFilesForAssistantMessage, syncGeneratedFilesToMemory } =
		await import("$lib/server/services/chat-files");
	const {
		assignFileProductionJobsToAssistantMessage,
		listConversationFileProductionJobs,
		submitFileProductionIntake,
	} = await import("$lib/server/services/file-production");
	const {
		assignPendingWritesToAssistantMessage,
		listPendingWritesForConversation,
	} = await import("$lib/server/services/connections/pending-writes");
	const { estimateTokenCount } = await import("$lib/utils/tokens");
	const {
		stampAskQuestion,
		discardAskQuestion,
		discardStaleAskQuestions,
		releaseAskQuestion,
		settleAskQuestion,
	} = await import("$lib/server/services/chat-turn/ask-questions");
	const { updateAssistantToolCallResult } = await import(
		"$lib/server/services/messages"
	);
	const { resolveTurnAcknowledgment } = await import(
		"$lib/server/services/chat-turn/turn-acknowledgment"
	);
	const { createThoughtStepClassifierSession } = await import(
		"$lib/server/services/chat-turn/thought-step-classifier"
	);

	(touchConversation as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	// The conversation is there, unless a test says it was deleted.
	(getConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
		id: "test-conv",
	});
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
	(recordAssistantTurnAnalytics as ReturnType<typeof vi.fn>).mockResolvedValue(
		undefined,
	);
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
	(
		assignPendingWritesToAssistantMessage as ReturnType<typeof vi.fn>
	).mockResolvedValue(undefined);
	(
		listPendingWritesForConversation as ReturnType<typeof vi.fn>
	).mockResolvedValue([]);
	(submitFileProductionIntake as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		status: 202,
		reused: false,
		job: { id: "job-recovered-1" },
	});
	(estimateTokenCount as ReturnType<typeof vi.fn>).mockReturnValue(100);
	(stampAskQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(true);
	(discardAskQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(discardStaleAskQuestions as ReturnType<typeof vi.fn>).mockResolvedValue(0);
	(releaseAskQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(true);
	(settleAskQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({});
	(updateAssistantToolCallResult as ReturnType<typeof vi.fn>).mockResolvedValue(
		true,
	);
	// P3b — default no-op session: samples nothing, returns no steps. Tests
	// that exercise the classifier wiring itself override this per-test.
	(
		createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
	).mockReturnValue({
		onReasoningDelta: vi.fn(),
		stop: vi.fn(),
		getSteps: vi.fn(() => []),
	});
	(resolveTurnAcknowledgment as ReturnType<typeof vi.fn>).mockResolvedValue(
		null,
	);
}

describe("stream-orchestrator SSE contract", () => {
	beforeEach(async () => {
		vi.resetAllMocks();
		await resetCompletionMocks();
	});

	afterEach(() => {
		clearStreamBuffer("test-stream");
		unregisterActiveChatStream("test-stream");
		vi.useRealTimers();
	});

	it("persists structural completion and explicit narration without rebuilding a fallback", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { runPlainNormalChatSendModel } = await import(
			"./plain-normal-chat-model-run"
		);
		const { createMessage } = await import("../messages");
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			phase: "closing" as const,
		};
		const completion = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			phase: "closing" as const,
			outcome: "answered" as const,
			stopCause: "natural_stop" as const,
			workingStopCause: "tool_budget" as const,
			closingAttempted: true,
		};
		const events = [
			{
				...scope,
				sequence: 0,
				type: "block_start",
				blockId: "b",
				nativeId: "b",
				kind: "text",
				role: "answer",
			},
			{
				...scope,
				sequence: 1,
				type: "block_delta",
				blockId: "b",
				text: "Let me check.\n\n## Result\n42",
			},
			{ ...scope, sequence: 2, type: "completion", completion },
		];
		const finish = vi.fn(async () => {});
		vi.mocked(runStreamingNormalChatSendModel).mockImplementation(
			async (params) => {
				for (const event of events) params.onOutputEvent?.(event as never);
				return createNeutralStreamingResult(
					[
						{ type: "text_delta", text: "Let me check.\n\n## Result\n42" },
						finishEvent,
					],
					{
						completionTurn: {
							segmentId: "s",
							getSnapshot: () => ({ segmentId: "s", events, completion }),
							finish,
						},
					},
				) as never;
			},
		);
		const parts = parseUiStreamParts(
			await readSseResponse(runStream({ streamId: "structured-owned" })),
		);
		expect(uiDataParts(parts, "data-normal-chat-output")).toEqual(events);
		expect(createMessage).toHaveBeenCalledWith(
			"test-conv",
			"assistant",
			"Let me check.\n\n## Result\n42",
			undefined,
			undefined,
			expect.objectContaining({ normalChatOutput: { version: 1, events } }),
		);
		expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
		expect(finish).toHaveBeenCalledWith("msg-1");
	});

	it("does not return a durable receipt when the new user message cannot be saved", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("../messages");
		vi.mocked(runStreamingNormalChatSendModel).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Canonical" },
				finishEvent,
			]) as never,
		);
		vi.mocked(createMessage).mockRejectedValueOnce(
			new Error("Synthetic user-message storage failure"),
		);
		const parts = parseUiStreamParts(
			await readSseResponse(runStream({ streamId: "failed-user-save" })),
		);
		expect(createMessage).toHaveBeenCalledTimes(1);
		expect(parts).toContainEqual({ type: "finish", finishReason: "error" });
		expect(uiDataParts(parts, "data-stream-metadata")).toEqual([]);
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

	it("hands the card pictures and the marks of the turn to the model run", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const pictureRefs = [{ imageFileId: "file-1", number: 1 }];
		const imageMarks = {
			imageFileId: "file-1",
			marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.4 }],
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		await readSseResponse(runStream({ pictureRefs, imageMarks }));

		expect(runStreamingNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({ pictureRefs, imageMarks }),
		);
	});

	it("opens the stream and reports preparation activity before deferred turn preparation resolves", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const appliedSkill = createAppliedSkillContext();
		const preparedTurn = createTurn({
			conversationId: "deferred-prep-conv",
			streamId: "deferred-prep-stream",
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model One",
			},
			appliedSkill,
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
		expect(runStreamingNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				depthMetadata: preparedTurn.depthMetadata,
				pendingSkillInstructions: appliedSkill.instructionsEnvelope,
			}),
		);
	});

	// The provenance line shows only what the USER chose for the turn. The
	// orchestrator is where both choices are still known — the skill resolved
	// at preflight, the forced `/web` on the request — so it records them with
	// the assistant message (see $lib/message-user-intent.ts) and repeats the
	// record on the terminal frame for the live session.
	it("records the user's applied skill and forced web search with the assistant message", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Drafted." },
				finishEvent,
			]),
		);

		const response = runStream({
			conversationId: "user-intent-conv",
			streamId: "user-intent-stream",
			forceWebSearch: true,
			appliedSkill: createAppliedSkillContext(),
		});
		const parts = parseUiStreamParts(await readSseResponse(response));

		const userIntent = {
			skill: { id: "skill-1", displayName: "Skill One" },
			webSearch: true,
		};
		expect(
			uiDataParts<Record<string, unknown>>(parts, "data-stream-metadata").at(
				-1,
			),
		).toMatchObject({ userIntent });
		await vi.waitFor(() => {
			expect(createMessage).toHaveBeenCalledWith(
				"user-intent-conv",
				"assistant",
				"Drafted.",
				undefined,
				undefined,
				expect.objectContaining({ userIntent }),
			);
		});
	});

	// A skill the model loads via `use_skill`, a `research_web` it runs by
	// itself: neither is the user's choice, so no record is written at all.
	it("records no user intent for a turn where only the model chose its tools", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{
					type: "tool_call",
					callId: "call-skill",
					toolName: "use_skill",
					input: { id: "skill-1" },
				},
				{
					type: "tool_result",
					callId: "call-skill",
					toolName: "use_skill",
					output: { ok: true },
				},
				{
					type: "tool_call",
					callId: "call-web",
					toolName: "research_web",
					input: { query: "notice period" },
				},
				{
					type: "tool_result",
					callId: "call-web",
					toolName: "research_web",
					output: { ok: true },
				},
				{ type: "text_delta", text: "Answered." },
				finishEvent,
			]),
		);

		const response = runStream({
			conversationId: "model-only-conv",
			streamId: "model-only-stream",
		});
		const parts = parseUiStreamParts(await readSseResponse(response));

		expect(
			uiDataParts<Record<string, unknown>>(parts, "data-stream-metadata").at(
				-1,
			),
		).not.toHaveProperty("userIntent");
		await vi.waitFor(() => {
			const assistantCall = (
				createMessage as ReturnType<typeof vi.fn>
			).mock.calls.find(
				(call) => call[0] === "model-only-conv" && call[1] === "assistant",
			);
			expect(assistantCall).toBeDefined();
			expect(assistantCall?.[5]).not.toHaveProperty("userIntent");
		});
	});

	it("detaches at the deadline without falsely failing an assistant commit already in flight", async () => {
		vi.useFakeTimers();
		const { createMessage } = await import("$lib/server/services/messages");
		const finish = vi.fn(async (_id?: string) => {});
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		vi.mocked(run).mockResolvedValue(
			createWatchdogStreamingResult(
				[{ type: "text_delta", text: "Answer." }, finishEvent],
				{
					completionTurn: {
						segmentId: "fixture-segment",
						getSnapshot: () => ({
							segmentId: "fixture-segment",
							events: [],
							completion: {
								version: 1,
								turnId: "fixture-turn",
								segmentId: "fixture-segment",
								phase: "working",
								outcome: "answered",
								stopCause: "natural_stop",
								workingStopCause: "natural_stop",
								closingAttempted: false,
							},
						}),
						finish,
					},
				},
			),
		);
		let land!: (value: never) => void;
		const pending = new Promise<never>((resolve) => {
			land = resolve;
		});
		vi.mocked(createMessage).mockImplementation(async (_conversation, role) =>
			role === "assistant" ? pending : ({ id: "user-row" } as never),
		);
		let settled = false;
		const reading = readSseResponse(runStream()).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(createMessage).toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(TURN_BOUND_MS);
			expect(settled).toBe(true);
			expect((await reading).join("")).not.toContain("data-stream-error");
			expect(finish).not.toHaveBeenCalled();
			expect(run).toHaveBeenCalledTimes(1);
			land({ id: "late-assistant" } as never);
			await vi.advanceTimersByTimeAsync(0);
			expect(finish).toHaveBeenCalledWith("late-assistant");
		} finally {
			land({ id: "late-assistant" } as never);
			await vi.advanceTimersByTimeAsync(0);
			vi.useRealTimers();
		}
	});

	it("bounds a stalled task-state read after model preparation without pulling the model", async () => {
		vi.useFakeTimers();
		const { getConversationTaskState } = await import(
			"$lib/server/services/task-state"
		);
		vi.mocked(getConversationTaskState).mockReturnValue(new Promise(() => {}));
		let pulled = false;
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		vi.mocked(run).mockResolvedValue(
			createWatchdogStreamingResult([], {
				stream: (async function* () {
					pulled = true;
					yield finishEvent;
				})(),
			}),
		);
		let settled = false;
		const reading = readSseResponse(runStream()).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(TURN_BOUND_MS);
			expect(settled).toBe(true);
			expect((await reading).join("")).toContain("data-stream-error");
			expect(pulled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		false,
		true,
	])("releases its owner when stalled iterator cleanup hangs=%s", async (cleanupHangs) => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		const finish = vi.fn(async () => {});
		const returned = vi.fn(() =>
			cleanupHangs
				? new Promise<IteratorResult<NeutralStreamEvent>>(() => {})
				: Promise.resolve({ done: true as const, value: undefined }),
		);
		const next = vi.fn(
			() => new Promise<IteratorResult<NeutralStreamEvent>>(() => {}),
		);
		vi.mocked(run).mockResolvedValue(
			createWatchdogStreamingResult([], {
				stream: { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
				completionTurn: { finish, getSnapshot: () => null },
			}),
		);
		const reading = readSseResponse(runStream());
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(next).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(TURN_BOUND_MS);
			expect((await reading).join("")).toContain("data-stream-error");
			expect(returned).toHaveBeenCalledTimes(1);
			expect(finish).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds finalization reads and prevents a late read from starting persistence", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		vi.mocked(runStreamingNormalChatSendModel).mockResolvedValue(
			createWatchdogStreamingResult([
				{ type: "text_delta", text: "Answer." },
				finishEvent,
			]),
		);
		let resolveReset!: (value: number) => void;
		const pendingReset = new Promise<number>((resolve) => {
			resolveReset = resolve;
		});
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
			startedResetGeneration: pendingReset,
		});
		let settled = false;
		const reading = readSseResponse(response).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(TURN_BOUND_MS);
			expect(settled).toBe(true);
			expect((await reading).join("")).toContain("data-stream-error");
			resolveReset(0);
			await vi.advanceTimersByTimeAsync(0);
			expect(createMessage).not.toHaveBeenCalled();
		} finally {
			resolveReset(0);
			await vi.advanceTimersByTimeAsync(0);
			vi.useRealTimers();
		}
	});
	it("bounds preparation and fences a late completion before any model dispatch", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		let resolvePreparation!: (value: ChatTurnPreparationResult) => void;
		const preparation = new Promise<ChatTurnPreparationResult>((resolve) => {
			resolvePreparation = resolve;
		});
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createAdmittedTurn(),
			prepareTurn: () => preparation,
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		let settled = false;
		const reading = readSseResponse(response).then((value) => {
			settled = true;
			return value;
		});
		try {
			await vi.advanceTimersByTimeAsync(TURN_BOUND_MS);
			expect(settled).toBe(true);
			expect((await reading).join("")).toContain("data-stream-error");
			resolvePreparation({ ok: true, value: createTurn() });
			await vi.advanceTimersByTimeAsync(0);
			expect(runStreamingNormalChatSendModel).not.toHaveBeenCalled();
		} finally {
			resolvePreparation({
				ok: false,
				error: { status: 500, error: "test cleanup" },
			});
			await vi.advanceTimersByTimeAsync(0);
			vi.useRealTimers();
		}
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
				reasoningDepth: "thorough",
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

	// Pending writes retain their independent turn-start snapshot: the
	// snapshot is kicked off eagerly (ensurePendingWriteIdsAtStart, called
	// unconditionally at turn start) and must neither block model startup nor
	// crash/mis-stamp the turn if it rejects.
	it("does not let a slow pending-write start snapshot block context/model startup", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { listPendingWritesForConversation } = await import(
			"$lib/server/services/connections/pending-writes"
		);
		let resolveSnapshot!: (writes: Array<{ id: string }>) => void;
		let snapshotResolved = false;
		const slowSnapshot = new Promise<Array<{ id: string }>>((resolve) => {
			resolveSnapshot = (writes) => {
				snapshotResolved = true;
				resolve(writes);
			};
		});
		(
			listPendingWritesForConversation as ReturnType<typeof vi.fn>
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
			conversationId: "slow-pw-snapshot-conv",
			streamId: "slow-pw-snapshot-stream",
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
			expect(listPendingWritesForConversation).toHaveBeenCalledWith(
				"u1",
				"slow-pw-snapshot-conv",
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

	it("handles a rejected hot pending-write start snapshot when no connection tool runs", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const {
			assignPendingWritesToAssistantMessage,
			listPendingWritesForConversation,
		} = await import("$lib/server/services/connections/pending-writes");
		(
			listPendingWritesForConversation as ReturnType<typeof vi.fn>
		).mockReturnValueOnce(
			Promise.reject(new Error("pending-write snapshot failed")),
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
			conversationId: "rejected-pw-snapshot-conv",
			streamId: "rejected-pw-snapshot-stream",
		});
		const chunks = await readSseResponse(response);

		expect(chunks.join("\n\n")).toContain("Hi");
		expect(assignPendingWritesToAssistantMessage).not.toHaveBeenCalled();
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
				requested: "thorough",
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

	// P2 (ADR-0056) — instant turn acknowledgment.
	it("emits the instant acknowledgment as a response activity, over the existing data-response-activity part, when it resolves in time", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { resolveTurnAcknowledgment } = await import(
			"$lib/server/services/chat-turn/turn-acknowledgment"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);
		(resolveTurnAcknowledgment as ReturnType<typeof vi.fn>).mockResolvedValue({
			intentClass: "research",
			topic: "the weather in Paris",
		});

		const response = runStream({ conversationId: "ack-conv" });
		const chunks = await readSseResponse(response);
		const parts = parseUiStreamParts(chunks);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parts,
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "turn-acknowledged",
					kind: "acknowledgment",
					status: "running",
					detail: "research",
					label: "the weather in Paris",
				}),
			]),
		);
		// No new AI SDK UI stream part name: every part type present is still
		// drawn from the pre-existing closed set.
		const partTypes = new Set(
			parts
				.filter((part): part is Record<string, unknown> => part !== "[DONE]")
				.map((part) => part.type),
		);
		expect(partTypes).toEqual(
			new Set([
				"text-start",
				"text-delta",
				"text-end",
				"data-response-activity",
				"data-stream-metadata",
				"finish",
			]),
		);

		expect(resolveTurnAcknowledgment).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "u1",
				conversationId: "ack-conv",
				message: "Hello",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("falls back silently to the existing spine when the acknowledgment call rejects — never surfaces an error, the turn still completes", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { resolveTurnAcknowledgment } = await import(
			"$lib/server/services/chat-turn/turn-acknowledgment"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);
		(resolveTurnAcknowledgment as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("control-model timeout"),
		);

		const response = runStream({ conversationId: "ack-timeout-conv" });
		const chunks = await readSseResponse(response);
		const body = chunks.join("\n\n");
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-response-activity",
		);

		// The turn proceeds and completes exactly as if no acknowledgment had
		// ever been attempted: no error surfaced, real content still streams.
		expect(body).toContain("Hi");
		expect(body).not.toContain("data-stream-error");
		expect(
			activityPayloads.some((activity) => activity.id === "turn-acknowledged"),
		).toBe(false);
		expect(
			activityPayloads.some((activity) => activity.id === "context-preparing"),
		).toBe(true);
	});

	// P3b (ADR-0056) — the reasoning-phase classifier.
	it("feeds reasoning-delta text to the classifier session, emits a classified step over the existing data-response-activity part (no new stream part names), and persists the accumulated steps", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const classifiedStep = {
			id: "step-1",
			source: "classified" as const,
			activityClass: "understanding-request",
			impliesExternalAction: false,
			anchor: { start: 0, end: 10 },
			createdAt: 1000,
		};
		let capturedOnReasoningDelta: ((text: string) => void) | undefined;
		(
			createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
		).mockImplementation((params: { onStep?: (step: unknown) => void }) => {
			capturedOnReasoningDelta = () => params.onStep?.(classifiedStep);
			return {
				onReasoningDelta: (text: string) => capturedOnReasoningDelta?.(text),
				stop: vi.fn(),
				getSteps: () => [classifiedStep],
			};
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "reasoning_delta", text: "Thinking about the request. " },
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({ conversationId: "thought-step-conv" });
		const chunks = await readSseResponse(response);
		const parts = parseUiStreamParts(chunks);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parts,
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "thought-step:step-1",
					kind: "thought_step",
					status: "running",
					detail: "understanding-request",
				}),
			]),
		);

		// No new AI SDK UI stream part name: reasoning content in this turn
		// additionally exercises the pre-existing reasoning-* parts, but the
		// closed set of part types present is otherwise unchanged from the
		// acknowledgment test above.
		const partTypes = new Set(
			parts
				.filter((part): part is Record<string, unknown> => part !== "[DONE]")
				.map((part) => part.type),
		);
		expect(partTypes).toEqual(
			new Set([
				"reasoning-start",
				"reasoning-delta",
				"reasoning-end",
				"text-start",
				"text-delta",
				"text-end",
				"data-response-activity",
				"data-stream-metadata",
				"finish",
			]),
		);

		// Durable persistence: the accumulated step rail rides
		// assistantMetadata.thoughtSteps into the persisted message, exactly
		// like turnAcknowledgment's fields ride the same object.
		await vi.waitFor(() => {
			expect(createMessage).toHaveBeenCalledWith(
				"thought-step-conv",
				"assistant",
				"Hi",
				"Thinking about the request. ",
				[{ type: "text", content: "Thinking about the request. " }],
				expect.objectContaining({ thoughtSteps: [classifiedStep] }),
			);
		});
	});

	// Follow-up (2026-08-16) to ADR-0056's amendment — summary LANGUAGE. A status
	// line is written while Alfy thinks, before any reply text exists, so no
	// reply language can be known yet: the classifier session gets the account's
	// UI language (owner decision, 2026-10-13), never a language guessed from
	// the message. It is the one model call the UI language reaches.
	it("threads the account's UI language into the classifier session as targetLanguage", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		// An English message from an account shown in Hungarian: the status line
		// is Hungarian (the UI), whatever the message says.
		const response = runStream(
			{
				conversationId: "hu-ui-conv",
				normalizedMessage: "Could you help me with this question?",
			},
			{ uiLanguage: "hu" },
		);
		await readSseResponse(response);

		expect(createThoughtStepClassifierSession).toHaveBeenCalledWith(
			expect.objectContaining({ targetLanguage: "hu" }),
		);
	});

	it("threads English as the target language for an account shown in English, and for one with no UI language", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		const classifierSession = createThoughtStepClassifierSession as ReturnType<
			typeof vi.fn
		>;
		for (const [index, user] of [{ uiLanguage: "en" as const }, {}].entries()) {
			classifierSession.mockClear();
			(
				runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
			).mockResolvedValue(
				createNeutralStreamingResult([
					{ type: "text_delta", text: "Szia" },
					finishEvent,
				]),
			);

			const response = runStream(
				{
					streamId: `en-ui-stream-${index}`,
					conversationId: `en-ui-conv-${index}`,
					normalizedMessage: "Szia, tudnál segíteni ebben a kérdésben?",
				},
				user,
			);
			await readSseResponse(response);

			expect(classifierSession).toHaveBeenCalledWith(
				expect.objectContaining({ targetLanguage: "en" }),
			);
		}
	});

	it("does not hand the UI language to the model run: the chat call never sees it", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const run = runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>;
		run.mockClear();
		run.mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream(
			{
				conversationId: "no-ui-language-conv",
				normalizedMessage: "Could you help me with this question?",
			},
			{ uiLanguage: "hu" },
		);
		await readSseResponse(response);

		expect(run).toHaveBeenCalledTimes(1);
		const params = run.mock.calls[0][0];
		expect(Object.keys(params.user).sort()).toEqual([
			"displayName",
			"email",
			"id",
		]);
		expect(Object.keys(params).filter((key) => /language/i.test(key))).toEqual(
			[],
		);
	});

	it("hands the account's UI language on to completion, where it is the last fallback of what is written after the reply", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { runPostTurnTasks } = await import(
			"$lib/server/services/chat-turn/finalize-steps"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Done." },
				finishEvent,
			]),
		);

		// The call that names the language is down, a reply of one word says
		// nothing about its language, nor does the message, nor is there an
		// earlier reply: the account's language it is.
		const response = runStream(
			{ conversationId: "ui-fallback-conv", normalizedMessage: "ok" },
			{ uiLanguage: "hu" },
		);
		await readSseResponse(response);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({ responseLanguage: "hu" }),
		);
	});

	// R1 defect 4 — the live `onStep` -> `emitResponseActivity` mapping must
	// forward `step.entity` as `label`, matching the persisted step shape.
	// The client's live thought-step header (ThinkingBlock's
	// `liveThoughtStepEntity`, wired from MessageBubble reading
	// `liveThoughtStepActivity?.label`) reads the entity from `label` — with
	// it missing on the live emission, the live header could never show the
	// entity even though the completed/persisted rail does.
	it("forwards the classified step's verbatim entity as label on the live thought_step response-activity", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		const classifiedStepWithEntity = {
			id: "step-entity-1",
			source: "classified" as const,
			activityClass: "understanding-request",
			impliesExternalAction: false,
			anchor: { start: 0, end: 10 },
			entity: "the budget discussion",
			createdAt: 1000,
		};
		let capturedOnReasoningDelta: ((text: string) => void) | undefined;
		(
			createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
		).mockImplementation((params: { onStep?: (step: unknown) => void }) => {
			capturedOnReasoningDelta = () =>
				params.onStep?.(classifiedStepWithEntity);
			return {
				onReasoningDelta: (text: string) => capturedOnReasoningDelta?.(text),
				stop: vi.fn(),
				getSteps: () => [classifiedStepWithEntity],
			};
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{
					type: "reasoning_delta",
					text: "Thinking about the budget discussion. ",
				},
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({ conversationId: "thought-step-entity-conv" });
		const chunks = await readSseResponse(response);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "thought-step:step-entity-1",
					kind: "thought_step",
					detail: "understanding-request",
					label: "the budget discussion",
				}),
			]),
		);
	});

	// Amendment (2026-08-16) to ADR-0056 — the `onStep` -> `emitResponseActivity`
	// mapping must ALSO forward `step.summary`, on the SAME existing
	// "thought_step" kind (no new stream part name), and the accumulated
	// step (summary included) must still round-trip into
	// assistantMetadata.thoughtSteps for durable persistence.
	it("forwards the classified step's entity-grounded summary on the live thought_step response-activity, and persists it", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const classifiedStepWithSummary = {
			id: "step-summary-1",
			source: "classified" as const,
			activityClass: "weighing-options",
			impliesExternalAction: false,
			anchor: { start: 0, end: 10 },
			entity: "option A",
			summary: "Comparing option A against option B",
			createdAt: 1000,
		};
		let capturedOnReasoningDelta: ((text: string) => void) | undefined;
		(
			createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
		).mockImplementation((params: { onStep?: (step: unknown) => void }) => {
			capturedOnReasoningDelta = () =>
				params.onStep?.(classifiedStepWithSummary);
			return {
				onReasoningDelta: (text: string) => capturedOnReasoningDelta?.(text),
				stop: vi.fn(),
				getSteps: () => [classifiedStepWithSummary],
			};
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{
					type: "reasoning_delta",
					text: "Comparing option A against option B. ",
				},
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({ conversationId: "thought-step-summary-conv" });
		const chunks = await readSseResponse(response);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "thought-step:step-summary-1",
					kind: "thought_step",
					detail: "weighing-options",
					label: "option A",
					summary: "Comparing option A against option B",
				}),
			]),
		);

		await vi.waitFor(() => {
			expect(createMessage).toHaveBeenCalledWith(
				"thought-step-summary-conv",
				"assistant",
				"Hi",
				"Comparing option A against option B. ",
				[{ type: "text", content: "Comparing option A against option B. " }],
				expect.objectContaining({
					thoughtSteps: [classifiedStepWithSummary],
				}),
			);
		});
	});

	it("stops the classifier session on the first answer text-delta", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		const stop = vi.fn();
		(
			createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
		).mockReturnValue({
			onReasoningDelta: vi.fn(),
			stop,
			getSteps: () => [],
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "reasoning_delta", text: "Reasoning first. " },
				{ type: "text_delta", text: "Then the answer." },
				finishEvent,
			]),
		);

		const response = runStream({ conversationId: "thought-step-stop-conv" });
		await readSseResponse(response);

		expect(stop).toHaveBeenCalled();
	});

	it("keeps the deterministic spine coherent when the classifier session produces no steps at all (disabled/unavailable) — enrichment only, never a separate mode", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createThoughtStepClassifierSession } = await import(
			"$lib/server/services/chat-turn/thought-step-classifier"
		);
		(
			createThoughtStepClassifierSession as ReturnType<typeof vi.fn>
		).mockReturnValue({
			onReasoningDelta: vi.fn(),
			stop: vi.fn(),
			getSteps: () => [],
		});
		// standard depth, no tools, no deliberation passes — the common turn
		// P1's spine exists to describe with no model call at all.
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult([
				{ type: "text_delta", text: "Hi" },
				finishEvent,
			]),
		);

		const response = runStream({ conversationId: "no-classifier-conv" });
		const chunks = await readSseResponse(response);
		const activityPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-response-activity",
		);

		expect(activityPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "depth-selected", kind: "depth" }),
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
		expect(
			activityPayloads.some((activity) => activity.kind === "thought_step"),
		).toBe(false);
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
			reasoningDepth: "thorough",
			depthMetadata: {
				requested: "thorough",
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
			reasoningDepth: "thorough",
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
			reasoningDepth: "thorough",
		});
		broadcastStreamChunk(
			"active-reconnect-stream",
			journalTextFrame("Already streaming"),
		);
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
			"$lib/server/services/chat-turn/finalize-steps"
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
		// The (post-turn) context status rides the terminal payload so the
		// header ring updates in the same session.
		expect(endPayload).toEqual(
			expect.objectContaining({ contextStatus: prepared.contextStatus }),
		);
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

	// E1 — a failed tool call now carries a genuine "failed" status (not a
	// fake "done"), with a stable `errorCode` riding the same StreamErrorCode
	// vocabulary `data-stream-error` uses, via classifyStreamErrorCause.
	it("emits failed tool events with a failed status (not a fake done), as not evidence-ready", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { persistAssistantEvidence } = await import(
			"$lib/server/services/chat-turn/finalize-steps"
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
		const toolPayloads = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-tool-call",
		);
		// No fake "done" payload for the failed call.
		expect(toolPayloads.some((payload) => payload.status === "done")).toBe(
			false,
		);
		const failedToolPayload = toolPayloads.find(
			(payload) => payload.status === "failed",
		);

		expect(failedToolPayload).toEqual(
			expect.objectContaining({
				status: "failed",
				metadata: {
					ok: false,
					evidenceReady: false,
					error: "Tool failed",
					errorCode: "backend_failure",
				},
			}),
		);
		expect(persistAssistantEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCalls: expect.arrayContaining([
					expect.objectContaining({
						status: "failed",
						metadata: expect.objectContaining({
							ok: false,
							evidenceReady: false,
							errorCode: "backend_failure",
						}),
					}),
				]),
			}),
		);
	});

	// produce_file RETURNS its failure instead of throwing it: the file
	// production ledger said the job failed, which is a normal tool_result as
	// far as the AI SDK is concerned. The activity row must still read as
	// failed, otherwise the user sees a "done" tool row above an assistant
	// message that cannot honestly claim the file exists.
	it("emits a failed status for a tool_result whose recorded entry failed", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const recorderEntry = {
			callId: "call-produce",
			name: "produce_file",
			input: { requestTitle: "Quarterly workbook" },
			status: "failed" as const,
			outputSummary:
				"File production failed for job job-1 (program_execution_failed): SyntaxError: invalid syntax",
			sourceType: "tool" as const,
			metadata: {
				ok: false,
				evidenceReady: false,
				jobId: "job-1",
				jobStatus: "failed",
				code: "program_execution_failed",
				retryable: true,
			},
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[
					{
						type: "tool_call",
						callId: "call-produce",
						toolName: "produce_file",
						input: { requestTitle: "Quarterly workbook" },
					},
					{
						type: "tool_result",
						callId: "call-produce",
						toolName: "produce_file",
						output: { ok: false, status: "failed" },
					},
					{ type: "text_delta", text: "I could not build that file." },
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

		expect(toolPayloads.map((payload) => payload.status)).toEqual([
			"running",
			"failed",
		]);
		expect(toolPayloads[1]).toEqual(
			expect.objectContaining({
				callId: "call-produce",
				name: "produce_file",
				status: "failed",
				outputSummary: recorderEntry.outputSummary,
				metadata: recorderEntry.metadata,
			}),
		);
	});

	// Slice F — an instruction offer is CREATED by the tool but PERSISTED by
	// finalize, and the only thing that carries it between the two is the
	// tool-call record this runtime builds from the recorded entry. This is
	// the join the seeded-metadata specs never touched: it failed on the real
	// `/stream` path by dropping the field, so the model was told the user
	// could see an offer that was never persisted and never rendered.
	it("carries a recorded instruction suggestion onto the persisted assistant message", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const suggestion = {
			id: "suggestion-1",
			status: "pending" as const,
			text: "Whenever you write a summary, start it with Next Steps.",
			scope: { kind: "personal" as const },
			createdAt: 1_770_000_000_000,
		};
		// Exactly what the tool's own recorder writes on the offered path,
		// including the absence of `ok`/`evidenceReady` (this entry is not
		// evidence) and the turn-local `instructionSuggestion` payload.
		const recorderEntry = {
			callId: "call-instruction",
			name: "suggest_instruction",
			input: { text: suggestion.text, scope: "personal" },
			status: "done" as const,
			outputSummary: "Instruction suggestion offered for personal instructions",
			sourceType: "tool" as const,
			metadata: { offered: true, scope: "personal" },
			instructionSuggestion: suggestion,
		};
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(
			createNeutralStreamingResult(
				[
					{
						type: "tool_call",
						callId: "call-instruction",
						toolName: "suggest_instruction",
						input: recorderEntry.input,
					},
					{
						type: "tool_result",
						callId: "call-instruction",
						toolName: "suggest_instruction",
						output: {
							ok: true,
							offered: true,
							scope: "personal",
							note: "The user now sees this offer with a Review and a Dismiss button.",
						},
					},
					{ type: "text_delta", text: "Understood." },
					finishEvent,
				],
				{ normalChatToolCalls: [recorderEntry] },
			),
		);

		const response = runStream();
		await readSseResponse(response);

		await vi.waitFor(() => {
			const assistantCall = (
				createMessage as ReturnType<typeof vi.fn>
			).mock.calls.find((call) => call[1] === "assistant");
			expect(assistantCall?.[5]).toMatchObject({
				instructionSuggestions: [suggestion],
			});
		});
	});

	it("maps provider usage events into persisted analytics", async () => {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		const { persistAssistantTurnState } = await import(
			"$lib/server/services/chat-turn/finalize-steps"
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

	// Deleting a chat stops the reply streaming into it and does not wait for
	// the turn to end (cleanup/conversation-cleanup.ts). The turn then ends
	// against a chat that is gone, and the browser, still attached because an
	// open chat stays mounted until the whole delete is answered, must be told
	// the turn was stopped, not that the backend failed.
	it("ends a turn that a delete stopped as a stop, not as a failure, when its conversation is gone", async () => {
		const { createMessage } = await import("$lib/server/services/messages");
		const { getConversation } = await import(
			"$lib/server/services/conversations"
		);
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		let markStreamListening!: () => void;
		const streamListening = new Promise<void>((resolve) => {
			markStreamListening = resolve;
		});
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockImplementation(async (params: { signal?: AbortSignal }) =>
			createNeutralStreamingResult([], {
				stream: (async function* () {
					yield { type: "text_delta", text: "Partial answer" };
					await new Promise<void>((resolve) => {
						markStreamListening();
						params.signal?.addEventListener("abort", () => resolve(), {
							once: true,
						});
					});
				})(),
			}),
		);
		// The delete got there first: the chat is gone, and a save would fail the
		// way it does against a deleted row.
		(getConversation as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		(createMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("FOREIGN KEY constraint failed"),
		);
		const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		try {
			const response = runStream({
				conversationId: "deleted-conv",
				streamId: "deleted-stream",
			});
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing response body");

			await expect(reader.read()).resolves.toMatchObject({ done: false });
			await streamListening;
			// What deleteConversationWithCleanup does to a streaming reply.
			expect(
				requestActiveChatStreamStop({
					streamId: "deleted-stream",
					userId: "u1",
				}),
			).toBe(true);
			const chunks: string[] = [];
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(new TextDecoder().decode(value));
			}
			const parts = parseUiStreamParts([chunks.join("")]);

			expect(
				parts.filter(
					(part) =>
						part !== "[DONE]" &&
						(part.type === "data-stream-error" || part.type === "error"),
				),
			).toEqual([]);
			expect(
				uiDataParts<Record<string, unknown>>(parts, "data-stream-metadata"),
			).toEqual([{ wasStopped: true }]);
			expect(parts.slice(-2)).toEqual([
				{ type: "finish", finishReason: "stop" },
				"[DONE]",
			]);
			expect(createMessage).not.toHaveBeenCalled();
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			consoleInfo.mockRestore();
			consoleError.mockRestore();
		}
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
					requested: "thorough",
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
						requested: "thorough",
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

// The first token: the `first_visible_token` mark (saved as
// `message_analytics.first_token_ms`, which the admin latency figures read) is the
// moment the first text a person can read in the answer area was written to the
// stream, counted from the request's start. With the completion engine that text
// travels as structural output events while the engine works; the accepted answer
// comes through the model run's stream once, when the engine has finished, so a
// mark taken there lands on the end of the turn. The first byte is the same
// story: the `first_upstream_event` mark (`first_byte_ms`) is the first sign that
// the provider produced output, and for a turn that answers without reasoning the
// model run's stream shows none until the end. These tests play the engine by
// hand under fake timers, so every number is exact.
describe("stream-orchestrator: when a completion-engine turn takes its first token", () => {
	const scope = (stepId: string) => ({
		version: 1 as const,
		turnId: "first-token-turn",
		segmentId: "first-token-segment",
		attemptId: "first-token-attempt",
		stepId,
		phase: "working" as const,
	});

	beforeEach(async () => {
		vi.resetAllMocks();
		await resetCompletionMocks();
	});

	afterEach(() => {
		clearStreamBuffer("test-stream");
		unregisterActiveChatStream("test-stream");
		vi.useRealTimers();
	});

	// A model run whose engine the test plays: it writes output events through the
	// callback the orchestrator handed the run whenever the test says so. Its
	// stream carries what the test hands it, as the engine's does: reasoning and
	// tool calls as they happen, the accepted answer once, when the engine ends.
	async function playEngine() {
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		let emit: ((event: NormalChatOutputEvent) => void) | undefined;
		const handed: NeutralStreamEvent[] = [];
		let closed = false;
		let wake: (() => void) | undefined;
		vi.mocked(runStreamingNormalChatSendModel).mockImplementation(
			async (params) => {
				emit = (event) => params.onOutputEvent?.(event);
				return createNeutralStreamingResult([], {
					stream: (async function* () {
						for (;;) {
							const next = handed.shift();
							if (next) yield next;
							else if (closed) return;
							else
								await new Promise<void>((resolve) => {
									wake = resolve;
								});
						}
					})(),
				}) as never;
			},
		);
		let sequence = 0;
		return {
			// Lets the turn run, without moving the clock, until it has asked the
			// model run for the engine.
			async running() {
				for (let turn = 0; turn < 20 && !emit; turn++)
					await vi.advanceTimersByTimeAsync(0);
				if (!emit) throw new Error("The turn never reached the model run");
			},
			// The engine opens a step. It carries no output.
			stepStart(stepId = "step-1") {
				emit?.({ ...scope(stepId), sequence: ++sequence, type: "step_start" });
			},
			startBlock(
				blockId: string,
				kind: "text" | "reasoning",
				role: NormalChatOutputRole,
				stepId = "step-1",
			) {
				emit?.({
					...scope(stepId),
					sequence: ++sequence,
					type: "block_start",
					blockId,
					nativeId: blockId,
					kind,
					role,
				});
			},
			writeText(blockId: string, text: string, stepId = "step-1") {
				emit?.({
					...scope(stepId),
					sequence: ++sequence,
					type: "block_delta",
					blockId,
					text,
				});
			},
			settleStep(role: "activity" | "answer", stepId = "step-1") {
				emit?.({
					...scope(stepId),
					sequence: ++sequence,
					type: "step_settled",
					role,
					finishReason: null,
				});
			},
			// An event for the model run's stream, as it happens. The turn reads it
			// at the current time once it has run (`advanceTimersByTimeAsync(0)`).
			yieldEvent(event: NeutralStreamEvent) {
				handed.push(event);
				wake?.();
			},
			acceptAnswer(answer: string) {
				handed.push({ type: "text_delta", text: answer }, finishEvent);
				closed = true;
				wake?.();
			},
		};
	}

	function terminalTimeline(chunks: string[]) {
		const metadata = uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-stream-metadata",
		)[0];
		return (metadata.serverTimeline as StreamTimelineTerminalPayload).server;
	}

	// What the turn hands to be saved with its reply: `analytics.firstTokenMs` is
	// the number that ends up in `message_analytics.first_token_ms`.
	async function savedAnalytics() {
		const { persistAssistantTurnState } = await import(
			"$lib/server/services/chat-turn/finalize-steps"
		);
		await vi.waitFor(() =>
			expect(persistAssistantTurnState).toHaveBeenCalled(),
		);
		return vi.mocked(persistAssistantTurnState).mock.calls[0][0].analytics;
	}

	it.each([
		"provisional",
		"answer",
	] as const)("takes the first token when the first %s text is written, not when the engine ends", async (role) => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		// The model thinks first. Reasoning is activity, never the first token.
		engine.startBlock("thinking", "reasoning", "activity");
		engine.writeText("thinking", "Weighing how to answer.");
		await vi.advanceTimersByTimeAsync(3_000);
		// Then the first words of the answer reach the person.
		engine.startBlock("answer", "text", role);
		engine.writeText("answer", "The first words of the answer.");
		const firstWordsAt = Date.now() - requestStartedAt;
		// The engine keeps writing for a long while before it can accept the answer.
		await vi.advanceTimersByTimeAsync(17_000);
		engine.writeText("answer", " And the rest of it.");
		await vi.advanceTimersByTimeAsync(2_000);
		engine.acceptAnswer("The first words of the answer. And the rest of it.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(firstWordsAt).toBe(3_000);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: firstWordsAt,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstTokenMs: firstWordsAt,
			generationTimeMs: 22_000,
		});
	});

	it("does not take reasoning, activity text or blank text as the first token", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		engine.startBlock("thinking", "reasoning", "activity");
		engine.writeText("thinking", "Working out what to look up.");
		await vi.advanceTimersByTimeAsync(1_000);
		// Text a step writes after its tool call is activity, not the answer.
		engine.startBlock("remark", "text", "activity");
		engine.writeText("remark", "Searching the library now.");
		await vi.advanceTimersByTimeAsync(1_000);
		// A draft that so far holds only blank text: line breaks, spaces and a
		// zero-width space, which nobody can see.
		engine.startBlock("draft", "text", "provisional", "step-2");
		engine.writeText("draft", "\n\n", "step-2");
		engine.writeText("draft", "   ", "step-2");
		engine.writeText("draft", "\u200b", "step-2");
		await vi.advanceTimersByTimeAsync(2_000);
		engine.writeText("draft", "Here is what I found.", "step-2");
		const firstWordsAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(5_000);
		engine.acceptAnswer("\n\n   \u200bHere is what I found.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(firstWordsAt).toBe(4_000);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: firstWordsAt,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstTokenMs: firstWordsAt,
			generationTimeMs: 9_000,
		});
	});

	it("counts a remark that a tool call withdraws afterwards", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		await vi.advanceTimersByTimeAsync(2_000);
		// The person reads this while the step is being written ...
		engine.startBlock("remark", "text", "provisional");
		engine.writeText("remark", "Let me check the library first.");
		const remarkAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(500);
		// ... and the step's tool call withdraws it.
		engine.settleStep("activity");
		await vi.advanceTimersByTimeAsync(9_500);
		engine.startBlock("answer", "text", "provisional", "step-2");
		engine.writeText("answer", "The library says 42.", "step-2");
		await vi.advanceTimersByTimeAsync(1_000);
		engine.acceptAnswer("The library says 42.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(remarkAt).toBe(2_000);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: remarkAt,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstTokenMs: remarkAt,
			generationTimeMs: 13_000,
		});
	});

	it("takes the first byte when a direct answer's first text is written, not when the engine ends", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		// No reasoning: the model starts straight on its answer.
		await vi.advanceTimersByTimeAsync(1_500);
		engine.startBlock("answer", "text", "provisional");
		engine.writeText("answer", "The first words of the answer.");
		const firstBytesAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(10_500);
		engine.acceptAnswer("The first words of the answer.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(firstBytesAt).toBe(1_500);
		const timeline = terminalTimeline(chunks);
		expect(timeline).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: firstBytesAt,
		});
		expect(timeline).not.toHaveProperty(
			SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING,
		);
		const analytics = await savedAnalytics();
		expect(analytics).toMatchObject({
			firstByteMs: firstBytesAt,
			generationTimeMs: 12_000,
		});
		expect(analytics?.firstThinkingMs).toBeUndefined();
	});

	it("keeps the first byte at the first reasoning event of a turn that thinks first", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		await vi.advanceTimersByTimeAsync(2_000);
		// The engine writes the reasoning block and hands the reasoning to the model
		// run's stream at the same moment.
		engine.startBlock("thinking", "reasoning", "activity");
		engine.writeText("thinking", "Weighing how to answer.");
		engine.yieldEvent({
			type: "reasoning_delta",
			text: "Weighing how to answer.",
		});
		await vi.advanceTimersByTimeAsync(0);
		const firstReasoningAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(4_000);
		engine.startBlock("answer", "text", "provisional");
		engine.writeText("answer", "The first words of the answer.");
		await vi.advanceTimersByTimeAsync(3_000);
		engine.acceptAnswer("The first words of the answer.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(firstReasoningAt).toBe(2_000);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: firstReasoningAt,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING]: firstReasoningAt,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: 6_000,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstByteMs: firstReasoningAt,
			firstThinkingMs: firstReasoningAt,
			firstTokenMs: 6_000,
			generationTimeMs: 9_000,
		});
	});

	it("does not take a step_start, which carries no output, as the first byte", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		// The engine opens a step. The event carries no output, so it is no first byte.
		engine.stepStart();
		await vi.advanceTimersByTimeAsync(2_500);
		engine.startBlock("answer", "text", "provisional");
		engine.writeText("answer", "The first words of the answer.");
		const firstBytesAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(6_500);
		engine.acceptAnswer("The first words of the answer.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(firstBytesAt).toBe(2_500);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: firstBytesAt,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstByteMs: firstBytesAt,
			generationTimeMs: 9_000,
		});
	});

	it("takes a block of any kind as the first byte, at the moment it starts", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		await vi.advanceTimersByTimeAsync(1_000);
		// A reasoning block opens and its first words follow a while later. Only
		// these output events reach the orchestrator (the model run's stream has
		// nothing to say until the end), so the mark can only come from the block.
		engine.startBlock("thinking", "reasoning", "activity");
		const blockStartedAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(400);
		engine.writeText("thinking", "Weighing how to answer.");
		await vi.advanceTimersByTimeAsync(5_600);
		engine.acceptAnswer("Done.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(blockStartedAt).toBe(1_000);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: blockStartedAt,
		});
	});

	it("keeps the first byte at a tool call that the model run's stream showed before any block", async () => {
		vi.useFakeTimers();
		const engine = await playEngine();
		const requestStartedAt = Date.now();
		const reading = readSseResponse(runStream());
		await engine.running();

		await vi.advanceTimersByTimeAsync(1_200);
		// The model calls a tool before it writes a word: the stream shows the call.
		engine.yieldEvent({
			type: "tool_call",
			callId: "call-1",
			toolName: "research_web",
			input: { query: "wall colours" },
		});
		engine.yieldEvent({
			type: "tool_result",
			callId: "call-1",
			toolName: "research_web",
			output: { success: true },
		});
		await vi.advanceTimersByTimeAsync(0);
		const toolCallAt = Date.now() - requestStartedAt;
		await vi.advanceTimersByTimeAsync(3_800);
		// The answer's first words come later and cannot move the mark.
		engine.startBlock("answer", "text", "provisional", "step-2");
		engine.writeText("answer", "The first words of the answer.", "step-2");
		await vi.advanceTimersByTimeAsync(2_000);
		engine.acceptAnswer("The first words of the answer.");
		await vi.advanceTimersByTimeAsync(0);
		const chunks = await reading;

		expect(toolCallAt).toBe(1_200);
		expect(terminalTimeline(chunks)).toMatchObject({
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT]: toolCallAt,
			[SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN]: 5_000,
		});
		expect(await savedAnalytics()).toMatchObject({
			firstByteMs: toolCallAt,
			firstTokenMs: 5_000,
			generationTimeMs: 7_000,
		});
	});

	it("still takes the first byte and the first token of a run with no completion turn from its own events", async () => {
		vi.useFakeTimers();
		const infoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const { getConfig } = await import("$lib/server/config-store");
		(getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			requestTimeoutMs: 30000,
			composerCommandRegistryEnabled: true,
			contextDiagnosticsDebug: true,
		});
		const { runStreamingNormalChatSendModel } = await import(
			"./streaming-normal-chat-model-run"
		);
		const pause = (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms));
		// The text of this run arrives as the run's own text_delta events, as it did
		// before the completion engine: there are no output events at all.
		vi.mocked(runStreamingNormalChatSendModel).mockResolvedValue(
			createNeutralStreamingResult([], {
				completionTurn: undefined,
				stream: (async function* () {
					await pause(1_000);
					yield { type: "text_delta", text: "  " };
					await pause(1_000);
					yield { type: "text_delta", text: "Hello" };
					await pause(5_000);
					yield { type: "text_delta", text: " again." };
					yield finishEvent;
				})(),
			}) as never,
		);
		try {
			const reading = readSseResponse(runStream());
			await vi.advanceTimersByTimeAsync(7_000);
			await reading;

			const phaseTimingLog = infoSpy.mock.calls.find(
				([message]) => message === "[CHAT_STREAM] phase_timing",
			);
			expect(phaseTimingLog?.[1]).toMatchObject({
				first_upstream_event_ms: 1_000,
				first_visible_token_ms: 2_000,
			});
		} finally {
			infoSpy.mockRestore();
		}
	});
});

// "Ask me first": a reply that asks the person stops where it asks, is saved as
// a segment with what its resume needs, and is never regenerated from scratch.
describe("stream-orchestrator: a reply that asks the person", () => {
	const STOPPED_BEFORE_ANSWER = "The user stopped the reply before answering.";
	const ENDED_BEFORE_ANSWER = "The reply ended before the user answered.";
	const questions = [
		{
			question: "Which one?",
			options: [{ label: "A", recommended: true }, { label: "B" }],
		},
	];
	const ask = { questionId: "q-1", toolCallId: "call-ask", questions };
	const askEntry = {
		callId: "call-ask",
		name: "ask_user",
		input: { questions },
		status: "done",
		outputSummary: "Asked the user; the reply paused for the answer.",
		sourceType: "tool",
		metadata: { paused: true, questionId: "q-1" },
	};
	const fetchEntry = {
		callId: "pre-1",
		name: "fetch_url",
		input: { urls: ["https://example.com/a"] },
		status: "done" as const,
		outputSummary: "Fetched 1 page.",
		sourceType: "web" as const,
	};
	const searchEntry = {
		callId: "call-search",
		name: "research_web",
		input: { query: "wall colours" },
		status: "done",
		outputSummary: "Found 2 sources.",
		resultDigest: "Source B prefers grey.",
		sourceType: "web",
		candidates: [],
		metadata: { ok: true, evidenceReady: true },
	};
	// what the model was given before it ran: the page the server fetched
	const continuationGiven: ModelMessage[] = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "pre-1",
					toolName: "fetch_url",
					input: { urls: ["https://example.com/a"] },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "pre-1",
					toolName: "fetch_url",
					output: { type: "json", value: { page: "the whole page" } },
				},
			],
		},
	];
	// what the run said and read until it stopped
	const responseMessages: ModelMessage[] = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-search",
					toolName: "research_web",
					input: { query: "wall colours" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-search",
					toolName: "research_web",
					output: { type: "json", value: { sources: ["the whole result"] } },
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
					input: { questions },
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
					output: { type: "json", value: { status: "waiting_for_user" } },
				},
			],
		},
	];
	const searchEvents: NeutralStreamEvent[] = [
		{
			type: "tool_call",
			callId: "call-search",
			toolName: "research_web",
			input: { query: "wall colours" },
		},
		{
			type: "tool_result",
			callId: "call-search",
			toolName: "research_web",
			output: { success: true },
		},
	];
	const askEvents: NeutralStreamEvent[] = [
		{
			type: "tool_call",
			callId: "call-ask",
			toolName: "ask_user",
			input: { questions },
		},
		{
			type: "tool_result",
			callId: "call-ask",
			toolName: "ask_user",
			output: { status: "waiting_for_user" },
		},
	];
	const askingRun = {
		fixtureOutcome: "paused",
		normalChatToolCalls: [searchEntry, askEntry],
		prefetchedToolCalls: [fetchEntry],
		continuationGiven,
		getResponseMessages: () => responseMessages,
		getTurnAsk: () => ask,
	};

	beforeEach(async () => {
		vi.resetAllMocks();
		await resetCompletionMocks();
	});

	async function mockRun(
		events: NeutralStreamEvent[],
		overrides: Record<string, unknown> = askingRun,
	) {
		const { runStreamingNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/streaming-normal-chat-model-run"
		);
		(
			runStreamingNormalChatSendModel as ReturnType<typeof vi.fn>
		).mockResolvedValue(createNeutralStreamingResult(events, overrides));
		return runStreamingNormalChatSendModel;
	}

	function terminalMetadata(chunks: string[]) {
		return uiDataParts<Record<string, unknown>>(
			parseUiStreamParts(chunks),
			"data-stream-metadata",
		)[0];
	}

	// The turn's own ending asks the store to discard the question the run asked,
	// and the store ignores one that is stamped. So the stamp has to come first, and
	// the ending has to wait for the completion. Were it not awaited, every pause
	// would be discarded while every test here, with the store mocked, still passed.
	async function expectStampedBeforeDiscarded() {
		const { stampAskQuestion, discardAskQuestion } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);
		await vi.waitFor(() =>
			expect(discardAskQuestion).toHaveBeenCalledWith({
				userId: "u1",
				questionId: "q-1",
			}),
		);
		expect(
			vi.mocked(stampAskQuestion).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(discardAskQuestion).mock.invocationCallOrder[0]);
	}

	// What a failing run writes to the log by itself: the upstream error and the
	// fallback that follows it. Caught here, so a test names the lines it causes
	// and the rest of the output stays quiet.
	function captureStreamLogs() {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		return {
			error,
			warn,
			restore() {
				error.mockRestore();
				warn.mockRestore();
			},
		};
	}

	it("ends a run that asked as a paused segment: no fallback, and the question named at the end", async () => {
		await mockRun([
			{ type: "text_delta", text: "Let me look first." },
			...searchEvents,
			{ type: "text_delta", text: "Which one?" },
			...askEvents,
			{
				type: "usage",
				usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
			},
			finishEvent,
		]);
		const { runPlainNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/plain-normal-chat-model-run"
		);
		const { stampAskQuestion } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);

		const chunks = await readSseResponse(runStream());
		const parts = parseUiStreamParts(chunks);

		expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
		expect(
			parts.some(
				(part) => part !== "[DONE]" && part.type === "data-stream-error",
			),
		).toBe(false);
		// the question is tied to the row that asked it, with what the resume
		// needs: the page it was given and what it said and read since
		expect(stampAskQuestion).toHaveBeenCalledTimes(1);
		expect(stampAskQuestion).toHaveBeenCalledWith({
			userId: "u1",
			questionId: "q-1",
			assistantMessageId: "msg-1",
			capture: {
				v: 1,
				messages: [...continuationGiven, ...responseMessages],
				results: [
					expect.objectContaining({
						toolCallId: "pre-1",
						toolName: "fetch_url",
						localDistilled: false,
					}),
					expect.objectContaining({
						toolCallId: "call-search",
						toolName: "research_web",
						localDistilled: false,
						digest: expect.objectContaining({ summary: "Found 2 sources." }),
					}),
				],
			},
		});
		const metadata = terminalMetadata(chunks);
		expect(metadata).toMatchObject({
			waitingQuestionId: "q-1",
			assistantMessageId: "msg-1",
			wasStopped: false,
		});
		expect(metadata).not.toHaveProperty("followUps");
		expect(parts).toContainEqual({ type: "finish", finishReason: "stop" });
		await expectStampedBeforeDiscarded();
	});

	it("ends a run that asked before saying a word as a paused segment, and never regenerates it from scratch", async () => {
		// only the ask call: no visible answer, but a completed tool call, which
		// is exactly what the whole-generation fallback is for when a run dies
		await mockRun([...askEvents, finishEvent]);
		const { runPlainNormalChatSendModel } = await import(
			"$lib/server/services/chat-turn/plain-normal-chat-model-run"
		);
		const { stampAskQuestion } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);
		const { createMessage } = await import("$lib/server/services/messages");

		const chunks = await readSseResponse(runStream());
		const parts = parseUiStreamParts(chunks);

		expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
		expect(
			parts.some(
				(part) => part !== "[DONE]" && part.type === "data-stream-error",
			),
		).toBe(false);
		expect(stampAskQuestion).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "q-1" }),
		);
		expect(terminalMetadata(chunks)).toMatchObject({
			waitingQuestionId: "q-1",
		});
		expect(createMessage).toHaveBeenCalledWith(
			"test-conv",
			"assistant",
			"",
			undefined,
			expect.arrayContaining([
				expect.objectContaining({ type: "tool_call", name: "ask_user" }),
			]),
			expect.anything(),
		);
		await expectStampedBeforeDiscarded();
	});

	it("discards the question of a run that failed after asking", async () => {
		const logs = captureStreamLogs();
		try {
			await mockRun(
				[
					...askEvents,
					{
						type: "error",
						error: "Provider rejected the model response after tool use.",
					},
				],
				{ ...askingRun, fixtureOutcome: "failed" },
			);
			const { stampAskQuestion, discardAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);

			const parts = parseUiStreamParts(await readSseResponse(runStream()));

			expect(parts).toContainEqual({ type: "finish", finishReason: "error" });
			expect(stampAskQuestion).not.toHaveBeenCalled();
			// the discard runs when the turn ends, a moment after the stream closes
			await vi.waitFor(() =>
				expect(discardAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
				}),
			);
		} finally {
			logs.restore();
		}
	});

	it("saves a run that asked and then failed with its words, its ask call reading that the reply ended, and its question discarded", async () => {
		const logs = captureStreamLogs();
		try {
			await mockRun(
				[
					{ type: "text_delta", text: "Which one?" },
					...askEvents,
					{
						type: "error",
						error: "Provider rejected the model response after tool use.",
					},
				],
				{ ...askingRun, fixtureOutcome: "failed" },
			);
			const { stampAskQuestion, discardAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const { createMessage } = await import("$lib/server/services/messages");

			const chunks = await readSseResponse(
				runStream({
					conversationId: "failed-ask-conv",
					streamId: "failed-ask-stream",
				}),
			);

			// saved as an ordinary turn: its words are kept, nothing is paused
			expect(terminalMetadata(chunks)).not.toHaveProperty("waitingQuestionId");
			expect(stampAskQuestion).not.toHaveBeenCalled();
			// the question goes, so the call that asked it must not read as open
			expect(createMessage).toHaveBeenCalledWith(
				"failed-ask-conv",
				"assistant",
				"Which one?",
				undefined,
				expect.arrayContaining([
					expect.objectContaining({
						type: "tool_call",
						name: "ask_user",
						outputSummary: ENDED_BEFORE_ANSWER,
						resultDigest: null,
					}),
				]),
				expect.anything(),
			);
			await vi.waitFor(() =>
				expect(discardAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
				}),
			);
		} finally {
			logs.restore();
		}
	});

	describe("a stream that closed without a finish", () => {
		// A resume answers the ask's result, so a pause is saved only when what the
		// run said and read holds it. A stream that closed can end before the last
		// step was captured.
		it("pauses a run whose captured messages hold the ask's result, naming the closure", async () => {
			await mockRun([{ type: "text_delta", text: "Which one?" }, ...askEvents]);
			const { runPlainNormalChatSendModel } = await import(
				"$lib/server/services/chat-turn/plain-normal-chat-model-run"
			);
			const { stampAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);

			const chunks = await readSseResponse(runStream());

			expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
			expect(stampAskQuestion).toHaveBeenCalledWith(
				expect.objectContaining({
					questionId: "q-1",
					capture: expect.objectContaining({
						messages: [...continuationGiven, ...responseMessages],
					}),
				}),
			);
			expect(terminalMetadata(chunks)).toMatchObject({
				waitingQuestionId: "q-1",
				streamClosedWithoutFinish: true,
				completionWarningCodes: ["stream_closed_without_finish"],
			});
			await expectStampedBeforeDiscarded();
		});

		it.each([
			["the stream closed without a finish", []],
			["a finish came before the step was captured", [finishEvent]],
		])("does not pause a run whose captured messages lack the ask's result when %s: it ends as a turn that never paused", async (_label, ending) => {
			// only the search step was captured; the step that asked was not
			await mockRun(
				[{ type: "text_delta", text: "Which one?" }, ...askEvents, ...ending],
				{
					...askingRun,
					fixtureOutcome: "incomplete",
					getResponseMessages: () => responseMessages.slice(0, 2),
				},
			);
			const { runPlainNormalChatSendModel } = await import(
				"$lib/server/services/chat-turn/plain-normal-chat-model-run"
			);
			const { stampAskQuestion, discardAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const { createMessage } = await import("$lib/server/services/messages");

			const chunks = await readSseResponse(
				runStream({
					conversationId: "uncaptured-ask-conv",
					streamId: "uncaptured-ask-stream",
				}),
			);

			// its words stand, so nothing is regenerated, and nothing is paused
			expect(runPlainNormalChatSendModel).not.toHaveBeenCalled();
			expect(terminalMetadata(chunks)).not.toHaveProperty("waitingQuestionId");
			expect(stampAskQuestion).not.toHaveBeenCalled();
			expect(createMessage).toHaveBeenCalledWith(
				"uncaptured-ask-conv",
				"assistant",
				"Which one?",
				undefined,
				expect.arrayContaining([
					expect.objectContaining({
						type: "tool_call",
						name: "ask_user",
						outputSummary: ENDED_BEFORE_ANSWER,
						resultDigest: null,
					}),
				]),
				expect.anything(),
			);
			await vi.waitFor(() =>
				expect(discardAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
				}),
			);
		});
	});

	it("saves a reply stopped after it asked as stopped, discards its question and pauses nothing", async () => {
		let atGate!: () => void;
		const reachedGate = new Promise<void>((resolve) => {
			atGate = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await mockRun([], {
			...askingRun,
			stream: (async function* () {
				yield { type: "text_delta", text: "Which one?" };
				for (const event of askEvents) yield event;
				atGate();
				await gate;
				yield finishEvent;
			})(),
		});
		const { stampAskQuestion, discardAskQuestion } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);
		const { createMessage } = await import("$lib/server/services/messages");

		const reading = readSseResponse(
			runStream({
				conversationId: "stopped-ask-conv",
				streamId: "stopped-ask-stream",
			}),
		);
		await reachedGate;
		// the person stops the reply after the question was asked, before the run
		// ends and the pause is decided
		expect(
			requestActiveChatStreamStop({
				streamId: "stopped-ask-stream",
				userId: "u1",
			}),
		).toBe(true);
		release();
		const chunks = await reading;

		const metadata = terminalMetadata(chunks);
		expect(metadata).toMatchObject({ wasStopped: true });
		expect(metadata).not.toHaveProperty("waitingQuestionId");
		expect(stampAskQuestion).not.toHaveBeenCalled();
		// a later turn's history must not read a question still open
		expect(createMessage).toHaveBeenCalledWith(
			"stopped-ask-conv",
			"assistant",
			"Which one?",
			undefined,
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool_call",
					name: "ask_user",
					outputSummary: STOPPED_BEFORE_ANSWER,
					resultDigest: null,
				}),
			]),
			expect.anything(),
		);
		await vi.waitFor(() =>
			expect(discardAskQuestion).toHaveBeenCalledWith({
				userId: "u1",
				questionId: "q-1",
			}),
		);
	});

	it("does not discard anything for a run that never asked", async () => {
		await mockRun([{ type: "text_delta", text: "Done." }, finishEvent], {});
		const { stampAskQuestion, discardAskQuestion } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);

		const chunks = await readSseResponse(
			runStream({
				conversationId: "never-asked-conv",
				streamId: "never-asked-stream",
			}),
		);
		// the turn's own ending (its `finally`) has run once the stream is gone
		await vi.waitFor(() =>
			expect(
				isStreamActive({
					streamId: "never-asked-stream",
					userId: "u1",
					conversationId: "never-asked-conv",
				}),
			).toBe(false),
		);

		expect(terminalMetadata(chunks)).not.toHaveProperty("waitingQuestionId");
		expect(stampAskQuestion).not.toHaveBeenCalled();
		expect(discardAskQuestion).not.toHaveBeenCalled();
	});

	it("discards a chat's stale unstamped questions when a turn starts, before the model runs", async () => {
		const runStreaming = await mockRun(
			[{ type: "text_delta", text: "Hi" }, finishEvent],
			{},
		);
		const { discardStaleAskQuestions } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);

		await readSseResponse(runStream({ conversationId: "sweep-conv" }));

		expect(discardStaleAskQuestions).toHaveBeenCalledTimes(1);
		expect(discardStaleAskQuestions).toHaveBeenCalledWith({
			userId: "u1",
			conversationId: "sweep-conv",
		});
		expect(
			vi.mocked(discardStaleAskQuestions).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(runStreaming).mock.invocationCallOrder[0]);
	});

	it("runs no sweep for a turn that holds no stream: it is not arbitrated and may overlap another turn of the chat", async () => {
		await mockRun([{ type: "text_delta", text: "Hi" }, finishEvent], {});
		const { discardStaleAskQuestions } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);

		const chunks = await readSseResponse(
			runStream({ conversationId: "no-stream-conv", streamId: undefined }),
		);

		expect(chunks.join("\n\n")).toContain("Hi");
		expect(discardStaleAskQuestions).not.toHaveBeenCalled();
	});

	it("starts the turn when the sweep fails", async () => {
		await mockRun(
			[{ type: "text_delta", text: "Still here." }, finishEvent],
			{},
		);
		const { discardStaleAskQuestions } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);
		vi.mocked(discardStaleAskQuestions).mockRejectedValue(
			new Error("database is locked"),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const chunks = await readSseResponse(runStream());

			expect(chunks.join("\n\n")).toContain("Still here.");
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("questions"),
				expect.anything(),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not sweep when the connection only reconnects to a running stream", async () => {
		const { discardStaleAskQuestions } = await import(
			"$lib/server/services/chat-turn/ask-questions"
		);
		const ownerController = new AbortController();
		registerActiveChatStream({
			streamId: "sweep-reconnect-stream",
			userId: "u1",
			conversationId: "sweep-reconnect-conv",
			controller: ownerController,
		});
		getOrCreateStreamBuffer({
			streamId: "sweep-reconnect-stream",
			userId: "u1",
			conversationId: "sweep-reconnect-conv",
			userMessage: "Hello",
			reasoningDepth: "thorough",
		});

		try {
			const response = runChatStreamOrchestrator({
				user: { id: "u1", displayName: "User", email: "u@test.com" },
				turn: createAdmittedTurn({
					conversationId: "sweep-reconnect-conv",
					streamId: "sweep-reconnect-stream",
				}),
				prepareTurn: async () => {
					throw new Error("Preparation must not run for active reconnects");
				},
				upstreamMessage: "Hello",
				downstreamAbortSignal: new AbortController().signal,
				requestStartTime: Date.now(),
				isReconnect: true,
			});
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing response body");
			await readNextSseChunk(reader);

			expect(discardStaleAskQuestions).not.toHaveBeenCalled();

			await reader.cancel().catch(() => undefined);
		} finally {
			clearStreamBuffer("sweep-reconnect-stream");
			unregisterActiveChatStream("sweep-reconnect-stream", ownerController);
		}
	});

	// The turn that carries the reply on from the person's answer. Its input is the
	// captured reply with the answer where the pause was; the question it answers is
	// settled when its segment is saved and given back when it ends unsaved.
	describe("a resume that carries the reply on from the answer", () => {
		const CLOUD = {
			baseUrl: "https://api.fireworks.ai/inference/v1",
		} as NormalChatModelRunProvider;
		const HOME = {
			baseUrl: "http://192.168.1.20:8000/v1",
		} as NormalChatModelRunProvider;
		const answerResult = {
			status: "answered",
			answers: [{ question: "Which one?", picked: ["B"] }],
			note: "The user answered.",
		};
		const CALENDAR_PAYLOAD = {
			events: [{ title: "Dentist with Dr. Kovacs" }],
		};
		// what the paused segment read, with the answer where its pause was
		const resumeContinuation: ModelMessage[] = [
			...continuationGiven,
			...responseMessages.slice(0, 2),
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
						output: { type: "json", value: CALENDAR_PAYLOAD },
					},
				],
			},
			responseMessages[2],
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-ask",
						toolName: "ask_user",
						output: { type: "json", value: answerResult },
					},
				],
			},
		];
		const CALENDAR_DIGEST = { ok: true, summary: "Found 1 event." };
		const resume: AskResumeInput = {
			depthOverride: true,
			questionId: "q-1",
			claim: "claim-1",
			askedMessageId: "asst-1",
			askToolCallId: "call-ask",
			userMessageId: "user-m",
			continuation: resumeContinuation,
			capturedResults: [
				{
					toolCallId: "pre-1",
					toolName: "fetch_url",
					localDistilled: false,
					digest: { ok: true, summary: "Fetched 1 page." },
				},
				{
					toolCallId: "call-search",
					toolName: "research_web",
					localDistilled: false,
					digest: { ok: true, summary: "Found 2 sources." },
				},
				{
					toolCallId: "call-cal",
					toolName: "calendar",
					localDistilled: false,
					digest: CALENDAR_DIGEST,
				},
			],
			userTexts: ["Satin, please"],
			priorSegmentToolCalls: [fetchEntry, searchEntry, askEntry] as never,
			keepConnectorDataLocal: true,
			answerDigest: {
				outputSummary: "The user picked: B",
				resultDigest: "answers:\n- Which one?: B",
			},
		};

		function runResume(
			overrides: Partial<ChatTurnPreflight> = {},
			options: Partial<StreamOrchestratorOptions> = {},
		) {
			return runChatStreamOrchestrator({
				user: { id: "u1", displayName: "User", email: "u@test.com" },
				turn: createTurn({
					turnOrigin: "ask_resume",
					skipPersistUserMessage: true,
					...overrides,
				}),
				upstreamMessage: "Hello",
				downstreamAbortSignal: new AbortController().signal,
				requestStartTime: Date.now(),
				resume,
				...options,
			});
		}

		function modelParams(
			runStreaming: Awaited<ReturnType<typeof mockRun>>,
		): Record<string, unknown> {
			const params = vi.mocked(runStreaming).mock.calls[0]?.[0];
			if (!params) throw new Error("The model was not run");
			return params as unknown as Record<string, unknown>;
		}

		function outputOf(messages: ModelMessage[], toolCallId: string): unknown {
			for (const message of messages) {
				if (message.role !== "tool") continue;
				for (const part of message.content) {
					if (part.type === "tool-result" && part.toolCallId === toolCallId) {
						return part.output;
					}
				}
			}
			return undefined;
		}

		it("runs a resume with its continuation and no instant acknowledgment, and gives its question back when it ends unsaved", async () => {
			const logs = captureStreamLogs();
			const { createMessage } = await import("../messages");
			vi.mocked(createMessage).mockRejectedValueOnce(
				new Error("Synthetic storage failure"),
			);
			try {
				const runStreaming = await mockRun(
					[{ type: "error", error: "Provider rejected the model response." }],
					{},
				);
				const { resolveTurnAcknowledgment } = await import(
					"$lib/server/services/chat-turn/turn-acknowledgment"
				);
				const { releaseAskQuestion, settleAskQuestion } = await import(
					"$lib/server/services/chat-turn/ask-questions"
				);

				const chunks = await readSseResponse(runResume());

				// the model run starts from the reply so far, on the person's own message
				// with the history cut before it, and reads no page again
				const params = modelParams(runStreaming);
				expect(params).toMatchObject({
					message: "Hello",
					conversationId: "test-conv",
					continuationMessages: resumeContinuation,
					resumeDepthOverride: true,
					historyBeforeMessageId: "user-m",
					skipWebPrefetch: true,
				});
				// no regeneration appendix: this is the same reply going on
				expect(params.systemPromptAppendix).toBeUndefined();
				expect(params.resumeProvenance).toEqual({
					userTexts: ["Satin, please"],
					priorResults: capturedProvenanceResults({
						v: 1,
						messages: resumeContinuation,
						results: resume.capturedResults,
					}),
				});
				// a resume is not a new question: no acknowledgment is asked for
				expect(resolveTurnAcknowledgment).not.toHaveBeenCalled();
				// it ended with an error and nothing saved: the question goes back
				expect(parseUiStreamParts(chunks)).toContainEqual({
					type: "finish",
					finishReason: "error",
				});
				await vi.waitFor(() =>
					expect(releaseAskQuestion).toHaveBeenCalledWith({
						userId: "u1",
						questionId: "q-1",
						claim: "claim-1",
					}),
				);
				expect(settleAskQuestion).not.toHaveBeenCalled();
			} finally {
				logs.restore();
			}
		});

		it("gates the continuation for each attempt with the captured results and the person's connector setting", async () => {
			const runStreaming = await mockRun(
				[{ type: "text_delta", text: "Here is the plan." }, finishEvent],
				{},
			);

			await readSseResponse(runResume());

			const gate = modelParams(runStreaming).gateMessagesForAttempt as (
				messages: ModelMessage[],
				provider: NormalChatModelRunProvider,
			) => ModelMessage[];
			// an attempt off the person's box is sent the connector result's digest
			const cloud = gate(resumeContinuation, CLOUD);
			expect(outputOf(cloud, "call-cal")).toEqual({
				type: "json",
				value: CALENDAR_DIGEST,
			});
			expect(JSON.stringify(cloud)).not.toContain("Dr. Kovacs");
			// the person's own box is sent all of it
			expect(gate(resumeContinuation, HOME)).toBe(resumeContinuation);
		});

		it("sends a person who keeps nothing local the whole continuation", async () => {
			const runStreaming = await mockRun(
				[{ type: "text_delta", text: "Here is the plan." }, finishEvent],
				{},
			);

			await readSseResponse(
				runResume({}, { resume: { ...resume, keepConnectorDataLocal: false } }),
			);

			const gate = modelParams(runStreaming).gateMessagesForAttempt as (
				messages: ModelMessage[],
				provider: NormalChatModelRunProvider,
			) => ModelMessage[];
			expect(gate(resumeContinuation, CLOUD)).toBe(resumeContinuation);
		});

		it("saves its segment as the continuation of the row that asked, then settles the question and writes the answer into that row's ask call", async () => {
			await mockRun(
				[{ type: "text_delta", text: "Here is the plan." }, finishEvent],
				{},
			);
			const { settleAskQuestion, releaseAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const { createMessage, updateAssistantToolCallResult } = await import(
				"$lib/server/services/messages"
			);

			const chunks = await readSseResponse(runResume());

			// the person's message is not saved again; the segment names the row it continues
			expect(createMessage).toHaveBeenCalledTimes(1);
			expect(createMessage).toHaveBeenCalledWith(
				"test-conv",
				"assistant",
				"Here is the plan.",
				undefined,
				undefined,
				expect.objectContaining({ continuesMessageId: "asst-1" }),
			);
			expect(terminalMetadata(chunks)).toMatchObject({
				assistantMessageId: "msg-1",
				wasStopped: false,
			});
			expect(terminalMetadata(chunks)).not.toHaveProperty("waitingQuestionId");
			// the answer settles with the claim that won it, and goes into the ask call
			expect(settleAskQuestion).toHaveBeenCalledWith({
				userId: "u1",
				questionId: "q-1",
				claim: "claim-1",
			});
			expect(updateAssistantToolCallResult).toHaveBeenCalledWith({
				conversationId: "test-conv",
				messageId: "asst-1",
				callId: "call-ask",
				toolName: "ask_user",
				questionId: "q-1",
				outputSummary: "The user picked: B",
				resultDigest: "answers:\n- Which one?: B",
			});
			// ... and the turn's ending hands the claim back, which the store ignores
			await vi.waitFor(() =>
				expect(releaseAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
					claim: "claim-1",
				}),
			);
		});

		it("captures a second question asked inside a resume on top of the first answer", async () => {
			const newSearchEntry = {
				...searchEntry,
				callId: "call-search-2",
				input: { query: "finishes" },
			};
			const ask2 = {
				questionId: "q-2",
				toolCallId: "call-ask-2",
				questions,
			};
			const ask2Entry = {
				...askEntry,
				callId: "call-ask-2",
				metadata: { paused: true, questionId: "q-2" },
			};
			const secondResponse: ModelMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call-search-2",
							toolName: "research_web",
							input: { query: "finishes" },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call-search-2",
							toolName: "research_web",
							output: { type: "json", value: { sources: ["finishes"] } },
						},
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "And the finish?" },
						{
							type: "tool-call",
							toolCallId: "call-ask-2",
							toolName: "ask_user",
							input: { questions },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call-ask-2",
							toolName: "ask_user",
							output: { type: "json", value: { status: "waiting_for_user" } },
						},
					],
				},
			];
			await mockRun(
				[
					{ type: "text_delta", text: "And the finish?" },
					{
						type: "tool_call",
						callId: "call-search-2",
						toolName: "research_web",
						input: { query: "finishes" },
					},
					{
						type: "tool_result",
						callId: "call-search-2",
						toolName: "research_web",
						output: { success: true },
					},
					{
						type: "tool_call",
						callId: "call-ask-2",
						toolName: "ask_user",
						input: { questions },
					},
					{
						type: "tool_result",
						callId: "call-ask-2",
						toolName: "ask_user",
						output: { status: "waiting_for_user" },
					},
					finishEvent,
				],
				{
					fixtureOutcome: "paused",
					normalChatToolCalls: [newSearchEntry, ask2Entry],
					prefetchedToolCalls: [],
					// what this run was given is the continuation it was started with
					continuationGiven: resumeContinuation,
					getResponseMessages: () => secondResponse,
					getTurnAsk: () => ask2,
				},
			);
			const { stampAskQuestion, settleAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);

			const chunks = await readSseResponse(runResume());

			// the second question's capture is the first answer's continuation and what
			// this run said and read, with the rows of the first segments kept as they
			// were and one more for this run's own search
			expect(stampAskQuestion).toHaveBeenCalledTimes(1);
			expect(stampAskQuestion).toHaveBeenCalledWith({
				userId: "u1",
				questionId: "q-2",
				assistantMessageId: "msg-1",
				capture: {
					v: 1,
					messages: [...resumeContinuation, ...secondResponse],
					results: [
						...resume.capturedResults,
						expect.objectContaining({
							toolCallId: "call-search-2",
							toolName: "research_web",
							localDistilled: false,
							digest: expect.objectContaining({ summary: "Found 2 sources." }),
						}),
					],
				},
			});
			// the first question is settled before the second is stamped
			expect(settleAskQuestion).toHaveBeenCalledWith({
				userId: "u1",
				questionId: "q-1",
				claim: "claim-1",
			});
			expect(
				vi.mocked(settleAskQuestion).mock.invocationCallOrder[0],
			).toBeLessThan(vi.mocked(stampAskQuestion).mock.invocationCallOrder[0]);
			expect(terminalMetadata(chunks)).toMatchObject({
				waitingQuestionId: "q-2",
			});
		});

		it("gives its question back when the stream does not start because another one is running", async () => {
			const { releaseAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const runStreaming = await mockRun(
				[{ type: "text_delta", text: "Not reached." }, finishEvent],
				{},
			);
			const ownerController = new AbortController();
			registerActiveChatStream({
				streamId: "resume-owner-stream",
				userId: "u1",
				conversationId: "resume-reconnect-conv",
				controller: ownerController,
			});
			getOrCreateStreamBuffer({
				streamId: "resume-owner-stream",
				userId: "u1",
				conversationId: "resume-reconnect-conv",
				userMessage: "Hello",
				reasoningDepth: "thorough",
			});

			try {
				const response = runResume({
					conversationId: "resume-reconnect-conv",
					streamId: "resume-answer-stream",
				});
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Missing response body");
				await readNextSseChunk(reader);

				// it joined the stream that runs, so it runs no model of its own, and the
				// question it holds goes back for the person to answer again
				expect(runStreaming).not.toHaveBeenCalled();
				await vi.waitFor(() =>
					expect(releaseAskQuestion).toHaveBeenCalledWith({
						userId: "u1",
						questionId: "q-1",
						claim: "claim-1",
					}),
				);

				await reader.cancel().catch(() => undefined);
			} finally {
				clearStreamBuffer("resume-owner-stream");
				unregisterActiveChatStream("resume-owner-stream", ownerController);
			}
		});

		// The claim is handed back whatever ends the start: the arbiter's other early
		// return, a throw in the setup before the turn's own try, and a throw in the
		// turn's own ending. Each would leave the chat refusing messages with no card
		// to answer until a restart.
		it("gives its question back when the stream cannot be registered and the turn closes", async () => {
			const { releaseAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const runStreaming = await mockRun(
				[{ type: "text_delta", text: "Not reached." }, finishEvent],
				{},
			);
			// the stream id is another person's: the registry rejects it and no stream
			// of this person's chat runs to join
			const otherUserController = new AbortController();
			registerActiveChatStream({
				streamId: "colliding-resume-stream",
				userId: "other-user",
				controller: otherUserController,
				conversationId: "other-conversation",
			});

			try {
				const response = runResume({
					conversationId: "u1-conversation",
					streamId: "colliding-resume-stream",
				});

				expect(await response.text()).toBe("");
				expect(runStreaming).not.toHaveBeenCalled();
				expect(releaseAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
					claim: "claim-1",
				});
			} finally {
				unregisterActiveChatStream(
					"colliding-resume-stream",
					otherUserController,
				);
			}
		});

		it("gives its question back when a step of the setup throws before the turn's own try", async () => {
			const { createThoughtStepClassifierSession } = await import(
				"$lib/server/services/chat-turn/thought-step-classifier"
			);
			const { releaseAskQuestion, settleAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			vi.mocked(createThoughtStepClassifierSession).mockImplementation(() => {
				throw new Error("classifier setup failed");
			});
			const runStreaming = await mockRun(
				[{ type: "text_delta", text: "Not reached." }, finishEvent],
				{},
			);

			try {
				await expect(
					readSseResponse(
						runResume({
							conversationId: "setup-throw-conv",
							streamId: "setup-throw-stream",
						}),
					),
				).rejects.toThrow("classifier setup failed");

				expect(runStreaming).not.toHaveBeenCalled();
				expect(settleAskQuestion).not.toHaveBeenCalled();
				expect(releaseAskQuestion).toHaveBeenCalledWith({
					userId: "u1",
					questionId: "q-1",
					claim: "claim-1",
				});
			} finally {
				// the turn never reached its own ending, which is what unregisters its
				// stream (as for any turn whose setup throws); the registry is the
				// test's to clean
				unregisterActiveChatStream("setup-throw-stream");
				clearStreamBuffer("setup-throw-stream");
			}
		});

		it("gives its question back when a step of the turn's own ending throws", async () => {
			const logs = captureStreamLogs();
			try {
				const { releaseAskQuestion } = await import(
					"$lib/server/services/chat-turn/ask-questions"
				);
				// reading what the run asked is the first thing the ending does
				await mockRun(
					[{ type: "text_delta", text: "Here is the plan." }, finishEvent],
					{
						getTurnAsk: () => {
							throw new Error("run state unreadable");
						},
					},
				);

				await readSseResponse(runResume()).catch(() => undefined);

				await vi.waitFor(() =>
					expect(releaseAskQuestion).toHaveBeenCalledWith({
						userId: "u1",
						questionId: "q-1",
						claim: "claim-1",
					}),
				);
			} finally {
				logs.restore();
			}
		});

		it("gives back and settles nothing for a turn that is not a resume", async () => {
			await mockRun([{ type: "text_delta", text: "Done." }, finishEvent], {});
			const { releaseAskQuestion, settleAskQuestion } = await import(
				"$lib/server/services/chat-turn/ask-questions"
			);
			const { resolveTurnAcknowledgment } = await import(
				"$lib/server/services/chat-turn/turn-acknowledgment"
			);
			const { updateAssistantToolCallResult } = await import(
				"$lib/server/services/messages"
			);

			await readSseResponse(runStream({ conversationId: "plain-conv" }));
			await vi.waitFor(() =>
				expect(
					isStreamActive({
						streamId: "test-stream",
						userId: "u1",
						conversationId: "plain-conv",
					}),
				).toBe(false),
			);

			expect(releaseAskQuestion).not.toHaveBeenCalled();
			expect(settleAskQuestion).not.toHaveBeenCalled();
			expect(updateAssistantToolCallResult).not.toHaveBeenCalled();
			expect(resolveTurnAcknowledgment).toHaveBeenCalledTimes(1);
		});
	});
});
