import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import NotePreview from "./NotePreview.svelte";

const SLIDE = {
	kind: "standard",
	semanticRole: "feature",
	sortOrder: 1,
	titleEn: "Two-factor authentication",
	titleHu: "Kétlépcsős azonosítás",
	bodyEn: "Keep your account safer.",
	bodyHu: "Tartsd biztonságban a fiókodat.",
	actionLabelEn: "Set up 2FA",
	actionLabelHu: "2FA beállítása",
	actionUrl: "/settings",
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		name: "Two-factor authentication",
		slides: [SLIDE],
		locale: "en" as const,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
});

// The admin preview is the reader's own strip, drawn with the draft's words: the
// admin sees what a reader will meet, not the campaign modal.
describe("NotePreview", () => {
	it("draws the reader's strip with the draft's words in the edited language", () => {
		// The interface speaks English; the admin is editing the Hungarian copy.
		uiLanguage.set("en");
		render(NotePreview, props({ locale: "hu" }));

		expect(screen.getByTestId("feature-note")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Kétlépcsős azonosítás" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Tartsd biztonságban a fiókodat."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "2FA beállítása" }),
		).toHaveAttribute("href", "/settings");
	});

	it("draws the English copy when English is the edited language", () => {
		uiLanguage.set("hu");
		render(NotePreview, props({ locale: "en" }));

		expect(
			screen.getByRole("heading", { name: "Two-factor authentication" }),
		).toBeInTheDocument();
		expect(screen.getByText("Keep your account safer.")).toBeInTheDocument();
	});

	it("is a picture only: inert, so the strip's buttons and link never reach the admin", async () => {
		render(NotePreview, props());

		const wrapper = screen.getByTestId("note-preview");
		expect(wrapper).toHaveAttribute("inert");
		expect(
			wrapper.querySelector('[data-testid="feature-note"]'),
		).not.toBeNull();

		// The strip is in preview mode: neither the dismiss nor the action calls
		// anything, and neither navigates (jsdom cannot follow the href anyway).
		const dismiss = screen.getByRole("button", { name: "Dismiss" });
		const link = screen.getByRole("link", { name: "Set up 2FA" });
		link.addEventListener("click", (event) => event.preventDefault(), {
			once: true,
		});
		await fireEvent.click(dismiss);
		await fireEvent.click(link);
	});

	it("keeps the card's shape when the draft has no words yet", () => {
		render(
			NotePreview,
			props({
				slides: [
					{
						...SLIDE,
						titleEn: "",
						titleHu: "",
						bodyEn: "",
						bodyHu: "",
						actionUrl: "",
					},
				],
			}),
		);

		// A draft can be empty; the region still needs a name.
		expect(
			screen.getByRole("region", { name: "New feature" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it("draws the empty note when no slide has been seeded yet", () => {
		render(NotePreview, props({ slides: [] }));

		expect(screen.getByTestId("feature-note")).toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "New feature" }),
		).toBeInTheDocument();
	});
});
