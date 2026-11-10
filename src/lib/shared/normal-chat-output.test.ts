import { describe, expect, it } from "vitest";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
	projectNormalChatOutput,
} from "./normal-chat-output";

describe("canonical output ownership", () => {
	it("keeps explicit private-thinking delimiters out of answer export without guessing from words", () => {
		const a = createNormalChatOutputAccumulator();
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "a:0",
			phase: "closing" as const,
		};
		a.apply({
			...scope,
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "0",
			kind: "text",
			role: "answer",
		});
		a.apply({
			...scope,
			sequence: 2,
			type: "block_delta",
			blockId: "b",
			text: "<think>private</think>Hello. Let me check.",
		});
		expect(a.getProjection().answer).toBe("Hello. Let me check.");
	});
	it("incrementally settles without replaying old text deltas", () => {
		const a = createNormalChatOutputAccumulator();
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "a:0",
			phase: "working" as const,
		};
		a.apply({
			...scope,
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "0",
			kind: "text",
			role: "provisional",
		});
		a.apply({
			...scope,
			sequence: 2,
			type: "block_delta",
			blockId: "b",
			text: "One",
		});
		expect(a.getProjection().answer).toBe("");
		a.apply({
			...scope,
			sequence: 3,
			type: "step_settled",
			role: "answer",
			finishReason: "stop",
		});
		a.apply({
			...scope,
			sequence: 2,
			type: "block_delta",
			blockId: "b",
			text: "One",
		});
		expect(a.getProjection().answer).toBe("One");
	});
	it("keeps provisional bytes out of the answer and replays settlement once", () => {
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "a:0",
			phase: "working" as const,
		};
		const events: NormalChatOutputEvent[] = [
			{
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "b1",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
			{
				...scope,
				sequence: 2,
				type: "block_delta",
				blockId: "b1",
				text: "Hello. Let me check.",
			},
			{ ...scope, sequence: 3, type: "block_end", blockId: "b1" },
			{
				...scope,
				sequence: 4,
				type: "step_settled",
				role: "activity",
				finishReason: "tool-calls",
			},
			{
				...scope,
				stepId: "a:1",
				sequence: 5,
				type: "block_start",
				blockId: "b2",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
			{
				...scope,
				stepId: "a:1",
				sequence: 6,
				type: "block_delta",
				blockId: "b2",
				text: "## Result",
			},
		];
		expect(projectNormalChatOutput(events).answer).toBe("");
		events.push({
			...scope,
			stepId: "a:1",
			sequence: 7,
			type: "step_settled",
			role: "answer",
			finishReason: "stop",
		});
		const result = projectNormalChatOutput([...events, ...events]);
		expect(result.answer).toBe("## Result");
		expect(result.activity.map((b) => b.text)).toEqual([
			"Hello. Let me check.",
		]);
	});
	it("preserves ordered answer blocks and excludes native reasoning", () => {
		const scope = {
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "c",
			stepId: "c:0",
			phase: "closing" as const,
		};
		const events: NormalChatOutputEvent[] = [
			{
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "r",
				nativeId: "r",
				kind: "reasoning",
				role: "activity",
			},
			{
				...scope,
				sequence: 2,
				type: "block_delta",
				blockId: "r",
				text: "private",
			},
			{
				...scope,
				sequence: 3,
				type: "block_start",
				blockId: "b",
				nativeId: "b",
				kind: "text",
				role: "answer",
			},
			{
				...scope,
				sequence: 4,
				type: "block_delta",
				blockId: "b",
				text: "One\n",
			},
			{
				...scope,
				sequence: 5,
				type: "block_start",
				blockId: "d",
				nativeId: "d",
				kind: "text",
				role: "answer",
			},
			{
				...scope,
				sequence: 6,
				type: "block_delta",
				blockId: "d",
				text: "## Two",
			},
		];
		expect(projectNormalChatOutput(events).answer).toBe("One\n## Two");
		expect(projectNormalChatOutput(events).activity).toEqual([]);
	});
});
