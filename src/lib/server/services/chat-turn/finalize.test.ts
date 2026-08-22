import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordMessageAnalytics } from "$lib/server/services/analytics";
import type { ChatFile } from "$lib/server/services/chat-files";
import { getArtifactsForUser } from "$lib/server/services/knowledge";
import { recordMemoryBehaviorEvent } from "$lib/server/services/memory-behavior-log";
import { buildAssistantEvidenceSummary } from "$lib/server/services/message-evidence";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { resolveWorkingDocumentSelection } from "$lib/server/services/working-document-selection";

const {
	mockJudgeFinishedTurn,
	mockListMessages,
	mockRefreshConversationSummary,
	mockResolveWorkingDocumentSelection,
	mockRunUserMemoryMaintenance,
	mockSyncGeneratedFilesToMemory,
	mockShouldTrackTaskContinuityFromTurn,
	mockIsConversationIncognito,
	mockCreateMessage,
	mockPersistUserTurnAttachments,
	mockPersistAssistantTurnState,
	mockPersistAssistantEvidence,
	mockRunPostTurnTasks,
	mockRecordAssistantTurnAnalytics,
	mockGenerateShortLocalText,
	mockResolveShortTextLanguage,
	mockUpdateMessageRailSummary,
} = vi.hoisted(() => ({
	mockJudgeFinishedTurn: vi.fn(
		async (): Promise<{
			status: "skipped" | "explicit" | "marathon" | "idle";
		}> => ({ status: "idle" }),
	),
	mockListMessages: vi.fn(async () => [] as ChatMessage[]),
	mockRefreshConversationSummary: vi.fn(async () => undefined),
	mockSyncGeneratedFilesToMemory: vi.fn(async () => undefined),
	mockResolveWorkingDocumentSelection: vi.fn(() => ({
		documentFocused: false,
		currentDocument: null,
		latestGeneratedDocumentIds: [],
		activeFocus: { artifactIds: [] },
		correction: { hasSignal: false, targetArtifactIds: [] },
		recentRefinement: { familyId: null, artifactIds: [] },
		reset: { hasSignal: false, suppressCarryover: false },
		currentTurnReasonCodesByArtifactId: new Map(),
		prompt: { reasonCodesByArtifactId: new Map() },
		workingSet: {
			candidateArtifactIds: [],
			candidateSignalsByArtifactId: new Map(),
		},
		retrieval: {
			preferredArtifactId: null,
			preferredGeneratedFamilyId: null,
			suppressGeneratedCarryover: false,
			hasExplicitResetSignal: false,
		},
		taskEvidence: {
			protectedArtifactIds: [],
			workingDocumentProtectedArtifactIds: [],
		},
	})),
	mockRunUserMemoryMaintenance: vi.fn(async () => undefined),
	mockShouldTrackTaskContinuityFromTurn: vi.fn(() => true),
	mockIsConversationIncognito: vi.fn(async () => false),
	mockCreateMessage: vi.fn(),
	mockPersistUserTurnAttachments: vi.fn(),
	mockPersistAssistantTurnState: vi.fn(),
	mockPersistAssistantEvidence: vi.fn(),
	mockRunPostTurnTasks: vi.fn(),
	mockRecordAssistantTurnAnalytics: vi.fn(async () => undefined),
	// A1/Fix 2 — the rail-summary step's control-model seam and its write-back.
	// Mocking ./short-local-text keeps the real rail-summary.ts + finalize-steps
	// gate in play (importActual) while the ≥200-char wiring tests below never
	// reach the real control model — the fragility the reviewer flagged.
	mockGenerateShortLocalText: vi.fn(async () => null as string | null),
	mockResolveShortTextLanguage: vi.fn(() => "en" as "en" | "hu"),
	mockUpdateMessageRailSummary: vi.fn(async () => undefined),
}));

// finalizeChatTurn fans post-turn work out to ./finalize-steps in one ordered
// sequence. The finalizeChatTurn tests seam at that module boundary; the direct
// tests of the steps below reach for the real implementations through
// vi.importActual("./finalize-steps").
vi.mock("$lib/server/services/chat-turn/finalize-steps", () => ({
	persistUserTurnAttachments: mockPersistUserTurnAttachments,
	persistAssistantTurnState: mockPersistAssistantTurnState,
	persistAssistantEvidence: mockPersistAssistantEvidence,
	runPostTurnTasks: mockRunPostTurnTasks,
	recordAssistantTurnAnalytics: mockRecordAssistantTurnAnalytics,
}));

vi.mock("$lib/server/services/chat-files", () => ({
	syncGeneratedFilesToMemory: mockSyncGeneratedFilesToMemory,
	getChatFilesForAssistantMessage: vi.fn(async () => []),
}));

vi.mock("$lib/server/services/analytics", () => ({
	recordMessageAnalytics: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/memory-controls", () => ({
	isConversationIncognito: mockIsConversationIncognito,
	isMemoryActiveForConversation: vi.fn(async () => true),
	isUserMemoryEnabled: vi.fn(async () => true),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: mockCreateMessage,
	listMessages: mockListMessages,
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageWebCitationAudit: vi.fn(async () => undefined),
	// A1 — runPostTurnTasks (importActual) now transitively reaches the
	// rail-summary step, which writes back through this seam. The short-reply
	// tests skip it (below the 200-char threshold); the ≥200-char wiring test
	// below asserts it actually lands.
	updateMessageRailSummary: mockUpdateMessageRailSummary,
}));

// Fix 2 — the rail-summary control-model seam. Mocked so the real
// rail-summary.ts (reached through importActual("./finalize-steps")) never
// hits the self-hosted control model in tests. resolveShortTextLanguage is
// kept trivial; the real one is exercised in short-local-text.test.ts.
vi.mock("./short-local-text", () => ({
	generateShortLocalText: mockGenerateShortLocalText,
	resolveShortTextLanguage: mockResolveShortTextLanguage,
}));

vi.mock("$lib/server/services/conversation-drafts", () => ({
	clearConversationDraft: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/conversation-summaries", () => ({
	refreshConversationSummary: mockRefreshConversationSummary,
}));

