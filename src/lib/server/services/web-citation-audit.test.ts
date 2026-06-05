import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/types";
import {
	applyWebCitationQualityGate,
	buildWebCitationAudit,
} from "./web-citation-audit";

function researchTool(candidates: ToolCallEntry["candidates"]): ToolCallEntry {
	return {
		name: "research_web",
		input: { query: "current price" },
		status: "done",
		sourceType: "web",
		outputSummary: "Found sources",
		candidates,
	};
}

describe("buildWebCitationAudit", () => {
	it("passes when final citations exactly match research_web sources", () => {
		const audit = buildWebCitationAudit({
			assistantResponse:
				"The current price is listed on the [official page](https://example.com/product?utm_source=chat).",
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://www.example.com/product",
						snippet: "Current price details.",
						sourceType: "web",
					},
				]),
			],
		});

		expect(audit).toMatchObject({
			status: "passed",
			retrievedSourceCount: 1,
			citedUrlCount: 1,
			supportedCitationCount: 1,
			unsupportedCitationCount: 0,
		});
		expect(audit?.citations[0]).toMatchObject({
			supported: true,
			matchType: "exact",
			matchedSourceId: "src-1",
		});
	});

	it("warns when research_web was used but the answer has no citations", () => {
		const audit = buildWebCitationAudit({
			assistantResponse: "The current price is $799.",
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://example.com/product",
						sourceType: "web",
					},
				]),
			],
		});

		expect(audit).toMatchObject({
			status: "missing_citations",
			retrievedSourceCount: 1,
			citedUrlCount: 0,
		});
	});

	it("flags unsupported final citations and records host-only matches separately", () => {
		const audit = buildWebCitationAudit({
			assistantResponse:
				"See [homepage](https://example.com/) and [other](https://other.example.net/page).",
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://example.com/product",
						sourceType: "web",
					},
				]),
			],
		});

		expect(audit?.status).toBe("unsupported_citations");
		expect(audit?.unsupportedCitationCount).toBe(2);
		expect(audit?.citations.map((citation) => citation.matchType)).toEqual([
			"host",
			"none",
		]);
	});

	it("returns null when no web research source or final citation exists", () => {
		expect(
			buildWebCitationAudit({
				assistantResponse: "No web claims here.",
				toolCalls: [],
			}),
		).toBeNull();
	});
});

describe("applyWebCitationQualityGate", () => {
	it("appends a generic source-check notice when researched answers omit citations", () => {
		const result = applyWebCitationQualityGate({
			assistantResponse: "The current price is $799.",
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://example.com/product",
						sourceType: "web",
					},
				]),
			],
		});

		expect(result.audit).toMatchObject({
			status: "missing_citations",
			noticeAppended: true,
		});
		expect(result.appendedNotice).toContain("Source check:");
		expect(result.response).toContain("web research");
		expect(result.response).not.toContain("Retrieved sources");
		expect(result.response).not.toContain("Official Product");
		expect(result.response).not.toContain("https://example.com/product");
	});

	it("appends a generic caution notice when citations were not retrieved sources", () => {
		const result = applyWebCitationQualityGate({
			assistantResponse: "See [wrong page](https://example.com/wrong).",
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://example.com/product",
						sourceType: "web",
					},
				]),
			],
		});

		expect(result.audit).toMatchObject({
			status: "unsupported_citations",
			unsupportedCitationCount: 1,
			noticeAppended: true,
		});
		expect(result.response).toContain("Treat unsupported links cautiously");
		expect(result.response).not.toContain("Retrieved sources");
		expect(result.response).not.toContain("Official Product");
		expect(result.response).not.toContain("https://example.com/product");
	});

	it("appends a source-failure notice when zero-source web research is followed by a citation", () => {
		const result = applyWebCitationQualityGate({
			assistantResponse:
				"Reuters says this is current: https://www.reuters.com/world/example.",
			toolCalls: [researchTool([])],
		});

		expect(result.audit).toMatchObject({
			status: "unsupported_citations",
			retrievedSourceCount: 0,
			citedUrlCount: 1,
			unsupportedCitationCount: 1,
			noticeAppended: true,
		});
		expect(result.appendedNotice).toContain("returned no retrievable sources");
		expect(result.response).toContain(
			"were not verified by the web research tool",
		);
	});

	it("leaves clean citations unchanged", () => {
		const response = "See [official page](https://example.com/product).";
		const result = applyWebCitationQualityGate({
			assistantResponse: response,
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Official Product",
						url: "https://example.com/product",
						sourceType: "web",
					},
				]),
			],
		});

		expect(result.audit?.status).toBe("passed");
		expect(result.appendedNotice).toBeNull();
		expect(result.response).toBe(response);
	});
});
