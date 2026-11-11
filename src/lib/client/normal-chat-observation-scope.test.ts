// Review-C scaffolding: the real runtime, deferred stream adapters and the real
// page message-list helpers (finalize/output/remove) so effects are visible rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import {
	createNormalChatClientTurnRuntime,
	type NormalChatClientTurnRuntimeAdapters,
	type NormalChatMessageListEvent,
} from "$lib/client/normal-chat-client-turn-runtime";
import { applyNormalChatOutputView } from "$lib/client/normal-chat-output-view";
import type { ServerUpdateKind } from "$lib/client/server-update-watch";
import type { ModelId } from "$lib/model-types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type {
	StreamCallbacks,
	StreamChatOptions,
	StreamHandle,
} from "$lib/services/streaming";
import {
	finalizeStreamingMessageList,
	removeMessageById,
} from "../../routes/(app)/chat/[conversationId]/_helpers";

type Invocation = {
	message: string;
	conversationId: string;
	callbacks: StreamCallbacks;
	options?: StreamChatOptions;
	handle: StreamHandle & {
		stop: ReturnType<typeof vi.fn>;
		detach: ReturnType<typeof vi.fn>;
	};
};

function harness(overrides: Partial<NormalChatClientTurnRuntimeAdapters> = {}) {
	const state = {
		messages: [] as ChatMessage[],
		conversationId: "conv-1",
		errors: [] as (string | null)[],
	};
	const invocations: Invocation[] = [];
	let id = 0;
	let streamSeq = 0;
	const apply = (event: NormalChatMessageListEvent) => {
		const m = state.messages;
		switch (event.type) {
			case "appendUser":
				state.messages = [...m, event.message];
				return;
			case "appendAssistantPlaceholder":
				state.messages = [...m, event.placeholder];
				return;
			case "applyNormalChatOutput":
				state.messages = applyNormalChatOutputView(
					m,
					event.placeholderId,
					event.view,
				);
				return;
			case "appendToken":
				state.messages = m.map((row) =>
					row.id === event.placeholderId
						? { ...row, content: row.content + event.chunk }
						: row,
				);
				return;
			case "setRuntimePhase":
				state.messages = m.map((row) =>
					row.id === event.placeholderId
						? { ...row, runtimePhase: event.phase }
						: row,
				);
				return;
			case "remove":
				state.messages = removeMessageById(m, event.messageId);
				return;
			case "finalize":
				state.messages = finalizeStreamingMessageList(m, {
					placeholderId: event.placeholderId,
					canonicalMessage: event.canonicalMessage,
					clientUserMessageId: event.clientUserMessageId,
					metadata: event.metadata,
				});
				return;
			default:
				return;
		}
	};
	const applyMessageListEvent = vi.fn(apply);
	const adapters: NormalChatClientTurnRuntimeAdapters = {
		streamChat: vi.fn((message, conversationId, callbacks, options) => {
			const handle = {
				streamId: options?.reconnectToStreamId ?? `stream-${++streamSeq}`,
				stop: vi.fn(),
				detach: vi.fn(),
			};
			invocations.push({ message, conversationId, callbacks, options, handle });
			return handle;
		}),
		checkForOrphanedStream: vi.fn(async () => null),
		getStreamBufferInfo: vi.fn(async () => null),
		submitAtlasTurn: vi.fn(async () => {
			throw new Error("no atlas in review harness");
		}),
		getConversationId: () => state.conversationId,
		getSelectedModel: () => "model1" as ModelId,
		getReasoningDepth: () => "thorough",
		getPersonalityProfileId: () => null,
		getActiveDocumentArtifactId: () => undefined,
		getMessages: () => state.messages,
		isReadOnly: () => false,
		isEditResendPending: () => false,
		isEditOpen: () => false,
		isBrowserHidden: () => false,
		randomId: () => `id-${++id}`,
		schedule: (cb, ms) => setTimeout(cb, ms),
		setConversationModelSelection: vi.fn(),
		clearDraft: vi.fn(),
		clearAttachedArtifacts: () => [],
		recordConversationActivity: vi.fn(),
		applyMessageListEvent,
		applyStreamMetadata: vi.fn(),
		attachFileProductionJobsToAssistantMessage: vi.fn(),
		refreshPendingWrites: vi.fn(),
		pollMessageEvidence: vi.fn(),
		refreshMessageCost: vi.fn(),
		hydrateConversationDetail: vi.fn(),
		pollForCompletion: vi.fn(),
		loadPersistedData: vi.fn(),
		readChatMessages: vi.fn(async () => null),
		fetchServerHealth: vi.fn(
			async (): Promise<ServerHealth> => ({ state: "up" }),
		),
		isNewVersionLive: () => false,
		askServerUpdate: vi.fn(async (): Promise<ServerUpdateKind> => "none"),
		maybeTriggerTitleGeneration: vi.fn(),
		runManualContextCompression: vi.fn(async () => undefined),
		restorePayloadToDraft: vi.fn(),
		markPendingSkillUnavailable: (p) => p,
		isPendingSkillUnavailableError: () => false,
		isForkedSourceHistoryConfirmationRequired: () => false,
		toFriendlySendError: (e) => e.message,
		setSendError: vi.fn((message: string | null) => {
			state.errors.push(message);
		}),
		onBackgroundInterrupted: vi.fn(),
		...overrides,
	};
	const runtime = createNormalChatClientTurnRuntime(adapters);
	return { adapters, runtime, invocations, state };
}

