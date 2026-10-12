import { render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { imageThumbnailRouteUrl } from "$lib/shared/url-provenance";
import { uiLanguage } from "$lib/stores/settings";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

// image_search's own result: a picture's address and Brave's resized copy of it. A
// reply may show a picture from the web only when a tool of its own message returned it.
const PHOTO = "https://example.com/photo.png";
const PHOTO_THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9waG90by5wbmc";
const PHOTO_RESULTS = {
	toolImages: [{ url: PHOTO, thumbnail: PHOTO_THUMB }],
	toolSourceHosts: new Set<string>(),
};

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

				// checklist → read-only checkboxes mirroring the model's state.
				const boxes = container.querySelectorAll<HTMLInputElement>(
					'.markdown-checklist input[type="checkbox"]',
				);
				expect(boxes.length).toBe(2);
				for (const box of boxes) {
					expect(box.disabled).toBe(true);
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

describe("MarkdownRenderer — diagram lanes dispatch through the registry", () => {
	it("routes a closed ```csv fence to a first-class table (CsvTable component)", async () => {
		const content = ["```csv", "name,value", "alpha,1", "beta,2", "```"].join(
			"\n",
		);

		const { container } = render(MarkdownRenderer, { props: { content } });

		await waitFor(
			() => {
				const wrap = container.querySelector(".markdown-table-wrap");
				expect(wrap).toBeTruthy();
				const headers = Array.from(container.querySelectorAll("thead th")).map(
					(th) => th.textContent,
				);
				expect(headers).toEqual(["name", "value"]);
				expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
				// It must NOT fall back to a grey code block.
				expect(container.querySelector(".code-block")).toBeNull();
			},
			{ timeout: 15000 },
		);
	}, 20000);

	it("routes a closed ```mermaid fence to the Mermaid lane (placeholder while it renders), not a code block", async () => {
		const content = ["```mermaid", "graph TD", "A-->B", "```"].join("\n");

		const { container } = render(MarkdownRenderer, { props: { content } });

		await waitFor(
			() => {
				// The mermaid lane renders (a placeholder or the SVG), never a grey
				// code block. Real mermaid can't measure text in jsdom, so it stays on
				// the source placeholder / error note — either way it is the Mermaid
				// component, not CodeBlock.
				const isMermaidLane =
					container.querySelector(".markdown-mermaid-placeholder") !== null ||
					container.querySelector(".markdown-mermaid") !== null ||
					container.querySelector(".markdown-diagram-error") !== null;
				expect(isMermaidLane).toBe(true);
				expect(container.querySelector(".code-block")).toBeNull();
			},
			{ timeout: 15000 },
		);
	}, 20000);

	it("keeps an UNTERMINATED diagram fence as a code block (streaming safety), not a diagram", async () => {
		// No closing ``` yet: the mermaid source must render as grey code, never be
		// handed to the mermaid renderer.
		const content = "intro\n\n```mermaid\ngraph TD\nA-->B";

		const { container } = render(MarkdownRenderer, {
			props: { content, isStreaming: true },
		});

		await waitFor(
			() => {
				expect(container.querySelector(".code-block")).toBeTruthy();
				expect(container.querySelector(".markdown-mermaid")).toBeNull();
				expect(
					container.querySelector(".markdown-mermaid-placeholder"),
				).toBeNull();
			},
			{ timeout: 15000 },
		);
	}, 20000);
});

describe("MarkdownRenderer — streaming word animation (C3)", () => {
	it("wraps newly-streamed words in .word-new spans on a normal-length answer", async () => {
		const { container } = render(MarkdownRenderer, {
			props: {
				content: "The quick brown fox jumps over the lazy dog.",
				isStreaming: true,
			},
		});

		await waitFor(
			() => {
				const wrapped = container.querySelectorAll(".word-new");
				expect(wrapped.length).toBeGreaterThan(0);
			},
			{ timeout: 15000 },
		);
	}, 20000);

	it("does not wrap per-word once the message exceeds the length threshold (falls back to block reveal)", async () => {
		// Well past WORD_ANIMATION_MAX_CHARS (12k): the whole-block fade-in carries
		// the reveal, so no per-word spans are created for the long answer.
		const longContent = `${"word ".repeat(6000)}end`; // ~30k chars
		const { container } = render(MarkdownRenderer, {
			props: { content: longContent, isStreaming: true },
		});

		// Give the throttled render + post-render effect time to run.
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(container.querySelector(".markdown-html")).toBeTruthy();
		expect(container.querySelectorAll(".word-new")).toHaveLength(0);
	}, 20000);
});

describe("MarkdownRenderer — image loading skeleton (C4)", () => {
	it("renders a skeleton frame before load and reveals the image on load", async () => {
		const { container } = render(MarkdownRenderer, {
			props: {
				content: `![a photo](${PHOTO})`,
				toolResults: PHOTO_RESULTS,
			},
		});

		let img: HTMLImageElement | null = null;
		await waitFor(
			() => {
				const frame = container.querySelector(".markdown-image-frame");
				expect(frame).toBeTruthy();
				// Starts in the loading (shimmer + reserved-space) state.
				expect(frame?.classList.contains("markdown-image-frame--loading")).toBe(
					true,
				);
				img = container.querySelector<HTMLImageElement>(".markdown-image");
				expect(img).toBeTruthy();
				// Shown from the app's own thumbnail route, never from the address the
				// reply wrote.
				expect(img?.getAttribute("src")).toBe(
					imageThumbnailRouteUrl(PHOTO_THUMB),
				);
			},
			{ timeout: 15000 },
		);

		// Simulate the image finishing loading: the frame leaves the loading state.
		const image = img as unknown as HTMLImageElement;
		image.dispatchEvent(new Event("load"));

		const frame = container.querySelector(".markdown-image-frame");
		expect(frame?.classList.contains("markdown-image-frame--loading")).toBe(
			false,
		);
		expect(frame?.classList.contains("markdown-image-frame--loaded")).toBe(
			true,
		);
	}, 20000);

	it("marks a broken image and collapses its skeleton frame on error", async () => {
		const { container } = render(MarkdownRenderer, {
			props: {
				content: `![broken](${PHOTO})`,
				toolResults: PHOTO_RESULTS,
			},
		});

		let img: HTMLImageElement | null = null;
		await waitFor(
			() => {
				img = container.querySelector<HTMLImageElement>(".markdown-image");
				expect(img).toBeTruthy();
			},
			{ timeout: 15000 },
		);

		const image = img as unknown as HTMLImageElement;
		image.dispatchEvent(new Event("error"));

		expect(image.classList.contains("markdown-image--broken")).toBe(true);
		const frame = container.querySelector(".markdown-image-frame");
		expect(frame?.classList.contains("markdown-image-frame--broken")).toBe(
			true,
		);
		expect(frame?.classList.contains("markdown-image-frame--loading")).toBe(
			false,
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

describe("MarkdownRenderer: what a reply may make the browser fetch on its own", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("shows a picture from the web as a link chip, with no image at all, when no tool returned it", async () => {
		const { container } = render(MarkdownRenderer, {
			props: {
				content:
					"Here it is: ![a photo](https://stranger.example/p.png?d=SECRET)",
				compactExternalLinks: true,
			},
		});

		await waitFor(
			() => {
				const chip = container.querySelector<HTMLAnchorElement>(
					"a.source-link-chip--image",
				);
				expect(chip).toBeTruthy();
				expect(chip?.href).toBe("https://stranger.example/p.png?d=SECRET");
				expect(
					chip?.querySelector(".source-link-chip__label")?.textContent,
				).toBe("a photo");
				expect(chip?.getAttribute("title")).toBe(
					"Image not loaded: a photo. Open the link to see it.",
				);
			},
			{ timeout: 15000 },
		);
		expect(container.querySelector("img")).toBeNull();
	}, 20000);

	it("says the chip's sentence in the reader's language, and again when the language changes", async () => {
		uiLanguage.set("hu");
		const { container } = render(MarkdownRenderer, {
			props: { content: "![a photo](https://stranger.example/p.png)" },
		});
		const title = () =>
			container
				.querySelector("a.source-link-chip--image")
				?.getAttribute("title");

		await waitFor(
			() =>
				expect(title()).toBe(
					"A kép nem töltődött be: a photo. A megtekintéséhez nyisd meg a hivatkozást.",
				),
			{ timeout: 15000 },
		);

		uiLanguage.set("en");
		await waitFor(
			() =>
				expect(title()).toBe(
					"Image not loaded: a photo. Open the link to see it.",
				),
			{ timeout: 15000 },
		);
	}, 20000);

	it("gives a source chip the globe at once unless a tool returned its host", async () => {
		const { container } = render(MarkdownRenderer, {
			props: {
				content:
					"See [Known](https://known.example/a) and [Stranger](https://stranger.example/b).",
				compactExternalLinks: true,
				toolResults: {
					toolImages: [],
					toolSourceHosts: new Set(["known.example"]),
				},
			},
		});

		await waitFor(
			() => {
				const chips = container.querySelectorAll("a.source-link-chip");
				expect(chips).toHaveLength(2);
				expect(
					chips[0].querySelector("img.source-link-chip__favicon"),
				).toBeTruthy();
				expect(chips[1].querySelector("img")).toBeNull();
				expect(
					chips[1]
						.querySelector(".source-link-chip__favicon-fallback")
						?.hasAttribute("hidden"),
				).toBe(false);
			},
			{ timeout: 15000 },
		);
	}, 20000);

	it("draws every block again, not only the last, when a tool result arrives while the reply streams", async () => {
		// The first block holds the picture; the last is what is still being written.
		const content = `![a photo](${PHOTO})\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\nThe tail`;
		const { container, rerender } = render(MarkdownRenderer, {
			props: { content, isStreaming: true },
		});

		await waitFor(
			() => {
				expect(
					container.querySelector("a.source-link-chip--image"),
				).toBeTruthy();
				expect(container.querySelector(".code-block")).toBeTruthy();
				expect(container.textContent).toContain("The tail");
			},
			{ timeout: 15000 },
		);
		expect(container.querySelector("img")).toBeNull();

		await rerender({ content, isStreaming: true, toolResults: PHOTO_RESULTS });

		await waitFor(
			() => {
				expect(
					container.querySelector("img.markdown-image")?.getAttribute("src"),
				).toBe(imageThumbnailRouteUrl(PHOTO_THUMB));
				expect(container.querySelector("a.source-link-chip--image")).toBeNull();
			},
			{ timeout: 15000 },
		);
	}, 30000);

	it("still opens the lightbox on a picture shown through the thumbnail route", async () => {
		const { container } = render(MarkdownRenderer, {
			props: { content: `![a photo](${PHOTO})`, toolResults: PHOTO_RESULTS },
		});

		let image: HTMLImageElement | null = null;
		await waitFor(
			() => {
				image = container.querySelector<HTMLImageElement>("img.markdown-image");
				expect(image).toBeTruthy();
			},
			{ timeout: 15000 },
		);
		(image as unknown as HTMLImageElement).click();

		await waitFor(
			() => {
				const shown = document.querySelector<HTMLImageElement>(
					'[data-testid="image-lightbox"] img',
				);
				expect(shown?.getAttribute("src")).toContain(
					"/api/image-search/thumbnail?url=",
				);
			},
			{ timeout: 5000 },
		);
	}, 20000);
});
