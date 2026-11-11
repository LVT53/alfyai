import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalChatOutputEvent } from "$lib/shared/normal-chat-output";
import {
	createCanonicalOutputRelay,
	createOutputEventWriter,
} from "./output-event-writer";

const scope = {
	version: 1 as const,
	turnId: "turn",
	segmentId: "segment",
	attemptId: "attempt",
	stepId: "step",
	phase: "working" as const,
};
const delta = (sequence: number, text: string): NormalChatOutputEvent => ({
	...scope,
	sequence,
	type: "block_delta",
	blockId: "block",
	text,
});
describe("live structural output transport", () => {
	afterEach(() => vi.useRealTimers());
	it("streams first progress immediately, then bounds wire bytes across a token burst", () => {
		vi.useFakeTimers();
		const frames: string[] = [];
		const writer = createOutputEventWriter(
			(frame) => {
				frames.push(frame);
				return true;
			},
			{ compact: true },
		);
		writer.write(delta(1, "first"));
		expect(frames).toHaveLength(1);
		for (let i = 2; i <= 1001; i++) writer.write(delta(i, " word"));
		expect(Buffer.byteLength(frames.join(""))).toBeLessThan(10000);
		vi.advanceTimersByTime(25);
		const events = frames.map(
			(frame) => JSON.parse(frame.slice(6)).data as NormalChatOutputEvent,
		);
		expect(
			events
				.filter((e) => e.type === "block_delta")
				.map((e) => e.text)
				.join(""),
		).toBe(`first${" word".repeat(1000)}`);
		expect(events.map((e) => e.sequence)).toEqual(
			[...events.map((e) => e.sequence)].sort((a, b) => a - b),
		);
		expect(Buffer.byteLength(frames.join(""))).toBeLessThan(10000);
	});

	it("bounds repeated scope overhead at a realistic 100ms token cadence", () => {
		vi.useFakeTimers();
		const frames: string[] = [];
		const writer = createOutputEventWriter(
			(frame) => {
				frames.push(frame);
				return true;
			},
			{ compact: true },
		);
		const longScope = {
			...scope,
			turnId: "t".repeat(64),
			segmentId: "s".repeat(64),
			attemptId: "a".repeat(95),
			stepId: "p".repeat(95),
		};
		writer.write({
			...longScope,
			sequence: 1,
			type: "block_start",
			blockId: "b".repeat(95),
			nativeId: "text",
			kind: "text",
			role: "provisional",
		});
		for (let i = 2; i <= 102; i++) {
			writer.write({
				...longScope,
				sequence: i,
				type: "block_delta",
				blockId: "b".repeat(95),
				text: " word",
			});
			vi.advanceTimersByTime(100);
		}
		process.stdout.write(
			`${JSON.stringify({ measurement: "slow-cadence-wire", bytes: Buffer.byteLength(frames.join("")), frames: frames.length, textBytes: 505 })}\n`,
		);
		expect(Buffer.byteLength(frames.join(""))).toBeLessThan(15000);
		expect(frames).toHaveLength(102);
	});
	it("flushes pending text before tool withdrawal and never merges across a structural boundary", () => {
		vi.useFakeTimers();
		const frames: string[] = [];
		const writer = createOutputEventWriter(
			(frame) => {
				frames.push(frame);
				return true;
			},
			{ compact: true },
		);
		writer.write(delta(1, "first"));
		writer.write(delta(2, " pending"));
		expect(frames).toHaveLength(1);
		writer.write({
			...scope,
			sequence: 3,
			type: "step_settled",
			role: "activity",
			finishReason: null,
		});
		expect(frames.map((frame) => JSON.parse(frame.slice(6)).data.type)).toEqual(
			["block_delta", "block_delta", "step_settled"],
		);
		vi.advanceTimersByTime(25);
		expect(frames).toHaveLength(3);
	});
});

it("keeps legacy clients and reconnect broadcasts canonical while compact clients opt in", () => {
	const start: NormalChatOutputEvent = {
		...scope,
		sequence: 1,
		type: "block_start",
		blockId: "block",
		nativeId: "native",
		kind: "text",
		role: "provisional",
	};
	const legacy: string[] = [];
	const compact: string[] = [];
	const oldWriter = createOutputEventWriter((frame) => {
		legacy.push(frame);
		return true;
	});
	const newWriter = createOutputEventWriter(
		(frame) => {
			compact.push(frame);
			return true;
		},
		{ compact: true },
	);
	for (const writer of [oldWriter, newWriter]) {
		writer.write(start);
		writer.write(delta(2, "hello"));
		writer.write(delta(3, " world"));
		writer.flush();
	}
	expect(legacy.join("")).not.toContain("data-normal-chat-delta");
	expect(compact.join("")).toContain("data-normal-chat-delta");
	const relay = createCanonicalOutputRelay();
	expect(compact.map(relay)).toEqual(legacy);
	expect(relay(": heartbeat\n\n")).toBe(": heartbeat\n\n");
});
