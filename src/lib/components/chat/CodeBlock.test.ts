import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

		expect(screen.getByText("Copied!")).toBeTruthy();
	});
});
