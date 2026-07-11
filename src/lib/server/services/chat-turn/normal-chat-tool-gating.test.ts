import { describe, expect, it } from "vitest";
import { selectNormalChatToolsForRequest } from "./normal-chat-tool-gating";

type ToolSetParam = Parameters<typeof selectNormalChatToolsForRequest>[0];

// The gating helper only inspects tool keys, so a lightweight stub with the
// production key set is sufficient to assert exposure decisions.
function fakeToolSet(): ToolSetParam {
	return {
		research_web: {},
		memory_context: {},
		image_search: {},
		produce_file: {},
		read_generated_file: {},
		done: {},
	} as unknown as ToolSetParam;
}

describe("selectNormalChatToolsForRequest", () => {
	it("exposes the memory-recall tool for a normal (non-incognito) conversation", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Tell me about the launch plan.",
		});
		expect(selected).toHaveProperty("memory_context");
		expect(selected).toHaveProperty("research_web");
	});

	it("exposes the memory-recall tool regardless of incognito (read side is not gated)", () => {
		// Incognito is "saved-but-untracked": it must not degrade a chat's
		// memory recall. The gate no longer accepts a memoryIncognito param.
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Tell me about the launch plan.",
		});
		expect(selected).toHaveProperty("memory_context");
		expect(selected).toHaveProperty("research_web");
	});

	it("keeps exposing memory when file-production tools are exposed", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Please create a file with the summary.",
			forceProduceFileTool: true,
		});
		expect(selected).toHaveProperty("memory_context");
		expect(selected).toHaveProperty("produce_file");
	});

	it("keeps exposing the memory-recall tool when memory is active", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Tell me about the launch plan.",
			memoryActive: true,
		});
		expect(selected).toHaveProperty("memory_context");
		expect(selected).toHaveProperty("research_web");
	});

	it("withholds the memory-recall tool when memory is inactive (master toggle off or incognito)", () => {
		// isMemoryActiveForConversation is the single source of truth; when the
		// caller resolves it to false the read-side recall tool must not be
		// offered to the model.
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Tell me about the launch plan.",
			memoryActive: false,
		});
		expect(selected).not.toHaveProperty("memory_context");
		// Non-memory tools are unaffected by the memory gate.
		expect(selected).toHaveProperty("research_web");
		expect(selected).toHaveProperty("image_search");
	});

	it("withholds memory even when file-production tools are exposed and memory is inactive", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Please create a file with the summary.",
			forceProduceFileTool: true,
			memoryActive: false,
		});
		expect(selected).not.toHaveProperty("memory_context");
		expect(selected).toHaveProperty("produce_file");
	});
});
