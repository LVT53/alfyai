import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeHtml } from "./html-sanitizer";

describe("sanitizeHtml rich-block allowlist", () => {
	// A3 accordion: the chosen source syntax is raw <details>/<summary> HTML
	// passthrough. These must survive DOMPurify so the collapsible renders.
	it("keeps <details>/<summary> and the open attribute for accordions", () => {
		const out = sanitizeHtml(
			"<details open><summary>More</summary><p>body</p></details>",
		);
		expect(out).toContain("<details");
		expect(out).toContain("<summary>More</summary>");
		expect(out).toContain("open");
		expect(out).toContain("<p>body</p>");
	});

	// A3 checklist: GFM task lists render <input type="checkbox"> in the prose
	// path (e.g. document previews). Confirm the checkbox and its state survive.
	it("keeps task-list checkbox inputs with type and checked", () => {
		const out = sanitizeHtml(
			'<ul><li><input type="checkbox" checked>done</li></ul>',
		);
		expect(out).toContain("<input");
		expect(out).toContain('type="checkbox"');
		expect(out).toContain("checked");
	});

	it("keeps the markdown-table wrapper markup", () => {
		const out = sanitizeHtml(
			'<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr><th>A</th></tr></thead></table></div>',
		);
		expect(out).toContain('class="markdown-table-wrap"');
		expect(out).toContain('class="markdown-table"');
		expect(out).toContain("<th>A</th>");
	});

	it("strips <script> tags", () => {
		const out = sanitizeHtml(
			"<details><summary>x</summary><script>alert(1)</script></details>",
		);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert(1)");
	});

	it("strips inline event handlers on allowed rich-block tags", () => {
		const out = sanitizeHtml(
			'<details onclick="steal()"><summary>x</summary></details>',
		);
		expect(out).toContain("<details");
		expect(out).not.toContain("onclick");
	});

	it("strips style attributes by default", () => {
		const out = sanitizeHtml('<summary style="position:fixed">x</summary>');
		expect(out).not.toContain("style=");
	});
});

describe("html utilities", () => {
	it("escapes HTML-sensitive characters with the default apostrophe entity", () => {
		expect(escapeHtml(`Tom & "Jerry" <'tag'>`)).toBe(
			"Tom &amp; &quot;Jerry&quot; &lt;&#39;tag&#39;&gt;",
		);
	});

	it("preserves legacy apostrophe entity spelling when requested", () => {
		expect(escapeHtml(`it's`, { apostropheEntity: "&#039;" })).toBe(
			"it&#039;s",
		);
	});
});
