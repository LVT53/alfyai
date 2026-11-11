import { expect, it } from "vitest";
import {
	decodeAiSdkUiStreamPayloads,
	readNormalChatOutputEvent,
} from "$lib/services/ai-sdk-ui-stream-contract";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
} from "$lib/shared/normal-chat-output";
import { streamNormalChatOutputEvent, streamTextDeltaEvent } from "./stream";
import { StreamReplayJournal } from "./stream-replay-journal";

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
function events(journal: StreamReplayJournal) {
	return journal
		.read()
		.chunks.flatMap(decodeAiSdkUiStreamPayloads)
		.flatMap((part) => {
			if (part === "[DONE]" || part.type !== "data-normal-chat-output")
				return [];
			const event = readNormalChatOutputEvent(part.data);
			return event ? [event] : [];
		});
}
it("compacts scoped deltas, retains settlement, replays idempotently then accepts live continuation", () => {
	const journal = new StreamReplayJournal();
	journal.append(streamNormalChatOutputEvent(start));
	journal.append(streamNormalChatOutputEvent(delta(2, "First ")));
	const early = journal.read();
	journal.append(streamNormalChatOutputEvent(delta(3, "second")));
	const accumulator = createNormalChatOutputAccumulator();
	for (const event of events(journal)) accumulator.apply(event);
	expect(accumulator.getProjection().blocks[0].text).toBe("First second");
	expect(accumulator.getProjection().answer).toBe("");
	for (const event of events(journal)) accumulator.apply(event);
	accumulator.apply(delta(4, " third"));
	const settled: NormalChatOutputEvent = {
		...scope,
		sequence: 5,
		type: "step_settled",
		role: "answer",
		finishReason: "stop",
	};
	accumulator.apply(settled);
	expect(accumulator.getProjection().answer).toBe("First second third");
	expect(early.chunks.join("")).not.toContain("second");
	journal.append(streamNormalChatOutputEvent(delta(4, " third")));
	journal.append(streamNormalChatOutputEvent(settled));
	expect(events(journal).map((event) => event.type)).toEqual([
		"block_start",
		"block_delta",
		"step_settled",
	]);
});
it("keeps reused block IDs in different attempts independent", () => {
	const journal = new StreamReplayJournal();
	for (const attemptId of ["a", "b"]) {
		journal.append(
			streamNormalChatOutputEvent({
				...start,
				attemptId,
				sequence: attemptId === "a" ? 1 : 4,
			}),
		);
		journal.append(
			streamNormalChatOutputEvent({
				...delta(attemptId === "a" ? 2 : 5, attemptId),
				attemptId,
			}),
		);
	}
	expect(
		events(journal)
			.filter((event) => event.type === "block_delta")
			.map((event) => event.text),
	).toEqual(["a", "b"]);
});
it("retains split SSE frames and refuses replay until the frame is complete", () => {
	const journal = new StreamReplayJournal();
	const wire = streamTextDeltaEvent('a\n"é🙂');
	for (const char of wire.slice(0, -1)) journal.append(char);
	expect(journal.read().complete).toBe(false);
	journal.append(wire.slice(-1));
	expect(journal.read()).toEqual({ complete: true, chunks: [wire] });
});
it("bounds escaped text and unfinished frame memory without returning a suffix", () => {
	const journal = new StreamReplayJournal();
	for (let i = 0; i < 100; i++)
		journal.append(streamTextDeltaEvent('"'.repeat(1000)));
	expect(journal.read()).toEqual({ complete: false, chunks: [] });
	journal.append(streamTextDeltaEvent("later"));
	expect(journal.read()).toEqual({ complete: false, chunks: [] });
	const partial = new StreamReplayJournal();
	partial.append(`data: ${"x".repeat(200_000)}`);
	expect(partial.read()).toEqual({ complete: false, chunks: [] });
});
