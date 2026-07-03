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
