import { render, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

// End-to-end tests that drive the REAL block pipeline: parseMarkdownBlocks +
// renderMarkdown + Checklist dispatch are all unmocked here (unlike the
// MessageBubble/MessageArea suites, which mock $lib/utils/markdown-loader). This
// exercises the A3 registry dispatch and the checklist block-level render path.
// Shiki runs for real (see markdown.test.ts), so the generous timeouts below
// cover first-time highlighter initialization.

describe("MarkdownRenderer — checklist item bodies render block-level markdown (Fix 1)", () => {
	it("renders a task item's nested sub-list as a real <ul> and its fenced code as a real <pre> (not flattened text)", async () => {
		const content = [
			"- [ ] parent task",
			"  - sub bullet one",
			"  - sub bullet two",
			"",
			"  ```js",
			"  const a = 1;",
			"  ```",
			"- [x] second done",
		].join("\n");

		const { container } = render(MarkdownRenderer, {
			props: { content },
		});

		await waitFor(
			() => {
				const checklist = container.querySelector(".markdown-checklist");
				expect(checklist).toBeTruthy();
				// The nested sub-list is a real <ul><li> inside the item body, not a
				// flattened "- sub bullet one" text run.
				const nestedItems = container.querySelectorAll(
					".markdown-checklist__text ul li",
				);
				expect(nestedItems.length).toBeGreaterThanOrEqual(2);
				expect(container.textContent).toContain("sub bullet one");
				// The fenced code renders as a real <pre> code block, not inline
				// backticks smashed into a paragraph.
				const pre = container.querySelector(".markdown-checklist__text pre");
				expect(pre).toBeTruthy();
				expect(pre?.textContent).toContain("const a = 1;");
			},
			{ timeout: 15000 },
		);
	}, 20000);
});

describe("MarkdownRenderer — checklist item links get the same treatment as the message (Fix 2)", () => {
	it("renders a [label](https://…) inside a task item as a source-link chip when compactExternalLinks is on", async () => {
		const content = "- [ ] read [Example Source](https://example.com/page)";

		const { container } = render(MarkdownRenderer, {
			props: { content, compactExternalLinks: true },
		});

		await waitFor(
			() => {
				const checklist = container.querySelector(".markdown-checklist");
				expect(checklist).toBeTruthy();
				const chip = container.querySelector(
					".markdown-checklist__text a.source-link-chip",
				);
				expect(chip).toBeTruthy();
				expect(
					chip?.querySelector(".source-link-chip__label")?.textContent,
				).toBe("Example Source");
				// It must NOT fall back to a bare inline anchor.
				expect(
					container.querySelector(
						".markdown-checklist__text a:not(.source-link-chip)",
					),
				).toBeNull();
			},
			{ timeout: 15000 },
		);
	}, 20000);
});

describe("MarkdownRenderer — real registry dispatch across every lane", () => {
	it("routes code→CodeBlock, checklist→enabled checkboxes, accordion→<details>, table→.markdown-table-wrap", async () => {
		const content = [
			"Here is a mixed document:",
			"",
			"```js",
			"const x = 1;",
			"```",
			"",
			"- [ ] todo one",
			"- [x] done two",
			"",
			"<details><summary>More info</summary>",
			"",
			"hidden **body**",
			"",
			"</details>",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| Alpha | 1 |",
		].join("\n");

		const { container } = render(MarkdownRenderer, {
			props: { content },
		});

		await waitFor(
			() => {
				// code → CodeBlock component (its root wrapper class).
				expect(container.querySelector(".code-block")).toBeTruthy();

				// checklist → enabled, tick-able checkboxes (not marked's disabled default).
				const boxes = container.querySelectorAll<HTMLInputElement>(
					'.markdown-checklist input[type="checkbox"]',
				);
				expect(boxes.length).toBe(2);
				for (const box of boxes) {
					expect(box.disabled).toBe(false);
				}

				// accordion → native <details> element.
				expect(container.querySelector("details")).toBeTruthy();

				// table → first-class scroll wrapper.
				expect(container.querySelector(".markdown-table-wrap")).toBeTruthy();
			},
			{ timeout: 15000 },
		);
	}, 20000);
});

describe("MarkdownRenderer — accordion (details) rendering", () => {
	it("renders a <details><summary> accordion with its title and collapsible body, and can be expanded", async () => {
		const content = [
			"<details><summary>Accordion title</summary>",
			"",
			"hidden **body copy**",
			"",
			"</details>",
		].join("\n");

		const { container } = render(MarkdownRenderer, {
			props: { content },
		});

		let details: HTMLDetailsElement | null = null;
		await waitFor(
			() => {
				details = container.querySelector("details");
				expect(details).toBeTruthy();
				const summary = details?.querySelector("summary");
				expect(summary?.textContent).toContain("Accordion title");
				// Body markdown is rendered inside the accordion (block-level).
				expect(details?.querySelector("strong")?.textContent).toBe("body copy");
			},
			{ timeout: 15000 },
		);

		// Expand it: native <details> toggles via the open property.
		const el = details as unknown as HTMLDetailsElement;
		expect(el.open).toBe(false);
		el.open = true;
		expect(el.open).toBe(true);
		expect(el.textContent).toContain("body copy");
	}, 20000);
});
