import { cleanup, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedArtifactTour } from "$lib/shared/artifacts/tours";
import { uiLanguage } from "$lib/stores/settings";
import ArtifactTour from "./ArtifactTour.svelte";

function makeTour(
	overrides: Partial<ResolvedArtifactTour> = {},
): ResolvedArtifactTour {
	return {
		artifactType: "canvas",
		contentKey: "default:1",
		source: "default",
		slides: [
			{
				title: { en: "A board for anything", hu: "Egy tábla, bármire" },
				body: { en: "First body.", hu: "Első szöveg." },
			},
			{
				title: {
					en: "Draw on it, and place things",
					hu: "Rajzolj rá, és helyezz el dolgokat",
				},
				body: { en: "Second body.", hu: "Második szöveg." },
			},
			{
				title: { en: "How to ask for one", hu: "Hogyan kérj ilyet" },
				body: { en: "Third body.", hu: "Harmadik szöveg." },
			},
		],
		summary: { en: "Empty board.", hu: "Üres tábla." },
		...overrides,
	};
}

function stubMatchMedia(matches: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

let animateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	uiLanguage.set("en");
	stubMatchMedia(false);
	animateSpy = vi.fn(() => ({
		finished: Promise.resolve(),
		cancel: vi.fn(),
	}));
	HTMLElement.prototype.animate =
		animateSpy as unknown as typeof HTMLElement.prototype.animate;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	uiLanguage.set("en");
});

function renderTour(
	props: Partial<{
		tour: ResolvedArtifactTour;
		startSlide: number;
		replay: boolean;
		animate: boolean;
	}> = {},
	options: { intro?: boolean } = {},
) {
	const onSeen = vi.fn();
	const onDismiss = vi.fn();
	const onClose = vi.fn();
	const user = userEvent.setup();
	const result = render(ArtifactTour, {
		props: { tour: makeTour(), onSeen, onDismiss, onClose, ...props },
		...options,
	});
	return { ...result, user, onSeen, onDismiss, onClose };
}

