import { describe, expect, it } from "vitest";
import { createNormalChatWireDecoder } from "./ai-sdk-ui-stream-contract";

const start = {
	version: 1,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "w",
	phase: "working",
	sequence: 1,
	type: "block_start",
	blockId: "b",
	nativeId: "n",
	kind: "text",
	role: "provisional",
} as const;
const full = (data: unknown) => ({ type: "data-normal-chat-output", data });
const delta = (ref = 1) => ({
	type: "data-normal-chat-delta",
	data: { ref, sequence: 2, text: "Visible" },
});
describe("compact output wire references", () => {
	it("expands only a known full scoped block and keeps duplicate replay starts idempotent", () => {
		const decoder = createNormalChatWireDecoder();
		expect(decoder.consume(full(start))).toEqual(start);
		expect(decoder.consume(full(start))).toEqual(start);
		expect(decoder.consume(delta())).toEqual({
			...start,
			type: "block_delta",
			sequence: 2,
			text: "Visible",
		});
	});
	it("refuses a reused reference with a different attempt or block identity", () => {
		for (const patch of [
			{ attemptId: "other" },
			{ blockId: "other" },
			{ stepId: "other" },
		]) {
			const decoder = createNormalChatWireDecoder();
			decoder.consume(full(start));
			expect(() => decoder.consume(full({ ...start, ...patch }))).toThrow(
				"output_reference_collision",
			);
		}
	});
	it("refuses unknown, ended, malformed and prior segment references", () => {
		const decoder = createNormalChatWireDecoder();
		expect(() => decoder.consume(delta())).toThrow("unknown_output_reference");
		decoder.consume(full(start));
		expect(() =>
			decoder.consume({
				type: "data-normal-chat-delta",
				data: { ref: 1, sequence: 2, text: 3 },
			}),
		).toThrow("invalid_output_delta");
		decoder.consume(full({ ...start, type: "block_end", sequence: 3 }));
		decoder.consume(full({ ...start, type: "block_end", sequence: 3 }));
		expect(() => decoder.consume(delta())).toThrow("unknown_output_reference");
		decoder.consume(full(start));
		decoder.consume(
			full({ ...start, type: "step_start", segmentId: "next", sequence: 4 }),
		);
		expect(() => decoder.consume(delta())).toThrow("unknown_output_reference");
	});
	it("uses independent connection dictionaries", () => {
		createNormalChatWireDecoder().consume(full(start));
		expect(() => createNormalChatWireDecoder().consume(delta())).toThrow(
			"unknown_output_reference",
		);
	});
});
