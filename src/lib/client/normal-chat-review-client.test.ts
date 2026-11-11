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

import { createNormalChatOutputAccumulator } from "$lib/shared/normal-chat-output";

describe("pending-stop regression", () => {
	describe("review C: Stop while a pending observation's re-read is out", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("takes the aborted re-read's end as the reader receipt", async () => {
			const h = harness({
				checkForOrphanedStream: vi.fn(async () => "orig"),
				getStreamBufferInfo: vi.fn(async () => ({ userMessage: "A" }) as never),
			});
			await h.runtime.checkForOrphanedStreamOnMount();
			const first = h.invocations[0];
			first.callbacks.onWaiting?.({
				version: 1,
				state: "pending",
				streamId: "orig",
				conversationId: "conv-1",
				turnId: "t",
				segmentId: "s",
			});
			await vi.advanceTimersByTimeAsync(2000);
			expect(h.invocations).toHaveLength(2);
			const reread = h.invocations[1];
			expect(reread.options?.reconnectToStreamId).toBe("orig");
			expect(h.runtime.snapshot().canStop).toBe(true);
			expect(h.runtime.stop()).toBe(true);
			expect(reread.handle.stop).toHaveBeenCalledOnce();
			// The aborted transport reports its end, as streaming.ts does on abort.
			reread.callbacks.onEnd("", { wasStopped: true });
			const settled = h.runtime.settleStoppedAction({ purpose: "navigate" });
			let status = "pending";
			void settled.then((r) => {
				status = r.status;
			});
			await vi.advanceTimersByTimeAsync(1);
			console.log(
				"navigate right after the re-read's abort receipt:",
				status,
				"observers:",
				h.invocations.length - 2,
			);
			expect(status).toBe("ready");
			// The private observer meets an unreachable server.
			h.invocations[2]?.callbacks.onError(new TypeError("Failed to fetch"));
			await vi.advanceTimersByTimeAsync(10_000);
			console.log("navigate after the observation ends unavailable:", status);
			expect(status).toBe("ready");
		});
	});
});

