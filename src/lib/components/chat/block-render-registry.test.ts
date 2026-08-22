import { describe, expect, it } from "vitest";
import { blockRenderer } from "./block-render-registry";
import Chart from "./Chart.svelte";
import Checklist from "./Checklist.svelte";
import CodeBlock from "./CodeBlock.svelte";
import CsvTable from "./CsvTable.svelte";
import Mermaid from "./Mermaid.svelte";

describe("block-render-registry dispatch", () => {
	it("dispatches each component-lane kind to its own component (incl. the diagram kinds)", () => {
		expect(blockRenderer("code")?.component).toBe(CodeBlock);
		expect(blockRenderer("checklist")?.component).toBe(Checklist);
		expect(blockRenderer("chart")?.component).toBe(Chart);
		expect(blockRenderer("csv")?.component).toBe(CsvTable);
		expect(blockRenderer("mermaid")?.component).toBe(Mermaid);
	});

	it("returns null for the prose-lane kinds (table / callout / accordion / html)", () => {
		expect(blockRenderer("table")).toBeNull();
		expect(blockRenderer("callout")).toBeNull();
		expect(blockRenderer("accordion")).toBeNull();
		expect(blockRenderer("html")).toBeNull();
	});

	it("adapts each block to its component's props", () => {
		expect(
			blockRenderer("code")?.props({
				kind: "code",
				code: "x=1",
				language: "python",
				html: "<pre>x=1</pre>",
			}),
		).toEqual({
			code: "x=1",
			language: "python",
			contentHtml: "<pre>x=1</pre>",
		});

		expect(
			blockRenderer("chart")?.props({ kind: "chart", code: '{"type":"bar"}' }),
		).toEqual({ code: '{"type":"bar"}' });

		expect(
			blockRenderer("csv")?.props({ kind: "csv", code: "a,b\n1,2" }),
		).toEqual({ code: "a,b\n1,2" });

		expect(
			blockRenderer("mermaid")?.props({ kind: "mermaid", code: "graph TD" }),
		).toEqual({ code: "graph TD" });

		const items = [{ checked: false, task: true, html: "todo" }];
		expect(
			blockRenderer("checklist")?.props({ kind: "checklist", items }),
		).toEqual({ items });
	});

	it("gives the diagram lanes a shared wrapper class", () => {
		expect(blockRenderer("chart")?.wrapperClass).toBe("markdown-diagram-block");
		expect(blockRenderer("csv")?.wrapperClass).toBe("markdown-diagram-block");
		expect(blockRenderer("mermaid")?.wrapperClass).toBe(
			"markdown-diagram-block",
		);
	});
});
