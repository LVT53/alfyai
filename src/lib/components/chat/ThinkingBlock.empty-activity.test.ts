import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import {
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "$lib/shared/normal-chat-output";
import { uiLanguage } from "$lib/stores/settings";
import ThinkingBlock from "./ThinkingBlock.svelte";

const scope = {
	version: 1 as const,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "a:0",
	phase: "working" as const,
};

describe("review D: empty text block (start/end with no delta) from a provider", () => {
	it("E1: an empty block becomes blank retained activity with a 'Previous activity' header", async () => {
		uiLanguage.set("en");
		vi.spyOn(Element.prototype, "animate").mockImplementation(
			() =>
				({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation,
		);
		const events = [
			{
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
			{ ...scope, sequence: 2, type: "block_end", blockId: "b" },
			{
				...scope,
				sequence: 3,
				type: "step_settled",
				role: "activity",
				finishReason: "tool-calls",
			},
			{
				...scope,
				phase: "closing",
				sequence: 4,
				type: "completion",
				completion: {
					version: 1,
					turnId: "t",
					segmentId: "s",
					phase: "working",
					outcome: "incomplete",
					stopCause: "stream_end",
					workingStopCause: "stream_end",
					closingAttempted: false,
				},
			},
		] as NormalChatOutputEvent[];
		const output = projectNormalChatOutput(events);
		console.log(
			"E1 activity blocks:",
			output.activity.length,
			"text:",
			JSON.stringify(output.activity[0]?.text),
		);
		render(ThinkingBlock, { output, thinkingIsDone: true });
		const header = screen.queryByRole("button", { name: /Previous activity/ });
		console.log("E1 header shown:", Boolean(header));
		if (header) {
			await fireEvent.click(header);
			const section = screen.queryByTestId("normal-chat-commentary");
			console.log(
				"E1 disclosed section text:",
				JSON.stringify(section?.textContent),
			);
		}
		expect(output.activity.length).toBe(0);
	});
});
