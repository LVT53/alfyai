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

	it("auto-repairs a same-host citation to the source sharing the longest path prefix", () => {
		// Same host AND a shared "/product" path prefix, so the closest
		// retrieved page is an honest repoint — the citation now passes
		// instead of triggering a quality notice. The unrelated /support page
		// on the same host shares no path segment and must not win.
		const response = "See [wrong page](https://example.com/product/old).";
		const result = applyWebCitationQualityGate({
			assistantResponse: response,
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Support",
						url: "https://example.com/support/contact",
						sourceType: "web",
					},
					{
						id: "src-2",
						title: "Official Product",
						url: "https://example.com/product/price",
						sourceType: "web",
					},
				]),
			],
		});

		expect(result.response).toBe(
			"See [wrong page](https://example.com/product/price).",
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

	it("strips (never repoints) a same-host citation when no source shares a path segment with it", () => {
		// Right domain, unrelated page: repointing here would silently pass
		// off /product as the source for a claim about /pricing.
		const response = "See [pricing page](https://example.com/pricing).";
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

		expect(result.response).toBe("See pricing page.");
		expect(result.repair).toEqual({
			cited: 1,
			verified: 0,
			repaired: 0,
			stripped: 1,
		});
	});

	it("strips (never repoints) a same-host citation when two sources tie on the longest shared path prefix", () => {
		// Both candidates share exactly "/product" with the broken URL, so
		// there is no closest page to pick — plain text is the honest result.
		const response = "See [wrong page](https://example.com/product/old).";
		const result = applyWebCitationQualityGate({
			assistantResponse: response,
			toolCalls: [
				researchTool([
					{
						id: "src-1",
						title: "Product Price",
						url: "https://example.com/product/price",
						sourceType: "web",
					},
					{
						id: "src-2",
						title: "Product Specs",
						url: "https://example.com/product/specs",
						sourceType: "web",
					},
				]),
			],
		});

		expect(result.response).toBe("See wrong page.");
		expect(result.repair).toEqual({
			cited: 1,
			verified: 0,
			repaired: 0,
			stripped: 1,
		});
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

	it("never rewrites or strips image markdown", () => {
		// `![alt](url)` is not a citation claim: repairing it would repoint the
		// image at an HTML page, and stripping it would leave a stray `!alt`.
		const response =
			"![a chart](https://cdn.other.test/chart.png) and ![on-domain](https://example.com/diagram.png)";
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
			cited: 0,
			verified: 0,
			repaired: 0,
			stripped: 0,
		});
	});

	it("never rewrites or strips links inside fenced code blocks or inline code", () => {
		// Link syntax inside code is content the user asked for, not a citation.
		const response = [
			"Write this:",
			"",
			"```md",
			"[docs](https://unrelated.test/page)",
			"```",
			"",
			"or inline: `[docs](https://unrelated.test/page)`.",
		].join("\n");
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
			cited: 0,
			verified: 0,
			repaired: 0,
			stripped: 0,
		});
	});

	it("still repairs a real citation that follows a protected code block", () => {
		const result = applyWebCitationQualityGate({
			assistantResponse:
				"```\n[sample](https://unrelated.test/page)\n```\n\nSee [wrong page](https://example.com/product/old).",
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
			"```\n[sample](https://unrelated.test/page)\n```\n\nSee [wrong page](https://example.com/product).",
		);
		expect(result.repair).toMatchObject({ cited: 1, repaired: 1 });
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
