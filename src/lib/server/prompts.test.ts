import { describe, expect, it } from "vitest";

import {
	ALFYAI_NEMOTRON_PROMPT,
	getSystemPrompt,
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

	it("normalizes the old fetch_content prompt body back to the current key", () => {
		const legacyPrompt = ALFYAI_NEMOTRON_PROMPT.replace(
			"| research_web | Search and retrieve web sources with citation-ready evidence (handles searching, page fetching, evidence extraction in one call) | Current facts, prices, availability, specs, policies, page-backed claims, comparisons, multi-source research |\n| memory_context | Retrieve durable memory, project context, persona memory, or account history | User preferences, project continuity, earlier decisions, generated reports, personal context |",
			"| search | Search the web for information | Current events, recent facts, product research, general-topic research, verification |\n| fetch_content | Fetch and read a specific URL | The user gives a link, search snippets are insufficient, or exact page details matter |",
		).replace(
			"Use research_web for web-backed research. It handles searching, page fetching, evidence extraction, and answer-brief assembly in one call — there is no separate search or fetch step.",
			"Use search for web research. Use fetch_content when the user gives a URL or when snippets are not enough.",
		);

		expect(normalizeSystemPromptReference(legacyPrompt)).toBe(
			"alfyai-nemotron",
		);
		expect(getSystemPrompt(legacyPrompt)).toBe(ALFYAI_NEMOTRON_PROMPT);
	});

	it("leaves custom prompt text untouched", () => {
		const customPrompt = "You are a custom assistant.";

		expect(normalizeSystemPromptReference(customPrompt)).toBe(customPrompt);
		expect(getSystemPrompt(customPrompt)).toBe(customPrompt);
	});

	it("teaches the unified produce_file contract in the built-in assistant prompt", () => {
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("produce_file");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("simple produce_file form");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("documentSource");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("program");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("markdown, content, or text");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain(
			'filename: "hungarian-parliament-news.md"',
		);
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("requestTitle");
		expect(ALFYAI_NEMOTRON_PROMPT).toContain("requestedOutputs");
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
