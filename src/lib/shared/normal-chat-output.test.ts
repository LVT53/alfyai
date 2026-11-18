import { describe, expect, it } from "vitest";
import {
	compactNormalChatOutputEvents,
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
	it("puts a blank line between the answer words of two steps", () => {
		// The words before a card the app refused and the words of the step that asks
		// again with the fixed card are both the reply's (chat-turn/AGENTS.md, The
		// Pause): two paragraphs, never one run-on line.
		const step = (stepId: string) => ({
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId,
			phase: "working" as const,
		});
		const events: NormalChatOutputEvent[] = [
			{
				...step("a:0"),
				sequence: 1,
				type: "block_start",
				blockId: "x",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
			{
				...step("a:0"),
				sequence: 2,
				type: "block_delta",
				blockId: "x",
				text: "The biggest fork is the day itself.",
			},
			{
				...step("a:1"),
				sequence: 3,
				type: "block_start",
				blockId: "y",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
			{
				...step("a:1"),
				sequence: 4,
				type: "block_delta",
				blockId: "y",
				text: "Which way suits you best?",
			},
			{
				...step("a:0"),
				sequence: 5,
				type: "step_settled",
				role: "answer",
				finishReason: "tool-calls",
			},
			{
				...step("a:1"),
				sequence: 6,
				type: "step_settled",
				role: "answer",
				finishReason: "tool-calls",
			},
		];
		expect(projectNormalChatOutput(events).answer).toBe(
			"The biggest fork is the day itself.\n\nWhich way suits you best?",
		);
	});
	it("keeps that blank line when answer blocks of a new step arrive one by one", () => {
		const a = createNormalChatOutputAccumulator();
		const step = (stepId: string) => ({
			version: 1 as const,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId,
			phase: "closing" as const,
		});
		a.apply({
			...step("a:0"),
			sequence: 1,
			type: "block_start",
			blockId: "x",
			nativeId: "0",
			kind: "text",
			role: "answer",
		});
		a.apply({
			...step("a:0"),
			sequence: 2,
			type: "block_delta",
			blockId: "x",
			text: "One.",
		});
		expect(a.getProjection().answer).toBe("One.");
		a.apply({
			...step("a:1"),
			sequence: 3,
			type: "block_start",
			blockId: "y",
			nativeId: "0",
			kind: "text",
			role: "answer",
		});
		a.apply({
			...step("a:1"),
			sequence: 4,
			type: "block_delta",
			blockId: "y",
			text: "Two.",
		});
		expect(a.getProjection().answer).toBe("One.\n\nTwo.");
	});
});

it("compacts interleaved blocks without changing scopes, ownership or replay identity", () => {
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
			blockId: "b",
			nativeId: "b",
			kind: "text",
			role: "provisional",
		},
		{ ...scope, sequence: 2, type: "block_delta", blockId: "b", text: "First" },
		{
			...scope,
			sequence: 3,
			type: "block_start",
			blockId: "r",
			nativeId: "r",
			kind: "reasoning",
			role: "activity",
		},
		{
			...scope,
			sequence: 4,
			type: "block_delta",
			blockId: "r",
			text: "private",
		},
		{
			...scope,
			sequence: 5,
			type: "block_delta",
			blockId: "b",
			text: " answer",
		},
		{ ...scope, sequence: 6, type: "block_end", blockId: "b" },
		{
			...scope,
			sequence: 7,
			type: "step_settled",
			role: "answer",
			finishReason: "stop",
		},
		{
			...scope,
			segmentId: "s2",
			sequence: 1,
			type: "block_start",
			blockId: "b",
			nativeId: "b",
			kind: "text",
			role: "answer",
		},
		{
			...scope,
			segmentId: "s2",
			sequence: 2,
			type: "block_delta",
			blockId: "b",
			text: "Second",
		},
	];
	const original = structuredClone(events);
	const compact = compactNormalChatOutputEvents([...events, ...events]);
	expect(compact).toHaveLength(events.length - 1);
	expect(projectNormalChatOutput(compact)).toEqual(
		projectNormalChatOutput(events),
	);
	expect(projectNormalChatOutput([...compact, ...compact])).toEqual(
		projectNormalChatOutput(events),
	);
	expect(compactNormalChatOutputEvents(compact)).toEqual(compact);
	expect(events).toEqual(original);
});
