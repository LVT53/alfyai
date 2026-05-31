import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildStaticHtmlPreviewSrcdoc,
	renderCsvPreviewHtml,
	renderTextPreview,
} from "./index";

const markdownMocks = vi.hoisted(() => ({
	renderHighlightedText: vi.fn(
		async (content: string, language: string | undefined, isDark: boolean) =>
			`highlighted:${language}:${isDark}:${content}`,
	),
	renderMarkdown: vi.fn(
		async (content: string, isDark: boolean) => `markdown:${isDark}:${content}`,
	),
}));

vi.mock("$lib/utils/markdown-loader", () => markdownMocks);

describe("text preview adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders quoted CSV as an escaped preview table", () => {
		const html = renderCsvPreviewHtml(
			'Name,Notes\n"Alfy, Inc.","Uses ""quotes"" & <tags>"',
		);

		expect(html).toContain('<table class="csv-table">');
		expect(html).toContain("<td>Alfy, Inc.</td>");
		expect(html).toContain("Uses &quot;quotes&quot; &amp; &lt;tags&gt;");
	});

	it("delegates Markdown and highlighted text through the shared markdown loader", async () => {
		await expect(
			renderTextPreview(
				{
					kind: "text",
					blob: new Blob(["# Title"]),
					text: "# Title",
					textKind: "markdown",
					language: "markdown",
				},
				{ isDark: true },
			),
		).resolves.toEqual({
			kind: "markdown",
			html: "markdown:true:# Title",
		});
		expect(markdownMocks.renderMarkdown).toHaveBeenCalledWith("# Title", true);

		await expect(
			renderTextPreview(
				{
					kind: "text",
					blob: new Blob(["const answer = 42;"]),
					text: "const answer = 42;",
					textKind: "highlighted",
					language: "typescript",
				},
				{ isDark: false },
			),
		).resolves.toEqual({
			kind: "highlighted",
			html: "highlighted:typescript:false:const answer = 42;",
		});
		expect(markdownMocks.renderHighlightedText).toHaveBeenCalledWith(
			"const answer = 42;",
			"typescript",
			false,
		);
	});

	it("builds static HTML srcdoc with sanitized markup and local CSS", () => {
		const srcdoc = buildStaticHtmlPreviewSrcdoc(`
			<style>
				@import "https://evil.test/style.css";
				body { background: url("javascript:alert(1)"); width: expression(alert(1)); }
				p::before { content: "<"; }
			</style>
			<script>alert("xss")</script>
			<p style="color: red" onclick="alert(1)">Preview</p>
		`);

		expect(srcdoc).toContain('<base target="_blank">');
		expect(srcdoc).toContain('<p style="color: red">Preview</p>');
		expect(srcdoc).not.toContain("<script");
		expect(srcdoc).not.toContain("onclick");
		expect(srcdoc).not.toContain("@import");
		expect(srcdoc).not.toContain("url(");
		expect(srcdoc).not.toContain("expression");
		expect(srcdoc).not.toContain("javascript:");
		expect(srcdoc).not.toContain('content: "<"');
	});
});
