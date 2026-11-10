import { expect, it } from "vitest";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";
import { renderConversationMarkdown } from "../conversation-export";
import type { ChatMessage } from "../messages-types";

it("exports the finalized incomplete answer with its status and no activity or private reasoning", () => {
	const scope = {
		version: 1 as const,
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "step",
		phase: "closing" as const,
	};
	const events: NormalChatOutputEvent[] = [
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
			text: "raw uncorrected link",
		},
		{
			...scope,
			sequence: 2,
			type: "completion",
			completion: {
				version: 1,
				turnId: "t",
				segmentId: "s",
				phase: "closing",
				outcome: "incomplete",
				stopCause: "length",
				workingStopCause: "tool_budget",
				closingAttempted: true,
			},
		},
	];
	const message: ChatMessage = {
		id: "m",
		role: "assistant",
		timestamp: 0,
		content: "Final citation-repaired partial",
		thinking: "private reasoning",
		normalChatOutput: { version: 1, events },
	};
	const markdown = renderConversationMarkdown("Synthetic", [message]);
	expect(markdown).toContain("Incomplete answer");
	expect(markdown).toContain(message.content);
	expect(markdown).not.toContain("raw uncorrected");
	expect(markdown).not.toContain("private reasoning");
});