vi.mock("$lib/server/services/memory-judge/dispatch", () => ({
	judgeFinishedTurn: mockJudgeFinishedTurn,
}));

vi.mock("$lib/server/services/knowledge", () => ({
	attachArtifactsToMessage: vi.fn(async () => undefined),
	createGeneratedOutputArtifact: vi.fn(async () => null),
	getArtifactsForUser: vi.fn(async () => []),
	getConversationWorkingSet: vi.fn(async () => []),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/knowledge/store", () => ({
	parseWorkingDocumentMetadata: vi.fn(() => ({})),
}));

vi.mock("$lib/server/services/memory-behavior-log", () => ({
	recordMemoryBehaviorEvent: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/memory-maintenance", () => ({
	runUserMemoryMaintenance: mockRunUserMemoryMaintenance,
}));

vi.mock("$lib/server/services/message-evidence", () => ({
	buildAssistantEvidenceSummary: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/notes", () => ({
	commitSkillNoteOperationsAfterAssistantMessage: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/task-state", () => ({
	shouldTrackTaskContinuityFromTurn: mockShouldTrackTaskContinuityFromTurn,
	attachContinuityToTaskState: vi.fn(async (_userId, taskState) => taskState),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/web-citation-audit", () => ({
	buildWebCitationAudit: vi.fn(() => null),
}));

vi.mock("$lib/server/services/working-document-selection", () => ({
	resolveWorkingDocumentSelection: mockResolveWorkingDocumentSelection,
}));

function makeChatMessage(
	id: string,
	role: ChatMessage["role"],
	content: string,
): ChatMessage {
	return {
		id,
		role,
		content,
		timestamp: 1_777_140_000_000,
	};
}