const aSend = (message: string) => ({
	message,
	attachmentIds: [],
	attachments: [],
	pendingAttachments: [],
});

const completion = {
	version: 1,
	turnId: "t-1",
	segmentId: "s-1",
	phase: "working",
	outcome: "answered",
	stopCause: "natural_stop",
	workingStopCause: "natural_stop",
	closingAttempted: false,
} as const;

describe("review C: an observation the reader cannot scope", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	async function reconnected() {
		const h = harness({
			checkForOrphanedStream: vi.fn(async () => "orig-stream"),
			getStreamBufferInfo: vi.fn(async () => ({ userMessage: "A" }) as never),
		});
		h.runtime.queue(aSend("queued B"));
		await h.runtime.checkForOrphanedStreamOnMount();
		expect(h.invocations).toHaveLength(1);
		expect(h.invocations[0].options?.reconnectToStreamId).toBe("orig-stream");
		expect(h.runtime.snapshot().isSending).toBe(true);
		h.runtime.queue(aSend("queued B"));
		expect(h.runtime.snapshot().queuedTurn?.message).toBe("queued B");
		return h;
	}

	it.each([
		[
			"terminal for another stream",
			{
				version: 1,
				state: "terminal",
				streamId: "someone-else",
				conversationId: "conv-1",
				assistantMessageId: "saved-1",
				completion,
			},
		],
		[
			"terminal for another chat",
			{
				version: 1,
				state: "terminal",
				streamId: "orig-stream",
				conversationId: "conv-2",
				assistantMessageId: "saved-1",
				completion,
			},
		],
		[
			"pending delivered as an end",
			{
				version: 1,
				state: "pending",
				streamId: "orig-stream",
				conversationId: "conv-1",
				turnId: "t-1",
				segmentId: "s-1",
			},
		],
	] as const)("%s: ends the turn explicitly instead of leaving it sending for ever", async (_label, observation) => {
		const h = await reconnected();
		h.invocations[0].callbacks.onFinishPart?.({ type: "finish" } as never);
		h.invocations[0].callbacks.onEnd("", { observation: observation as never });
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		const snap = h.runtime.snapshot();
		// Either settled (sending released) or an explicit unavailable error: never silence.
		expect(snap.isSending).toBe(false);
		expect(h.state.errors.at(-1)).toBe("chat.observationUnavailable");
		expect(h.invocations).toHaveLength(1);
		expect(h.adapters.restorePayloadToDraft).toHaveBeenCalledWith(
			expect.objectContaining({ message: "queued B" }),
		);
	});
});
