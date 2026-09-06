import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
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
	it("records a generic source-check notice when researched answers omit citations", () => {
		const response = "The current price is $799.";
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

		expect(result.audit).toMatchObject({
			status: "missing_citations",
			noticeAppended: false,
		});
		expect(result.appendedNotice).toContain("Source check:");
		expect(result.response).toBe(response);
		expect(result.response).not.toContain("Retrieved sources");
		expect(result.response).not.toContain("Official Product");
		expect(result.response).not.toContain("https://example.com/product");
	});

	it("auto-repairs a same-domain unsupported citation by rewriting it to the retrieved source's URL", () => {
		// A same-registrable-domain mismatch (wrong path on example.com) is
		// repaired in place — the citation now passes instead of triggering a
		// quality notice.
		const response = "See [wrong page](https://example.com/wrong).";
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

		expect(result.response).toBe(
			"See [wrong page](https://example.com/product).",
		);
		expect(result.repair).toEqual({
			cited: 1,
			verified: 0,
			repaired: 1,
			stripped: 0,
		});
		expect(result.audit).toMatchObject({
			status: "passed",
			unsupportedCitationCount: 0,
		});
		expect(result.appendedNotice).toBeNull();
	});

	it("auto-repairs a citation to an unrelated domain by stripping the link markup and keeping the text", () => {
		const response = "See [an unrelated page](https://other-domain.test/x).";
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

		expect(result.response).toBe("See an unrelated page.");
		expect(result.repair).toEqual({
			cited: 1,
			verified: 0,
			repaired: 0,
			stripped: 1,
		});
		// With the only citation stripped, this now reads as "researched but
		// no source-backed link survived" rather than "unsupported citation".
		expect(result.audit).toMatchObject({
			status: "missing_citations",
			citedUrlCount: 0,
		});
		expect(result.appendedNotice).toContain("did not include source links");
	});

	it("does not touch a URL the user pasted in their own message, even when it matches no retrieved source", () => {
		const response = "See [your link](https://other-domain.test/x).";
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
			userMessage: "What does https://other-domain.test/x say?",
		});

		expect(result.response).toBe(response);
		expect(result.repair).toEqual({
			cited: 0,
			verified: 0,
			repaired: 0,
			stripped: 0,
		});
	});

	it("leaves the response untouched and reports no repair when no web tool ran this turn", () => {
		const response = "See [some link](https://other-domain.test/x).";
		const result = applyWebCitationQualityGate({
			assistantResponse: response,
			toolCalls: [],
		});

		expect(result.response).toBe(response);
		expect(result.repair).toBeNull();
	});

	it("leaves the response untouched (byte-for-byte) when every citation is already supported", () => {
		const response =
			"See [official page](https://example.com/product) for details.";
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

		expect(result.response).toBe(response);
		expect(result.repair).toEqual({
			cited: 1,
			verified: 1,
			repaired: 0,
			stripped: 0,
		});
		expect(result.audit?.status).toBe("passed");
	});

	it("records a source-failure notice when zero-source web research is followed by a citation", () => {
		const response =
			"Reuters says this is current: https://www.reuters.com/world/example.";
		const result = applyWebCitationQualityGate({
			assistantResponse: response,
			toolCalls: [researchTool([])],
		});

		expect(result.audit).toMatchObject({
			status: "unsupported_citations",
			retrievedSourceCount: 0,
			citedUrlCount: 1,
			unsupportedCitationCount: 1,
			noticeAppended: false,
		});
		expect(result.appendedNotice).toContain("returned no retrievable sources");
		expect(result.appendedNotice).toContain(
			"were not verified by the web research tool",
		);
		expect(result.response).toBe(response);
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
