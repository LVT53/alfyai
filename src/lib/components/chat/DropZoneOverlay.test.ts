import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import DropZoneOverlay from "./DropZoneOverlay.svelte";

// The drag overlay is the largest text on screen while a drag is in flight,
// and it was the last component in src/lib/components with no $lib/i18n
// import at all — both of its lines were English literals, so a Hungarian
// user dragging a file onto the chat got the one full-screen message in the
// app that had never been translated.
describe("DropZoneOverlay", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders nothing until a drag is over the page", () => {
		render(DropZoneOverlay, { active: false });
		expect(screen.queryByTestId("drop-zone-overlay")).toBeNull();
	});

	it("invites the drop, with the size limit, in English", () => {
		render(DropZoneOverlay, { active: true });
		expect(
			screen.getByText("Drop files to attach (max 100MB per file)"),
		).toBeInTheDocument();
	});

	it("says why a drop is refused mid-generation, in English", () => {
		render(DropZoneOverlay, { active: true, rejected: true });
		expect(
			screen.getByText("Cannot upload while generating"),
		).toBeInTheDocument();
		// The invitation must not also be on screen — the two are exclusive.
		expect(
			screen.queryByText("Drop files to attach (max 100MB per file)"),
		).toBeNull();
	});

	it("says both of them in Hungarian", () => {
		uiLanguage.set("hu");

		render(DropZoneOverlay, { active: true });
		expect(
			screen.getByText("Húzd ide a fájlokat csatoláshoz (max. 100 MB/fájl)"),
		).toBeInTheDocument();

		render(DropZoneOverlay, { active: true, rejected: true });
		expect(
			screen.getByText("Válaszírás közben nem tudsz feltölteni"),
		).toBeInTheDocument();
	});
});
