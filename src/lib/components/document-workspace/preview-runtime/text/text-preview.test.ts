import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildStaticHtmlPreviewSrcdoc,
	buildTrustedHtmlPreviewSrcdoc,
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

	it("applies the local CSS sanitizer to inline style attributes", () => {
		const srcdoc = buildStaticHtmlPreviewSrcdoc(`
			<p style="color: blue; background-image: url('https://evil.test/track.png'); width: expression(alert(1));">Preview</p>
		`);

		expect(srcdoc).toContain("color: blue");
		expect(srcdoc).not.toContain("https://evil.test");
		expect(srcdoc).not.toContain("url(");
		expect(srcdoc).not.toContain("expression");
	});

	it("removes image-set resource loads from local CSS and inline styles", () => {
		const srcdoc = buildStaticHtmlPreviewSrcdoc(`
			<style>
				body { background-image: image-set("https://evil.test/a.png" 1x); }
			</style>
			<p style="background-image: -webkit-image-set('https://evil.test/b.png' 1x); color: green;">Preview</p>
		`);

		expect(srcdoc).toContain("color: green");
		expect(srcdoc).not.toContain("image-set");
		expect(srcdoc).not.toContain("https://evil.test");
	});

	it("preserves report scripts only for trusted HTML runtime previews", async () => {
		await expect(
			renderTextPreview({
				kind: "html",
				blob: new Blob([
					"<main>Report</main><script>window.ready=true</script>",
				]),
				text: "<main>Report</main><script>window.ready=true</script>",
				trustedRuntime: false,
			}),
		).resolves.toMatchObject({
			kind: "html",
			trustedRuntime: false,
			srcdoc: expect.not.stringContaining("<script>window.ready=true</script>"),
		});

		const trusted = await renderTextPreview({
			kind: "html",
			blob: new Blob(["<main>Report</main><script>window.ready=true</script>"]),
			text: "<main>Report</main><script>window.ready=true</script>",
			trustedRuntime: true,
		});

		expect(trusted).toMatchObject({
			kind: "html",
			trustedRuntime: true,
			srcdoc: expect.stringContaining("<script>window.ready=true</script>"),
		});
		if (trusted.kind !== "html") {
			throw new Error("Expected trusted HTML preview");
		}
		expect(trusted.srcdoc).toContain(`http-equiv="Content-Security-Policy"`);
		expect(trusted.srcdoc).toContain("script-src 'unsafe-inline'");
	});

	// ADR-0068: the same rule as the header the report is served with. A report
	// holds its pictures as data: URIs, so the policy it is previewed under has no
	// remote address in it.
	it("allows a trusted report pictures from itself only, in the meta policy as in the header", () => {
		for (const html of [
			"<!doctype html><html><head><title>Report</title></head><body></body></html>",
			"<html><body>Report</body></html>",
			"<main>Report</main>",
		]) {
			const srcdoc = buildTrustedHtmlPreviewSrcdoc(html);
			const policy = /content="([^"]+)"/.exec(srcdoc)?.[1] ?? "";
			expect(policy).toContain("img-src data:;");
			expect(policy).not.toMatch(/\bhttps?:/);
		}
	});

	// Read aloud's bridge (`$lib/client/read-aloud/report-bridge.ts`): the one
	// script of the app's own a report's frame runs, added at preview time to the
	// trusted srcdoc and to nothing else, so a report made before it gets it too.
	describe("read aloud's bridge", () => {
		// `$&`, `$1` and `` $` `` would be replacement patterns to `String.replace`.
		const BRIDGE = '<script nonce="n0nce">bridge("$&$1$`")</script>';
		const REPORT =
			"<!doctype html><html><head><title>Report</title></head><body><main>Report</main><script>window.ready=true</script></body></html>";
		const html = (text: string, trustedRuntime: boolean) => ({
			kind: "html" as const,
			blob: new Blob([text]),
			text,
			trustedRuntime,
		});
		const srcdocOf = (result: Awaited<ReturnType<typeof renderTextPreview>>) =>
			result.kind === "html" && "srcdoc" in result ? result.srcdoc : "";

		it("goes last in a trusted report's body, exactly as given", () => {
			const srcdoc = buildTrustedHtmlPreviewSrcdoc(REPORT, BRIDGE);
			expect(srcdoc).toContain(
				`<script>window.ready=true</script>${BRIDGE}</body></html>`,
			);
			expect(srcdoc.match(/bridge\(/g)).toHaveLength(1);
			expect(srcdoc).toContain(`http-equiv="Content-Security-Policy"`);
		});

		it("goes inside the body of a report that has no body tag", () => {
			expect(
				buildTrustedHtmlPreviewSrcdoc("<main>Report</main>", BRIDGE),
			).toMatch(
				/<main>Report<\/main><script nonce="n0nce">bridge\("\$&\$1\$`"\)<\/script><\/body><\/html>$/,
			);
			expect(
				buildTrustedHtmlPreviewSrcdoc("<html><p>Report</p></html>", BRIDGE),
			).toContain(`<p>Report</p>${BRIDGE}</html>`);
		});

		it("is in a trusted preview only when it is asked for", async () => {
			expect(
				srcdocOf(
					await renderTextPreview(html(REPORT, true), {
						readAloudBridge: BRIDGE,
					}),
				),
			).toContain(BRIDGE);
			expect(
				srcdocOf(await renderTextPreview(html(REPORT, true))),
			).not.toContain("bridge(");
		});

		it("never reaches a static preview", async () => {
			const srcdoc = srcdocOf(
				await renderTextPreview(html(REPORT, false), {
					readAloudBridge: BRIDGE,
				}),
			);
			expect(srcdoc).toContain("Report");
			expect(srcdoc).not.toContain("bridge(");
			expect(srcdoc).not.toContain("n0nce");
		});
	});

	it("injects a constrained CSP into trusted full HTML reports", () => {
		const srcdoc = buildTrustedHtmlPreviewSrcdoc(
			"<!doctype html><html><head><title>Report</title></head><body><script>window.ready=true</script></body></html>",
		);

		expect(srcdoc).toContain("<title>Report</title>");
		expect(srcdoc).toContain("<script>window.ready=true</script>");
		expect(srcdoc).toContain("default-src 'none'");
		expect(srcdoc).toContain("</head><body>");
	});
});
