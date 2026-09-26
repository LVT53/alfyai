import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import AlfyWriting from "./AlfyWriting.svelte";

afterEach(() => {
	cleanup();
});

describe("AlfyWriting", () => {
	it("shows the block's label while a tool call is in flight", () => {
		render(AlfyWriting, { label: "Packing list" });
		expect(screen.getByTestId("alfy-writing")).toHaveTextContent(
			"Alfy is writing: Packing list",
		);
	});

	it("announces itself politely for screen readers", () => {
		render(AlfyWriting, { label: "Budget" });
		expect(screen.getByTestId("alfy-writing")).toHaveAttribute(
			"aria-live",
			"polite",
		);
	});
});
