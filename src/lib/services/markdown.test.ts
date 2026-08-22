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

	it("can render external source links as compact labeled chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Example Source](https://example.com/page) for details.",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain('class="source-link-chip"');
		expect(html).toContain(
			'aria-label="Open source: Example Source - https://example.com/page"',
		);
		expect(html).toContain(
			'class="source-link-chip__label">Example Source</span>',
		);
		expect(html).toContain('class="source-link-chip__favicon"');
		// Privacy (C1): the favicon must be served from the app's same-origin
		// /api/favicon proxy, never leaked to a third-party favicon service.
		expect(html).toContain('src="/api/favicon?domain=example.com"');
		expect(html).not.toContain("google.com");
		expect(html).toContain('alt=""');
		expect(html).toContain('class="source-link-chip__icon"');
		expect(html).not.toContain(">Example Source</a>");
	});

	describe("image loading skeleton (C4)", () => {
		it("wraps an embedded image in a loading skeleton frame", async () => {
			const mod = await import("./markdown");
			const html = await mod.renderMarkdown(
				"![a diagram](https://example.com/diagram.png)",
				false,
			);

			// The image is wrapped in a skeleton frame that starts in the loading
			// state, so a slow image reserves space + shimmers instead of shifting.
			expect(html).toContain(
				'class="markdown-image-frame markdown-image-frame--loading"',
			);
			expect(html).toContain('class="markdown-image"');
			expect(html).toContain('src="https://example.com/diagram.png"');
			expect(html).toContain('alt="a diagram"');
			// Lazy/async decoding hints stay on the image.
			expect(html).toContain('loading="lazy"');
		});
	});

	describe("sourceFaviconUrl (C1 — favicon privacy)", () => {
		it("routes through the same-origin /api/favicon proxy, never google.com", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			const url = sourceFaviconUrl("https://example.com/page");
			expect(url).toBe("/api/favicon?domain=example.com");
			expect(url).not.toContain("google.com");
		});

		it("strips a leading www. from the host (mirrors getFaviconUrl)", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			expect(sourceFaviconUrl("https://www.nytimes.com/x")).toBe(
				"/api/favicon?domain=nytimes.com",
			);
		});

		it("encodes non-ASCII / punycode-eligible hosts safely", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			const url = sourceFaviconUrl("https://sub.example.co.uk/path?q=1");
			expect(url).toBe("/api/favicon?domain=sub.example.co.uk");
		});

		it("returns null on a non-web / unparseable href (contract preserved)", async () => {
			const { sourceFaviconUrl } = await import("./markdown");
			expect(sourceFaviconUrl("not a url")).toBeNull();
			expect(sourceFaviconUrl("javascript:alert(1)")).toBeNull();
			expect(sourceFaviconUrl("")).toBeNull();
		});
	});

	it("renders compact source chips with a hidden globe favicon fallback", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [Example Source](https://example.com/page) for details.",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain('class="source-link-chip__favicon"');
		expect(html).toContain(
			'<span class="source-link-chip__favicon-fallback" aria-hidden="true" hidden=""></span>',
		);
		expect(html).toContain('class="source-link-chip__icon"');
		expect(html).not.toContain("onerror=");
	});

	it("renders inline compact source references as source link chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Alpha claim (S2).\n\nSources: [S2](https://example.com/source)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain("Alpha claim ");
		expect(html).toContain('href="https://example.com/source"');
		expect(html).toContain('class="source-link-chip"');
		expect(html).toContain('class="source-link-chip__label">S2</span>');
		expect(html).not.toContain("(S2)");
	});

	it("can render inline source references from candidates derived from the full assistant message", async () => {
		const mod = await import("./markdown");
		const sourceReferences = await mod.collectSourceReferenceCandidates(
			"Alpha claim (S2).\n\n```txt\nnot a source [S2](https://wrong.example)\n```\n\nSources:\n- [S1](https://one.example)\n- [S2](https://two.example)",
		);
		const html = await mod.renderMarkdown("Alpha claim (S2).", false, {
			compactExternalLinks: true,
			sourceReferences,
		});

		expect(html).toContain('href="https://two.example"');
		expect(html).toContain('class="source-link-chip__label">S2</span>');
		expect(html).not.toContain("https://wrong.example");
		expect(html).not.toContain("(S2)");
	});

	it("derives inline source reference labels from compact source links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Alpha claim (Policy memo).\n\nSources: [Policy memo](https://example.com/policy)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain('href="https://example.com/policy"');
		expect(html).toContain(
			'class="source-link-chip__label">Policy memo</span>',
		);
		expect(html).not.toContain("(Policy memo)");
	});

	it("does not render inline source references inside code or existing links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Inline code `(Policy memo)` and [Local (Policy memo)](./draft.md).\n\nSources: [Policy memo](https://example.com/policy)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html.match(/class="source-link-chip"/g) ?? []).toHaveLength(1);
		expect(html).toContain("<code>(Policy memo)</code>");
		expect(html).toContain("Local (Policy memo)");
	});

	it("removes bare source markers when rendering compact source-link chips", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"Claim one 【S5】 and claim two【S12】.\n\nSources: [Example Source](https://example.com/page)",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain("Claim one and claim two.");
		expect(html).not.toContain("【S5】");
		expect(html).not.toContain("【S12】");
		expect(html).toContain('class="source-link-chip"');
	});

	it("uses a domain label when compact source link text is only a URL", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"See [https://www.example.com/page](https://www.example.com/page).",
			false,
			{ compactExternalLinks: true },
		);

		expect(html).toContain(
			'class="source-link-chip__label">example.com</span>',
		);
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

	it("renders shell scripts through the Bash highlighter", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderHighlightedText(
			"#!/usr/bin/env bash\necho ok",
			"bash",
			false,
		);

		expect(html).toContain("<pre");
		expect(html).toContain("style=");
		expect(html).toContain("echo");
	});

	it("wraps tables as a first-class block from the renderer (not a post-process)", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderMarkdown(
			"| Name | Value |\n| --- | --- |\n| Alpha | 1 |",
			false,
		);

		expect(html).toContain('class="markdown-table-wrap"');
		expect(html).toContain('class="markdown-table"');
		expect(html).toContain("<th>Name</th>");
		expect(html).toContain("<td>Alpha</td>");
		expect(html).toMatch(/<\/table>\s*<\/div>/);
	});
});

