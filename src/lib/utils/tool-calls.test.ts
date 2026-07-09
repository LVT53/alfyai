import { describe, expect, it } from "vitest";

import type { ThinkingSegment } from "$lib/types";
import {
	formatConnectionToolAction,
	getHumanReadableToolNameKey,
	isConnectionToolName,
	isConnectionWriteToolName,
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

	it("recognizes the four connection tool names (7.5 — used to trigger a pending-writes hydrate)", () => {
		expect(isConnectionWriteToolName("files")).toBe(true);
		expect(isConnectionWriteToolName("Calendar")).toBe(true);
		expect(isConnectionWriteToolName("EMAIL")).toBe(true);
		expect(isConnectionWriteToolName("photos")).toBe(true);
		expect(isConnectionWriteToolName("produce_file")).toBe(false);
		expect(isConnectionWriteToolName("research_web")).toBe(false);
	});

	it("maps common names to localized tool keys", () => {
		expect(getHumanReadableToolNameKey("research_web")).toBe(
			"toolCalls.webSearch",
		);
		expect(getHumanReadableToolNameKey("web search")).toBe(
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

	it("maps each connection tool to its capability label key (no more vague 'generic')", () => {
		expect(getHumanReadableToolNameKey("calendar")).toBe("toolCalls.calendar");
		expect(getHumanReadableToolNameKey("Files")).toBe("toolCalls.files");
		expect(getHumanReadableToolNameKey("EMAIL")).toBe("toolCalls.email");
		expect(getHumanReadableToolNameKey("photos")).toBe("toolCalls.photos");
		expect(getHumanReadableToolNameKey("media")).toBe("toolCalls.media");
		expect(getHumanReadableToolNameKey("location")).toBe("toolCalls.location");
		expect(getHumanReadableToolNameKey("contacts")).toBe("toolCalls.contacts");
		// A genuinely unknown tool still falls back to generic.
		expect(getHumanReadableToolNameKey("something_else")).toBe(
			"toolCalls.generic",
		);
	});

	it("identifies connection tool names and humanizes their action verbs", () => {
		expect(isConnectionToolName("calendar")).toBe(true);
		expect(isConnectionToolName("research_web")).toBe(false);
		expect(formatConnectionToolAction("list_events")).toBe("list events");
		expect(formatConnectionToolAction("check_availability")).toBe(
			"check availability",
		);
		expect(formatConnectionToolAction("SEARCH")).toBe("search");
	});

	it("creates deterministic keys for equivalent object inputs", () => {
		const first = toolCallInputKey({ b: 2, a: 1 });
		const second = toolCallInputKey({ a: 1, b: 2 });
		expect(first).toBe(second);
		expect(first).toBe('{"a":1,"b":2}');
	});

	it("normalizes nested objects recursively for stable keys", () => {
		const value = toolCallInputKey({
			outer: { z: 1, a: 2 },
			inner: [3, { b: 1, a: 2 }],
		});
		expect(value).toBe('{"inner":[3,{"a":2,"b":1}],"outer":{"a":2,"z":1}}');
	});

	it("returns empty string when input contains non-serializable values", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const key = toolCallInputKey(cyclic);
		expect(key).toBe("");
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
