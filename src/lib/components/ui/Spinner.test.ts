import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Spinner from "./Spinner.svelte";

describe("Spinner", () => {
	it("renders a spinning lucide Loader icon with the canonical stroke width", () => {
		render(Spinner);

		const icon = screen.getByTestId("spinner");
		expect(icon.tagName).toBe("svg");
		expect(icon).toHaveClass("animate-spin");
		expect(icon).toHaveClass("lucide-loader");
		expect(icon).toHaveAttribute("stroke-width", "2");
		expect(icon).toHaveAttribute("aria-hidden", "true");
	});

	it("defaults to a 16px size and honors an explicit size prop", () => {
		const { unmount } = render(Spinner);
		expect(screen.getByTestId("spinner")).toHaveAttribute("width", "16");
		unmount();

		render(Spinner, { props: { size: 32 } });
		const icon = screen.getByTestId("spinner");
		expect(icon).toHaveAttribute("width", "32");
		expect(icon).toHaveAttribute("height", "32");
	});

	it("merges caller-supplied classes alongside animate-spin", () => {
		render(Spinner, { props: { class: "text-accent" } });

		const icon = screen.getByTestId("spinner");
		expect(icon).toHaveClass("animate-spin");
		expect(icon).toHaveClass("text-accent");
	});
});
