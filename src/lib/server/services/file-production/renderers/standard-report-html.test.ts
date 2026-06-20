import { describe, expect, it } from "vitest";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportHtml } from "./standard-report-html";

describe("AlfyAI Standard Report HTML renderer", () => {
	function renderFixtureHtml() {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Atlas Report",
			subtitle: "A prototype-aligned report.",
			blocks: [
				{ type: "heading", level: 2, text: "Executive Summary" },
				{ type: "paragraph", text: "Readable report content." },
				{
					type: "confidenceMarker",
					code: "atlas_audit_marker",
					label: "Partially Supported",
					severity: "warning",
					message:
						"Source [2] is directionally useful, but the report should avoid unsupported certainty until independent confirmation is available.",
				},
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{
							title: "Example docs",
							url: "https://example.com/docs",
							reasoning:
								"Fetched page excerpt: Shows the favicon fallback path. This sentence is extra page text that should not be dumped into the hover tooltip because the report should show compact reasoning.",
						},
						{
							title: "Local library note",
							reasoning: "Library-only sources still need a visible icon.",
							provided: true,
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) throw new Error("Fixture should validate");

		return renderStandardReportHtml(validation.source).content.toString("utf8");
	}

	it("renders source-owned HTML and escapes model text", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "HTML report",
			blocks: [
				{ type: "heading", level: 2, text: "Summary" },
				{
					type: "paragraph",
					text: '<script>alert("not markup")</script>',
				},
				{
					type: "list",
					style: "numbered",
					items: ["Escaped text remains visible"],
				},
				{
					type: "callout",
					tone: "tip",
					title: "Download check",
					text: "HTML callout remains readable.",
				},
				{
					type: "code",
					language: "html",
					text: "<section>safe text</section>",
				},
				{ type: "quote", text: "HTML quote text", citation: "QA" },
				{
					type: "table",
					title: "HTML table",
					columns: [{ key: "format", label: "Format", kind: "text" }],
					rows: [{ format: "Downloaded HTML" }],
				},
				{
					type: "chart",
					chartType: "line",
					title: "Weekly active users",
					caption: "Caption",
					altText: "Accessible chart summary.",
					units: "users",
					xKey: "week",
					yKey: "users",
					data: [{ week: "2026-W01", users: 1200 }],
				},
				{
					type: "image",
					source: { kind: "https", url: "https://example.com/image.png" },
					altText: "HTML image fallback",
					caption: "Image caption",
					sourceAttribution: {
						title: "Example image source",
						url: "https://example.com/image-source",
					},
				},
				{
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						{
							title: "Vendor docs",
							url: "https://example.com/docs",
							reasoning: "Compact reasoning belongs in the tooltip.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const rendered = renderStandardReportHtml(validation.source);

		expect(rendered.filename).toBe("html-report.html");
		expect(rendered.mimeType).toBe("text/html");
		expect(rendered.content.toString("utf8")).toContain("<!doctype html>");
		expect(rendered.content.toString("utf8")).toContain(
			'<meta name="alfyai-template" content="alfyai_standard_report" />',
		);
		expect(rendered.content.toString("utf8")).toContain(
			"&lt;script&gt;alert(&quot;not markup&quot;)&lt;/script&gt;",
		);
		expect(rendered.content.toString("utf8")).not.toContain("<script>alert");
		expect(rendered.content.toString("utf8")).toContain(
			"Escaped text remains visible",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"HTML callout remains readable.",
		);
		expect(rendered.content.toString("utf8")).not.toContain(
			'class="confidence-marker-row"',
		);
		expect(rendered.content.toString("utf8")).toContain(
			"&lt;section&gt;safe text&lt;/section&gt;",
		);
		expect(rendered.content.toString("utf8")).toContain("HTML quote text");
		expect(rendered.content.toString("utf8")).toContain("Downloaded HTML");
		expect(rendered.content.toString("utf8")).toContain(
			'data-chart-type="line"',
		);
		expect(rendered.content.toString("utf8")).toContain("HTML image fallback");
		expect(rendered.content.toString("utf8")).toContain("Example image source");
		expect(rendered.content.toString("utf8")).toContain(
			'<aside class="report-sidebar"',
		);
		expect(rendered.content.toString("utf8")).toContain(
			'<article class="report-content"',
		);
		expect(rendered.content.toString("utf8")).toContain("Libre Baskerville");
		expect(rendered.content.toString("utf8")).toContain("Nimbus Sans L");
		expect(rendered.content.toString("utf8")).toContain("report-section");
		expect(rendered.content.toString("utf8")).toContain("report-nav");
		expect(rendered.content.toString("utf8")).toContain(
			'<p class="source-subheading">Web Sources</p>',
		);
		expect(rendered.content.toString("utf8")).toContain(
			'<ul class="source-list">',
		);
		expect(rendered.content.toString("utf8")).toContain(
			"Compact reasoning belongs in the tooltip.",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"@media (prefers-color-scheme: dark)",
		);
		expect(rendered.content.toString("utf8")).toContain(
			"--report-text:#1B1815",
		);
		expect(rendered.content.toString("utf8")).toContain('fill="#1B1815"');
	});

	it("uses a prototype-like navigable report viewer shell", () => {
		const html = renderFixtureHtml();

		expect(html).toContain('<div class="report-viewer"');
		expect(html).toContain('<aside class="report-sidebar"');
		expect(html).toContain('<article class="report-content"');
		expect(html).toContain('<div class="mobile-report-header"');
		expect(html).toContain('<div class="sidebar-backdrop"');
		expect(html).toContain('class="report-sidebar-resizer"');
		expect(html).toContain('role="separator"');
		expect(html).toContain('href="#executive-summary-1"');
		expect(html).toContain('<section class="report-section"');
		expect(html).toContain("updateActiveSection");
		expect(html).toContain("pointerdown");
		expect(html).toContain("positionReportSidebar");
		expect(html).toContain("window.addEventListener('pointermove'");
		expect(html).toContain("getBoundingClientRect");
	});

	it("keeps report sidebar links inside the embedded report document", () => {
		const html = renderFixtureHtml();

		expect(html).toContain("event.preventDefault()");
		expect(html).toContain("target.scrollIntoView({ block: 'start' })");
		expect(html).not.toContain(
			"link.addEventListener('click', () => window.setTimeout(updateActiveSection, 120))",
		);
	});

	it("fills the viewport without report-card chrome when opened directly as standalone HTML", () => {
		const html = renderFixtureHtml();

		expect(html).toContain("html,body{");
		expect(html).toMatch(/min-height:100(?:dvh|vh)/);
		expect(html).toMatch(/body\{[^}]*padding:0/);
		expect(html).toContain(".report-viewer{");
		expect(html).toMatch(/\.report-viewer\{[^}]*min-height:100(?:dvh|vh)/);
		expect(html).toMatch(/\.report-viewer\{[^}]*max-width:none/);
		expect(html).toMatch(/\.report-viewer\{[^}]*border:0/);
		expect(html).toMatch(/\.report-viewer\{[^}]*border-radius:0/);
		expect(html).toMatch(/\.report-viewer\{[^}]*box-shadow:none/);
		expect(html).toMatch(/@media \(max-width: 760px\)\{[^}]*body\{/);
		expect(html).toMatch(
			/@media \(max-width: 760px\)\{[\s\S]*\.report-viewer\{[\s\S]*min-height:100(?:dvh|vh)/,
		);
	});

	it("renders visible globe fallbacks for missing or failed favicons", () => {
		const html = renderFixtureHtml();

		expect(html).toContain('class="favicon-placeholder"');
		expect(html).toContain("data-favicon-fallback");
		expect(html).toContain("[hidden]{display:none!important;}");
		expect(html).toContain('onerror="');
		expect(html).toContain('aria-label="Source 1: Example docs"');
		expect(html).toContain(
			'aria-label="Source 2: Local library note. You provided these."',
		);
		expect(html).toContain("<svg");
		expect(html).toContain('viewBox="0 0 24 24"');
		expect(html).toContain('stroke="currentColor"');
	});

	it("renders compact source reasoning instead of dumping fetched page text", () => {
		const html = renderFixtureHtml();

		expect(html).toContain("Shows the favicon fallback path.");
		expect(html).not.toContain("Fetched page excerpt:");
		expect(html).not.toContain(
			"This sentence is extra page text that should not be dumped",
		);
	});

	it("renders source pills inline and reserves text source lists for the final Sources section", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Sourced Atlas Report",
			blocks: [
				{ type: "heading", level: 2, text: "Executive Summary" },
				{
					type: "paragraph",
					text: "Surface code maturity is documented [1].",
					sources: [
						{
							title: "Uploaded strategy memo",
							reasoning: "Local evidence selected by Atlas.",
							provided: true,
						},
					],
				},
				{
					type: "sourceChips",
					title: "Section Sources",
					sources: [
						{
							title: "Section vendor note",
							url: "https://section.example.com/note",
							reasoning: "Relevant only to this paragraph.",
						},
					],
				},
				{ type: "heading", level: 2, text: "Sources" },
				{
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						{
							title: "Vendor docs",
							url: "https://example.com/docs",
							reasoning: "Official docs for current claims.",
						},
					],
				},
				{
					type: "sourceChips",
					title: "Your Library",
					sources: [
						{
							title: "Uploaded strategy memo",
							reasoning: "User-provided local evidence.",
							provided: true,
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);

		expect(html).toContain("Surface code maturity is documented ");
		expect(html).not.toContain("Surface code maturity is documented [1]");
		expect(html).toContain('class="inline-source-chips"');
		expect(html).toContain(
			'aria-label="Source 2: Uploaded strategy memo. You provided these."',
		);
		expect(html).not.toContain("source-chip-section");
		expect(html).not.toContain("source-chip-list");
		expect(html).toContain('<p class="source-subheading">Web Sources</p>');
		expect(html).toContain('<p class="source-subheading">Your Library</p>');
		expect(html).toContain('<ul class="source-list">');
		expect(html).toContain('class="source-item"');
		expect(html).toContain(">Vendor docs</a>");
		expect(html).toContain('<span class="source-domain">example.com</span>');
	});

	it("converts model-authored Source labels into inline source pills", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Labeled source report",
			blocks: [
				{ type: "heading", level: 2, text: "Findings" },
				{
					type: "paragraph",
					text: "The trend is current [Source 0] and cross-checked [Source 1].",
					sources: [
						{
							title: "First web result",
							url: "https://example.com/first",
							reasoning: "Selected for the current claim.",
						},
						{
							title: "Second web result",
							url: "https://example.com/second",
							reasoning: "Selected as corroborating evidence.",
						},
					],
				},
				{ type: "heading", level: 2, text: "Sources" },
				{
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						{
							title: "First web result",
							url: "https://example.com/first",
							reasoning: "Selected for the current claim.",
						},
						{
							title: "Second web result",
							url: "https://example.com/second",
							reasoning: "Selected as corroborating evidence.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);

		expect(html).toContain("The trend is current ");
		expect(html).not.toContain("[Source 0]");
		expect(html).not.toContain("[Source 1]");
		expect(html).toContain('aria-label="Source 1: First web result"');
		expect(html).toContain('aria-label="Source 2: Second web result"');
		const paragraphHtml =
			/<p>The trend is current[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
		expect(paragraphHtml).not.toContain('class="inline-source-chips"');
		expect(paragraphHtml.match(/class="source-chip"/g) ?? []).toHaveLength(2);
	});

	it("converts explicit global-style source labels when a paragraph has one local source", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Global source label report",
			blocks: [
				{ type: "heading", level: 2, text: "Findings" },
				{
					type: "paragraph",
					text: "Inline sections should carry source icons where relevant [Source 2].",
					sources: [
						{
							title: "Third web result",
							url: "https://example.com/third",
							reasoning: "Selected as paragraph-local evidence.",
						},
					],
				},
				{ type: "heading", level: 2, text: "Sources" },
				{
					type: "sourceChips",
					title: "Web Sources",
					sources: [
						{
							title: "First web result",
							url: "https://example.com/first",
							reasoning: "Report-wide source before the local citation.",
						},
						{
							title: "Second web result",
							url: "https://example.com/second",
							reasoning: "Report-wide source before the local citation.",
						},
						{
							title: "Third web result",
							url: "https://example.com/third",
							reasoning: "Selected as paragraph-local evidence.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);
		const paragraphHtml =
			/<p>Inline sections should carry source icons where relevant[\s\S]*?<\/p>/.exec(
				html,
			)?.[0] ?? "";

		expect(paragraphHtml).not.toContain("[Source 2]");
		expect(paragraphHtml).toContain('aria-label="Source 3: Third web result"');
		expect(paragraphHtml).toContain('data-source-number="3"');
		expect(paragraphHtml).not.toContain('class="inline-source-chips"');
		expect(paragraphHtml.match(/class="source-chip"/g) ?? []).toHaveLength(1);
	});

	it("converts Hungarian explicit source labels when a paragraph has one local source", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			language: "hu",
			title: "Magyar forrásjelentés",
			blocks: [
				{ type: "heading", level: 2, text: "Megállapítások" },
				{
					type: "paragraph",
					text: "A bekezdés forrásikont kap [Forrás 2].",
					sources: [
						{
							title: "Harmadik webes forrás",
							url: "https://example.com/harmadik",
							reasoning: "Bekezdésszintű bizonyíték.",
						},
					],
				},
				{ type: "heading", level: 2, text: "Források" },
				{
					type: "sourceChips",
					title: "Webes források",
					sources: [
						{
							title: "Első webes forrás",
							url: "https://example.com/elso",
							reasoning: "Jelentésszintű forrás.",
						},
						{
							title: "Második webes forrás",
							url: "https://example.com/masodik",
							reasoning: "Jelentésszintű forrás.",
						},
						{
							title: "Harmadik webes forrás",
							url: "https://example.com/harmadik",
							reasoning: "Bekezdésszintű bizonyíték.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);
		const paragraphHtml =
			/<p>A bekezdés forrásikont kap[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";

		expect(paragraphHtml).not.toContain("[Forrás 2]");
		expect(paragraphHtml).toContain(
			'aria-label="Forrás 3: Harmadik webes forrás"',
		);
		expect(paragraphHtml).toContain('data-source-number="3"');
		expect(paragraphHtml).not.toContain('class="inline-source-chips"');
		expect(paragraphHtml.match(/class="source-chip"/g) ?? []).toHaveLength(1);
	});

	it("removes a duplicate first heading that repeats the report title", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			title: "Duplicate Title Report",
			blocks: [
				{ type: "heading", level: 2, text: "Duplicate Title Report" },
				{ type: "heading", level: 2, text: "Executive Summary" },
				{ type: "paragraph", text: "The first visible section remains." },
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);

		expect(html).toContain(
			'<h1 class="report-title">Duplicate Title Report</h1>',
		);
		expect(html).not.toMatch(/href="#duplicate-title-report-\d+"/);
		expect(html).not.toMatch(/<h2[^>]*>Duplicate Title Report<\/h2>/);
		expect(html).toMatch(/href="#executive-summary-\d+"/);
		expect(html).toMatch(
			/<section class="report-section" id="executive-summary-\d+"><h2>Executive Summary<\/h2>/,
		);
	});

	it("renders source tooltips with theme tokens, favicon content, and viewport-aware positioning", () => {
		const html = renderFixtureHtml();

		expect(html).toContain("--report-tooltip-bg:");
		expect(html).toContain("--report-tooltip-text:");
		expect(html).toContain("html.dark{color-scheme:dark;");
		expect(html).toContain(".source-tooltip{position:fixed;");
		expect(html).toContain(".honesty-tooltip{position:fixed;");
		expect(html).toContain("positionFloatingTooltips");
		expect(html).toContain("report-sidebar");
		expect(html).toContain("source-tooltip-head");
		expect(html).toContain('<span class="source-favicon"><img');
		expect(html).toContain("source-tooltip-reason");
	});

	it("localizes viewer chrome and final source groups for Hungarian reports", () => {
		const validation = validateGeneratedDocumentSource({
			version: 1,
			template: "alfyai_standard_report",
			language: "hu",
			title: "Magyar Atlas jelentés",
			blocks: [
				{ type: "heading", level: 2, text: "Vezetői összefoglaló" },
				{
					type: "paragraph",
					text: "A megállapítás forrásokkal alátámasztott [1].",
				},
				{ type: "heading", level: 2, text: "Források" },
				{
					type: "sourceChips",
					title: "Webes források",
					sources: [
						{
							title: "Példa forrás",
							url: "https://example.com/hu",
							reasoning: "Az Atlas által elfogadott webes bizonyíték.",
						},
					],
				},
				{
					type: "sourceChips",
					title: "Saját könyvtár",
					sources: [
						{
							title: "Feltöltött jegyzet",
							provided: true,
							reasoning: "A felhasználó adta meg.",
						},
					],
				},
			],
		});
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const html = renderStandardReportHtml(validation.source).content.toString(
			"utf8",
		);

		expect(html).toContain('<html lang="hu">');
		expect(html).toContain('aria-label="Jelentésszakaszok"');
		expect(html).toContain('aria-label="Szakaszmenü megnyitása"');
		expect(html).toContain("Szakaszok");
		expect(html).toContain('<p class="source-subheading">Webes források</p>');
		expect(html).toContain('<p class="source-subheading">Saját könyvtár</p>');
		expect(html).toContain('aria-label="Forrás 1: Példa forrás"');
		expect(html).toContain("saját könyvtár");
		expect(html).not.toContain(
			'<span class="inline-source-chips" aria-label="Webes források"',
		);
	});

	it("renders structured confidence markers with backend metadata in hover tooltips", () => {
		const html = renderFixtureHtml();

		expect(html).toContain('class="honesty-marker partial"');
		expect(html).toContain('class="honesty-tooltip"');
		expect(html).toContain('data-confidence-code="atlas_audit_marker"');
		expect(html).toContain('data-confidence-severity="warning"');
		expect(html).toContain("Partially Supported");
		expect(html).toContain("unsupported certainty");
		expect(html).toContain(".honesty-marker:hover .honesty-tooltip");
		expect(html).not.toContain("confidence-marker-row");
	});
});