describe("ArtifactTour", () => {
	it("renders the first of three slides with its dots, and advances on Next", async () => {
		const { user } = renderTour();

		const region = screen.getByRole("region", { name: "How this kind works" });
		expect(within(region).getByText("Step 1 of 3")).toBeInTheDocument();
		expect(
			within(region).getByRole("heading", { name: "A board for anything" }),
		).toBeInTheDocument();
		expect(within(region).getByText("First body.")).toBeInTheDocument();

		const dots = within(region).getByRole("img", { name: "3 steps" });
		const marks = within(dots).getAllByTestId("artifact-tour-dot");
		expect(marks).toHaveLength(3);
		expect(marks.map((mark) => mark.dataset.active)).toEqual([
			"true",
			"false",
			"false",
		]);

		await user.click(within(region).getByRole("button", { name: "Next" }));

		expect(within(region).getByText("Step 2 of 3")).toBeInTheDocument();
		expect(
			within(region).getByRole("heading", {
				name: "Draw on it, and place things",
			}),
		).toBeInTheDocument();
		expect(
			within(dots)
				.getAllByTestId("artifact-tour-dot")
				.map((mark) => mark.dataset.active),
		).toEqual(["false", "true", "false"]);
	});

	it("goes back, and never past the first or last slide", async () => {
		const { user } = renderTour();

		// Slide 1: nothing to go back to.
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(screen.getByRole("button", { name: "Next" }));

		// Slide 3: the way forward is the end, not a fourth slide.
		expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
		expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
	});

	it("starts where it is told to, within the three slides", () => {
		renderTour({ startSlide: 2 });
		expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
		cleanup();
		renderTour({ startSlide: 9 });
		expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
		cleanup();
		renderTour({ startSlide: -4 });
		expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
	});

	it("calls onSeen once, with the last slide index, when the user finishes", async () => {
		const { user, onSeen, onDismiss } = renderTour();

		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		const done = screen.getByRole("button", { name: "Got it" });
		await user.click(done);
		// A second activation (a double click, a held Enter) must not write twice.
		await user.click(done);
		await user.keyboard("{Enter}");

		expect(onSeen).toHaveBeenCalledTimes(1);
		expect(onSeen).toHaveBeenCalledWith(2);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("calls onDismiss with the current index when the user skips", async () => {
		const { user, onSeen, onDismiss } = renderTour();

		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(screen.getByRole("button", { name: "Skip" }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledWith(1);
		expect(onSeen).not.toHaveBeenCalled();
	});

	it("shows the replay hint on the last slide only", async () => {
		const { user } = renderTour();
		const hint = "You'll see this once. You can replay it any time.";

		expect(screen.queryByText(hint)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.queryByText(hint)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText(hint)).toBeInTheDocument();
	});

	it("announces the new step's position and title, in a live region of its own, when Next or Back is pressed", async () => {
		const { user } = renderTour();

		const live = screen.getByTestId("artifact-tour-live");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveAttribute("aria-atomic", "true");
		// Nothing is announced for the slide the card opens on: the card's own name is.
		expect(live).toHaveTextContent("");
		await user.click(screen.getByRole("button", { name: "Next" }));
		// The same element changes its words, which is what a live region announces.
		expect(screen.getByTestId("artifact-tour-live")).toBe(live);
		expect(live).toHaveTextContent("Step 2 of 3. Draw on it, and place things");
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(live).toHaveTextContent("Step 3 of 3. How to ask for one");
		await user.click(screen.getByRole("button", { name: "Back" }));
		expect(live).toHaveTextContent("Step 2 of 3. Draw on it, and place things");

		// The visible step line is plain text, so nothing is read twice.
		const step = screen.getByTestId("artifact-tour-step");
		expect(step).toHaveTextContent("Step 2 of 3");
		expect(step).not.toHaveAttribute("aria-live");
	});

	it("reads the step as '1. lépés / 3' in Hungarian, in the line and in the announcement", async () => {
		uiLanguage.set("hu");
		const { user } = renderTour();

		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"1. lépés / 3",
		);
		await user.click(screen.getByRole("button", { name: "Tovább" }));
		expect(screen.getByTestId("artifact-tour-live")).toHaveTextContent(
			"2. lépés / 3. Rajzolj rá, és helyezz el dolgokat",
		);
	});

	it("is one region, traps no focus, and puts Skip first in tab order", async () => {
		const user = userEvent.setup();
		render(ArtifactTour, {
			props: {
				tour: makeTour(),
				onSeen: vi.fn(),
				onDismiss: vi.fn(),
				onClose: vi.fn(),
			},
		});
		const outside = document.createElement("button");
		outside.textContent = "Outside";
		document.body.append(outside);

		const region = screen.getByRole("region", { name: "How this kind works" });
		expect(screen.getAllByRole("region")).toHaveLength(1);
		// Not a dialog: nothing behind it is inert, and focus is free to leave.
		expect(region).not.toHaveAttribute("aria-modal");
		expect(region.closest("[inert]")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Next" }));
		const controls = within(region).getAllByRole("button");
		expect(controls.map((control) => control.textContent?.trim())).toEqual([
			"Skip",
			"Back",
			"Next",
		]);

		(controls[0] as HTMLElement).focus();
		await user.tab();
		expect(document.activeElement).toBe(controls[1]);
		await user.tab();
		expect(document.activeElement).toBe(controls[2]);
		await user.tab();
		expect(document.activeElement).toBe(outside);
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(controls[2]);

		outside.remove();
	});

	it("keeps the keyboard on the same button from Next through Got it, and off the floor when Back goes", async () => {
		const { user } = renderTour();
		const primary = screen.getByRole("button", { name: "Next" });
		primary.focus();
		await user.keyboard("{Enter}");
		await user.keyboard("{Enter}");

		// Slide 3: the same element, now "Got it", still has focus.
		expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
		const done = screen.getByRole("button", { name: "Got it" });
		expect(done).toBe(primary);
		expect(document.activeElement).toBe(done);

		// Back from slide 2 lands on slide 1, where Back no longer exists.
		await user.click(screen.getByRole("button", { name: "Back" }));
		const back = screen.getByRole("button", { name: "Back" });
		back.focus();
		await user.keyboard("{Enter}");
		expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Next" }),
		);
	});

	it("closes on Escape, as Skip does, and only while focus is in the card", async () => {
		const { user, onDismiss, onSeen } = renderTour();
		const outside = document.createElement("button");
		document.body.append(outside);

		await user.click(screen.getByRole("button", { name: "Next" }));
		// The reader keeps working beside the card: Escape out there is theirs.
		outside.focus();
		await user.keyboard("{Escape}");
		expect(onDismiss).not.toHaveBeenCalled();

		screen.getByRole("button", { name: "Skip" }).focus();
		await user.keyboard("{Escape}");
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledWith(1);
		expect(onSeen).not.toHaveBeenCalled();

		outside.remove();
	});

	it("calls neither callback when replaying, and closes through onClose", async () => {
		// Skip.
		const skipped = renderTour({ replay: true });
		expect(screen.getByText("Replaying")).toBeInTheDocument();
		await skipped.user.click(screen.getByRole("button", { name: "Next" }));
		await skipped.user.click(screen.getByRole("button", { name: "Skip" }));
		expect(skipped.onClose).toHaveBeenCalledTimes(1);
		expect(skipped.onSeen).not.toHaveBeenCalled();
		expect(skipped.onDismiss).not.toHaveBeenCalled();
		cleanup();

		// The last slide's "Got it".
		const finished = renderTour({ replay: true });
		await finished.user.click(screen.getByRole("button", { name: "Next" }));
		await finished.user.click(screen.getByRole("button", { name: "Next" }));
		await finished.user.click(screen.getByRole("button", { name: "Got it" }));
		expect(finished.onClose).toHaveBeenCalledTimes(1);
		expect(finished.onSeen).not.toHaveBeenCalled();
		expect(finished.onDismiss).not.toHaveBeenCalled();
		cleanup();

		// Escape.
		const escaped = renderTour({ replay: true });
		screen.getByRole("button", { name: "Skip" }).focus();
		await escaped.user.keyboard("{Escape}");
		expect(escaped.onClose).toHaveBeenCalledTimes(1);
		expect(escaped.onSeen).not.toHaveBeenCalled();
		expect(escaped.onDismiss).not.toHaveBeenCalled();
	});

	it("does not offer the once-only hint, nor the Replaying label, in a first-open tour", async () => {
		const { user } = renderTour();
		expect(screen.queryByText("Replaying")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.queryByText("Replaying")).toBeNull();
	});

	it("does not say it will not be seen again while replaying", async () => {
		const { user } = renderTour({ replay: true });
		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(
			screen.queryByText("You'll see this once. You can replay it any time."),
		).toBeNull();
	});

	it("renders the current language's copy and switches languages live", async () => {
		const { user } = renderTour();
		expect(
			screen.getByRole("heading", { name: "A board for anything" }),
		).toBeInTheDocument();

		uiLanguage.set("hu");
		expect(
			await screen.findByRole("heading", { name: "Egy tábla, bármire" }),
		).toBeInTheDocument();
		expect(screen.getByText("Első szöveg.")).toBeInTheDocument();
		expect(screen.getByText("1. lépés / 3")).toBeInTheDocument();
		expect(
			screen.getByRole("region", { name: "Így működik ez a típus" }),
		).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "3 lépés" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Tovább" }));
		expect(
			screen.getByRole("heading", {
				name: "Rajzolj rá, és helyezz el dolgokat",
			}),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Tovább" }));
		expect(screen.getByRole("button", { name: "Értem" })).toBeInTheDocument();
		expect(
			screen.getByText("Egyszer látod. Bármikor újranézheted."),
		).toBeInTheDocument();

		uiLanguage.set("en");
		expect(
			await screen.findByRole("heading", { name: "How to ask for one" }),
		).toBeInTheDocument();
	});

	it("survives a tour whose copy is missing a language by falling back to en", () => {
		uiLanguage.set("hu");
		const tour = makeTour();
		tour.slides[0] = {
			title: { en: "A board for anything", hu: "" },
			body: { en: "First body.", hu: "   " },
		};
		renderTour({ tour });

		expect(
			screen.getByRole("heading", { name: "A board for anything" }),
		).toBeInTheDocument();
		expect(screen.getByText("First body.")).toBeInTheDocument();
		// The chrome is still the reader's own language.
		expect(screen.getByRole("button", { name: "Tovább" })).toBeInTheDocument();
	});

	it("draws the illustration of the kind it explains, hidden from assistive tech", () => {
		for (const artifactType of ["document", "app", "canvas"] as const) {
			renderTour({ tour: makeTour({ artifactType }) });
			const art = screen.getByTestId("artifact-tour-illustration");
			expect(art).toHaveAttribute("aria-hidden", "true");
			expect(art.querySelector("svg")?.dataset.kind).toBe(artifactType);
			cleanup();
		}
	});

	// Slice 6 T7 asks for the illustration's alt text to be built from
	// `artifacts.type.*`. The drawings are decorative (`aria-hidden`, next to
	// the very words that say what they show), so they have no alt text to
	// build: what the test can hold is that the drawing carries no words of its
	// own, in either language, so a kind's name cannot differ from the
	// dictionary's by being typed into a picture.
	it("gives the drawing no words of its own, in either language", () => {
		for (const language of ["en", "hu"] as const) {
			uiLanguage.set(language);
			for (const artifactType of ["document", "app", "canvas"] as const) {
				renderTour({ tour: makeTour({ artifactType }) });
				const art = screen.getByTestId("artifact-tour-illustration");
				expect(art.textContent?.trim()).toBe("");
				expect(art.querySelector("title, desc, text")).toBeNull();
				expect(
					art.querySelector("[aria-label], [alt], [aria-labelledby]"),
				).toBeNull();
				cleanup();
			}
		}
	});

	it("moves between slides with a short animation, and stays instant under prefers-reduced-motion", async () => {
		const { user } = renderTour();
		animateSpy.mockClear();
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(animateSpy).toHaveBeenCalledTimes(1);

		cleanup();
		stubMatchMedia(true);
		animateSpy.mockClear();
		const reduced = renderTour();
		await reduced.user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
		expect(animateSpy).not.toHaveBeenCalled();
	});

	it("slides in from nothing when the host asks for motion, and is simply there otherwise", async () => {
		// The host (the panel) asks; the admin's preview does not.
		renderTour({}, { intro: true });
		expect(animateSpy).not.toHaveBeenCalled();
		cleanup();

		renderTour({ animate: true }, { intro: true });
		expect(animateSpy).toHaveBeenCalled();
		// The first frame of its entrance is a collapsed one: the card arrives as a
		// height that grows, and the page below it moves with that, not in one frame.
		const [keyframes] = animateSpy.mock.calls[0] as [Keyframe[]];
		expect(keyframes[0]).toHaveProperty("height");
		expect(keyframes[0]).toHaveProperty("overflow", "hidden");
	});

	it("does not slide under prefers-reduced-motion, whatever the host asks", () => {
		stubMatchMedia(true);
		renderTour({ animate: true }, { intro: true });

		expect(animateSpy).not.toHaveBeenCalled();
		expect(screen.getByTestId("artifact-tour")).toBeInTheDocument();
	});

	it("hands focus back the moment the reader leaves, not when the card has finished going", async () => {
		const before = document.createElement("button");
		before.textContent = "Before";
		document.body.append(before);
		before.focus();

		const { user } = renderTour();
		expect(document.activeElement).toBe(
			screen.getByRole("region", { name: "How this kind works" }),
		);
		await user.click(screen.getByRole("button", { name: "Skip" }));

		// A leaving card stays in the page until its exit has played; focus must
		// not wait for that (it would sit on a button that is on its way out).
		expect(screen.getByTestId("artifact-tour")).toBeInTheDocument();
		expect(document.activeElement).toBe(before);

		before.remove();
	});

	it("takes focus when it shows, and gives it back to where it was when it goes", async () => {
		const before = document.createElement("button");
		before.textContent = "Before";
		document.body.append(before);
		before.focus();

		const { user, unmount } = renderTour();
		const region = screen.getByRole("region", { name: "How this kind works" });
		expect(document.activeElement).toBe(region);

		await user.click(screen.getByRole("button", { name: "Skip" }));
		unmount();
		expect(document.activeElement).toBe(before);

		before.remove();
	});

	it("leaves the reader's focus alone when they are already typing", () => {
		const field = document.createElement("div");
		field.setAttribute("contenteditable", "true");
		field.tabIndex = 0;
		document.body.append(field);
		field.focus();

		renderTour();
		expect(document.activeElement).toBe(field);

		field.remove();
	});
});
