import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dynamic `import("mermaid")` inside the component resolves to this mock, so
// we control the SVG it "renders" (and can make it throw a parse error) without
// a real DOM-measuring mermaid run.
const initialize = vi.fn();
const renderMermaid = vi.fn();

vi.mock("mermaid", () => ({
	default: { initialize, render: renderMermaid },
}));

import { theme } from "$lib/stores/theme";
import Mermaid from "./Mermaid.svelte";

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="4" height="4"></rect></g></svg>';

describe("Mermaid", () => {
	beforeEach(() => {
		initialize.mockClear();
		renderMermaid.mockReset();
		theme.set("light");
	});

	it("sanitizes the mermaid SVG through the DOMPurify gate before injecting it", async () => {
		// mermaid returns SVG that includes a smuggled <script>. If the component
		// injected it raw the script tag would survive; it must be stripped, while
		// the benign SVG shapes survive — proving sanitizeHtml({ svg:true }) ran.
		renderMermaid.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg"><g><rect x="0" y="0" width="4" height="4"></rect></g><script>window.__pwned=1</script></svg>',
		});

		const { container } = render(Mermaid, {
			props: { code: "graph TD\nA-->B" },
		});

		await waitFor(() => {
			expect(container.querySelector(".markdown-mermaid svg")).toBeTruthy();
		});
		const host = container.querySelector(".markdown-mermaid");
		expect(host?.querySelector("g")).toBeTruthy();
		expect(host?.querySelector("rect")).toBeTruthy();
		// The script must NOT have made it into the DOM.
		expect(host?.querySelector("script")).toBeNull();
		expect(host?.innerHTML).not.toContain("__pwned");
	});

	it("degrades to an error note + the raw source on a mermaid parse error (never crashes)", async () => {
		renderMermaid.mockRejectedValue(new Error("Parse error on line 1"));

		const { container } = render(Mermaid, {
			props: { code: "graph TD\nA--!!-->B" },
		});

		await waitFor(() => {
			expect(container.querySelector(".markdown-diagram-error")).toBeTruthy();
		});
		const source = container.querySelector(".markdown-diagram-source");
		expect(source?.textContent).toContain("A--!!-->B");
		expect(container.querySelector(".markdown-mermaid svg")).toBeNull();
	});

	it("shows a lightweight placeholder (the source) before the diagram resolves — the same branch SSR renders", () => {
		// A never-resolving render keeps the component in its pre-render state: the
		// exact branch shown server-side (effects/dynamic-import are client-only) and
		// before mermaid finishes. No SVG, just the source placeholder.
		renderMermaid.mockReturnValue(new Promise<{ svg: string }>(() => {}));

		const { container } = render(Mermaid, {
			props: { code: "graph TD\nA-->B" },
		});

		const placeholder = container.querySelector(
			".markdown-mermaid-placeholder",
		);
		expect(placeholder).toBeTruthy();
		expect(placeholder?.textContent).toContain("graph TD");
		expect(container.querySelector(".markdown-mermaid svg")).toBeNull();
		expect(container.querySelector(".markdown-diagram-error")).toBeNull();
	});

	// Mermaid's default theme inks lines, arrows and labels dark, which a dark
	// page swallows: the diagram is drawn in the reader's theme (the chat and a
	// Canvas block both draw it through this component).
	it("draws in Mermaid's default theme on a light page and its dark theme on a dark one", async () => {
		renderMermaid.mockResolvedValue({ svg: SVG });

		const light = render(Mermaid, { props: { code: "graph TD\nA-->B" } });
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
		expect(initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ theme: "default" }),
		);
		light.unmount();

		theme.set("dark");
		render(Mermaid, { props: { code: "graph TD\nA-->B" } });
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
		expect(initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ theme: "dark" }),
		);
	});

	it("says the whole strict posture with every render, so a theme never gives back the labels the SVG gate is built for", async () => {
		renderMermaid.mockResolvedValue({ svg: SVG });
		theme.set("dark");
		render(Mermaid, { props: { code: "graph TD\nA-->B" } });
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
		expect(initialize).toHaveBeenLastCalledWith({
			startOnLoad: false,
			securityLevel: "strict",
			htmlLabels: false,
			flowchart: { htmlLabels: false },
			theme: "dark",
		});
	});

	it("draws again in the other theme when the reader switches", async () => {
		renderMermaid.mockResolvedValue({ svg: SVG });
		render(Mermaid, { props: { code: "graph TD\nA-->B" } });
		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));

		theme.set("dark");

		await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
		expect(initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ theme: "dark" }),
		);
	});
});
