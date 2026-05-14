import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeSource = () =>
	readFileSync(resolve(process.cwd(), "langflow_nodes/project_context_tool.py"), "utf8");

describe("Langflow Project Context tool node", () => {
	it("exposes project_context summary mode as the model-facing tool contract", () => {
		const source = nodeSource();

		expect(source).toContain('display_name = "Project Context"');
		expect(source).toContain('name = "project_context"');
		expect(source).toContain('method="project_context"');
		expect(source).toContain("def project_context(self) -> Data:");
		expect(source).toContain("/api/tools/project-context");

		for (const field of [
			"mode",
			"query",
			"maxSiblings",
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

	it("emits memory tool markers with bounded evidence candidates", () => {
		const source = nodeSource();

		expect(source).toContain('"TOOL_START"');
		expect(source).toContain('"TOOL_END"');
		expect(source).toContain('"name": "project_context"');
		expect(source).toContain('"sourceType": "memory"');
		expect(source).toContain('"candidates": evidence_candidates');
		expect(source).toContain("evidence_candidates[:max_siblings]");
	});
});
