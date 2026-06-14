import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
	type ChatGPTCodeContent,
	type ChatGPTConversation,
	type ChatGPTExecutionOutputContent,
	type ChatGPTImagePart,
	type ChatGPTMappingNode,
	type ChatGPTMessage,
	type ChatGPTMessageContent,
	type ChatGPTMultimodalTextContent,
	type ChatGPTReasoningRecapContent,
	type ChatGPTSystemErrorContent,
	type ChatGPTTextContent,
	type ChatGPTTextPart,
	type ChatGPTThoughtsContent,
	type ChatGPTUserEditableContextContent,
	detectBranches,
	extractContent,
	isDeletedMessage,
	parseConversationsJson,
	reconstructThread,
	stripUnicodeControls,
} from "./parser";

function makeMessage(overrides: Partial<ChatGPTMessage> = {}): ChatGPTMessage {
	return {
		id: "msg-1",
		author: { role: "user", name: null, metadata: {} },
		create_time: 1000000,
		update_time: null,
		content: { content_type: "text", parts: ["Hello"] },
		status: "finished_successfully",
		end_turn: true,
		weight: 1,
		metadata: {},
		recipient: "all",
		channel: null,
		...overrides,
	};
}

function makeNode(
	id: string,
	message: ChatGPTMessage | null,
	parent: string | null,
	children: string[],
): ChatGPTMappingNode {
	return { id, message, parent, children };
}

// ─── stripUnicodeControls ────────────────────────────────────────────

describe("stripUnicodeControls", () => {
	it("removes U+E200–U+E204 control characters", () => {
		const input = "Hello\u{e200} Wor\u{e201}ld\u{e204}!";
		expect(stripUnicodeControls(input)).toBe("Hello World!");
	});

	it("returns the same string when no control characters are present", () => {
		expect(stripUnicodeControls("normal text")).toBe("normal text");
	});

	it("returns empty string when input is empty", () => {
		expect(stripUnicodeControls("")).toBe("");
	});

	it("returns empty string when input is only control characters", () => {
		expect(stripUnicodeControls("\u{e200}\u{e201}\u{e202}")).toBe("");
	});

	it("preserves other Unicode characters outside the control range", () => {
		const input = "Café résumé \u{1f600}";
		expect(stripUnicodeControls(input)).toBe(input);
	});

	it("removes U+E203 specifically", () => {
		expect(stripUnicodeControls("a\u{e203}b")).toBe("ab");
	});

	it("handles multiple occurrences of same control char", () => {
		expect(stripUnicodeControls("\u{e200}x\u{e200}y")).toBe("xy");
	});
});

// ─── isDeletedMessage ────────────────────────────────────────────────

describe("isDeletedMessage", () => {
	it("returns true for status 'deleted'", () => {
		expect(isDeletedMessage(makeMessage({ status: "deleted" }))).toBe(true);
	});

	it("returns true for status 'hidden'", () => {
		expect(isDeletedMessage(makeMessage({ status: "hidden" }))).toBe(true);
	});

	it("returns true for status 'rejected'", () => {
		expect(isDeletedMessage(makeMessage({ status: "rejected" }))).toBe(true);
	});

	it("returns true for status 'cancelled'", () => {
		expect(isDeletedMessage(makeMessage({ status: "cancelled" }))).toBe(true);
	});

	it("is case-insensitive for status", () => {
		expect(isDeletedMessage(makeMessage({ status: "DELETED" }))).toBe(true);
		expect(isDeletedMessage(makeMessage({ status: "Hidden" }))).toBe(true);
	});

	it("returns true when metadata.is_visually_hidden_from_conversation is true", () => {
		expect(
			isDeletedMessage(
				makeMessage({
					status: "finished_successfully",
					metadata: { is_visually_hidden_from_conversation: true },
				}),
			),
		).toBe(true);
	});

	it("returns false for normal 'finished_successfully' status", () => {
		expect(
			isDeletedMessage(makeMessage({ status: "finished_successfully" })),
		).toBe(false);
	});

	it("returns false when status is missing (undefined)", () => {
		const msg = makeMessage();
		(msg as Record<string, unknown>).status = undefined;
		expect(isDeletedMessage(msg)).toBe(false);
	});

	it("returns false for arbitrary status values", () => {
		expect(isDeletedMessage(makeMessage({ status: "in_progress" }))).toBe(
			false,
		);
	});
});