function makeChatFile(params: {
	id: string;
	conversationId: string;
	assistantMessageId: string;
	artifactId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
}): ChatFile {
	return {
		...params,
		userId: "user-1",
		storagePath: "/tmp/generated/report.pdf",
		documentFamilyId: null,
		documentFamilyStatus: null,
		documentLabel: null,
		documentRole: null,
		versionNumber: null,
		originConversationId: null,
		originAssistantMessageId: null,
		sourceChatFileId: null,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runPostTurnTasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListMessages.mockResolvedValue([]);
		mockJudgeFinishedTurn.mockResolvedValue({ status: "idle" });
		// Rail-summary seam defaults (a test may override per-case). Reset the
		// implementation too — clearAllMocks only clears call history — so an
		// mockImplementation/mockResolvedValue set by one case never leaks.
		mockGenerateShortLocalText.mockReset();
		mockGenerateShortLocalText.mockResolvedValue(null);
		mockResolveShortTextLanguage.mockReturnValue("en");
		mockUpdateMessageRailSummary.mockReset();
		mockUpdateMessageRailSummary.mockResolvedValue(undefined);
	});

	it("logs summary refresh failures without rejecting post-turn tasks", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockRefreshConversationSummary.mockRejectedValueOnce(
			new Error("summary offline"),
		);
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await expect(
			runPostTurnTasks({
				turnKind: "send",
				userId: "user-1",
				conversationId: "conv-1",
				upstreamMessage: "upstream prompt payload",
				userMessage: "normalized user message",
				assistantResponse: "visible assistant response",
				assistantMirrorContent: "assistant mirror text",
				maintenanceReason: "chat_send",
			}),
		).resolves.toBeUndefined();

		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "normalized user message",
			assistantResponse: "visible assistant response",
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
		expect(errorSpy).toHaveBeenCalledWith(
			"[SEND] Conversation summary refresh failed:",
			expect.any(Error),
		);

		errorSpy.mockRestore();
	});

	it("dispatches post-turn memory intake to judgeFinishedTurn with the finished turn", async () => {
		// The tier decision (explicit / marathon / idle), the gate check, the
		// dirty-ledger safety net and the D1/D2 watermark rules all live inside
		// judgeFinishedTurn now — those behaviours are asserted against real logic
		// in memory-judge/dispatch.test.ts. Here we only assert finalize hands the
		// judge the right turn and does not otherwise gate it.
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "My company is Acme Studio.",
			userMessageId: "user-message-1",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			assistantMessageId: "assistant-message-1",
			workCapsule: {
				workflowSummary: "Finished the brief.",
				taskSummary: "Brief update",
				artifact: { name: "brief.md" },
			},
			maintenanceReason: "chat_send",
		});

		expect(mockJudgeFinishedTurn).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "My company is Acme Studio.",
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
		});
		// The judge dispatch runs alongside — not instead of — the rest of the
		// post-turn work.
		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "My company is Acme Studio.",
			assistantResponse: "I will keep that in mind.",
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
	});

	it("threads null message ids and defers to the dispatch's mirror-content fallback", async () => {
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "Please remember that I prefer concise answers.",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			startedResetGeneration: 7,
		});

		// Missing user/assistant message ids are normalized to null before the
		// judge sees them (it derives the override sequence from real ids only).
		expect(mockJudgeFinishedTurn).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "Please remember that I prefer concise answers.",
			userMessageId: null,
			assistantMessageId: null,
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
		});
		expect(mockRefreshConversationSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				startedResetGeneration: 7,
			}),
		);
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
	});

	it("swallows a failing judge dispatch without rejecting post-turn completion", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mockJudgeFinishedTurn.mockRejectedValueOnce(new Error("judge offline"));
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await expect(
			runPostTurnTasks({
				turnKind: "send",
				userId: "user-1",
				conversationId: "conv-1",
				upstreamMessage: "upstream prompt payload",
				userMessage: "Please remember that I prefer concise answers.",
				userMessageId: "user-message-1",
				assistantResponse: "I will keep that in mind.",
				assistantMirrorContent: "assistant mirror text",
				assistantMessageId: "assistant-message-1",
				maintenanceReason: "chat_send",
			}),
		).resolves.toBeUndefined();

		expect(mockJudgeFinishedTurn).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"[MEMORY_JUDGE] Post-turn trigger failed:",
			expect.any(Error),
		);
		// The rest of the post-turn work still ran.
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
		errorSpy.mockRestore();
	});

	it("does not block post-turn completion on memory maintenance", async () => {
		let resolveMaintenance: ((value: undefined) => void) | undefined;
		const maintenancePromise = new Promise<undefined>((resolve) => {
			resolveMaintenance = resolve;
		});
		mockRunUserMemoryMaintenance.mockReturnValueOnce(maintenancePromise);
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		let completed = false;
		const postTurn = runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "Please remember that I prefer concise answers.",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		}).then(() => {
			completed = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(completed).toBe(true);
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);

		resolveMaintenance?.(undefined);
		await postTurn;
	});

	it("logs asynchronous memory maintenance failures after post-turn completion", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		let rejectMaintenance: ((error: Error) => void) | undefined;
		mockRunUserMemoryMaintenance.mockReturnValueOnce(
			new Promise<undefined>((_resolve, reject) => {
				rejectMaintenance = reject;
			}),
		);
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "Please remember that I prefer concise answers.",
			assistantResponse: "I will keep that in mind.",
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		});

		const error = new Error("maintenance failed");
		rejectMaintenance?.(error);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(errorSpy).toHaveBeenCalledWith(
			"[SEND] Post-turn memory maintenance failed:",
			error,
		);

		errorSpy.mockRestore();
	});

	// Fix 2 (coverage) — end-to-end finalize-steps → rail wiring. The existing
	// cases above all use short replies (< the 200-char skip threshold), so the
	// real rail-summary.ts returns before ever writing back — the rail path was
	// never actually exercised through the gate. This drives a ≥200-char reply
	// through the REAL runPostTurnTasks + rail-summary.ts (control model mocked,
	// per the reviewer's fragility note) and asserts the summary is generated
	// and persisted.
	it("generates and persists a rail summary for a ≥200-char reply through the real finalize-steps gate", async () => {
		mockGenerateShortLocalText.mockResolvedValue(
			"Q3 segment performance recap",
		);
		// Comfortably above RAIL_SUMMARY_MIN_CONTENT_LENGTH (200) so rail-summary
		// does NOT take its short-reply skip.
		const longReply = "S".repeat(250);
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "How did Q3 segments perform?",
			userMessageId: "user-message-1",
			assistantResponse: longReply,
			assistantMirrorContent: longReply,
			assistantMessageId: "assistant-message-1",
			maintenanceReason: "chat_send",
		});

		// The gate fired the rail task, rail-summary.ts saw a ≥200-char reply (no
		// skip), asked the mocked control model, and persisted the headline.
		expect(mockGenerateShortLocalText).toHaveBeenCalledTimes(1);
		expect(mockUpdateMessageRailSummary).toHaveBeenCalledWith(
			"assistant-message-1",
			"Q3 segment performance recap",
		);
	});

	// Fix 1 (data-loss race) — locks the ordering invariant at the tail level:
	// the rail-summary metadata write (an unsynchronized metadataJson RMW, same
	// as evidence/webCitationAudit) must not run until the evidence write has
	// committed. Here the evidence write is modeled by evidenceWriteBarrier; the
	// rail write is proven to land strictly after it releases.
	it("holds the rail-summary write until the evidence barrier resolves (Fix 1 ordering)", async () => {
		mockGenerateShortLocalText.mockResolvedValue("Ordered headline");
		const order: string[] = [];
		mockUpdateMessageRailSummary.mockImplementation(async () => {
			order.push("rail");
		});
		let releaseEvidence!: () => void;
		const evidenceWriteBarrier = new Promise<void>((resolve) => {
			releaseEvidence = () => {
				order.push("evidence");
				resolve();
			};
		});
		const longReply = "S".repeat(250);
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		const done = runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "upstream prompt payload",
			userMessage: "How did Q3 segments perform?",
			userMessageId: "user-message-1",
			assistantResponse: longReply,
			assistantMirrorContent: longReply,
			assistantMessageId: "assistant-message-1",
			maintenanceReason: "chat_send",
			evidenceWriteBarrier,
		});

		await flushMicrotasks();
		// The evidence write is still in flight — the rail write must not land.
		expect(mockUpdateMessageRailSummary).not.toHaveBeenCalled();

		releaseEvidence();
		await done;

		// Once evidence has committed, the rail write runs — observing it.
		expect(mockUpdateMessageRailSummary).toHaveBeenCalledWith(
			"assistant-message-1",
			"Ordered headline",
		);
		expect(order).toEqual(["evidence", "rail"]);
	});
});