describe("loadMarkdownBlocks (chat block model)", () => {
	it("produces typed blocks for a mixed document in source order", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"intro\n\n```js\ncode();\n```\n\n- [ ] a\n- [x] b\n\n| A |\n| - |\n| 1 |",
		);

		expect(blocks.map((b) => b.kind)).toEqual([
			"html",
			"code",
			"checklist",
			"table",
		]);
	});

	it("strips a leading [Translation unavailable] marker before splitting", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks(
			"[Translation unavailable] plain answer",
		);

		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("html");
		expect(blocks[0].raw).not.toContain("[Translation unavailable]");
		expect(blocks[0].raw).toContain("plain answer");
	});

	it("exposes checklist items with their checked/task state", async () => {
		const mod = await import("./markdown");
		const blocks = await mod.loadMarkdownBlocks("- [ ] todo\n- [x] done");
		const [block] = blocks;

		expect(block.kind).toBe("checklist");
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items).toEqual([
			{ checked: false, task: true, text: "todo" },
			{ checked: true, task: true, text: "done" },
		]);
	});
});

describe("renderInlineMarkdown (checklist item bodies)", () => {
	it("renders inline emphasis without wrapping block tags", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderInlineMarkdown("buy **milk**", false);

		expect(html).toContain("<strong>milk</strong>");
		expect(html).not.toContain("<p>");
	});

	it("renders inline links as external new-tab links", async () => {
		const mod = await import("./markdown");
		const html = await mod.renderInlineMarkdown(
			"call [bob](https://example.com)",
			false,
		);

		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('target="_blank"');
	});
});
