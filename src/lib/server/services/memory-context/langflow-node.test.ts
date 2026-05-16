import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeSource = () =>
	readFileSync(
		resolve(process.cwd(), "langflow_nodes/memory_context_tool.py"),
		"utf8",
	);
const legacyToolName = ["project", "context"].join("_");
const legacyToolRoute = `/api/tools/${legacyToolName.replace("_", "-")}`;

describe("Langflow Memory Context tool node", () => {
	it("exposes memory_context project, persona, and history fields as the model-facing tool contract", () => {
		const source = nodeSource();

		expect(source).toContain('display_name = "Memory Context"');
		expect(source).toContain('name = "memory_context"');
		expect(source).toContain('method="memory_context"');
		expect(source).toContain("def memory_context(self) -> Data:");
		expect(source).toContain("/api/tools/memory-context");
		expect(source).toContain('options=["project", "persona", "history"]');
		expect(source).not.toContain(`name = "${legacyToolName}"`);
		expect(source).not.toContain(`method="${legacyToolName}"`);
		expect(source).not.toContain(legacyToolRoute);

		for (const field of [
			"mode",
			"query",
			"maxSiblings",
			"siblingConversationId",
			"maxMessages",
			"maxHistoryConversations",
			"historyConversationId",
			"selectedConversationId",
			"includeEvidenceCandidates",
		]) {
			expect(source).toContain(`name="${field}"`);
			expect(source).toMatch(
				new RegExp(`name="${field}"[\\s\\S]*?tool_mode=True`),
			);
		}
	});

	it("does not expose internal scope identifiers as tool-mode inputs", () => {
		const source = nodeSource();

		expect(source).not.toMatch(/name="conversationId"/);
		expect(source).not.toMatch(/name="conversation_id"/);
		expect(source).not.toMatch(/name="userId"/);
		expect(source).not.toMatch(/name="user_id"/);
		expect(source).not.toMatch(/name="folderId"/);
		expect(source).not.toMatch(/name="projectId"/);
		expect(source).toContain('getattr(self.graph, "session_id", None)');
	});

	it("scopes memory_context service assertions to the memory_context audience", () => {
		const source = nodeSource();

		expect(source).toContain('"audience": "memory_context"');
	});

	it("emits memory tool markers with bounded evidence candidates", () => {
		const source = nodeSource();

		expect(source).toContain('"TOOL_START"');
		expect(source).toContain('"TOOL_END"');
		expect(source).toContain('"name": "memory_context"');
		expect(source).not.toContain(`"name": "${legacyToolName}"`);
		expect(source).toContain('"sourceType": "memory"');
		expect(source).toContain('"candidates": evidence_candidates');
		expect(source).toContain('"metadata": metadata');
		expect(source).toContain('"appliedMaxHistoryConversations"');
		expect(source).toContain('"omittedConversationCount"');
		expect(source).toContain('mode == "history" and not is_detail');
		expect(source).toContain("candidate_limit = max_history_conversations");
		expect(source).toContain("candidate_limit = max_messages");
		expect(source).toContain("candidate_limit = max_siblings");
		expect(source).toContain("evidence_candidates[:candidate_limit]");
	});
});
