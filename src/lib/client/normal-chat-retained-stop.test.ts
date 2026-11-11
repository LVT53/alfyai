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

describe("review C: a Stop whose reader never reports and whose observation fails", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("allows independent navigation and historical regenerate while the uncertain stopped row stays protected", async () => {
		let answerUpdate: (kind: "none") => void = () => {};
		const h = harness({
			askServerUpdate: vi.fn(
				() =>
					new Promise<ServerUpdateKind>((resolve) => {
						answerUpdate = resolve;
					}),
			),
		});
		// An older, server-saved exchange is on screen (no renderKey: loaded from the server).
		h.state.messages.push(
			{ id: "u-0", role: "user", content: "earlier", timestamp: 1 },
			{ id: "a-0", role: "assistant", content: "earlier answer", timestamp: 2 },
		);
		await h.runtime.send(aSend("A"));
		// The connection dies before any text: the runtime asks whether an update cut it.
		h.invocations[0].callbacks.onError(new TypeError("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(0);
		expect(h.runtime.snapshot().canStop).toBe(true);
		expect(h.runtime.stop()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const observer = h.invocations[1];
		expect(observer.options?.reconnectToStreamId).toBe("stream-1");
		// The private read-only observer cannot reach the server either.
		observer.callbacks.onError(new TypeError("Failed to fetch"));
		await vi.advanceTimersByTimeAsync(0);
		answerUpdate("none");
		await vi.advanceTimersByTimeAsync(60_000);
		const nav1 = await h.runtime.settleStoppedAction({ purpose: "navigate" });
		if (nav1.status === "ready") nav1.release();
		const regenStopped = await h.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "id-2",
		});
		const regenHistorical = await h.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "a-0",
		});
		if (regenHistorical.status === "ready") regenHistorical.release();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		const nav2 = await h.runtime.settleStoppedAction({ purpose: "navigate" });
		if (nav2.status === "ready") nav2.release();
		const regenHistorical2 = await h.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "a-0",
		});
		if (regenHistorical2.status === "ready") regenHistorical2.release();
		// A newer turn also permits the independent historical target.
		await h.runtime.send(aSend("B"));
		h.invocations.at(-1)?.callbacks.onEnd("ok", { assistantMessageId: "a-B" });
		const regenAfterNewTurn = await h.runtime.settleStoppedAction({
			purpose: "regenerate",
			messageId: "a-0",
		});
		// The spec allows an immediate permit for an already durable historical row
		// with no *relevant* unresolved stopped fact.
		expect(regenHistorical.status).toBe("ready");
		expect(nav1.status).toBe("ready");
		expect(nav2.status).toBe("ready");
		expect(regenHistorical2.status).toBe("ready");
		expect(regenStopped.status).toBe("unavailable");
		expect(regenAfterNewTurn.status).toBe("ready");
	});
});
