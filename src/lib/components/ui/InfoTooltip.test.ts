import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import InfoTooltip from "./InfoTooltip.svelte";

function renderTooltip(overrides = {}) {
	return render(InfoTooltip, {
		props: {
			text: "This is what AlfyAI reads to personalize replies.",
			...overrides,
		},
	});
}

describe("InfoTooltip", () => {
	it("hides the tooltip content until the trigger is interacted with", () => {
		renderTooltip();

		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("shows the tooltip on hover and hides it on mouse leave", async () => {
		renderTooltip();
		const trigger = screen.getByRole("button");

		await fireEvent.mouseEnter(trigger);
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"This is what AlfyAI reads to personalize replies.",
		);
		expect(trigger).toHaveAttribute(
			"aria-describedby",
			screen.getByRole("tooltip").id,
		);

		await fireEvent.mouseLeave(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("shows the tooltip on keyboard focus and dismisses on blur", async () => {
		renderTooltip();
		const trigger = screen.getByRole("button");

		await fireEvent.focus(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await fireEvent.blur(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("dismisses the tooltip when Escape is pressed", async () => {
		renderTooltip();
		const trigger = screen.getByRole("button");

		await fireEvent.focus(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await fireEvent.keyDown(trigger, { key: "Escape" });
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("uses the label prop as the accessible name when provided", () => {
		renderTooltip({ label: "About this summary" });

		expect(
			screen.getByRole("button", { name: "About this summary" }),
		).toBeInTheDocument();
	});

	it("falls back to the text as the accessible name without a label", () => {
		renderTooltip();

		expect(
			screen.getByRole("button", {
				name: "This is what AlfyAI reads to personalize replies.",
			}),
		).toBeInTheDocument();
	});
});
