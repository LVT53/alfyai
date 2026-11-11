import { afterEach, expect, it, vi } from "vitest";
import {
	applyNormalChatOutputView,
	normalChatOutputView,
} from "$lib/client/normal-chat-output-view";
import {
	streamDataPartEvent,
	streamNormalChatOutputEvent,
} from "$lib/server/services/chat-turn/stream";
import { StreamReplayJournal } from "$lib/server/services/chat-turn/stream-replay-journal";
import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	endEvent,
	makeCallbacks,
	runStreamWithMockedResponse,
} from "$lib/services/streaming.test-helpers";
import type {
	NormalChatOutputEvent,
	NormalChatOutputProjection,
} from "$lib/shared/normal-chat-output";

afterEach(() => vi.unstubAllGlobals());
it("reconnects after consuming the first delta, replaces compact replay, then applies live tail exactly once", async () => {
	vi.stubGlobal("fetch", vi.fn());
	const scope = {
		version: 1 as const,
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "step",
		phase: "working" as const,
	};
	const start: NormalChatOutputEvent = {
		...scope,
		sequence: 1,
		type: "block_start",
		blockId: "b",
		nativeId: "text",
		kind: "text",
		role: "provisional",
	};
	const delta = (sequence: number, text: string): NormalChatOutputEvent => ({
		...scope,
		sequence,
		type: "block_delta",
		blockId: "b",
		text,
	});
	const journal = new StreamReplayJournal();
	const initial = [start, delta(2, "First ")];
	let messages: ChatMessage[] = [
		{ id: "reply", role: "assistant", content: "", timestamp: 0 },
	];
	let replacement = false;
	let pending: NormalChatOutputProjection | undefined;
	const callbacks = () => ({
		...makeCallbacks(),
		onNormalChatOutput(view: NormalChatOutputProjection) {
			if (replacement) pending = view;
			else messages = applyNormalChatOutputView(messages, "reply", view);
		},
		onReplayComplete() {
			expect(normalChatOutputView(messages[0])?.blocks[0].text).toBe("First ");
			expect(pending?.blocks[0].text).toBe("First second");
			if (pending)
				messages = applyNormalChatOutputView(messages, "reply", pending);
			replacement = false;
		},
	});
	for (const event of initial)
		journal.append(streamNormalChatOutputEvent(event));
	await runStreamWithMockedResponse({
		responseChunks: initial.map(streamNormalChatOutputEvent),
		callbacks: callbacks(),
	}).done;
	expect(normalChatOutputView(messages[0])?.blocks[0].text).toBe("First ");
	journal.append(streamNormalChatOutputEvent(delta(3, "second")));
	replacement = true;
	const next = runStreamWithMockedResponse({
		message: "",
		options: { reconnectToStreamId: "stream" },
		callbacks: callbacks(),
		responseChunks: [
			streamDataPartEvent("data-replay-start", {}),
			...journal.read().chunks,
			streamDataPartEvent("data-replay-end", {}),
			streamNormalChatOutputEvent(delta(4, " third")),
			streamNormalChatOutputEvent(delta(4, " third")),
			streamNormalChatOutputEvent({
				...scope,
				sequence: 5,
				type: "step_settled",
				role: "answer",
				finishReason: "stop",
			}),
			endEvent(),
		],
	});
	await next.done;
	expect(messages).toHaveLength(1);
	expect(messages[0].content).toBe("First second third");
	expect(normalChatOutputView(messages[0])?.blocks[0].text).toBe(
		"First second third",
	);
	expect(next.callbacks.onEnd).toHaveBeenCalledWith(
		"First second third",
		undefined,
	);
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(
		JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)),
	).toMatchObject({
		message: "",
		streamId: "stream",
		reconnectToStreamId: "stream",
		conversationId: "conv-1",
	});
});
