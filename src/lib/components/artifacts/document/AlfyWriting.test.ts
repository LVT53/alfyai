import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import AlfyWriting from "./AlfyWriting.svelte";

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
});

describe("AlfyWriting", () => {
	// While nothing more is known the strip stands for a read as much as for an edit
	// (a turn that only reads the Document shows it too), so it says neither "working"
	// nor "changing": Alfy is going through it (FX-2, owner's call on F6).
	it("says Alfy is going through the document while nothing more is known, which is true of a read and of an edit", () => {
		render(AlfyWriting, {});
		expect(screen.getByTestId("alfy-writing")).toHaveTextContent(
			"Alfy is going through the document…",
		);
		expect(screen.getByTestId("alfy-writing")).not.toHaveTextContent(
			/working/i,
		);
	});

	it("says it in Hungarian too, without claiming work it may not do", () => {
		uiLanguage.set("hu");
		render(AlfyWriting, {});
		expect(screen.getByTestId("alfy-writing")).toHaveTextContent(
			"Alfy átnézi a dokumentumot…",
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
