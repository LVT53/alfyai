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
		use_skill: {},
		suggest_instruction: {},
		// Feature 2 · Artifacts (decisions.md ruling 43): registered
		// unconditionally, like produce_file/read_generated_file above — no
		// per-turn gate exists for them and none should be added, since the
		// tool set sits inside the cached prompt prefix.
		create_artifact: {},
		read_artifact: {},
		edit_artifact: {},
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

	it("withholds the skill-loading tool when the Composer Command Registry is off", () => {
		// The per-turn skills catalogue and the `$` selection are both gated on
		// composerCommandRegistryEnabled; use_skill must not stay a live back
		// door into skill instructions when the feature is switched off.
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Critique this plan.",
			skillsEnabled: false,
		});
		expect(selected).not.toHaveProperty("use_skill");
		expect(selected).toHaveProperty("memory_context");
	});

	it("exposes the skill-loading tool when the Composer Command Registry is on", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Critique this plan.",
			skillsEnabled: true,
		});
		expect(selected).toHaveProperty("use_skill");
	});

	it("exposes the instruction-suggestion tool for an ordinary conversation", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "From now on, always suggest trains.",
			incognito: false,
		});
		expect(selected).toHaveProperty("suggest_instruction");
	});

	it("withholds the instruction-suggestion tool in an incognito conversation", () => {
		// Incognito's promise is that nothing is learned from the chat. An
		// offer to write a standing instruction is a learning-shaped surface,
		// so it is absent there — while the instructions themselves, which are
		// the user's own text and not something the app learned, keep working
		// (that is `/instruction`'s half of the rule).
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "From now on, always suggest trains.",
			incognito: true,
		});
		expect(selected).not.toHaveProperty("suggest_instruction");
		// And the read-side tools are untouched by this gate: incognito is not
		// a general tool switch.
		expect(selected).toHaveProperty("memory_context");
		expect(selected).toHaveProperty("produce_file");
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

	// Feature 2 · Artifacts (decisions.md ruling 43): the three tools are
	// registered unconditionally in normal-chat-tools/index.ts, and no gate
	// here withholds them — every existing gate (memory, skills, incognito)
	// is about a DIFFERENT feature, so this only has to prove none of them
	// happens to catch the artifact tools by accident.
	it("never withholds the artifact tools, under any combination of gates", () => {
		const selected = selectNormalChatToolsForRequest(fakeToolSet(), {
			message: "Keep this as a plan I can edit with you.",
			memoryActive: false,
			skillsEnabled: false,
			incognito: true,
		});
		expect(selected).toHaveProperty("create_artifact");
		expect(selected).toHaveProperty("read_artifact");
		expect(selected).toHaveProperty("edit_artifact");
	});
});
