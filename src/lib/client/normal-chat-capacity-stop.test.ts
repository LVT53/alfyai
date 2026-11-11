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

describe("review C: Stop during a fresh send's capacity backoff", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("starts no new generation after Stop released the composer", async () => {
		const h = harness();
		await h.runtime.send(aSend("A"));
		expect(h.invocations).toHaveLength(1);
		// Admission refusal: the server is full. The runtime keeps the placeholder
		// "preparing" and schedules startStream again in 500 ms.
		h.invocations[0].callbacks.onError(
			Object.assign(new Error("Server at capacity"), {
				status: 503,
				code: "CAPACITY_EXCEEDED",
				reason: "global_limit",
			}),
		);
		// The person sees Stop and presses it.
		expect(h.runtime.snapshot().canStop).toBe(true);
		expect(h.runtime.stop()).toBe(true);
		expect(h.runtime.snapshot()).toMatchObject({
			isSending: false,
			canStop: false,
		});
		const stoppedRow = h.state.messages.at(-1);
		expect(stoppedRow?.wasStopped).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// The private observer (reconnect only) is allowed.
		const observers = () =>
			h.invocations.filter((i) => i.options?.reconnectToStreamId);
		const freshSends = () =>
			h.invocations.filter((i) => !i.options?.reconnectToStreamId);
		expect(observers()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(600);
		const zombie = freshSends()[1];
		if (zombie) {
			zombie.callbacks.onToken("zombie words");
			await vi.advanceTimersByTimeAsync(50);
		}
		// Stop "never ... starts a generation": exactly the one fresh POST that was refused.
		expect(freshSends()).toHaveLength(1);
	});
});
