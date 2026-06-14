import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractWebResearchPage,
	getWebResearchExtractionMetrics,
	resetWebResearchExtractionForTests,
} from "./extraction";

function htmlResponse(value: string): Response {
	return new Response(value, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

const articleHtml = `
<!doctype html>
<html>
	<head><title>Clean Search Extraction</title></head>
	<body>
		<nav>Home Pricing Sign in Changelog Careers Support</nav>
		<article>
			<h1>Clean Search Extraction</h1>
			<p>Search quality improves when the model receives source-derived Markdown instead of flattened page snippets.</p>
			<p>This article intentionally contains enough relevant body text for Readability to treat it as the primary content. It explains that headings, lists, tables, and code blocks help downstream evidence selection remain grounded in the opened page.</p>
			<ul>
				<li>Keep SearXNG for discovery.</li>
				<li>Use local Readability extraction first.</li>
			</ul>
			<table>
				<thead><tr><th>Layer</th><th>Role</th></tr></thead>
				<tbody><tr><td>SearXNG</td><td>Discovery</td></tr><tr><td>Readability</td><td>Extraction</td></tr></tbody>
			</table>
			<pre><code>const extractor = "readability";</code></pre>
			<p>The final paragraph repeats the implementation goal: preserve citations, preserve exact quote text, and avoid sending raw boilerplate to the answer model.</p>
		</article>
		<footer>Newsletter Terms Privacy Careers</footer>
	</body>
</html>`;

describe("web research extraction", () => {
	afterEach(() => {
		resetWebResearchExtractionForTests();
		vi.restoreAllMocks();
	});

	it("extracts source-derived markdown while preserving lists, tables, and code", async () => {
		const fetchMock = vi.fn(async () => htmlResponse(articleHtml));

		const result = await extractWebResearchPage({
			url: "https://docs.example.com/search-extraction",
			config: {
				webResearchExtractorMode: "readability",
				webResearchExtractCacheTtlHours: 0,
			},
			fetch: fetchMock,
		});

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Clean Search Extraction");
		expect(result?.markdown).toContain("# Clean Search Extraction");
		expect(result?.markdown).toMatch(/-\s+Keep SearXNG for discovery\./);
		expect(result?.markdown).toContain("| Layer | Role |");
		expect(result?.markdown).toContain("```");
		expect(result?.markdown).toContain('const extractor = "readability";');
		expect(result?.plainText).toContain("source-derived Markdown");
		expect(result?.plainText).not.toContain("Newsletter Terms Privacy Careers");
		expect(result?.quality.score).toBeGreaterThanOrEqual(0.45);
		expect(result?.diagnostics.extractor).toBe("readability");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves machine-readable timestamps from relative time elements", async () => {
		const fetchMock = vi.fn(async () =>
			htmlResponse(`
				<!doctype html>
				<html>
					<head><title>Release Notes</title></head>
					<body>
						<article>
							<h1>GitHub CLI 2.93.0</h1>
							<p>
								<relative-time datetime="2026-05-27T17:47:41Z">
									27 May 17:47
								</relative-time>
							</p>
							<p>This release note has enough source text for the local article extractor to preserve the release timestamp, version identifier, changelog facts, asset notes, and surrounding content without relying on a model to infer the missing year.</p>
							<p>The important regression is that the visible relative date keeps the machine-readable year from the datetime attribute.</p>
						</article>
					</body>
				</html>`),
		);

		const result = await extractWebResearchPage({
			url: "https://github.com/cli/cli/releases",
			config: {
				webResearchExtractorMode: "readability",
				webResearchExtractCacheTtlHours: 0,
			},
			fetch: fetchMock,
		});

		expect(result?.markdown).toContain("27 May 17:47 (2026-05-27T17:47:41Z)");
		expect(result?.plainText).toContain("2026-05-27T17:47:41Z");
	});

	it("rejects unsafe local URLs before fetch", async () => {
		const fetchMock = vi.fn();

		const result = await extractWebResearchPage({
			url: "http://127.0.0.1/private",
			config: {},
			fetch: fetchMock,
		});

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("serves repeated extractions from cache when the TTL allows it", async () => {
		const fetchMock = vi.fn(async () => htmlResponse(articleHtml));
		const config = {
			webResearchExtractorMode: "readability" as const,
			webResearchExtractCacheTtlHours: 1,
		};

		const first = await extractWebResearchPage({
			url: "https://docs.example.com/search-extraction",
			config,
			fetch: fetchMock,
			now: 1000,
		});
		const second = await extractWebResearchPage({
			url: "https://docs.example.com/search-extraction",
			config,
			fetch: fetchMock,
			now: 2000,
		});

		expect(first?.diagnostics.cacheHit).toBe(false);
		expect(second?.diagnostics.cacheHit).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getWebResearchExtractionMetrics()).toMatchObject({
			attemptedCount: 2,
			succeededCount: 2,
			cacheHitCount: 1,
			failedCount: 0,
		});
	});

	it("blocks unsafe redirects before following them", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "http://127.0.0.1/private" },
				}),
		);

		const result = await extractWebResearchPage({
			url: "https://redirect.example.com/page",
			config: {},
			fetch: fetchMock,
		});

		expect(result).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getWebResearchExtractionMetrics()).toMatchObject({
			blockedCount: 1,
			lastErrorCode: "unsafe_redirect",
		});
	});
});
