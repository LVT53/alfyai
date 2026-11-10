import { describe, expect, it } from "vitest";
import { placeReplySegments } from "$lib/components/chat/reply-segments";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
} from "$lib/shared/normal-chat-output";
import {
	finalizeStreamingMessageList,
	landedAssistantRow,
} from "../../routes/(app)/chat/[conversationId]/_helpers";
import {
	applyNormalChatOutputView,
	type NormalChatOutputMessage,
	normalChatOutputView,
} from "./normal-chat-output-view";

const scope = {
	version: 1,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "w",
	phase: "working",
} as const;
const events: NormalChatOutputEvent[] = [
	{
		...scope,
		sequence: 0,
		type: "block_start",
		blockId: "b",
		nativeId: "native",
		kind: "text",
		role: "provisional",
	},
	{
		...scope,
		sequence: 1,
		type: "block_delta",
		blockId: "b",
		text: "Working <img src=x>",
	},
];
const row = (id: string, content: string): NormalChatOutputMessage => ({
	id,
	role: "assistant",
	timestamp: 1,
	content,
});
describe("browser output view", () => {
	it("recognizes a saved terminal activity-only reply as landed for polling", () => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "working",
			outcome: "incomplete",
			stopCause: "stream_end",
			workingStopCause: "stream_end",
			closingAttempted: false,
		} as const;
		const message = {
			...row("saved", ""),
			normalChatOutput: {
				version: 1 as const,
				events: [
					...events,
					{ ...scope, sequence: 2, type: "completion" as const, completion },
				],
			},
		};
		expect(landedAssistantRow(message, [])).toBe(true);
	});
	it("retains ordinary interrupted activity after reload without replacing finalized saved answer", () => {
		const message = {
			...row("saved", "Final [citation]"),
			normalChatOutput: { version: 1 as const, events },
		};
		const view = normalChatOutputView(message);
		expect(view?.answer).toBe("");
		expect(view?.activity[0]).toMatchObject({
			blockId: "b",
			nativeId: "native",
			text: "Working <img src=x>",
		});
		expect(message.content).toBe("Final [citation]");
		expect(normalChatOutputView(message)).toBe(view);
	});
	it("finalizes a structural stop with activity but no fabricated answer", () => {
		const accumulator = createNormalChatOutputAccumulator();
		for (const event of events) accumulator.apply(event);
		const live = applyNormalChatOutputView(
			[row("p", "")],
			"p",
			accumulator.getProjection(),
		);
		const [saved] = finalizeStreamingMessageList(live, {
			placeholderId: "p",
			clientUserMessageId: null,
			metadata: { wasStopped: true },
		});
		expect(saved.content).toBe("");
		expect(normalChatOutputView(saved)?.activity[0].text).toBe(
			"Working <img src=x>",
		);
	});
	it("uses finalContent on stopped closing answers and preserves earlier canonical segment text once", () => {
		const messages = [
			row("first", "Earlier answer"),
			{ ...row("p", "raw"), continuesMessageId: "first" },
		];
		const saved = finalizeStreamingMessageList(messages, {
			placeholderId: "p",
			clientUserMessageId: null,
			metadata: { wasStopped: true, finalContent: "Partial [fixed]" },
		});
		expect(saved[1].content).toBe("Partial [fixed]");
		expect(placeReplySegments(saved, [], null).get(saved[1].id)?.copyText).toBe(
			"Earlier answer\n\nPartial [fixed]",
		);
	});
});