describe("noop-stop regression", () => {
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
	const scope = {
		version: 1,
		turnId: "t-1",
		segmentId: "s-1",
		attemptId: "a",
		stepId: "w",
		phase: "working",
	} as const;
	const saved: ChatMessage = {
		id: "S",
		role: "assistant",
		content: "the answer",
		timestamp: 3,
		normalChatOutput: {
			version: 1,
			events: [
				{
					...scope,
					sequence: 1,
					type: "block_start",
					blockId: "b",
					nativeId: "b",
					kind: "text",
					role: "answer",
				},
				{
					...scope,
					sequence: 2,
					type: "block_delta",
					blockId: "b",
					text: "the answer",
				},
				{ ...scope, sequence: 3, type: "completion", completion },
			],
		} as never,
	};

	describe("review C: a no-op Stop while a normal observation reads its saved row", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it.each([
			"regenerate",
			"navigate",
		] as const)("a %s command does not abandon the turn it could not stop", async (purpose) => {
			let rows: (v: ChatMessage[] | null) => void = () => {};
			const h = harness({
				checkForOrphanedStream: vi.fn(async () => "orig"),
				getStreamBufferInfo: vi.fn(async () => ({ userMessage: "A" }) as never),
				readChatMessages: vi.fn(
					() =>
						new Promise<ChatMessage[] | null>((r) => {
							rows = r;
						}),
				),
			});
			await h.runtime.checkForOrphanedStreamOnMount();
			const placeholder = h.state.messages.at(-1)?.id as string;
			const reconnect = h.invocations[0];
			reconnect.callbacks.onFinishPart?.({ type: "finish" } as never);
			reconnect.callbacks.onEnd("", {
				observation: {
					version: 1,
					state: "terminal",
					streamId: "orig",
					conversationId: "conv-1",
					assistantMessageId: "S",
					completion,
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(h.runtime.snapshot()).toMatchObject({
				isSending: true,
				canStop: false,
			});
			const result = await h.runtime.settleStoppedAction(
				purpose === "regenerate"
					? { purpose, messageId: placeholder }
					: { purpose },
			);
			rows([{ id: "U", role: "user", content: "A", timestamp: 2 }, saved]);
			await vi.advanceTimersByTimeAsync(60_000);
			const snap = h.runtime.snapshot();
			console.log(
				purpose,
				"->",
				result.status,
				JSON.stringify({
					isSending: snap.isSending,
					active: snap.active,
					canStop: snap.canStop,
					phase: snap.phase,
					row: h.state.messages.at(-1)?.id,
					streaming: h.state.messages.at(-1)?.isStreaming,
				}),
			);
			expect(snap.isSending).toBe(false);
			expect(h.state.messages.at(-1)?.id).toBe("S");
		});
	});
});

describe("errorline regression", () => {
	function stoppedRowFixture() {
		const output = createNormalChatOutputAccumulator();
		const scope = {
			version: 1,
			turnId: "t-1",
			segmentId: "s-1",
			attemptId: "a",
			stepId: "w",
			phase: "working",
		} as const;
		output.apply({
			...scope,
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "b",
			kind: "text",
			role: "activity",
		});
		output.apply({
			...scope,
			sequence: 2,
			type: "block_delta",
			blockId: "b",
			text: "working",
		});
		const live = output.getProjection();
		const completion = {
			version: 1,
			turnId: "t-1",
			segmentId: "s-1",
			phase: "working",
			outcome: "stopped",
			stopCause: "user_stop",
			workingStopCause: "user_stop",
			closingAttempted: false,
		} as const;
		output.apply({ ...scope, sequence: 3, type: "completion", completion });
		const saved: ChatMessage = {
			id: "saved-1",
			role: "assistant",
			content: "",
			timestamp: 5,
			normalChatOutput: { version: 1, events: [] } as never,
		};
		// Persisted events: rebuild the same projection from the same events.
		const events = [
			{
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "b",
				nativeId: "b",
				kind: "text",
				role: "activity",
			},
			{
				...scope,
				sequence: 2,
				type: "block_delta",
				blockId: "b",
				text: "working",
			},
			{ ...scope, sequence: 3, type: "completion", completion },
		];
		saved.normalChatOutput = { version: 1, events } as never;
		return { live, completion, saved };
	}

	describe("review C: what a Stop settlement writes to the page's error line", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("does not clear an error that a later, unrelated action set while it observed", async () => {
			const facts = stoppedRowFixture();
			let rows: (v: ChatMessage[]) => void = () => {};
			const h = harness({
				readChatMessages: vi.fn(
					() =>
						new Promise<ChatMessage[] | null>((r) => {
							rows = r;
						}),
				),
			});
			await h.runtime.send(aSend("A"));
			h.invocations[0].callbacks.onNormalChatOutput?.(facts.live);
			expect(h.runtime.stop()).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			const observer = h.invocations[1];
			observer.callbacks.onEnd("", {
				observation: {
					version: 1,
					state: "terminal",
					streamId: "stream-1",
					conversationId: "conv-1",
					assistantMessageId: "saved-1",
					completion: facts.completion,
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			// Meanwhile the person does something else on the page that fails (an edit's
			// turn check, a fork, a compaction): the page writes its own sentence.
			h.adapters.setSendError("chat.editCheckFailed");
			rows([
				{ id: "u-1", role: "user", content: "A", timestamp: 4 },
				facts.saved,
			]);
			await vi.advanceTimersByTimeAsync(0);
			console.log(
				"error line writes:",
				JSON.stringify(h.state.errors),
				"row:",
				h.state.messages.at(-1)?.id,
			);
			expect(h.state.messages.at(-1)?.id).toBe("saved-1");
			expect(h.state.errors.at(-1)).toBe("chat.editCheckFailed");
		});
	});
});

describe("duplicate regression", () => {
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
	const scope = {
		version: 1,
		turnId: "t-1",
		segmentId: "s-1",
		attemptId: "a",
		stepId: "w",
		phase: "working",
	} as const;
	const saved: ChatMessage = {
		id: "S",
		role: "assistant",
		content: "the answer",
		timestamp: 3,
		normalChatOutput: {
			version: 1,
			events: [
				{
					...scope,
					sequence: 1,
					type: "block_start",
					blockId: "b",
					nativeId: "b",
					kind: "text",
					role: "answer",
				},
				{
					...scope,
					sequence: 2,
					type: "block_delta",
					blockId: "b",
					text: "the answer",
				},
				{ ...scope, sequence: 3, type: "completion", completion },
			],
		} as never,
	};

	describe("review C: canonical adoption when the saved row is already on screen", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("leaves one copy of the saved reply (reload raced the end of the turn)", async () => {
			const h = harness({
				checkForOrphanedStream: vi.fn(async () => "orig"),
				getStreamBufferInfo: vi.fn(async () => ({ userMessage: "A" }) as never),
				readChatMessages: vi.fn(async () => [
					{ id: "U", role: "user", content: "A", timestamp: 2 } as ChatMessage,
					saved,
				]),
			});
			// The server-rendered page already holds the saved turn; the stream is still registered.
			h.state.messages.push(
				{ id: "U", role: "user", content: "A", timestamp: 2 },
				{ ...saved },
			);
			await h.runtime.checkForOrphanedStreamOnMount();
			const reconnect = h.invocations[0];
			reconnect.callbacks.onFinishPart?.({ type: "finish" } as never);
			reconnect.callbacks.onEnd("", {
				observation: {
					version: 1,
					state: "terminal",
					streamId: "orig",
					conversationId: "conv-1",
					assistantMessageId: "S",
					completion,
				},
			});
			await vi.advanceTimersByTimeAsync(10);
			const ids = h.state.messages.map(
				(m) => `${m.role}:${m.id}:${m.renderKey ?? "-"}`,
			);
			console.log(
				"rows after adoption:",
				JSON.stringify(ids),
				"sending:",
				h.runtime.snapshot().isSending,
			);
			expect(h.state.messages.filter((m) => m.id === "S")).toHaveLength(1);
		});
	});
});

describe("erased-end regression", () => {
	describe("review C: the runtime's reading of an end whose observation was erased", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("a reconnect ending with no observation and no ids finalizes as done and sends the queue", async () => {
			const h = harness({
				checkForOrphanedStream: vi.fn(async () => "orig"),
				getStreamBufferInfo: vi.fn(async () => ({ userMessage: "A" }) as never),
			});
			await h.runtime.checkForOrphanedStreamOnMount();
			h.runtime.queue(aSend("queued B"));
			const reconnect = h.invocations[0];
			// What streaming.ts hands over for an unmarked malformed terminal observation.
			reconnect.callbacks.onFinishPart?.({ type: "finish" } as never);
			reconnect.callbacks.onEnd("", {
				observation: undefined,
				normalChatFinalization: undefined,
			});
			await vi.advanceTimersByTimeAsync(10);
			const row = h.state.messages.find((m) => m.role === "assistant");
			console.log(
				JSON.stringify({
					row: {
						id: row?.id,
						isStreaming: row?.isStreaming,
						warnings: row?.completionWarningCodes,
						content: row?.content,
					},
					errors: h.state.errors,
					posts: h.invocations.map((i) => i.message),
				}),
			);
			expect(h.invocations.map((i) => i.message)).not.toContain("queued B");
		});
	});
});
