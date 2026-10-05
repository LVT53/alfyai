import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import TourPreview from "./TourPreview.svelte";

const SLIDES = [
	{
		kind: "summary",
		titleEn: "Empty board. Insert a block.",
		titleHu: "Üres tábla. Szúrj be egy blokkot.",
		bodyEn: "",
		bodyHu: "",
	},
	{
		kind: "standard",
		titleEn: "First step",
		titleHu: "Első lépés",
		bodyEn: "First words.",
		bodyHu: "Első szavak.",
	},
	{
		kind: "standard",
		titleEn: "Second step",
		titleHu: "Második lépés",
		bodyEn: "Second words.",
		bodyHu: "Második szavak.",
	},
	{
		kind: "standard",
		titleEn: "Third step",
		titleHu: "Harmadik lépés",
		bodyEn: "Third words.",
		bodyHu: "Harmadik szavak.",
	},
];

function props(overrides: Record<string, unknown> = {}) {
	return {
		releaseVersion: "canvas",
		slides: SLIDES,
		locale: "en" as const,
		slideIndex: 1,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
});

// The preview is the reader's own card, drawn with the draft's words: the admin
// sees what a reader will meet, not an announcement modal with a logo.
describe("TourPreview", () => {
	it("draws the reader's card for the open step, with the draft's words", async () => {
		render(TourPreview, props());

		const card = await screen.findByTestId("artifact-tour");
		expect(card).toHaveAttribute("data-kind", "canvas");
		expect(card).toHaveAttribute("data-replay", "false");
		expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
			"First step",
		);
		expect(screen.getByTestId("artifact-tour-body")).toHaveTextContent(
			"First words.",
		);
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 1 of 3",
		);
	});

	it("shows the language being edited, whatever language the interface speaks", async () => {
		uiLanguage.set("en");
		render(TourPreview, props({ locale: "hu" }));

		await waitFor(() =>
			expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
				"Első lépés",
			),
		);
		expect(screen.getByTestId("artifact-tour-body")).toHaveTextContent(
			"Első szavak.",
		);
	});

	it("follows the slide chosen in the rail", async () => {
		const { rerender } = render(TourPreview, props({ slideIndex: 1 }));
		await screen.findByTestId("artifact-tour");

		await rerender(props({ slideIndex: 3 }));

		await waitFor(() =>
			expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
				"Third step",
			),
		);
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 3 of 3",
		);
		// The last step is where the reader is told they can watch it again.
		expect(screen.getByTestId("artifact-tour-hint")).toBeInTheDocument();
	});

	it("follows the words as they are typed", async () => {
		const { rerender } = render(TourPreview, props());
		await screen.findByTestId("artifact-tour");

		await rerender(
			props({
				slides: SLIDES.map((slide, index) =>
					index === 1 ? { ...slide, titleEn: "A better first step" } : slide,
				),
			}),
		);

		await waitFor(() =>
			expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
				"A better first step",
			),
		);
	});

	it("previews the summary slide as the empty state it is: one line and the link to the tour", () => {
		render(TourPreview, props({ slideIndex: 0 }));

		expect(screen.getByTestId("tour-preview-line")).toHaveTextContent(
			"Empty board. Insert a block.",
		);
		expect(screen.getByTestId("tour-preview-line-replay")).toBeInTheDocument();
		expect(screen.queryByTestId("artifact-tour")).not.toBeInTheDocument();
	});

	it("is a picture only: inert, so the card's keys, focus and buttons never reach the admin", async () => {
		render(TourPreview, props());
		await screen.findByTestId("artifact-tour");

		expect(screen.getByTestId("tour-preview")).toHaveAttribute("inert");
	});

	it("says what it needs when the tour names no kind that ships, and draws no card", () => {
		render(TourPreview, props({ releaseVersion: "2.1.0" }));

		expect(
			screen.getByText(
				"The preview needs the tour's kind: Document, App or Canvas.",
			),
		).toBeInTheDocument();
		expect(screen.queryByTestId("artifact-tour")).not.toBeInTheDocument();
	});

	it("draws each kind's own illustration", async () => {
		for (const kind of ["document", "app", "canvas"]) {
			cleanup();
			render(TourPreview, props({ releaseVersion: kind }));
			expect(await screen.findByTestId("artifact-tour")).toHaveAttribute(
				"data-kind",
				kind,
			);
		}
	});
});
