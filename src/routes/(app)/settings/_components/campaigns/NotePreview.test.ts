import { cleanup, render, screen } from "@testing-library/svelte";
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

	it("renders the reader's strip inside an inert wrapper, so the admin cannot act on it", () => {
		const { container } = render(NotePreview, props());

		const wrapper = screen.getByTestId("note-preview");
		expect(wrapper).toHaveAttribute("inert");
		// The card is a child of the inert wrapper, not a second drawing of it.
		expect(
			wrapper.querySelector('[data-testid="feature-note"]'),
		).not.toBeNull();
		expect(container.querySelector('[data-testid="feature-note"]')).toBe(
			wrapper.querySelector('[data-testid="feature-note"]'),
		);
		// Preview mode is what makes the strip's own X and CTA no-ops; the strip
		// test covers that guard.
		expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
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
