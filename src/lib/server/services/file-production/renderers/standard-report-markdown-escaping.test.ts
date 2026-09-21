/**
 * What the Markdown renderer does with model text that contains Markdown.
 *
 * This output is three things at once: the `.md` the user downloads, the text
 * `read_generated_file` hands back to the model, and (since the MinerU 4
 * migration) the stored text of a document-source file — which is also the
 * base a `produce_file` patch is applied to. Text that silently restructures
 * the document therefore corrupts all three, so every interpolation point
 * escapes per CommonMark/GFM.
 *
 * Text with nothing special in it must come out byte-for-byte as before; the
 * positive fixtures and `standard-report-markdown.test.ts` pin that.
 */
import { describe, expect, it } from "vitest";
import type { GeneratedDocumentSource } from "../source-schema";
import { validateGeneratedDocumentSource } from "../source-schema";
import { renderStandardReportMarkdown } from "./standard-report-markdown";

function render(source: unknown): string {
	const validation = validateGeneratedDocumentSource(source);
	expect(validation.ok).toBe(true);
	if (!validation.ok) throw new Error("fixture did not validate");
	return renderStandardReportMarkdown(validation.source).content.toString(
		"utf8",
	);
}

function documentWith(blocks: unknown[], extra: object = {}): unknown {
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "Escaping report",
		blocks,
		...extra,
	};
}

describe("link text", () => {
	it("escapes brackets and backslashes so a title cannot close its own label", () => {
		const markdown = render(
			documentWith([
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{
							title: "Report [2024] (final)](https://evil.example.com) ",
							url: "https://example.com/report",
						},
					],
				},
			]),
		);

		expect(markdown).toContain(
			"[Report \\[2024\\] (final)\\](https://evil.example.com)](https://example.com/report)",
		);
		// Exactly one label actually closes — the smuggled destination never
		// becomes one.
		expect(markdown.match(/(?<!\\)\]\(/g)).toHaveLength(1);
	});
});

describe("link destination", () => {
	it("percent-encodes spaces and parentheses instead of ending the link early", () => {
		const markdown = render(
			documentWith([
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{
							title: "Spaced source",
							url: "https://example.com/a b(c)d",
						},
					],
				},
			]),
		);

		expect(markdown).toContain(
			"[Spaced source](https://example.com/a%20b%28c%29d)",
		);
	});

	it("leaves a plain URL untouched", () => {
		const markdown = render(
			documentWith([
				{
					type: "sourceChips",
					title: "Sources",
					sources: [
						{ title: "Gov source", url: "https://gov.ie/renewables?a=1#b" },
					],
				},
			]),
		);

		expect(markdown).toContain("[Gov source](https://gov.ie/renewables?a=1#b)");
	});

	it("escapes an image's own link text and destination", () => {
		const markdown = render(
			documentWith([
				{
					type: "image",
					source: {
						kind: "https",
						url: "https://example.com/a picture(1).png",
					},
					altText: "A [bracketed] picture",
					sourceAttribution: {
						title: "Source [x]",
						url: "https://example.com/s (1)",
					},
				},
			]),
		);

		expect(markdown).toContain(
			"![A \\[bracketed\\] picture](https://example.com/a%20picture%281%29.png)",
		);
		expect(markdown).toContain(
			"Source: [Source \\[x\\]](https://example.com/s%20%281%29)",
		);
	});
});

describe("table cells", () => {
	it("escapes pipes and the backslashes in front of them, and flattens newlines", () => {
		const markdown = render(
			documentWith([
				{
					type: "table",
					columns: [
						{ key: "region", label: "Region | Zone", kind: "text" },
						{ key: "notes", label: "Notes", kind: "text" },
					],
					rows: [
						{ region: "EMEA | North", notes: "first line\nsecond line" },
						// A value ending in a backslash used to escape the pipe the
						// renderer added, swallowing the next cell.
						{ region: "path\\", notes: "after" },
					],
				},
			]),
		);

		expect(markdown).toContain("| Region \\| Zone | Notes |");
		expect(markdown).toContain("| EMEA \\| North | first line second line |");
		expect(markdown).toContain("| path\\\\ | after |");
		// Every row still has exactly the two cells the columns declare.
		for (const line of markdown
			.split("\n")
			.filter((row) => row.startsWith("|"))) {
			expect(line.replace(/\\\|/g, "").split("|")).toHaveLength(4);
		}
	});
});

