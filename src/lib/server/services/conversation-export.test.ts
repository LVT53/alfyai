import { describe, expect, it } from "vitest";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";
import { renderConversationMarkdown } from "./conversation-export";
import type { ChatMessage } from "./messages-types";

describe("outward canonical answer status", () => {
	it.each([
		"answered",
		"incomplete",
		"stopped",
		"failed",
	] as const)("exports %s with canonical bytes and no private activity", (outcome) => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome,
			stopCause: "length",
			workingStopCause: "tool_budget",
			closingAttempted: true,
		} as const;
		const events: NormalChatOutputEvent[] = [
			{
				version: 1,
				turnId: "t",
				segmentId: "s",
				attemptId: "a",
				stepId: "c",
				phase: "closing",
				sequence: 0,
				type: "completion",
				completion,
			},
		];
		const message: ChatMessage = {
			id: "m",
			role: "assistant",
			timestamp: 0,
			content: "  Canonical [fixed]\n",
			thinking: "PRIVATE",
			normalChatOutput: { version: 1, events },
		};
		const result = renderConversationMarkdown("Synthetic", [message]);
		expect(result).toContain(message.content);
		expect(result.includes("_Incomplete answer._")).toBe(
			outcome !== "answered",
		);
		expect(result).not.toContain("PRIVATE");
	});
});
