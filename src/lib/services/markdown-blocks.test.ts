import { marked } from "marked";
import { describe, expect, it } from "vitest";
import {
	BLOCK_RENDER_STRATEGIES,
	classifyMarkdownBlocks,
	type MarkdownBlock,
	RESERVED_STAGE2_KINDS,
	resolveBlockRenderStrategy,
} from "./markdown-blocks";

// The single parse/split step is driven by marked's block lexer. These tests
// exercise the pure classifier with the same lexer options the app uses so the
// fixtures reflect real streaming/partial-fence behaviour (folds B3).
function parse(source: string): MarkdownBlock[] {
	const tokens = marked.lexer(source, { gfm: true, breaks: true });
	return classifyMarkdownBlocks(tokens);
}

describe("classifyMarkdownBlocks", () => {
	it("classifies a fenced code block with its language", () => {
		const blocks = parse("```ts\nconst answer = 42;\n```");
		expect(blocks).toHaveLength(1);
		const [block] = blocks;
		expect(block.kind).toBe("code");
		if (block.kind !== "code") throw new Error("expected code block");
		expect(block.language).toBe("ts");
		expect(block.code).toBe("const answer = 42;");
	});

	it("treats an unterminated fence (mid-stream) as a single code block", () => {
		// The old splitMarkdownBlocks flushed an open fence as code; the lexer
		// must keep that behaviour so streaming partial code does not regress.
		const blocks = parse("intro line\n\n```js\nconst a = 1;");
		expect(blocks.map((b) => b.kind)).toEqual(["html", "code"]);
		const code = blocks[1];
		if (code.kind !== "code") throw new Error("expected code block");
		expect(code.language).toBe("js");
		expect(code.code).toBe("const a = 1;");
	});

	it("classifies a fence without a language as a code block with no language", () => {
		const blocks = parse("```\nplain\n```");
		const [block] = blocks;
		expect(block.kind).toBe("code");
		if (block.kind !== "code") throw new Error("expected code block");
		expect(block.language).toBeUndefined();
	});

	it("classifies a GFM task list as an interactive checklist block", () => {
		const blocks = parse("- [ ] todo one\n- [x] done two");
		expect(blocks).toHaveLength(1);
		const [block] = blocks;
		expect(block.kind).toBe("checklist");
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items).toEqual([
			{ checked: false, task: true, text: "todo one" },
			{ checked: true, task: true, text: "done two" },
		]);
	});

	it("keeps a task item's block-level body (nested sub-list + fenced code) in its text so it can be block-rendered (Fix 1 contract)", () => {
		// The item body carries block content — a nested sub-list AND a fenced code
		// block. The classifier must preserve it verbatim in `text` so the renderer
		// can run it through the FULL block-level markdown renderer instead of
		// flattening it with parseInline.
		const blocks = parse(
			[
				"- [ ] parent task",
				"  - sub bullet one",
				"  - sub bullet two",
				"",
				"  ```js",
				"  const a = 1;",
				"  ```",
			].join("\n"),
		);
		expect(blocks).toHaveLength(1);
		const [block] = blocks;
		expect(block.kind).toBe("checklist");
		if (block.kind !== "checklist") throw new Error("expected checklist");
		const [item] = block.items;
		expect(item.task).toBe(true);
		expect(item.text).toContain("- sub bullet one");
		expect(item.text).toContain("- sub bullet two");
		expect(item.text).toContain("```js");
		expect(item.text).toContain("const a = 1;");
	});

	it("classifies a mixed list containing any task item as a checklist", () => {
		const blocks = parse("- [ ] task\n- plain bullet");
		const [block] = blocks;
		expect(block.kind).toBe("checklist");
		if (block.kind !== "checklist") throw new Error("expected checklist");
		expect(block.items).toEqual([
			{ checked: false, task: true, text: "task" },
			{ checked: false, task: false, text: "plain bullet" },
		]);
	});

	it("leaves a plain bullet list as prose html (not a checklist)", () => {
		const blocks = parse("- alpha\n- beta");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("html");
	});

	it("classifies a GFM table as a first-class table block", () => {
		const blocks = parse("| A | B |\n| --- | --- |\n| 1 | 2 |");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("table");
	});

	it("classifies an Obsidian callout blockquote as a callout block", () => {
		const blocks = parse("> [!NOTE] Heads up\n> body line");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("callout");
	});

	it("leaves a normal blockquote as prose html", () => {
		const blocks = parse("> just a quote\n> more");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("html");
	});

	it("classifies a self-contained <details> block as an accordion", () => {
		const blocks = parse(
			"<details><summary>More</summary>inline body</details>",
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("accordion");
	});

	it("coalesces a multi-token <details> span (blank lines inside) into one accordion", () => {
		// marked splits this into html + paragraph + html tokens; the classifier
		// must re-join them so renderMarkdown receives a complete <details> element.
		const source =
			"<details><summary>More</summary>\n\nhidden **body**\n\n</details>";
		const blocks = parse(source);
		expect(blocks).toHaveLength(1);
		const [block] = blocks;
		expect(block.kind).toBe("accordion");
		expect(block.raw).toContain("<summary>More</summary>");
		expect(block.raw).toContain("hidden **body**");
		expect(block.raw).toContain("</details>");
	});

	it("flushes an unterminated <details> (mid-stream) as an accordion block", () => {
		const blocks = parse("<details><summary>More</summary>\n\nstill streaming");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("accordion");
	});

	it("groups consecutive prose (headings, paragraphs, plain lists) into one html block", () => {
		const blocks = parse("# Title\n\npara one\n\npara two\n\n- a\n- b");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("html");
		expect(blocks[0].raw).toContain("# Title");
		expect(blocks[0].raw).toContain("para two");
	});

	it("splits prose that surrounds special blocks into ordered typed blocks", () => {
		const blocks = parse(
			"before text\n\n```js\ncode();\n```\n\n| A |\n| - |\n| 1 |\n\nafter text",
		);
		expect(blocks.map((b) => b.kind)).toEqual([
			"html",
			"code",
			"table",
			"html",
		]);
	});

	it("does not emit empty html blocks for whitespace-only runs", () => {
		const blocks = parse("```js\na\n```\n\n\n```js\nb\n```");
		expect(blocks.map((b) => b.kind)).toEqual(["code", "code"]);
	});
});

describe("block renderer registry", () => {
	it("maps every block kind to a render strategy", () => {
		expect(Object.keys(BLOCK_RENDER_STRATEGIES).sort()).toEqual(
			["accordion", "callout", "checklist", "code", "html", "table"].sort(),
		);
	});

	it("routes code to the code renderer and checklists to the checklist renderer", () => {
		expect(resolveBlockRenderStrategy("code")).toBe("code");
		expect(resolveBlockRenderStrategy("checklist")).toBe("checklist");
	});

	it("routes table, callout, accordion and html through the prose renderer", () => {
		expect(resolveBlockRenderStrategy("table")).toBe("prose");
		expect(resolveBlockRenderStrategy("callout")).toBe("prose");
		expect(resolveBlockRenderStrategy("accordion")).toBe("prose");
		expect(resolveBlockRenderStrategy("html")).toBe("prose");
	});

	it("reserves the Stage 2 diagram kinds without implementing them", () => {
		expect(RESERVED_STAGE2_KINDS).toEqual(["mermaid", "chart", "csv"]);
		// Reserved names must NOT yet be produced or registered as Stage 1 kinds.
		for (const reserved of RESERVED_STAGE2_KINDS) {
			expect(reserved in BLOCK_RENDER_STRATEGIES).toBe(false);
		}
	});
});