describe("finalizeChatTurn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateMessage.mockReset();
		mockCreateMessage.mockImplementation(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user" ? "user message" : "assistant response",
				),
		);
		mockPersistUserTurnAttachments.mockReset();
		mockPersistUserTurnAttachments.mockResolvedValue(undefined);
		mockPersistAssistantTurnState.mockReset();
		mockPersistAssistantTurnState.mockResolvedValue({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {},
		});
		mockPersistAssistantEvidence.mockReset();
		mockPersistAssistantEvidence.mockResolvedValue(undefined);
		mockRunPostTurnTasks.mockReset();
		mockRunPostTurnTasks.mockResolvedValue(undefined);
		mockRecordAssistantTurnAnalytics.mockReset();
		mockRecordAssistantTurnAnalytics.mockResolvedValue(undefined);
	});

	it("invokes onDurableReceiptReady with message ids before the deferred projection resolves, then keeps running it in the background — no promise or task-starting function comes back to the caller", async () => {
		const deferredTurnState = createDeferred<{
			activeWorkingSet: [];
			taskState: null;
			contextDebug: null;
			workCapsule: undefined;
		}>();
		// Hold the assistant turn-state step open so the deferred projection
		// cannot progress until the test resolves it.
		mockPersistAssistantTurnState.mockReturnValueOnce(
			deferredTurnState.promise,
		);
		// buildChatTurnCompletionContextSources (kept real in finalize.ts) calls
		// getProjectReferenceContext, so that mock is the honest proxy for "the
		// deferred context-source projection ran".
		const mockGetProjectReferenceContext =
			getProjectReferenceContext as ReturnType<typeof vi.fn>;
		const { finalizeChatTurn } = await import("./finalize");

		let receipt:
			| { userMessage?: { id: string }; assistantMessage: { id: string } }
			| undefined;
		const completion = await finalizeChatTurn({
			turnKind: "stream",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "user message",
			persistUserMessage: true,
			normalizedMessage: "user message",
			upstreamMessage: "upstream message",
			assistantResponse: "assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: null,
			assistantMirrorContent: "assistant response",
			maintenanceReason: "chat_stream",
			// finalizeChatTurn invokes and awaits this itself — it never hands the
			// caller a promise or a task-starting function to schedule.
			onDurableReceiptReady: (r) => {
				receipt = r;
			},
		});

		// finalize's own returned promise settles once the receipt hook has run
		// and the (still-blocked) background projection has lost its race
		// against a single tick — see waitOneTick in finalize.ts.
		expect(receipt?.userMessage?.id).toBe("user-message");
		expect(receipt?.assistantMessage.id).toBe("assistant-message");
		expect(completion.userMessage?.id).toBe("user-message");
		expect(completion.assistantMessage?.id).toBe("assistant-message");
		expect(completion.turnState).toBeNull();
		expect(completion.contextSources.groups).toEqual([]);
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				userMessageId: "user-message",
				assistantMessageId: "assistant-message",
			}),
		);
		expect(mockGetProjectReferenceContext).not.toHaveBeenCalled();
		expect(mockRunPostTurnTasks).not.toHaveBeenCalled();

		deferredTurnState.resolve({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: undefined,
		});
		await flushMicrotasks();

		expect(mockGetProjectReferenceContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		);
		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-message",
			}),
		);
	});

	it("reconciles new generated outputs during turn completion", async () => {
		const assignGeneratedOutputJobs = vi.fn(async () => undefined);
		const syncGeneratedFilesToMemory = vi.fn(async () => undefined);
		const getGeneratedFilesForAssistantMessage = vi.fn(async () => [
			makeChatFile({
				id: "file-new",
				conversationId: "conv-1",
				assistantMessageId: "assistant-message",
				artifactId: "artifact-generated",
				filename: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 456,
				createdAt: 1_777_140_200,
			}),
		]);
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "Create a report",
			persistUserMessage: true,
			normalizedMessage: "Create a report",
			upstreamMessage: "Create a report",
			assistantResponse: "Done.",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 2,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "Done.",
			maintenanceReason: "chat_send",
			generatedOutputReconciliation: {
				fileProductionJobIdsAtStart: new Set(["job-existing"]),
				getFileProductionJobs: vi.fn(async () => [
					{ id: "job-existing", files: [{ id: "file-existing" }] },
					{ id: "job-new", files: [{ id: "file-new" }] },
				]),
				assignFileProductionJobsToAssistantMessage: assignGeneratedOutputJobs,
				syncGeneratedFilesToMemory,
				getChatFilesForAssistantMessage: getGeneratedFilesForAssistantMessage,
			},
		});

		expect(assignGeneratedOutputJobs).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"assistant-message",
			["job-new"],
		);
		expect(syncGeneratedFilesToMemory).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-message",
			fileIds: ["file-new"],
			assistantResponse: "Done.",
		});
		expect(completion.generatedFiles).toEqual([
			expect.objectContaining({
				id: "file-new",
				assistantMessageId: "assistant-message",
				filename: "report.pdf",
			}),
		]);
	});

	it("reconciles new pending writes during turn completion, stamping only the new ids", async () => {
		const assignPendingWrites = vi.fn(async () => undefined);
		const getPendingWrites = vi.fn(async () => [
			{ id: "pw-existing" },
			{ id: "pw-new" },
		]);
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "Save this to Nextcloud",
			persistUserMessage: true,
			normalizedMessage: "Save this to Nextcloud",
			upstreamMessage: "Save this to Nextcloud",
			assistantResponse: "Done.",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 2,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "Done.",
			maintenanceReason: "chat_send",
			generatedOutputReconciliation: {
				fileProductionJobIdsAtStart: new Set(),
				getFileProductionJobs: vi.fn(async () => []),
				getChatFilesForAssistantMessage: vi.fn(async () => []),
				pendingWriteIdsAtStart: new Set(["pw-existing"]),
				getPendingWrites,
				assignPendingWritesToAssistantMessage: assignPendingWrites,
			},
		});

		expect(assignPendingWrites).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"assistant-message",
			["pw-new"],
		);
	});

	it("skips pending-write reconciliation entirely when pendingWriteIdsAtStart is not provided (no-op, existing callers stay unaffected)", async () => {
		const getPendingWrites = vi.fn(async () => []);
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "hi",
			persistUserMessage: true,
			normalizedMessage: "hi",
			upstreamMessage: "hi",
			assistantResponse: "Done.",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 2,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "Done.",
			maintenanceReason: "chat_send",
			generatedOutputReconciliation: {
				fileProductionJobIdsAtStart: new Set(),
				getFileProductionJobs: vi.fn(async () => []),
				getChatFilesForAssistantMessage: vi.fn(async () => []),
				getPendingWrites,
			},
		});

		expect(getPendingWrites).not.toHaveBeenCalled();
	});

	it("persists completed control-only turns with empty visible assistant text", async () => {
		mockCreateMessage.mockImplementation(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> =>
				makeChatMessage(
					`${role}-message`,
					role,
					role === "user" ? "normalized user message" : "",
				),
		);
		const mockApplySkillControlOperations =
			applySkillControlOperations as ReturnType<typeof vi.fn>;
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "",
			assistantMetadata: {
				evidenceStatus: "pending",
				skillQuestion: true,
			},
			skillControlOperations: [
				{
					operationId: "control-only-question",
					kind: "session_transition",
					transition: "awaiting_user",
				} as never,
			],
			skillControlSessionId: "session-1",
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 0,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "",
			maintenanceReason: "chat_send",
		});

		expect(completion.assistantMessage).toEqual(
			expect.objectContaining({
				id: "assistant-message",
				role: "assistant",
				content: "",
			}),
		);
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"",
			undefined,
			undefined,
			expect.objectContaining({ skillQuestion: true }),
		);
		expect(mockApplySkillControlOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-message",
			operations: [
				expect.objectContaining({ operationId: "control-only-question" }),
			],
		});
		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "assistant-message",
				assistantResponse: "",
			}),
		);
	});

	it("includes streamId in skill control warnings when present", async () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const mockCommitSkillNoteOperations =
			commitSkillNoteOperationsAfterAssistantMessage as ReturnType<
				typeof vi.fn
			>;
		const mockApplySkillControlOperations =
			applySkillControlOperations as ReturnType<typeof vi.fn>;
		mockCommitSkillNoteOperations.mockRejectedValueOnce(
			new Error("notes offline"),
		);
		mockApplySkillControlOperations.mockRejectedValueOnce(
			new Error("sessions offline"),
		);
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "stream",
			streamId: "stream-1",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [{ operationId: "op-1" } as never],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_stream",
		});

		expect(warnSpy).toHaveBeenCalledWith(
			"[STREAM] Failed to apply Skill Note Operations",
			expect.objectContaining({
				streamId: "stream-1",
				conversationId: "conv-1",
			}),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			"[STREAM] Failed to apply Skill Control Envelope",
			expect.objectContaining({
				streamId: "stream-1",
				conversationId: "conv-1",
			}),
		);
		warnSpy.mockRestore();
	});

	it("creates the assistant message before attachment persistence in stream mode", async () => {
		const callOrder: string[] = [];
		mockCreateMessage.mockImplementation(
			async (
				_conversationId: string,
				role: "user" | "assistant",
			): Promise<ChatMessage> => {
				callOrder.push(`${role}:create`);
				return makeChatMessage(
					`${role}-message`,
					role,
					role === "user"
						? "normalized user message"
						: "visible assistant response",
				);
			},
		);
		mockPersistUserTurnAttachments.mockImplementation(async () => {
			callOrder.push("attachments:persist");
			return [];
		});
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "stream",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: ["att-1"],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_stream",
		});

		expect(callOrder).toEqual([
			"user:create",
			"assistant:create",
			"attachments:persist",
		]);
	});

	it("adds baseline Depth Metadata when persisting a completed assistant message", async () => {
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			reasoningDepth: "max",
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "provider:local:model-a",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"visible assistant response",
			undefined,
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
					modelId: "provider:local:model-a",
					modelDisplayName: "Model One",
				},
			}),
		);
	});

	it("persists resolved Auto Depth Metadata from preflight instead of rebuilding the baseline", async () => {
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Provider Model A",
				providerDisplayName: "Provider One",
			},
			reasoningDepth: "auto",
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "model1",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "provider:local:model-a",
				modelDisplayName: "Provider Model A",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		});

		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"visible assistant response",
			undefined,
			undefined,
			expect.objectContaining({
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
					modelId: "provider:local:model-a",
					modelDisplayName: "Provider Model A",
					providerDisplayName: "Provider One",
				},
			}),
		);
	});

	it("swallows attachment persistence failures in stream mode instead of failing the turn", async () => {
		mockPersistUserTurnAttachments.mockImplementation(async () => {
			throw new Error("attachment offline");
		});
		const { finalizeChatTurn } = await import("./finalize");

		// finalize no longer hands back a pending attachmentTask for the caller
		// to await — attachment persistence is scheduled and swallowed entirely
		// inside finalize's own background projection. The turn as a whole must
		// still resolve cleanly despite the attachment failure.
		await expect(
			finalizeChatTurn({
				turnKind: "stream",
				userId: "user-1",
				conversationId: "conv-1",
				userMessageContent: "normalized user message",
				persistUserMessage: true,
				normalizedMessage: "normalized user message",
				upstreamMessage: "upstream prompt payload",
				assistantResponse: "visible assistant response",
				assistantMetadata: { evidenceStatus: "pending" },
				skillControlOperations: [],
				skillControlSessionId: null,
				attachmentIds: ["att-1"],
				activeDocumentArtifactId: null,
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				analytics: {
					model: "model-1",
					modelDisplayName: "Model One",
					promptTokens: 8,
					completionTokens: 5,
					generationTimeMs: undefined,
					providerUsage: null,
				},
				assistantMirrorContent: "assistant mirror text",
				maintenanceReason: "chat_stream",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				assistantMessage: expect.objectContaining({ id: "assistant-message" }),
			}),
		);
		await flushMicrotasks();

		expect(mockPersistUserTurnAttachments).toHaveBeenCalled();
	});

	it("returns the durable completion result while the follow-up work runs in the background", async () => {
		const evidenceDeferred = (() => {
			let resolve!: () => void;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		})();
		const mockBuildAssistantEvidenceSummary =
			buildAssistantEvidenceSummary as ReturnType<typeof vi.fn>;
		mockBuildAssistantEvidenceSummary.mockImplementationOnce(
			async () => evidenceDeferred.promise,
		);
		const { finalizeChatTurn } = await import("./finalize");

		const postTurnDeferred = (() => {
			let resolve!: () => void;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		})();
		mockPersistAssistantEvidence.mockImplementationOnce(
			async () => evidenceDeferred.promise,
		);
		mockRunPostTurnTasks.mockImplementationOnce(
			async () => postTurnDeferred.promise,
		);
		const completion = await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		});

		expect(completion.userMessage).toEqual(
			expect.objectContaining({ id: "user-message" }),
		);
		expect(completion.assistantMessage).toEqual(
			expect.objectContaining({ id: "assistant-message" }),
		);
		expect(mockRunUserMemoryMaintenance).not.toHaveBeenCalled();

		// A send turn's tail (memory judge / summary / maintenance) is started by
		// finalize itself, in the background, right after the eager projection
		// resolves — the caller gets the durable receipt above and nothing to
		// separately schedule. waitForEvidenceBeforePostTurnTasks now derives to
		// false for every send turn, so runPostTurnTasks fires without waiting
		// for the still-pending evidence write.
		expect(mockPersistAssistantEvidence).toHaveBeenCalledTimes(1);
		expect(mockRunPostTurnTasks).toHaveBeenCalledTimes(1);
		evidenceDeferred.resolve();
		postTurnDeferred.resolve();
		await flushMicrotasks();
	});

	// Fix 1 (data-loss race) — finalize must hand the tail the SAME in-flight
	// evidence-write promise it created, so the rail-summary step can await the
	// real evidence write (not a copy) before its own metadataJson RMW. This is
	// the send-path wiring that keeps the rail write from clobbering evidence on
	// the concurrent path.
	it("threads the in-flight evidence write to runPostTurnTasks as the rail-summary barrier", async () => {
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: { evidenceStatus: "pending" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
		});

		expect(mockRunPostTurnTasks).toHaveBeenCalledTimes(1);
		const [runArgs] = mockRunPostTurnTasks.mock.calls[0] as [
			{ evidenceWriteBarrier?: Promise<unknown> },
		];
		// The barrier is exactly the evidence task finalize created from
		// persistAssistantEvidence — same promise handle, not a re-wrap.
		expect(runArgs.evidenceWriteBarrier).toBe(
			mockPersistAssistantEvidence.mock.results[0]?.value,
		);
	});

	it("forwards Atlas-style skip options through finalization without disabling other completion work", async () => {
		mockPersistAssistantTurnState.mockResolvedValue({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: {
				taskSummary: "Atlas task",
				workflowSummary: "Atlas workflow",
				artifact: { name: "Atlas report" },
			},
		});
		const { finalizeChatTurn } = await import("./finalize");

		await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "atlas request",
			persistUserMessage: true,
			normalizedMessage: "atlas request",
			upstreamMessage: "atlas request",
			assistantResponse: "atlas queued",
			assistantMetadata: { evidenceStatus: "not_applicable" },
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: null,
			assistantMirrorContent: "atlas queued",
			maintenanceReason: "chat_send",
			skipAssistantProseMemoryIntake: true,
		});
		// finalize starts the tail (which threads skipAssistantProseMemoryIntake
		// through to runPostTurnTasks) itself; nothing is returned for the
		// caller to trigger.
		await flushMicrotasks();

		expect(mockPersistAssistantTurnState).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: "atlas queued",
			}),
		);
		expect(mockRunPostTurnTasks).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantResponse: "atlas queued",
				skipAssistantProseMemoryIntake: true,
			}),
		);
	});

	it("skips assistant-prose memory intake while preserving summary refresh and maintenance", async () => {
		const { runPostTurnTasks } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await runPostTurnTasks({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			upstreamMessage: "atlas request",
			userMessage: "atlas request",
			userMessageId: "user-message",
			assistantResponse: "atlas queued",
			assistantMirrorContent: "atlas queued",
			assistantMessageId: "assistant-message",
			workCapsule: {
				taskSummary: "Atlas task",
				workflowSummary: "Atlas workflow",
				artifact: { name: "Atlas report" },
			},
			maintenanceReason: "chat_send",
			startedResetGeneration: 0,
			skipAssistantProseMemoryIntake: true,
		});

		expect(mockJudgeFinishedTurn).not.toHaveBeenCalled();
		expect(mockRefreshConversationSummary).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			userMessage: "atlas request",
			assistantResponse: "atlas queued",
			startedResetGeneration: 0,
		});
		expect(mockRunUserMemoryMaintenance).toHaveBeenCalledWith(
			"user-1",
			"chat_send",
		);
	});

	it("returns context sources assembled by the completion boundary", async () => {
		const mockGetProjectReferenceContext =
			getProjectReferenceContext as ReturnType<typeof vi.fn>;
		mockGetProjectReferenceContext.mockResolvedValueOnce({
			source: "project_folder",
			projectId: "folder-1",
			projectName: "Launch folder",
			entries: [
				{
					conversationId: "conv-sibling-1",
					title: "Pricing notes",
					objective: null,
					summary: "Stable pricing brief.",
				},
			],
			omittedSiblingCount: 0,
		});
		mockPersistAssistantTurnState.mockResolvedValue({
			activeWorkingSet: [
				{
					id: "working-1",
					type: "generated_output",
					name: "Working output",
					mimeType: null,
					sizeBytes: null,
					conversationId: "conv-1",
					summary: null,
					createdAt: 0,
					updatedAt: 0,
				},
			],
			taskState: null,
			contextDebug: null,
			workCapsule: {} as unknown as undefined,
		});
		const { finalizeChatTurn } = await import("./finalize");

		const completion = await finalizeChatTurn({
			turnKind: "send",
			userId: "user-1",
			conversationId: "conv-1",
			userMessageContent: "normalized user message",
			persistUserMessage: true,
			normalizedMessage: "normalized user message",
			upstreamMessage: "upstream prompt payload",
			assistantResponse: "visible assistant response",
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: "Model One",
			},
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: [],
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "model-1",
				modelDisplayName: "Model One",
				promptTokens: 8,
				completionTokens: 5,
				generationTimeMs: undefined,
				providerUsage: null,
			},
			assistantMirrorContent: "assistant mirror text",
			maintenanceReason: "chat_send",
			linkedSources: [
				{
					displayArtifactId: "display-1",
					promptArtifactId: "prompt-1",
					familyArtifactIds: [],
					name: "Linked source.pdf",
					type: "document",
					documentOrigin: "uploaded",
				},
			],
		});

		expect(completion.contextSources.groups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "linked_source",
					items: [
						expect.objectContaining({
							artifactId: "display-1",
							title: "Linked source.pdf",
						}),
					],
				}),
				expect.objectContaining({
					kind: "working_set",
					items: [
						expect.objectContaining({
							artifactId: "working-1",
							title: "Working output",
						}),
					],
				}),
				expect.objectContaining({
					kind: "project_folder",
					items: [
						expect.objectContaining({
							title: "Launch folder",
						}),
					],
				}),
			]),
		);
	});

	it("records document refinement correction from Working Document Selection", async () => {
		const mockGetArtifactsForUser = getArtifactsForUser as ReturnType<
			typeof vi.fn
		>;
		const mockRecordMemoryEvent = recordMemoryBehaviorEvent as ReturnType<
			typeof vi.fn
		>;
		const mockResolveSelection = resolveWorkingDocumentSelection as ReturnType<
			typeof vi.fn
		>;
		mockGetArtifactsForUser.mockResolvedValueOnce([
			{
				id: "brief-v1",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v1.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1,
				updatedAt: 1,
				extension: "pdf",
				storagePath: null,
				contentText: null,
				metadata: {
					documentFamilyId: "family-brief",
					documentLabel: "Project brief",
				},
			},
		]);
		mockResolveSelection.mockReturnValueOnce({
			documentFocused: true,
			currentDocument: {
				artifactId: "brief-v1",
				familyId: "family-brief",
				reasonCodes: ["recent_user_correction"],
				source: "active_focus",
			},
			latestGeneratedDocumentIds: [],
			activeFocus: { artifactIds: ["brief-v1"] },
			correction: { hasSignal: true, targetArtifactIds: ["brief-v1"] },
			recentRefinement: { familyId: null, artifactIds: [] },
			reset: { hasSignal: false, suppressCarryover: false },
			currentTurnReasonCodesByArtifactId: new Map([
				["brief-v1", ["recent_user_correction"]],
			]),
			prompt: {
				reasonCodesByArtifactId: new Map([
					["brief-v1", ["recent_user_correction"]],
				]),
			},
			workingSet: {
				candidateArtifactIds: ["brief-v1"],
				candidateSignalsByArtifactId: new Map(),
			},
			retrieval: {
				preferredArtifactId: "brief-v1",
				preferredGeneratedFamilyId: null,
				suppressGeneratedCarryover: false,
				hasExplicitResetSignal: false,
			},
			taskEvidence: {
				protectedArtifactIds: ["brief-v1"],
				workingDocumentProtectedArtifactIds: ["brief-v1"],
			},
		});
		const { persistAssistantTurnState } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await persistAssistantTurnState({
			userId: "user-1",
			conversationId: "conv-1",
			normalizedMessage: "Please use the alternate tone.",
			assistantResponse: "Updated brief.",
			attachmentIds: [],
			activeDocumentArtifactId: "brief-v1",
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
			analytics: null,
		});

		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "document_refined",
				payload: expect.objectContaining({
					explicitCorrection: true,
				}),
			}),
		);
	});

	it("does not record document refinement when Working Document Selection ignores a stale active document", async () => {
		const mockGetArtifactsForUser = getArtifactsForUser as ReturnType<
			typeof vi.fn
		>;
		const mockRecordMemoryEvent = recordMemoryBehaviorEvent as ReturnType<
			typeof vi.fn
		>;
		mockGetArtifactsForUser.mockResolvedValueOnce([
			{
				id: "brief-v1",
				userId: "user-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "brief-v1.pdf",
				mimeType: "application/pdf",
				sizeBytes: 100,
				conversationId: "conv-1",
				summary: null,
				createdAt: 1,
				updatedAt: 1,
				extension: "pdf",
				storagePath: null,
				contentText: null,
				metadata: {
					documentFamilyId: "family-brief",
					documentLabel: "Project brief",
				},
			},
		]);
		const { persistAssistantTurnState } =
			await vi.importActual<typeof import("./finalize-steps")>(
				"./finalize-steps",
			);

		await persistAssistantTurnState({
			userId: "user-1",
			conversationId: "conv-1",
			normalizedMessage: "What is the capital of France?",
			assistantResponse: "Paris.",
			attachmentIds: [],
			activeDocumentArtifactId: "brief-v1",
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			userMessageId: "user-message-1",
			assistantMessageId: "assistant-message-1",
			analytics: null,
		});

		expect(mockRecordMemoryEvent).not.toHaveBeenCalled();
	});

	// M1 — server stream-timeline marks (firstByteMs/firstThinkingMs/
	// firstTokenMs) persisted to messageAnalytics. See ADR-0042's amendment.
	describe("stream-timeline marks analytics (M1)", () => {
		beforeEach(() => {
			mockIsConversationIncognito.mockResolvedValue(false);
		});

		it("threads firstByteMs/firstThinkingMs/firstTokenMs through persistAssistantTurnState into recordMessageAnalytics", async () => {
			const mockRecordMessageAnalytics = recordMessageAnalytics as ReturnType<
				typeof vi.fn
			>;
			const { persistAssistantTurnState } =
				await vi.importActual<typeof import("./finalize-steps")>(
					"./finalize-steps",
				);

			await persistAssistantTurnState({
				userId: "user-1",
				conversationId: "conv-1",
				normalizedMessage: "What is the capital of France?",
				assistantResponse: "Paris.",
				attachmentIds: [],
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				userMessageId: "user-message-1",
				assistantMessageId: "assistant-message-1",
				analytics: {
					model: "model-1",
					firstByteMs: 42,
					firstThinkingMs: 44,
					firstTokenMs: 55,
				},
			});

			expect(mockRecordMessageAnalytics).toHaveBeenCalledWith(
				expect.objectContaining({
					messageId: "assistant-message-1",
					firstByteMs: 42,
					firstThinkingMs: 44,
					firstTokenMs: 55,
				}),
			);
		});

		it("records only the marks a turn reached via recordAssistantTurnAnalytics when turn-state persistence is skipped (e.g. a stopped stream), without invoking the full turn-state projection", async () => {
			const { finalizeChatTurn } = await import("./finalize");

			await finalizeChatTurn({
				turnKind: "stream",
				userId: "user-1",
				conversationId: "conv-1",
				userMessageContent: "user message",
				persistUserMessage: true,
				normalizedMessage: "user message",
				upstreamMessage: "upstream message",
				assistantResponse: "partial answer",
				assistantMetadata: { wasStopped: true },
				skillControlOperations: [],
				skillControlSessionId: null,
				attachmentIds: [],
				activeDocumentArtifactId: null,
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				analytics: {
					model: "model-1",
					firstByteMs: 40,
					firstThinkingMs: 61,
					// firstTokenMs never reached — stopped before any visible token.
				},
				assistantMirrorContent: "",
				maintenanceReason: "chat_stream",
				// Mirrors stream-completion.ts's `persistTurnState: !wasStopped`.
				persistTurnState: false,
			});

			expect(mockRecordAssistantTurnAnalytics).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					conversationId: "conv-1",
					assistantMessageId: "assistant-message",
					analytics: expect.objectContaining({
						firstByteMs: 40,
						firstThinkingMs: 61,
					}),
				}),
			);
			// The heavier turn-state projection (working set, task-state
			// checkpoint, document refinement, ...) is NOT resurrected just to
			// carry the timing marks — a stopped turn still skips it.
			expect(mockPersistAssistantTurnState).not.toHaveBeenCalled();
		});

		it("ADR-0042 invariant: a throwing analytics sink does not fail persistAssistantTurnState or the turn's other post-turn work", async () => {
			const mockRecordMessageAnalytics = recordMessageAnalytics as ReturnType<
				typeof vi.fn
			>;
			mockRecordMessageAnalytics.mockRejectedValueOnce(
				new Error("analytics sink unavailable"),
			);
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			const { persistAssistantTurnState } =
				await vi.importActual<typeof import("./finalize-steps")>(
					"./finalize-steps",
				);

			// Malformed marks (NaN/negative) alongside a throwing sink — neither
			// should surface as a rejection here.
			await expect(
				persistAssistantTurnState({
					userId: "user-1",
					conversationId: "conv-1",
					normalizedMessage: "What is the capital of France?",
					assistantResponse: "Paris.",
					attachmentIds: [],
					contextStatus: null,
					initialTaskState: null,
					initialContextDebug: null,
					userMessageId: "user-message-1",
					assistantMessageId: "assistant-message-1",
					analytics: {
						model: "model-1",
						firstByteMs: Number.NaN,
						firstThinkingMs: -5,
						firstTokenMs: 55,
					},
				}),
			).resolves.toBeDefined();

			expect(mockRecordMessageAnalytics).toHaveBeenCalled();
			errorSpy.mockRestore();
		});
	});

	describe("incognito telemetry suppression", () => {
		beforeEach(() => {
			mockIsConversationIncognito.mockResolvedValue(false);
		});

		it("persistAssistantTurnState records usage/cost analytics for a normal (non-incognito) turn", async () => {
			mockIsConversationIncognito.mockResolvedValueOnce(false);
			const mockRecordMessageAnalytics = recordMessageAnalytics as ReturnType<
				typeof vi.fn
			>;
			const { persistAssistantTurnState } =
				await vi.importActual<typeof import("./finalize-steps")>(
					"./finalize-steps",
				);

			await persistAssistantTurnState({
				userId: "user-1",
				conversationId: "conv-1",
				normalizedMessage: "What is the capital of France?",
				assistantResponse: "Paris.",
				attachmentIds: [],
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				userMessageId: "user-message-1",
				assistantMessageId: "assistant-message-1",
				analytics: {
					model: "model-1",
					modelDisplayName: "Model One",
					promptTokens: 10,
					completionTokens: 5,
				},
			});

			expect(mockIsConversationIncognito).toHaveBeenCalledWith("conv-1");
			expect(mockRecordMessageAnalytics).toHaveBeenCalledWith(
				expect.objectContaining({
					messageId: "assistant-message-1",
					conversationId: "conv-1",
					userId: "user-1",
					model: "model-1",
				}),
			);
		});

		it("persistAssistantTurnState skips usage/cost analytics for an incognito turn", async () => {
			mockIsConversationIncognito.mockResolvedValueOnce(true);
			const mockRecordMessageAnalytics = recordMessageAnalytics as ReturnType<
				typeof vi.fn
			>;
			const { persistAssistantTurnState } =
				await vi.importActual<typeof import("./finalize-steps")>(
					"./finalize-steps",
				);

			await persistAssistantTurnState({
				userId: "user-1",
				conversationId: "conv-secret",
				normalizedMessage: "What is the capital of France?",
				assistantResponse: "Paris.",
				attachmentIds: [],
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				userMessageId: "user-message-1",
				assistantMessageId: "assistant-message-1",
				analytics: {
					model: "model-1",
					modelDisplayName: "Model One",
					promptTokens: 10,
					completionTokens: 5,
				},
			});

			expect(mockIsConversationIncognito).toHaveBeenCalledWith("conv-secret");
			expect(mockRecordMessageAnalytics).not.toHaveBeenCalled();
		});

		it("finalizeChatTurn still persists the assistant message and writes no usage row for an incognito turn", async () => {
			mockIsConversationIncognito.mockResolvedValue(true);
			const mockRecordMessageAnalytics = recordMessageAnalytics as ReturnType<
				typeof vi.fn
			>;
			const { finalizeChatTurn } = await import("./finalize");

			const completion = await finalizeChatTurn({
				turnKind: "send",
				userId: "user-1",
				conversationId: "conv-secret",
				userMessageContent: "user message",
				persistUserMessage: true,
				normalizedMessage: "user message",
				upstreamMessage: "upstream message",
				assistantResponse: "assistant response",
				assistantMetadata: {},
				skillControlOperations: [],
				skillControlSessionId: null,
				attachmentIds: [],
				activeDocumentArtifactId: null,
				contextStatus: null,
				initialTaskState: null,
				initialContextDebug: null,
				analytics: {
					model: "model-1",
					modelDisplayName: "Model One",
					promptTokens: 10,
					completionTokens: 5,
				},
				assistantMirrorContent: "assistant response",
				maintenanceReason: "chat_send",
			});

			// The conversation and its messages stay saved (incognito is
			// saved-but-untracked, not hidden).
			expect(mockCreateMessage).toHaveBeenCalledWith(
				"conv-secret",
				"assistant",
				"assistant response",
				undefined,
				undefined,
				expect.anything(),
			);
			expect(completion.assistantMessage?.id).toBe("assistant-message");
			// No usage/cost analytics row is written for this turn.
			expect(mockRecordMessageAnalytics).not.toHaveBeenCalled();
		});
	});
});
