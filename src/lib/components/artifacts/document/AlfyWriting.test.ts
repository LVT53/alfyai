import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import AlfyWriting from "./AlfyWriting.svelte";

afterEach(() => {
	cleanup();
});

describe("AlfyWriting", () => {
	it("says Alfy is working on the document while nothing more is known", () => {
		render(AlfyWriting, {});
		expect(screen.getByTestId("alfy-writing")).toHaveTextContent(
			"Alfy is working on the document…",
		);
	});

	it("names the call's own summary once it is known", () => {
		render(AlfyWriting, { summary: "Packing list" });
		expect(screen.getByTestId("alfy-writing")).toHaveTextContent(
			"Alfy is working on the document: Packing list",
		);
	});

	it("announces itself politely for screen readers", () => {
		render(AlfyWriting, { summary: "Budget" });
		const strip = screen.getByTestId("alfy-writing");
		expect(strip).toHaveAttribute("aria-live", "polite");
		expect(strip).toHaveAttribute("role", "status");
	});
});
