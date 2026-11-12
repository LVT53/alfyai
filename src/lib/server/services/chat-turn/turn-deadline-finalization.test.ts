// The stream transport's watchdog and the model engine used to share one deadline
// (`requestStartTime + requestTimeoutMs`), so a reply whose model work legally ran
// until it had no time left to be finalized and saved: the turn was reported as a
// failure and nothing was written. The engine keeps `requestTimeoutMs` of model
// time and no more; finalization gets its own window after it
// (TURN_FINALIZATION_WINDOW_MS), and a finalization that hangs still ends in an
// explicit failure when that window closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearStreamBuffer,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { TURN_FINALIZATION_WINDOW_MS } from "$lib/shared/normal-chat-completion";
import { runChatStreamOrchestrator } from "./stream-orchestrator";
import type { ChatTurnPreflight } from "./types";

vi.mock("./completion-lifetime", () => ({
	observeCompletionTurn: async () => null,
}));

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

// ---- harness copied from stream-orchestrator.test.ts ----
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
		for (const line of lines) if (line.trim()) chunks.push(line);
	}
	if (buffer.trim()) chunks.push(buffer);
	return chunks;
}

function createTurn(): ChatTurnPreflight {
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
	} as ChatTurnPreflight;
}

function result(
	stream: AsyncIterable<NeutralStreamEvent>,
	finish = vi.fn(async (_id?: string) => {}),
) {
	return {
		completionTurn: {
			segmentId: "fixture-segment",
			finish,
			getSnapshot: () => ({
				segmentId: "fixture-segment",
				events: [],
				completion: {
					version: 1,
					turnId: "fixture-turn",
					segmentId: "fixture-segment",
					phase: "closing",
					outcome: "answered",
					stopCause: "natural_stop",
					workingStopCause: "deadline",
					closingAttempted: true,
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
		stream,
		prefetchedToolCalls: [],
		getNormalChatToolCalls: () => [],
		getToolCalls: () => [],
		getTurnAsk: () => null,
		getResponseMessages: () => [],
		continuationGiven: [],
	};
}

async function defaults() {
	const { getConversation, touchConversation } = await import(
		"$lib/server/services/conversations"
	);
	const { createMessage, listConversationMessagesForExport } = await import(
		"$lib/server/services/messages"
	);
	const finalizeSteps = await import(
		"$lib/server/services/chat-turn/finalize-steps"
	);
	const asks = await import("$lib/server/services/chat-turn/ask-questions");
	const { createThoughtStepClassifierSession } = await import(
		"$lib/server/services/chat-turn/thought-step-classifier"
	);
	const { resolveTurnAcknowledgment } = await import(
		"$lib/server/services/chat-turn/turn-acknowledgment"
	);
	const { estimateTokenCount } = await import("$lib/utils/tokens");
	vi.mocked(touchConversation).mockResolvedValue(undefined as never);
	vi.mocked(getConversation).mockResolvedValue({ id: "test-conv" } as never);
	vi.mocked(createMessage).mockImplementation(
		async (_c, role) =>
			({ id: role === "assistant" ? "assistant-row" : "user-row" }) as never,
	);
	vi.mocked(listConversationMessagesForExport).mockResolvedValue([] as never);
	vi.mocked(finalizeSteps.persistUserTurnAttachments).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(finalizeSteps.persistAssistantTurnState).mockResolvedValue({
		activeWorkingSet: [],
		taskState: null,
		contextDebug: null,
		workCapsule: undefined,
	} as never);
	vi.mocked(finalizeSteps.persistAssistantEvidence).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(finalizeSteps.runPostTurnTasks).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(finalizeSteps.recordAssistantTurnAnalytics).mockResolvedValue(
		undefined as never,
	);
	vi.mocked(estimateTokenCount).mockReturnValue(100);
	vi.mocked(asks.discardStaleAskQuestions).mockResolvedValue(0 as never);
	vi.mocked(asks.discardAskQuestion).mockResolvedValue(undefined as never);
	vi.mocked(createThoughtStepClassifierSession).mockReturnValue({
		onReasoningDelta: vi.fn(),
		stop: vi.fn(),
		getSteps: vi.fn(() => []),
	} as never);
	vi.mocked(resolveTurnAcknowledgment).mockResolvedValue(null as never);
}

describe("a turn whose model work runs until the engine deadline is still finalized", () => {
	beforeEach(async () => {
		vi.resetAllMocks();
		await defaults();
	});
	afterEach(() => {
		clearStreamBuffer("test-stream");
		unregisterActiveChatStream("test-stream");
		vi.useRealTimers();
	});

	it("a closing answer that ends inside its own completion deadline is saved, not reported as a failure", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const { readConversationLanguage } = await import(
			"$lib/server/services/chat-turn/conversation-language"
		);
		// Production: callShortLocalControlModel on model2, once per turn after the reply.
		vi.mocked(readConversationLanguage).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
		);
		const requestStartTime = Date.now();
		let engineDeadline = 0;
		vi.mocked(run).mockImplementation((async (params: {
			completionDeadlineAt?: number;
		}) => {
			engineDeadline = params.completionDeadlineAt ?? 0;
			return result(
				(async function* () {
					yield {
						type: "text_delta",
						text: "Closing answer.",
					} as NeutralStreamEvent;
					// The engine's closing timer is snapshot.deadlineAt itself. This
					// closing settles 500 ms before that bound.
					await new Promise((resolve) =>
						setTimeout(resolve, engineDeadline - 500 - Date.now()),
					);
					yield finishEvent;
				})(),
			);
		}) as never);
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime,
		});
		const reading = readSseResponse(response);
		await vi.advanceTimersByTimeAsync(40_000);
		const wire = (await reading).join("");
		const assistantWrites = vi
			.mocked(createMessage)
			.mock.calls.filter((call) => call[1] === "assistant").length;
		expect(engineDeadline - requestStartTime).toBe(30_000);
		expect(wire).not.toContain("data-stream-error");
		expect(assistantWrites).toBe(1);
		// The watchdog's timers, the longer ones included, are cleared.
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("control: the same turn whose closing ends 25 s before the deadline is saved", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const { readConversationLanguage } = await import(
			"$lib/server/services/chat-turn/conversation-language"
		);
		vi.mocked(readConversationLanguage).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
		);
		vi.mocked(run).mockImplementation((async () =>
			result(
				(async function* () {
					yield {
						type: "text_delta",
						text: "Closing answer.",
					} as NeutralStreamEvent;
					await new Promise((resolve) => setTimeout(resolve, 5000));
					yield finishEvent;
				})(),
			)) as never);
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		const reading = readSseResponse(response);
		await vi.advanceTimersByTimeAsync(40_000);
		const wire = (await reading).join("");
		expect(wire).not.toContain("data-stream-error");
		expect(
			vi
				.mocked(createMessage)
				.mock.calls.filter((call) => call[1] === "assistant"),
		).toHaveLength(1);
	});

	it("a closing cut at the engine deadline (outcome saved as a partial) is still finalized", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const requestStartTime = Date.now();
		vi.mocked(run).mockImplementation((async (params: {
			completionDeadlineAt?: number;
		}) =>
			result(
				(async function* () {
					yield {
						type: "text_delta",
						text: "Partial closing answer",
					} as NeutralStreamEvent;
					// The engine's own closing timer fires at completionDeadlineAt and
					// then yields its terminal usage/finish.
					await new Promise((resolve) =>
						setTimeout(
							resolve,
							(params.completionDeadlineAt ?? 0) - Date.now(),
						),
					);
					yield finishEvent;
				})(),
			)) as never);
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime,
		});
		const reading = readSseResponse(response);
		await vi.advanceTimersByTimeAsync(40_000);
		const wire = (await reading).join("");
		const assistantWrites = vi
			.mocked(createMessage)
			.mock.calls.filter((call) => call[1] === "assistant").length;
		expect(wire).not.toContain("data-stream-error");
		expect(assistantWrites).toBe(1);
	});

	it("a finalization that hangs still ends in an explicit failure when the finalization window closes, and not before", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		const { createMessage } = await import("$lib/server/services/messages");
		const { readConversationLanguage } = await import(
			"$lib/server/services/chat-turn/conversation-language"
		);
		// The model work ends at once; the language call after it never answers.
		vi.mocked(readConversationLanguage).mockImplementation(
			() => new Promise(() => {}),
		);
		vi.mocked(run).mockImplementation((async () =>
			result(
				(async function* () {
					yield { type: "text_delta", text: "Answer." } as NeutralStreamEvent;
					yield finishEvent;
				})(),
			)) as never);
		const response = runChatStreamOrchestrator({
			user: { id: "u1", displayName: "User", email: "u@test.com" },
			turn: createTurn(),
			upstreamMessage: "Hello",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		let settled = false;
		const reading = readSseResponse(response).then((chunks) => {
			settled = true;
			return chunks;
		});
		// The model deadline passes (30 s): finalization is still inside its window.
		await vi.advanceTimersByTimeAsync(30_000 + TURN_FINALIZATION_WINDOW_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true);
		const wire = (await reading).join("");
		expect(wire).toContain("data-stream-error");
		// A timeout before the commit starts fences the write for good.
		expect(
			vi
				.mocked(createMessage)
				.mock.calls.filter((call) => call[1] === "assistant"),
		).toHaveLength(0);
	});

	it("gives the engine the model deadline only, never the end of the finalization window", async () => {
		vi.useFakeTimers();
		const { runStreamingNormalChatSendModel: run } = await import(
			"./streaming-normal-chat-model-run"
		);
		let engineDeadline = 0;
		vi.mocked(run).mockImplementation((async (params: {
			completionDeadlineAt?: number;
		}) => {
			engineDeadline = params.completionDeadlineAt ?? 0;
			return result(
				(async function* () {
					yield { type: "text_delta", text: "Answer." } as NeutralStreamEvent;
					yield finishEvent;
				})(),
			);
		}) as never);
		const requestStartTime = Date.now();
		const reading = readSseResponse(
			runChatStreamOrchestrator({
				user: { id: "u1", displayName: "User", email: "u@test.com" },
				turn: createTurn(),
				upstreamMessage: "Hello",
				downstreamAbortSignal: new AbortController().signal,
				requestStartTime,
			}),
		);
		await vi.advanceTimersByTimeAsync(1_000);
		await reading;
		expect(engineDeadline).toBe(requestStartTime + 30_000);
	});
});
