import { describe, expect, it } from "vitest";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
	projectNormalChatOutput,
	sanitizeNormalChatAnswer,
} from "./normal-chat-output";
import { joinReplyText } from "./reply-text";

const base = {
	version: 1 as const,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	phase: "working" as const,
};
const ev = (
	stepId: string,
	sequence: number,
	body: Record<string, unknown>,
): NormalChatOutputEvent =>
	({ ...base, stepId, sequence, ...body }) as NormalChatOutputEvent;

describe("review D: reducer ordering and idempotency", () => {
	it("D1: last-arrival-wins on step_settled (answer then activity demotes the answer)", () => {
		const events = [
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			}),
			ev("a:0", 2, { type: "block_delta", blockId: "b", text: "Real answer" }),
			// natural promotion (sequence 4) delivered BEFORE the finish-step settle (sequence 3)
			ev("a:0", 4, {
				type: "step_settled",
				role: "answer",
				finishReason: "stop",
			}),
			ev("a:0", 3, {
				type: "step_settled",
				role: "activity",
				finishReason: "stop",
			}),
		];
		const p = projectNormalChatOutput(events);
		// sequence says the answer promotion (4) is the later settlement
		console.log("D1 answer:", JSON.stringify(p.answer));
		expect(p.answer).toBe("Real answer");
	});

	it("D2: a block that starts after its step was settled never takes the settled role", () => {
		const events = [
			ev("a:0", 1, {
				type: "step_settled",
				role: "answer",
				finishReason: "stop",
			}),
			ev("a:0", 2, {
				type: "block_start",
				blockId: "late",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			}),
			ev("a:0", 3, { type: "block_delta", blockId: "late", text: "Late" }),
		];
		const p = projectNormalChatOutput(events);
		console.log("D2 answer:", JSON.stringify(p.answer));
		expect(p.answer).toBe("Late");
	});

	it("D3: delta before its block_start is dropped and its sequence is burned", () => {
		const a = createNormalChatOutputAccumulator();
		const d = ev("a:0", 2, { type: "block_delta", blockId: "b", text: "Lost" });
		a.apply(d);
		a.apply(
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "answer",
			}),
		);
		// a redelivery of the same delta is now refused as a duplicate
		const accepted = a.apply(d);
		console.log(
			"D3 redelivery accepted:",
			accepted,
			"answer:",
			JSON.stringify(a.getProjection().answer),
		);
		expect(a.getProjection().answer).toBe("Lost");
	});

	it("D4: same sequence under a different attempt id is dropped as a duplicate", () => {
		const a = createNormalChatOutputAccumulator();
		a.apply(
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b1",
				nativeId: "0",
				kind: "text",
				role: "answer",
			}),
		);
		a.apply(ev("a:0", 2, { type: "block_delta", blockId: "b1", text: "One" }));
		const second = {
			...base,
			attemptId: "a2",
			stepId: "a2:0",
		};
		const r1 = a.apply({
			...second,
			sequence: 2,
			type: "block_start",
			blockId: "b2",
			nativeId: "0",
			kind: "text",
			role: "answer",
		} as NormalChatOutputEvent);
		console.log("D4 second attempt event accepted:", r1);
		expect(r1).toBe(true);
	});

	it("D5: block_start spreads sequence/type onto the stored block", () => {
		const p = projectNormalChatOutput([
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "answer",
			}),
		]);
		console.log("D5 block keys:", Object.keys(p.blocks[0]).sort().join(","));
	});
});

describe("review D: sanitizer and shortcut parity", () => {
	it("D6: a trailing partial inline-thinking opener is silently dropped from an answer", () => {
		for (const text of ["x <", "Use the tag <th", "if a <|", "Compare: a <"]) {
			console.log(
				"D6",
				JSON.stringify(text),
				"->",
				JSON.stringify(sanitizeNormalChatAnswer(text)),
			);
		}
		expect(sanitizeNormalChatAnswer("The symbol is <")).toBe("The symbol is <");
	});

	it("D7: accumulator shortcut skips the sanitizer when a zero-width char precedes a tool-call fence", () => {
		const toolFence =
			'​```json\n{"tool_calls":[{"name":"x","arguments":{}}]}\n```';
		const direct = sanitizeNormalChatAnswer(toolFence);
		const a = createNormalChatOutputAccumulator();
		a.apply(
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "answer",
			}),
		);
		a.apply(
			ev("a:0", 2, { type: "block_delta", blockId: "b", text: toolFence }),
		);
		console.log(
			"D7 direct:",
			JSON.stringify(direct),
			"accumulator:",
			JSON.stringify(a.getProjection().answer),
		);
		expect(a.getProjection().answer).toBe(direct);
	});

	it("D7b: same without the zero-width char (control)", () => {
		const toolFence =
			'```json\n{"tool_calls":[{"name":"x","arguments":{}}]}\n```';
		const direct = sanitizeNormalChatAnswer(toolFence);
		const a = createNormalChatOutputAccumulator();
		a.apply(
			ev("a:0", 1, {
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "answer",
			}),
		);
		a.apply(
			ev("a:0", 2, { type: "block_delta", blockId: "b", text: toolFence }),
		);
		expect(a.getProjection().answer).toBe(direct);
	});
});

describe("review D: outward text for finalization marker with empty answer", () => {
	it("D8: a finalization marker with no answer text still yields a non-empty outward text", () => {
		const out = joinReplyText([
			{
				content: "",
				normalChatFinalization: {
					version: 1,
					status: "failed",
					cause: "file_association_failed",
					wasStopped: false,
				},
			},
		]);
		console.log("D8 outward:", JSON.stringify(out));
		expect(out).toBe("");
	});
});

it("replays an early scoped delta through a detached apply callback only once", () => {
	const accumulator = createNormalChatOutputAccumulator();
	const { apply } = accumulator;
	const delta = ev("a:0", 2, {
		type: "block_delta",
		blockId: "early",
		text: "Early",
	});
	apply(delta);
	apply(
		ev("a:0", 1, {
			type: "block_start",
			blockId: "early",
			nativeId: "n",
			kind: "text",
			role: "answer",
		}),
	);
	expect(accumulator.getProjection().answer).toBe("Early");
	apply(delta);
	expect(accumulator.getProjection().answer).toBe("Early");
});
