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

	it("withholds the memory-recall tool when the conversation is incognito", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Tell me about the launch plan.",
			memoryIncognito: true,
		});
		expect(selected).not.toHaveProperty("memory_context");
		// Non-memory tools remain available under incognito.
		expect(selected).toHaveProperty("research_web");
	});

	it("still withholds memory even when file-production tools are exposed", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Please create a file with the summary.",
			forceProduceFileTool: true,
			memoryIncognito: true,
		});
		expect(selected).not.toHaveProperty("memory_context");
		expect(selected).toHaveProperty("produce_file");
	});
});
