import { describe, expect, it } from "vitest";

import type { ThinkingSegment } from "$lib/types";
import {
	getHumanReadableToolNameKey,
	isFileProductionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
	toolCallInputKey,
} from "./tool-calls";

describe("tool-calls utils", () => {
	it("normalizes file-production tool names from loose input", () => {
		expect(isFileProductionToolName("produce_file")).toBe(true);
		expect(isFileProductionToolName("PRODUCE FILE")).toBe(true);
		expect(isFileProductionToolName("produce-file")).toBe(true);
		expect(isFileProductionToolName("generate_file_production")).toBe(true);
		expect(isFileProductionToolName("image_search")).toBe(false);
	});

	it("maps common names to localized tool keys", () => {
		expect(getHumanReadableToolNameKey("research_web")).toBe(
			"toolCalls.webSearch",
		);
		expect(getHumanReadableToolNameKey("browse")).toBe("toolCalls.fetchPage");
		expect(getHumanReadableToolNameKey("memory_context")).toBe(
			"toolCalls.memoryLookup",
		);
		expect(getHumanReadableToolNameKey("produce_file")).toBe(
			"toolCalls.createFile",
		);
	});

	it("creates deterministic keys for equivalent object inputs", () => {
		const first = toolCallInputKey({ b: 2, a: 1 });
		const second = toolCallInputKey({ a: 1, b: 2 });
		expect(first).toBe(second);
		expect(first).toBe('{"a":1,"b":2}');
	});

	it("filters visible thinking segments", () => {
		const visibleText: ThinkingSegment = {
			type: "text",
			content: "searching",
		};
		const invisibleText: ThinkingSegment = {
			type: "text",
			content: "   ",
		};
		const visibleStatus: ThinkingSegment = {
			type: "status",
			id: "visible-status",
			label: "running",
			status: "running",
		};
		const visibleToolCall: ThinkingSegment = {
			type: "tool_call",
			input: {},
			name: "image_search",
			status: "running",
		};
		const hiddenToolCall: ThinkingSegment = {
			type: "tool_call",
			input: {},
			name: "produce_file",
			status: "running",
		};

		expect(isVisibleThinkingSegment(visibleText)).toBe(true);
		expect(isVisibleThinkingSegment(invisibleText)).toBe(false);
		expect(isVisibleThinkingSegment(visibleStatus)).toBe(true);
		expect(isVisibleThinkingSegment(visibleToolCall)).toBe(true);
		expect(isVisibleThinkingSegment(hiddenToolCall)).toBe(false);

		expect(isVisibleThinkingToolCall(visibleToolCall)).toBe(true);
		expect(isVisibleThinkingToolCall(hiddenToolCall)).toBe(false);
	});
});