// ─── extractContent ──────────────────────────────────────────────────

describe("extractContent", () => {
	describe("null / non-object inputs", () => {
		it("returns null for null content", () => {
			expect(
				extractContent(null as unknown as ChatGPTMessageContent),
			).toBeNull();
		});

		it("returns null for undefined content", () => {
			expect(
				extractContent(undefined as unknown as ChatGPTMessageContent),
			).toBeNull();
		});

		it("returns null for string content", () => {
			expect(
				extractContent("hello" as unknown as ChatGPTMessageContent),
			).toBeNull();
		});

		it("returns null for number content", () => {
			expect(extractContent(42 as unknown as ChatGPTMessageContent)).toBeNull();
		});
	});

	describe("text content_type", () => {
		it("joins parts with newline separator", () => {
			const content: ChatGPTTextContent = {
				content_type: "text",
				parts: ["Hello", "World", "How are you?"],
			};
			expect(extractContent(content)).toBe("Hello\nWorld\nHow are you?");
		});

		it("returns single part without newline", () => {
			const content: ChatGPTTextContent = {
				content_type: "text",
				parts: ["Single message"],
			};
			expect(extractContent(content)).toBe("Single message");
		});

		it("filters non-string parts", () => {
			const content = {
				content_type: "text",
				parts: ["Hello", 123 as unknown as string, "World"],
			} as ChatGPTTextContent;
			expect(extractContent(content)).toBe("Hello\nWorld");
		});

		it("returns null when parts is missing", () => {
			const content = { content_type: "text" } as ChatGPTTextContent;
			expect(extractContent(content)).toBeNull();
		});

		it("returns null when parts is not an array", () => {
			const content = {
				content_type: "text",
				parts: "not-an-array",
			} as unknown as ChatGPTTextContent;
			expect(extractContent(content)).toBeNull();
		});

		it("strips Unicode control characters from joined text", () => {
			const content: ChatGPTTextContent = {
				content_type: "text",
				parts: ["Hello\u{e200}", "\u{e201}World"],
			};
			expect(extractContent(content)).toBe("Hello\nWorld");
		});

		it("returns empty string when all parts are non-string", () => {
			const content = {
				content_type: "text",
				parts: [1, 2, 3],
			} as unknown as ChatGPTTextContent;
			expect(extractContent(content)).toBe("");
		});
	});

	describe("code content_type", () => {
		it("wraps code in triple-backtick fenced block with language", () => {
			const content: ChatGPTCodeContent = {
				content_type: "code",
				language: "python",
				text: "print('hello')",
			};
			expect(extractContent(content)).toBe("```python\nprint('hello')\n```");
		});

		it("handles empty language", () => {
			const content: ChatGPTCodeContent = {
				content_type: "code",
				language: "",
				text: "console.log('hi')",
			};
			expect(extractContent(content)).toBe("```\nconsole.log('hi')\n```");
		});

		it("handles missing language field", () => {
			const content = {
				content_type: "code",
				text: "const x = 1;",
			} as ChatGPTCodeContent;
			expect(extractContent(content)).toBe("```\nconst x = 1;\n```");
		});

		it("handles empty text", () => {
			const content: ChatGPTCodeContent = {
				content_type: "code",
				language: "typescript",
				text: "",
			};
			expect(extractContent(content)).toBe("```typescript\n\n```");
		});

		it("handles multiline code", () => {
			const content: ChatGPTCodeContent = {
				content_type: "code",
				language: "javascript",
				text: "function a() {\n  return 1;\n}",
			};
			expect(extractContent(content)).toBe(
				"```javascript\nfunction a() {\n  return 1;\n}\n```",
			);
		});

		it("strips Unicode control characters in code blocks", () => {
			const content: ChatGPTCodeContent = {
				content_type: "code",
				language: "python",
				text: "x\u{e201} = 1",
			};
			expect(extractContent(content)).toBe("```python\nx = 1\n```");
		});
	});

	describe("execution_output content_type", () => {
		it("joins parts with newline separator", () => {
			const content: ChatGPTExecutionOutputContent = {
				content_type: "execution_output",
				parts: ["line1", "line2", "line3"],
			};
			expect(extractContent(content)).toBe("line1\nline2\nline3");
		});

		it("filters non-string parts", () => {
			const content = {
				content_type: "execution_output",
				parts: ["ok", 42 as unknown as string],
			} as ChatGPTExecutionOutputContent;
			expect(extractContent(content)).toBe("ok");
		});

		it("returns null when parts is missing", () => {
			const content = {
				content_type: "execution_output",
			} as ChatGPTExecutionOutputContent;
			expect(extractContent(content)).toBeNull();
		});

		it("returns null when parts is not an array", () => {
			const content = {
				content_type: "execution_output",
				parts: "string",
			} as unknown as ChatGPTExecutionOutputContent;
			expect(extractContent(content)).toBeNull();
		});
	});

	describe("multimodal_text content_type", () => {
		it("extracts only text parts, preserving order", () => {
			const textPart: ChatGPTTextPart = {
				content_type: "text",
				text: "Hello from image analysis",
			};
			const imagePart: ChatGPTImagePart = {
				content_type: "image_asset_pointer",
				asset_pointer: "file-abc123",
				size_bytes: 1024,
				width: 800,
				height: 600,
				fovea: null,
				metadata: null,
			};
			const content: ChatGPTMultimodalTextContent = {
				content_type: "multimodal_text",
				parts: [textPart, imagePart],
			};
			expect(extractContent(content)).toBe("Hello from image analysis");
		});

		it("joins multiple text parts with empty string", () => {
			const part1: ChatGPTTextPart = {
				content_type: "text",
				text: "First part ",
			};
			const part2: ChatGPTTextPart = {
				content_type: "text",
				text: "Second part",
			};
			const content: ChatGPTMultimodalTextContent = {
				content_type: "multimodal_text",
				parts: [part1, part2],
			};
			expect(extractContent(content)).toBe("First part Second part");
		});

		it("returns empty string when there are no text parts", () => {
			const imagePart: ChatGPTImagePart = {
				content_type: "image_asset_pointer",
				asset_pointer: "file-xyz",
				size_bytes: 500,
				width: 400,
				height: 300,
				fovea: null,
				metadata: null,
			};
			const content: ChatGPTMultimodalTextContent = {
				content_type: "multimodal_text",
				parts: [imagePart],
			};
			expect(extractContent(content)).toBe("");
		});

		it("returns null when parts is missing", () => {
			const content = {
				content_type: "multimodal_text",
			} as ChatGPTMultimodalTextContent;
			expect(extractContent(content)).toBeNull();
		});

		it("filters unknown part types", () => {
			const textPart: ChatGPTTextPart = {
				content_type: "text",
				text: "Visible text",
			};
			const content = {
				content_type: "multimodal_text",
				parts: [textPart, { content_type: "unknown_type", data: "x" }],
			} as ChatGPTMultimodalTextContent;
			expect(extractContent(content)).toBe("Visible text");
		});

		it("strips Unicode control characters from text parts", () => {
			const textPart: ChatGPTTextPart = {
				content_type: "text",
				text: "Hello\u{e200}World",
			};
			const content: ChatGPTMultimodalTextContent = {
				content_type: "multimodal_text",
				parts: [textPart],
			};
			expect(extractContent(content)).toBe("HelloWorld");
		});
	});

	describe("skipped content types", () => {
		it("returns null for user_editable_context", () => {
			const content: ChatGPTUserEditableContextContent = {
				content_type: "user_editable_context",
				user_profile: "profile text",
				user_instructions: "instructions",
			};
			expect(extractContent(content)).toBeNull();
		});

		it("returns null for thoughts", () => {
			const content: ChatGPTThoughtsContent = {
				content_type: "thoughts",
				thoughts: ["thinking..."],
			};
			expect(extractContent(content)).toBeNull();
		});

		it("returns null for reasoning_recap", () => {
			const content: ChatGPTReasoningRecapContent = {
				content_type: "reasoning_recap",
				content: "recap text",
			};
			expect(extractContent(content)).toBeNull();
		});

		it("returns null for system_error", () => {
			const content: ChatGPTSystemErrorContent = {
				content_type: "system_error",
				error_type: "timeout",
				code: "ERR_TIMEOUT",
			};
			expect(extractContent(content)).toBeNull();
		});

		it("returns null for unknown content_type", () => {
			const content = {
				content_type: "some_future_type",
				data: "something",
			};
			expect(
				extractContent(content as unknown as ChatGPTMessageContent),
			).toBeNull();
		});

		it("returns null for object without content_type", () => {
			const content = { arbitrary: "data" };
			expect(
				extractContent(content as unknown as ChatGPTMessageContent),
			).toBeNull();
		});
	});
});

