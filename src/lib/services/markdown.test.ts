import { describe, expect, it, vi } from "vitest";

vi.mock("shiki", () => ({
	createHighlighter: vi.fn().mockResolvedValue({
		codeToHtml: vi.fn().mockReturnValue("<pre><code>mocked</code></pre>"),
	}),
}));

vi.mock("jsdom", () => ({
	JSDOM: vi.fn().mockImplementation(() => ({
		window: {},
	})),
}));

vi.mock("dompurify", () => ({
	default: vi.fn().mockReturnValue({
		sanitize: vi.fn().mockImplementation((html: string) => html),
	}),
}));

describe("Markdown Rendering Service", () => {
	it("renderMarkdown is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.renderMarkdown).toBe("function");
	});

	it("renderHighlightedText is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.renderHighlightedText).toBe("function");
	});

	it("initHighlighter is exported as a function", async () => {
		const mod = await import("./markdown");
		expect(typeof mod.initHighlighter).toBe("function");
	});

	it("renders markdown links as new-tab external links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"[Source](https://example.com/page)",
			false,
		);

		expect(html).toContain('href="https://example.com/page"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer external"');
	});

	it("can render external source links as compact icon pills", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Example Source](https://example.com/page) for details.",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain('class="source-link-pill"');
		expect(html).toContain(
			'aria-label="Open source: Example Source - https://example.com/page"',
		);
		expect(html).toContain('class="source-link-pill__tooltip"');
		expect(html).toContain(
			'class="source-link-pill__name">Example Source</span>',
		);
		expect(html).toContain(
			'class="source-link-pill__url">https://example.com/page</span>',
		);
		expect(html).not.toContain(">Example Source</a>");
	});

	it("renders document frontmatter and Obsidian-style callouts while keeping local links non-navigating", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`---\ntitle: Client Notes\ntags:\n  - planning\n---\n\n> [!NOTE] Decision\n> Keep this visible.\n\n[Local](./draft.md) [[Wiki Link]] ![[Embed.png]]`,
			false,
		);

		expect(html).toContain("markdown-frontmatter");
		expect(html).toContain("Client Notes");
		expect(html).toContain("markdown-callout");
		expect(html).toContain("Decision");
		expect(html).not.toContain('href="./draft.md"');
		expect(html).toContain("[[Wiki Link]]");
		expect(html).toContain("![[Embed.png]]");
	});

	it("renders common reading structures for Markdown documents", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			`# Title\n\n## Section\n\n- Bullet\n- [x] Done\n\n1. First\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |`,
			false,
		);

		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<h2>Section</h2>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<ol>");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("markdown-table-wrap");
		expect(html).toContain("<th>Name</th>");
		expect(html).toContain("<td>Alpha</td>");
	});

	it("preserves Shiki inline styles for fenced code in rendered Markdown", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"```ts\nconst answer: number = 42;\n```",
			false,
		);

		expect(html).toContain("<pre");
		expect(html).toContain("style=");
		expect(html).toContain("answer");
	});
});