describe("text at the start of a line", () => {
	it("escapes a paragraph that would otherwise open a block", () => {
		const markdown = render(
			documentWith([
				{ type: "paragraph", text: "# Not a heading" },
				{ type: "paragraph", text: "> Not a quote" },
				{ type: "paragraph", text: "- Not a bullet" },
				{ type: "paragraph", text: "1. Not a list item" },
				{ type: "paragraph", text: "---" },
				{ type: "paragraph", text: "```js not a fence" },
			]),
		);

		expect(markdown).toContain("\\# Not a heading");
		expect(markdown).toContain("\\> Not a quote");
		expect(markdown).toContain("\\- Not a bullet");
		expect(markdown).toContain("1\\. Not a list item");
		// A lone `---` between two blank lines is a thematic break; `--- text`
		// is not, and is left alone.
		expect(markdown).toContain("\\---");
		expect(markdown).toContain("\\```js not a fence");
	});

	it("leaves inline punctuation and mid-line structure alone", () => {
		// `#hashtag` is not a heading and `*emphasis*` is not a bullet, so
		// escaping either would change bytes for no reason.
		const markdown = render(
			documentWith([
				{ type: "paragraph", text: "#hashtag stays, as does 5 - 3 = 2" },
				{ type: "paragraph", text: "*emphasis* opens the line" },
			]),
		);

		expect(markdown).toContain("#hashtag stays, as does 5 - 3 = 2");
		expect(markdown).toContain("*emphasis* opens the line");
	});

	it("escapes a subtitle, a date, an image caption and a chart description", () => {
		const markdown = render(
			documentWith(
				[
					{
						type: "image",
						source: { kind: "https", url: "https://example.com/a.png" },
						altText: "A picture",
						caption: "## Caption that is not a heading",
					},
					{
						type: "chart",
						chartType: "bar",
						title: "A chart",
						caption: "A caption.",
						units: "items",
						altText: "- description that is not a bullet",
						xKey: "label",
						yKey: "value",
						data: [{ label: "Total", value: 1 }],
					},
				],
				{ subtitle: "# Subtitle", date: "> Date" },
			),
		);

		expect(markdown).toContain("\\# Subtitle");
		expect(markdown).toContain("\\> Date");
		expect(markdown).toContain("\\## Caption that is not a heading");
		expect(markdown).toContain("\\- description that is not a bullet");
	});
});

describe("fenced code", () => {
	it("picks a fence longer than the longest run inside", () => {
		const markdown = render(
			documentWith([
				{
					type: "code",
					language: "md",
					text: "```\nnested fence\n```\n#### still code",
				},
			]),
		);

		expect(markdown).toContain(
			"````md\n```\nnested fence\n```\n#### still code\n````",
		);
	});

	it("keeps the plain three-backtick fence when the code has none", () => {
		const markdown = render(
			documentWith([
				{ type: "code", language: "python", text: "print('hello')" },
			]),
		);

		expect(markdown).toContain("```python\nprint('hello')\n```");
	});

	it("does not let the language word carry a fence of its own", () => {
		const markdown = render(
			documentWith([
				{ type: "code", language: "js`````", text: "const a = 1;" },
			]),
		);

		expect(markdown).toContain("```js\nconst a = 1;\n```");
	});
});

describe("the escaped document still round-trips", () => {
	it("renders every escape into one document without losing a block", () => {
		const source: GeneratedDocumentSource = {
			version: 1,
			template: "alfyai_standard_report",
			title: "Escaping report",
			blocks: [
				{ type: "paragraph", text: "# leading hash" },
				{
					type: "table",
					columns: [{ key: "a", label: "A | B", kind: "text" }],
					rows: [{ a: "x | y" }],
				},
				{ type: "code", text: "```\ninner\n```" },
			],
		};
		const markdown =
			renderStandardReportMarkdown(source).content.toString("utf8");

		// One table row, one escaped paragraph, one fence pair: nothing merged
		// into anything else.
		expect(markdown.match(/^````$/gm)).toHaveLength(2);
		expect(markdown).toContain("\\# leading hash");
		expect(markdown).toContain("| x \\| y |");
	});
});