// ─── reconstructThread ───────────────────────────────────────────────

describe("reconstructThread", () => {
	it("returns messages in chronological order (oldest first)", () => {
		const msg1 = makeMessage({
			id: "m1",
			author: { role: "user", name: null, metadata: {} },
			content: { content_type: "text", parts: ["First"] },
			create_time: 1000,
			weight: 1,
		});
		const msg2 = makeMessage({
			id: "m2",
			author: { role: "assistant", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Second"] },
			create_time: 2000,
			weight: 2,
		});
		const msg3 = makeMessage({
			id: "m3",
			author: { role: "user", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Third"] },
			create_time: 3000,
			weight: 3,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			root: makeNode("root", msg1, null, ["n2"]),
			n2: makeNode("n2", msg2, "root", ["n3"]),
			n3: makeNode("n3", msg3, "n2", []),
		};

		const result = reconstructThread(mapping, "n3");
		expect(result).toHaveLength(3);
		expect(result[0].content).toBe("First");
		expect(result[1].content).toBe("Second");
		expect(result[2].content).toBe("Third");
	});

	it("sets correct role for user messages", () => {
		const msg = makeMessage({
			author: { role: "user", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Hi"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].role).toBe("user");
	});

	it("sets correct role for assistant messages", () => {
		const msg = makeMessage({
			author: { role: "assistant", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Hi"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].role).toBe("assistant");
	});

	it("sets createdAt from create_time (epoch seconds)", () => {
		const msg = makeMessage({
			create_time: 1700000000,
			content: { content_type: "text", parts: ["Hi"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].createdAt).toEqual(new Date(1700000000 * 1000));
	});

	it("does not set createdAt when create_time is null", () => {
		const msg = makeMessage({
			create_time: null,
			content: { content_type: "text", parts: ["Hi"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].createdAt).toBeUndefined();
	});

	it("sets metadata.model from model_slug", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Hi"] },
			metadata: { model_slug: "gpt-4" },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].metadata?.model).toBe("gpt-4");
	});

	it("falls back to default_model_slug for metadata.model", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Hi"] },
			metadata: { default_model_slug: "gpt-3.5" },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].metadata?.model).toBe("gpt-3.5");
	});

	it("sets metadata.weight", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Hi"] },
			weight: 42,
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].metadata?.weight).toBe(42);
	});

	it("skips nodes with null message", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Visible"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			root: makeNode("root", null, null, ["visible"]),
			visible: makeNode("visible", msg, "root", []),
		};
		const result = reconstructThread(mapping, "visible");
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("Visible");
	});

	it("skips deleted messages (by status)", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Should be skipped"] },
			status: "deleted",
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("skips hidden messages (by metadata flag)", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Hidden"] },
			metadata: { is_visually_hidden_from_conversation: true },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("skips system role messages", () => {
		const msg = makeMessage({
			author: { role: "system", name: null, metadata: {} },
			content: { content_type: "text", parts: ["System prompt"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("skips tool role messages", () => {
		const msg = makeMessage({
			author: { role: "tool", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Tool result"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("skips messages with content that extracts to null (e.g. thoughts)", () => {
		const msg = makeMessage({
			author: { role: "assistant", name: null, metadata: {} },
			content: {
				content_type: "thoughts",
				thoughts: ["thinking..."],
			},
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("skips messages with empty content after trim", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["   "] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(0);
	});

	it("trims whitespace from content", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["  Hello  "] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].content).toBe("Hello");
	});

	it("handles missing mapping node gracefully", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Orphan"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, "non-existent-parent", []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(1);
	});

	it("detects and breaks on cycles in the parent chain", () => {
		const msg1 = makeMessage({
			id: "m1",
			content: { content_type: "text", parts: ["A"] },
			weight: 1,
		});
		const msg2 = makeMessage({
			id: "m2",
			content: { content_type: "text", parts: ["B"] },
			weight: 2,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			a: makeNode("a", msg1, "b", []),
			b: makeNode("b", msg2, "a", []),
		};

		const result = reconstructThread(mapping, "a");
		expect(result.length).toBeGreaterThanOrEqual(2);
	});

	it("returns empty when current_node is null and no leaf exists", () => {
		const mapping: Record<string, ChatGPTMappingNode> = {};
		const result = reconstructThread(mapping, null);
		expect(result).toHaveLength(0);
	});

	it("uses highest-weight leaf as fallback when current_node is null", () => {
		const msgLow = makeMessage({
			id: "low",
			content: { content_type: "text", parts: ["Low weight"] },
			weight: 1,
		});
		const msgHigh = makeMessage({
			id: "high",
			content: { content_type: "text", parts: ["High weight"] },
			weight: 10,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			leaf1: makeNode("leaf1", msgLow, null, []),
			leaf2: makeNode("leaf2", msgHigh, null, []),
		};

		const result = reconstructThread(mapping, null);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("High weight");
	});

	it("skips leaf nodes that have no message when finding fallback", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Only valid"] },
			weight: 5,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			empty: makeNode("empty", null, null, []),
			valid: makeNode("valid", msg, null, []),
		};

		const result = reconstructThread(mapping, null);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("Only valid");
	});

	it("ignores non-leaf nodes when finding fallback (only leaf nodes used)", () => {
		const msgParent = makeMessage({
			id: "parent",
			content: { content_type: "text", parts: ["Parent"] },
			weight: 100,
		});
		const msgChild = makeMessage({
			id: "child",
			content: { content_type: "text", parts: ["Child"] },
			weight: 1,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msgParent, null, ["n2"]),
			n2: makeNode("n2", msgChild, "n1", []),
		};

		const result = reconstructThread(mapping, null);
		expect(result).toHaveLength(2);
		expect(result[0].content).toBe("Parent");
		expect(result[1].content).toBe("Child");
	});

	it("handles a single-node conversation", () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Solo"] },
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("Solo");
	});

	it("walks backward via parent pointers, NOT forward via children", () => {
		const msg1 = makeMessage({
			id: "m1",
			content: { content_type: "text", parts: ["Start"] },
			weight: 1,
		});
		const msg2 = makeMessage({
			id: "m2",
			content: { content_type: "text", parts: ["Middle"] },
			weight: 2,
		});
		const msg3 = makeMessage({
			id: "m3",
			content: { content_type: "text", parts: ["End"] },
			weight: 3,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg1, null, ["n2", "n3"]),
			n2: makeNode("n2", msg2, "n1", []),
			n3: makeNode("n3", msg3, "n1", []),
		};

		const result = reconstructThread(mapping, "n3");
		expect(result).toHaveLength(2);
		expect(result[0].content).toBe("Start");
		expect(result[1].content).toBe("End");
	});

	it("includes code content messages with correct fenced formatting", () => {
		const msg = makeMessage({
			author: { role: "assistant", name: null, metadata: {} },
			content: {
				content_type: "code",
				language: "python",
				text: "print('hello')",
			},
		});
		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", msg, null, []),
		};
		const result = reconstructThread(mapping, "n1");
		expect(result[0].content).toBe("```python\nprint('hello')\n```");
	});
});

// ─── detectBranches ──────────────────────────────────────────────────

describe("detectBranches", () => {
	function makeMsg(
		id: string,
		role: "user" | "assistant",
		text: string,
		weight = 1.0,
	): ChatGPTMessage {
		return makeMessage({
			id,
			author: { role, name: null, metadata: {} },
			content: { content_type: "text", parts: [text] },
			weight,
		});
	}

	it("returns empty when there are no branches (single linear path)", () => {
		const m1 = makeMsg("m1", "user", "Hello", 1);
		const m2 = makeMsg("m2", "assistant", "Hi", 1);
		const m3 = makeMsg("m3", "user", "How are you?", 1);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2"]),
			n2: makeNode("n2", m2, "n1", ["n3"]),
			n3: makeNode("n3", m3, "n2", []),
		};

		const result = detectBranches(mapping, "n3");
		expect(result).toHaveLength(0);
	});

	it("detects a branch when a node has multiple children with weight < 1.0", () => {
		const m1 = makeMsg("m1", "user", "Q1", 1);
		const m2a = makeMsg("m2a", "assistant", "A1 v1", 1);
		const m2b = makeMsg("m2b", "assistant", "A1 v2", 0.5);
		const m3a = makeMsg("m3a", "user", "Q2 after v1", 1);
		const m3b = makeMsg("m3b", "user", "Q2 after v2", 1);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2a", "n2b"]),
			n2a: makeNode("n2a", m2a, "n1", ["n3a"]),
			n2b: makeNode("n2b", m2b, "n1", ["n3b"]),
			n3a: makeNode("n3a", m3a, "n2a", []),
			n3b: makeNode("n3b", m3b, "n2b", []),
		};

		const result = detectBranches(mapping, "n3a");
		expect(result).toHaveLength(1);
		expect(result[0].divergenceNodeId).toBe("n1");
		expect(result[0].branchNodeId).toBe("n2b");
		expect(result[0].weight).toBe(0.5);
		expect(result[0].messages).toHaveLength(3);
		expect(result[0].messages[0].content).toBe("Q1");
		expect(result[0].messages[1].content).toBe("A1 v2");
		expect(result[0].messages[2].content).toBe("Q2 after v2");
	});

	it("detects edited prompts (user message with multiple children)", () => {
		const m1 = makeMsg("m1", "user", "Original Q", 1);
		const m2 = makeMsg("m2", "assistant", "Answer to original", 1);
		const m3a = makeMsg("m3a", "user", "Edited Q", 1);
		const m3b = makeMsg("m3b", "user", "Original follow-up", 0.5);
		const m4a = makeMsg("m4a", "assistant", "Answer to edited", 1);
		const m4b = makeMsg("m4b", "assistant", "Answer to follow-up", 0.5);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2"]),
			n2: makeNode("n2", m2, "n1", ["n3a", "n3b"]),
			n3a: makeNode("n3a", m3a, "n2", ["n4a"]),
			n3b: makeNode("n3b", m3b, "n2", ["n4b"]),
			n4a: makeNode("n4a", m4a, "n3a", []),
			n4b: makeNode("n4b", m4b, "n3b", []),
		};

		const result = detectBranches(mapping, "n4a");
		expect(result).toHaveLength(1);
		expect(result[0].divergenceNodeId).toBe("n2");
		expect(result[0].branchNodeId).toBe("n3b");
		expect(result[0].weight).toBe(0.5);
		expect(result[0].messages[0].content).toBe("Original Q");
		expect(result[0].messages[1].content).toBe("Answer to original");
		expect(result[0].messages[2].content).toBe("Original follow-up");
		expect(result[0].messages[3].content).toBe("Answer to follow-up");
	});

	it("detects multiple branches from the same divergence point", () => {
		const m1 = makeMsg("m1", "user", "Prompt", 1);
		const m2a = makeMsg("m2a", "assistant", "Response v1", 1);
		const m2b = makeMsg("m2b", "assistant", "Response v2", 0.5);
		const m2c = makeMsg("m2c", "assistant", "Response v3", 0.3);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2a", "n2b", "n2c"]),
			n2a: makeNode("n2a", m2a, "n1", []),
			n2b: makeNode("n2b", m2b, "n1", []),
			n2c: makeNode("n2c", m2c, "n1", []),
		};

		const result = detectBranches(mapping, "n2a");
		expect(result).toHaveLength(2);
		expect(result[0].branchNodeId).toBe("n2b");
		expect(result[1].branchNodeId).toBe("n2c");
	});

	it("returns empty when current_node is null", () => {
		const mapping: Record<string, ChatGPTMappingNode> = {};
		expect(detectBranches(mapping, null)).toHaveLength(0);
	});

	it("ignores children with weight >= 1.0 (not real branches)", () => {
		const m1 = makeMsg("m1", "user", "Q", 1);
		const m2a = makeMsg("m2a", "assistant", "A1", 1);
		const m2b = makeMsg("m2b", "assistant", "A2", 1);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2a", "n2b"]),
			n2a: makeNode("n2a", m2a, "n1", []),
			n2b: makeNode("n2b", m2b, "n1", []),
		};

		const result = detectBranches(mapping, "n2a");
		expect(result).toHaveLength(0);
	});

	it("handles branches where branch leaf is deeper than active leaf", () => {
		const m1 = makeMsg("m1", "user", "Q", 1);
		const m2a = makeMsg("m2a", "assistant", "A short", 1);
		const m2b = makeMsg("m2b", "assistant", "A long", 0.5);
		const m3b = makeMsg("m3b", "user", "Follow-up", 1);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2a", "n2b"]),
			n2a: makeNode("n2a", m2a, "n1", []),
			n2b: makeNode("n2b", m2b, "n1", ["n3b"]),
			n3b: makeNode("n3b", m3b, "n2b", []),
		};

		const result = detectBranches(mapping, "n2a");
		expect(result).toHaveLength(1);
		expect(result[0].messages).toHaveLength(3);
	});

	it("ignores nodes without messages on the branch path", () => {
		const m1 = makeMsg("m1", "user", "Q", 1);
		const m2a = makeMsg("m2a", "assistant", "A active", 1);
		const m3b = makeMsg("m3b", "assistant", "A branch", 0.5);

		const mapping: Record<string, ChatGPTMappingNode> = {
			n1: makeNode("n1", m1, null, ["n2a", "n-empty"]),
			n2a: makeNode("n2a", m2a, "n1", []),
			"n-empty": makeNode("n-empty", null, "n1", ["n3b"]),
			n3b: makeNode("n3b", m3b, "n-empty", []),
		};

		const result = detectBranches(mapping, "n2a");
		expect(result).toHaveLength(1);
		expect(result[0].messages).toHaveLength(2);
		expect(result[0].messages[0].content).toBe("Q");
		expect(result[0].messages[1].content).toBe("A branch");
	});
});

// ─── parseConversationsJson ──────────────────────────────────────────

describe("parseConversationsJson", () => {
	async function makeZipWithConversations(
		conversations: ChatGPTConversation[],
	): Promise<Buffer> {
		const zip = new JSZip();
		zip.file("conversations.json", JSON.stringify(conversations));
		return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
	}

	function makeConversation(
		overrides: Partial<ChatGPTConversation> = {},
	): ChatGPTConversation {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Hello"] },
		});
		const node = makeNode("leaf", msg, null, []);
		return {
			id: "conv-1",
			title: "Test Conversation",
			create_time: 1700000000,
			update_time: 1700001000,
			mapping: { leaf: node },
			current_node: "leaf",
			conversation_id: "conv-1",
			moderation_results: [],
			plugin_ids: null,
			conversation_template_id: null,
			gizmo_id: null,
			gizmo_type: null,
			is_archived: false,
			is_starred: null,
			safe_urls: [],
			default_model_slug: null,
			conversation_origin: null,
			voice: null,
			async_status: null,
			disabled_tool_ids: [],
			...overrides,
		};
	}

	it("parses a ZIP with a single conversation", async () => {
		const conv = makeConversation();
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.errors).toHaveLength(0);
		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0].title).toBe("Test Conversation");
		expect(result.conversations[0].messages).toHaveLength(1);
	});

	it("parses a ZIP with multiple conversations", async () => {
		const conv1 = makeConversation({ id: "c1", title: "First" });
		const conv2 = makeConversation({ id: "c2", title: "Second" });
		const buffer = await makeZipWithConversations([conv1, conv2]);
		const result = await parseConversationsJson(buffer);

		expect(result.errors).toHaveLength(0);
		expect(result.conversations).toHaveLength(2);
		expect(result.conversations[0].title).toBe("First");
		expect(result.conversations[1].title).toBe("Second");
	});

	it("uses conversation_id over id for output id", async () => {
		const conv = makeConversation({
			id: "internal-id",
			conversation_id: "exported-id",
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].id).toBe("exported-id");
	});

	it("falls back to id when conversation_id is empty", async () => {
		const conv = makeConversation({
			id: "fallback-id",
			conversation_id: "",
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].id).toBe("fallback-id");
	});

	it('uses "Untitled" when title is empty', async () => {
		const conv = makeConversation({ title: "" });
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].title).toBe("Untitled");
	});

	it("sets createdAt and updatedAt from epoch seconds", async () => {
		const conv = makeConversation({
			create_time: 1700000000,
			update_time: 1700003600,
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].createdAt).toEqual(
			new Date(1700000000 * 1000),
		);
		expect(result.conversations[0].updatedAt).toEqual(
			new Date(1700003600 * 1000),
		);
	});

	it("sets model from default_model_slug", async () => {
		const conv = makeConversation({ default_model_slug: "gpt-4" });
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].model).toBe("gpt-4");
	});

	it("sets gizmoId from gizmo_id", async () => {
		const conv = makeConversation({ gizmo_id: "gizmo-123" });
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].gizmoId).toBe("gizmo-123");
	});

	it("skips conversations with empty mapping", async () => {
		const conv = makeConversation({
			mapping: {} as Record<string, ChatGPTMappingNode>,
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].rawId).toBe("conv-1");
	});

	it("skips conversations where all messages are deleted", async () => {
		const deletedMsg = makeMessage({
			content: { content_type: "text", parts: ["Deleted"] },
			status: "deleted",
		});
		const node = makeNode("leaf", deletedMsg, null, []);
		const conv = makeConversation({
			mapping: { leaf: node },
			current_node: "leaf",
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
	});

	it("returns error for invalid ZIP buffer", async () => {
		const buffer = Buffer.from("not a zip file");
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("Failed to read ZIP");
	});

	it("returns error when conversations.json is missing", async () => {
		const zip = new JSZip();
		zip.file("other.json", "{}");
		const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("No conversations.json");
	});

	it("returns error when conversations.json is invalid JSON", async () => {
		const zip = new JSZip();
		zip.file("conversations.json", "not valid json {{{");
		const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("Failed to parse");
	});

	it("returns error when conversations.json is not an array", async () => {
		const zip = new JSZip();
		zip.file("conversations.json", JSON.stringify({ not: "an array" }));
		const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].reason).toContain("not an array");
	});

	it("returns both successful conversations and per-entry errors", async () => {
		const valid = makeConversation({ id: "good", title: "Good" });
		const bad = makeConversation({
			id: "bad",
			title: "Bad",
			mapping: {} as Record<string, ChatGPTMappingNode>,
		});
		const buffer = await makeZipWithConversations([valid, bad]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0].title).toBe("Good");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].rawId).toBe("bad");
	});

	it("handles create_time of 0 gracefully", async () => {
		const conv = makeConversation({ create_time: 0, update_time: 0 });
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations[0].createdAt).toEqual(new Date(0));
		expect(result.conversations[0].updatedAt).toEqual(new Date(0));
	});

	it("handles missing current_node by using highest-weight leaf fallback", async () => {
		const msg = makeMessage({
			content: { content_type: "text", parts: ["Surviving"] },
			weight: 1,
		});
		const node = makeNode("leaf", msg, null, []);
		const conv = makeConversation({
			mapping: { leaf: node },
			current_node: null,
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0].messages).toHaveLength(1);
	});

	it("captures unexpected errors on individual conversation entries", async () => {
		const conv = makeConversation();
		(conv as Record<string, unknown>).mapping = undefined;

		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
	});

	it("handles conversations with system messages skipped from output", async () => {
		const userMsg = makeMessage({
			id: "u1",
			author: { role: "user", name: null, metadata: {} },
			content: { content_type: "text", parts: ["User question"] },
			weight: 1,
		});
		const sysMsg = makeMessage({
			id: "s1",
			author: { role: "system", name: null, metadata: {} },
			content: { content_type: "text", parts: ["System prompt"] },
			weight: 2,
		});
		const assMsg = makeMessage({
			id: "a1",
			author: { role: "assistant", name: null, metadata: {} },
			content: { content_type: "text", parts: ["Assistant reply"] },
			weight: 3,
		});

		const mapping: Record<string, ChatGPTMappingNode> = {
			root: makeNode("root", userMsg, null, ["sys"]),
			sys: makeNode("sys", sysMsg, "root", ["ass"]),
			ass: makeNode("ass", assMsg, "sys", []),
		};

		const conv = makeConversation({
			mapping,
			current_node: "ass",
		});
		const buffer = await makeZipWithConversations([conv]);
		const result = await parseConversationsJson(buffer);

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0].messages).toHaveLength(2);
		expect(result.conversations[0].messages[0].role).toBe("user");
		expect(result.conversations[0].messages[0].content).toBe("User question");
		expect(result.conversations[0].messages[1].role).toBe("assistant");
		expect(result.conversations[0].messages[1].content).toBe("Assistant reply");
	});
});
