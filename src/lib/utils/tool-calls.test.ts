import { describe, expect, it } from "vitest";

import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	formatConnectionToolAction,
	getHumanReadableToolNameKey,
	getToolCallIconType,
	isArtifactToolCall,
	isAskToolCall,
	isConnectionToolName,
	isConnectionWriteToolName,
	isDeliveringToolName,
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

	// Owner polish pass ("Interim Thought Steps" rail) — icon tags follow the
	// exact same branch order/predicates as getHumanReadableToolNameKey above
	// (same classification, second rendering), so every case tested there
	// gets a matching icon-type assertion here.
	it("maps tool names to icon types, reusing the same classification as getHumanReadableToolNameKey", () => {
		expect(getToolCallIconType("research_web")).toBe("web-search");
		expect(getToolCallIconType("web search")).toBe("web-search");
		expect(getToolCallIconType("browse")).toBe("fetch-url");
		expect(getToolCallIconType("fetch_url")).toBe("fetch-url");
		expect(getToolCallIconType("image_search")).toBe("image-search");
		expect(getToolCallIconType("memory_context")).toBe("memory");
		expect(getToolCallIconType("produce_file")).toBe("file-production");
	});

	// The in-chat card (Feature 2, cross-kind task): create_artifact and
	// edit_artifact share one icon type — the card body itself (ArtifactCard)
	// carries the per-kind glyph, so the row only needs to know "this is one
	// of the two artifact tools", not which of the four kinds.
	it("maps create_artifact and edit_artifact to the same 'artifact' icon type", () => {
		expect(getToolCallIconType("create_artifact")).toBe("artifact");
		expect(getToolCallIconType("edit_artifact")).toBe("artifact");
	});

	it("maps each connection tool to the SAME icon assignment SettingsConnectionsTab's CAPABILITY_ICONS already uses per capability", () => {
		expect(getToolCallIconType("calendar")).toBe("calendar");
		expect(getToolCallIconType("Files")).toBe("files");
		expect(getToolCallIconType("EMAIL")).toBe("email");
		expect(getToolCallIconType("photos")).toBe("photos");
		expect(getToolCallIconType("media")).toBe("media");
		expect(getToolCallIconType("location")).toBe("location");
		expect(getToolCallIconType("contacts")).toBe("contacts");
		expect(getToolCallIconType("repos")).toBe("repos");
		expect(getToolCallIconType("tasks")).toBe("tasks");
	});

	it("falls back to a generic icon type for an unrecognized tool name", () => {
		expect(getToolCallIconType("something_else")).toBe("generic");
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
	// F16: what a turn MADE is drawn after its text, not in the rail above it.
	it("names the calls whose row and card are what the turn made", () => {
		const call = (name: string): ThinkingSegment => ({
			type: "tool_call",
			input: {},
			name,
			status: "done",
		});

		expect(isArtifactToolCall(call("create_artifact"))).toBe(true);
		expect(isArtifactToolCall(call("edit_artifact"))).toBe(true);
		// Reading something is a step, and so is every other tool.
		expect(isArtifactToolCall(call("read_artifact"))).toBe(false);
		expect(isArtifactToolCall(call("research_web"))).toBe(false);
		expect(isArtifactToolCall(call("produce_file"))).toBe(false);
		expect(
			isArtifactToolCall({ type: "text", content: "create_artifact" }),
		).toBe(false);
	});

	// "Ask me first": the question is drawn from its question row, as a card and then a
	// folded line, never as a step of the rail. The call is taken out of the rail by
	// its name alone (Ruling 15), so a call the tool refused or that never finished
	// leaves it too, and the folded line has no tool glyph to draw.
	it("knows the ask call and gives it the ask icon type", () => {
		const call = (
			name: string,
			status: "running" | "done" | "failed" = "done",
			metadata?: Record<string, string | number | boolean | null>,
		): ThinkingSegment => ({
			type: "tool_call",
			input: {},
			name,
			status,
			...(metadata ? { metadata } : {}),
		});

		expect(getToolCallIconType("ask_user")).toBe("ask");

		expect(isAskToolCall(call("ask_user"))).toBe(true);
		expect(isAskToolCall(call("ask_user", "running"))).toBe(true);
		expect(isAskToolCall(call("ask_user", "failed"))).toBe(true);
		// a call the tool refused is a finished ask_user call marked ok: false
		expect(isAskToolCall(call("ask_user", "done", { ok: false }))).toBe(true);
		// one that paused the reply, and one that asked nobody, both leave
		expect(isAskToolCall(call("ask_user", "done", { paused: true }))).toBe(
			true,
		);

		// Every other tool stays a step of the rail, an artifact call included.
		expect(isAskToolCall(call("research_web"))).toBe(false);
		expect(isAskToolCall(call("create_artifact"))).toBe(false);
		expect(isAskToolCall(call("use_skill"))).toBe(false);
		expect(isAskToolCall(call("ask_user_later"))).toBe(false);
		expect(isAskToolCall({ type: "text", content: "ask_user" })).toBe(false);
		expect(isArtifactToolCall(call("ask_user"))).toBe(false);
		expect(getToolCallIconType("create_artifact")).toBe("artifact");
	});

	// A tool whose result is itself the thing asked for needs no words after it
	// (`chat-turn/AGENTS.md`, "A Turn's Final Answer"); every other tool does.
	describe("isDeliveringToolName", () => {
		it("is true for the tools whose result is what the person asked for", () => {
			expect(isDeliveringToolName("create_artifact")).toBe(true);
			expect(isDeliveringToolName("edit_artifact")).toBe(true);
			expect(isDeliveringToolName("make_image")).toBe(true);
			expect(isDeliveringToolName("suggest_instruction")).toBe(true);
			expect(isDeliveringToolName("ask_user")).toBe(true);
		});

		it("is true for a file-production tool under any of its loose spellings", () => {
			expect(isDeliveringToolName("produce_file")).toBe(true);
			expect(isDeliveringToolName("PRODUCE FILE")).toBe(true);
			expect(isDeliveringToolName("produce-file")).toBe(true);
			expect(isDeliveringToolName("generate_file_production")).toBe(true);
		});

		it("is false for a tool that needs words after its result", () => {
			expect(isDeliveringToolName("research_web")).toBe(false);
			expect(isDeliveringToolName("run_python")).toBe(false);
			// the connection tools read or propose, and the reply says what came of it
			expect(isDeliveringToolName("files")).toBe(false);
			expect(isDeliveringToolName("email")).toBe(false);
			expect(isDeliveringToolName("use_skill")).toBe(false);
			expect(isDeliveringToolName("memory_context")).toBe(false);
		});

		it("is false for a name that only looks like a delivering one, and for no name", () => {
			expect(isDeliveringToolName("read_artifact")).toBe(false);
			expect(isDeliveringToolName("ask_user_later")).toBe(false);
			expect(isDeliveringToolName("image_search")).toBe(false);
			expect(isDeliveringToolName("")).toBe(false);
		});
	});
});
