import { describe, expect, it } from "vitest";

import {
	ALFYAI_NEMOTRON_PROMPT,
	getSystemPrompt,
	LEGACY_ALFYAI_NEMOTRON_PROMPT_TOOL_TABLE,
	normalizeSystemPromptReference,
	stripDeprecatedPreserveProtocol,
} from "./prompts";

describe("prompts", () => {
	it("leaves an empty prompt unset", () => {
		expect(getSystemPrompt(undefined)).toBe("");
		expect(getSystemPrompt("")).toBe("");
	});

	it("normalizes known prompt text back to its key", () => {
		expect(normalizeSystemPromptReference(ALFYAI_NEMOTRON_PROMPT)).toBe(
			"alfyai-nemotron",
		);
	});

	it("normalizes the old fetch_content prompt body (built on the previous tool-table prompt) back to the current key", () => {
		const legacyPrompt = LEGACY_ALFYAI_NEMOTRON_PROMPT_TOOL_TABLE.replace(
			"| research_web | Search the web for current sources with citation-ready evidence | Current facts, prices, availability, specs, policies, comparisons, multi-source research |\n| fetch_url | Fetch and read specific web page(s) by URL | The user gives a link, or you need full details/specs from a specific page beyond search snippets |\n| memory_context | Retrieve durable memory, project context, persona memory, or account history | User preferences, project continuity, earlier decisions, generated reports, personal context |",
			"| search | Search the web for information | Current events, recent facts, product research, general-topic research, verification |\n| fetch_content | Fetch and read a specific URL | The user gives a link, search snippets are insufficient, or exact page details matter |",
		).replace(
			'Use research_web to search the web. Pass {"query": "your question"} and it returns sources and evidence snippets with citation instructions. Use these as your primary evidence; do not invent claims that are not backed by the returned sources.',
			"Use search for web research. Use fetch_content when the user gives a URL or when snippets are not enough.",
		);

		expect(normalizeSystemPromptReference(legacyPrompt)).toBe(
			"alfyai-nemotron",
		);
		expect(getSystemPrompt(legacyPrompt)).toBe(ALFYAI_NEMOTRON_PROMPT);
	});

	// P2 prompt diet, review outcome 7 — normalizeSystemPromptReference and its
	// legacy-migration constants are updated alongside the prompt itself, so a
	// stored admin override holding the immediately previous (pre-diet)
	// prompt body still resolves to the canonical, current prompt text.
	it("normalizes the immediately previous (pre prompt-diet) prompt body back to the current key", () => {
		expect(
			normalizeSystemPromptReference(LEGACY_ALFYAI_NEMOTRON_PROMPT_TOOL_TABLE),
		).toBe("alfyai-nemotron");
		expect(getSystemPrompt(LEGACY_ALFYAI_NEMOTRON_PROMPT_TOOL_TABLE)).toBe(
			ALFYAI_NEMOTRON_PROMPT,
		);
	});

	it("leaves custom prompt text untouched", () => {
		const customPrompt = "You are a custom assistant.";

		expect(normalizeSystemPromptReference(customPrompt)).toBe(customPrompt);
		expect(getSystemPrompt(customPrompt)).toBe(customPrompt);
	});

	// P2 prompt diet — the tool table and its per-tool mechanics (parameter
	// examples, JSON shapes) moved entirely to each tool's own TOOL_I18N
	// description (see normal-chat-tools/index.test.ts); the base prompt now
	// only names the tools it has cross-tool policy for, in the `## Tools`
	// paragraph.
	it("names research_web and fetch_url as separate web tools in the Tools policy, without table mechanics", () => {
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("## Tools");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("research_web");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("fetch_url");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("memory_context");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Available Tools");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain(
			"| Tool | Purpose | Use When |",
		);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain(
			"| fetch_url | Fetch and read specific web page(s) by URL |",
		);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain(
			"no separate search or fetch step",
		);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/mode "exact"/);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/freshness "live"/);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/sourcePolicy/);
	});

	it("keeps research_web's objective/searchQueries argument mechanics out of the base prompt (tool description only)", () => {
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain('"objective"');
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain('"searchQueries"');
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("2-3 short keyword queries");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain('{"query": "your question"}');
	});

	it("keeps only cross-tool policy for produce_file in the built-in assistant prompt, not its tool-specific mechanics", () => {
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("produce_file");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("documentSource");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("image_search");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("idempotency scoping");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/Langflow/i);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/JSON-encoded/i);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/JSON strings/i);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(/as a JSON string/i);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain(
			"documentSource, and program as text fields",
		);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain(
			"rather than a nested object or array",
		);
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("generate_file");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("export_document");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("createPDF");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("Terracotta Crown");
		// Tool mechanics (the simple-form field names, examples, and
		// requestedOutputs) now live only in produce_file's own description.
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("simple produce_file form");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("requestTitle");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("requestedOutputs");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Files And Artifacts");
		expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Calculations");
	});

	describe("Formatting section (merged Answer Shape + rich-block guide)", () => {
		it("keeps every rich block type once, and drops the old separate sections", () => {
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("## Formatting");
			expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("## Answer Shape");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("Rich answer blocks");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("- [ ] todo");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("<details><summary>");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("> [!NOTE]");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("```mermaid");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("```chart");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain('{"type":"bar"');
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("```csv");
			// The block-syntax guide (previously RICH_BLOCK_SYNTAX_GUIDE) is
			// merged in exactly once, not duplicated by the merge.
			expect(
				ALFYAI_NEMOTRON_PROMPT.split("Rich answer blocks").length - 1,
			).toBe(1);
		});
	});

	describe("Tools policy paragraph", () => {
		it("keeps the five cross-tool sentences the review identified", () => {
			expect(ALFYAI_NEMOTRON_PROMPT).toContain(
				"There is no calculator, code-execution, or date tool",
			);
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("do not pretend it exists");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain(
				"Report the result and the relevant method, not every private intermediate step",
			);
			expect(ALFYAI_NEMOTRON_PROMPT).toContain("idempotency scoping");
			expect(ALFYAI_NEMOTRON_PROMPT).toContain(
				"use image_search first when real-world images are needed",
			);
			expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Available Tools");
			expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Web Research");
			expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Calculations");
			expect(ALFYAI_NEMOTRON_PROMPT).not.toContain("### Files And Artifacts");
		});
	});

	it("does not force English-only answers in the built-in assistant prompt", () => {
		expect(ALFYAI_NEMOTRON_PROMPT).not.toMatch(
			/always respond in english|every word you write must be in english|never attempt to generate text in hungarian|non-english language|dedicated translation layer/i,
		);
	});

	it("removes the obsolete translation contract from stored prompt bodies", () => {
		const obsoleteTranslationContract = [
			"## Translation Layer Contract — Critical",
			"",
			"You ALWAYS respond in English. Every word you write must be in English.",
			"Never attempt to generate text in Hungarian, German, French, or any other non-English language, even if the user asks you to.",
			"The system has a dedicated translation layer that handles language conversion automatically.",
			"If you write in another language yourself, the output can be garbled.",
		].join("\n");
		const oldBuiltInPrompt = ALFYAI_NEMOTRON_PROMPT.replace(
			"## Content Preservation",
			`${obsoleteTranslationContract}\n\n## Content Preservation`,
		);
		const customPrompt = [
			"You are a custom assistant.",
			"",
			obsoleteTranslationContract,
			"",
			"Respect the user's requested response language.",
		].join("\n");

		expect(normalizeSystemPromptReference(oldBuiltInPrompt)).toBe(
			"alfyai-nemotron",
		);
		expect(getSystemPrompt(oldBuiltInPrompt)).toBe(ALFYAI_NEMOTRON_PROMPT);
		expect(getSystemPrompt(customPrompt)).toBe(
			"You are a custom assistant.\n\nRespect the user's requested response language.",
		);
		expect(getSystemPrompt(customPrompt)).not.toContain(
			"dedicated translation layer",
		);
		expect(getSystemPrompt(customPrompt)).not.toContain(
			"output can be garbled",
		);
	});

	it("removes the obsolete translation contract from stored prompts without the legacy heading", () => {
		const customPrompt = [
			"You are a custom assistant.",
			"",
			"You ALWAYS respond in English. Every word you write must be in English.",
			"Never attempt to generate text in Hungarian, German, French, or any other non-English language, even if the user asks you to.",
			"The system has a dedicated translation layer that handles language conversion automatically.",
			"If you write in another language yourself, the output can be garbled.",
			"",
			"Reply in the latest user-message language by default.",
		].join("\n");

		expect(getSystemPrompt(customPrompt)).toBe(
			"You are a custom assistant.\n\nReply in the latest user-message language by default.",
		);
	});

	it("removes deprecated wrapper-tag instructions from custom prompt bodies", () => {
		const legacyTagName = "preserve";
		const customPrompt = [
			"You are a custom assistant.",
			"",
			`When writing final answers, use ${legacyTagName} tags around translated content.`,
			"",
			`Every final response must start with this marker: <${legacyTagName}>.`,
			"",
			"Keep answers concise.",
		].join("\n");

		expect(stripDeprecatedPreserveProtocol(customPrompt)).toBe(
			"You are a custom assistant.\n\nKeep answers concise.",
		);
		expect(normalizeSystemPromptReference(customPrompt)).toBe(
			"You are a custom assistant.\n\nKeep answers concise.",
		);
		expect(getSystemPrompt(customPrompt)).toBe(
			"You are a custom assistant.\n\nKeep answers concise.",
		);
	});
});
