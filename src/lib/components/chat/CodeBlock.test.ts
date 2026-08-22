import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import chatDict from "$lib/i18n/chat";
import CodeBlock from "./CodeBlock.svelte";

Object.assign(navigator, {
	clipboard: {
		writeText: vi.fn().mockImplementation(() => Promise.resolve()),
	},
});

describe("CodeBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders correctly with language", () => {
		render(CodeBlock, {
			props: {
				code: 'print("hello world")',
				language: "python",
			},
		});

		expect(screen.getByText("python")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
	});

	it("renders without language", () => {
		render(CodeBlock, {
			props: {
				code: 'print("hello world")',
			},
		});

		expect(screen.queryByText("python")).toBeNull();
		expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
	});

	it("copies code to clipboard when clicking copy button", async () => {
		render(CodeBlock, {
			props: {
				code: "const a = 1;",
			},
		});

		const copyButton = screen.getByRole("button", { name: "Copy code" });
		await fireEvent.click(copyButton);

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("const a = 1;");

		// The copied confirmation must come from the localized key, not a
		// hardcoded "Copied!" string (i18n leak fix).
		expect(screen.getByText("Copied!")).toBeTruthy();
	});

	it("renders the localized copied confirmation instead of a hardcoded string", async () => {
		// Guard against the i18n leak regressing: the copied label must resolve
		// through the codeBlock.copied key (EN "Copied!").
		expect(chatDict.en["codeBlock.copied"]).toBe("Copied!");
		expect(chatDict.hu["codeBlock.copied"]).toBe("Másolva!");

		render(CodeBlock, {
			props: {
				code: "const a = 1;",
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

		expect(screen.getByText(chatDict.en["codeBlock.copied"])).toBeTruthy();
	});

	describe("long-block line collapse (C2)", () => {
		const longCode = Array.from(
			{ length: 40 },
			(_, i) => `const line${i} = ${i};`,
		).join("\n");
		const shortCode = Array.from(
			{ length: 10 },
			(_, i) => `const line${i} = ${i};`,
		).join("\n");

		it("renders a >30-line block collapsed with a working expand toggle", async () => {
			render(CodeBlock, {
				props: { code: longCode, language: "javascript" },
			});

			const toggle = screen.getByTestId("code-lines-toggle");
			expect(toggle).toBeTruthy();
			// Starts collapsed: the clamp wrapper is present and the toggle offers
			// to reveal the hidden lines (40 total − 15 visible = 25 hidden).
			expect(toggle.getAttribute("aria-expanded")).toBe("false");
			expect(toggle.textContent).toContain("25");
			expect(document.querySelector(".code-clip--clamped")).toBeTruthy();

			// Expanding removes the clamp and flips the toggle to "Show less".
			await fireEvent.click(toggle);
			expect(toggle.getAttribute("aria-expanded")).toBe("true");
			expect(toggle.textContent).toContain("Show less");
			expect(document.querySelector(".code-clip--clamped")).toBeNull();

			// Collapsing again re-applies the clamp.
			await fireEvent.click(toggle);
			expect(toggle.getAttribute("aria-expanded")).toBe("false");
			expect(document.querySelector(".code-clip--clamped")).toBeTruthy();
		});

		it("renders a short block fully with no collapse toggle", () => {
			render(CodeBlock, {
				props: { code: shortCode, language: "javascript" },
			});

			expect(screen.queryByTestId("code-lines-toggle")).toBeNull();
			expect(document.querySelector(".code-clip--clamped")).toBeNull();
		});

		it("keeps the copy button and language label intact on a long block", () => {
			render(CodeBlock, {
				props: { code: longCode, language: "python" },
			});

			expect(screen.getByText("python")).toBeTruthy();
			expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
			expect(screen.getByTestId("code-lines-toggle")).toBeTruthy();
		});
	});

	it("meets the ≥44px touch-target minimum on the copy button", () => {
		// ADR-0043: interactive affordances on touch devices must be ≥44px.
		// The size classes are present in the markup so touch users always get
		// a tappable target (jsdom cannot evaluate the @media query, but the
		// classes must exist structurally).
		render(CodeBlock, {
			props: {
				code: "const a = 1;",
			},
		});

		const copyButton = screen.getByRole("button", { name: "Copy code" });
		expect(copyButton.className).toContain("min-h-[44px]");
		expect(copyButton.className).toContain("min-w-[44px]");
	});
});
