import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadAloudPlayerActions } from "$lib/client/read-aloud/controller";
import { idleReadAloudView, type ReadAloudView } from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudNote from "./ReadAloudNote.svelte";
import ReadAloudPlayerPill from "./ReadAloudPlayerPill.svelte";

function actions(): ReadAloudPlayerActions {
	return {
		toggle: vi.fn(),
		retry: vi.fn(),
		seek: vi.fn(),
		beginDrag: vi.fn(),
		dragTo: vi.fn(),
		endDrag: vi.fn(),
		sentencePreview: vi.fn(() => "2/2 · Shall I read you…"),
		setSpeed: vi.fn(),
		locate: vi.fn(),
		stop: vi.fn(),
	};
}

const view = (extra: Partial<ReadAloudView> = {}): ReadAloudView => ({
	...idleReadAloudView,
	status: "paused",
	sentence: 1,
	count: 2,
	notches: [0, 0.6],
	progress: 0.7,
	elapsed: "0:04",
	total: "0:07",
	...extra,
});

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Stubs the viewport as a phone (the pill's two rows) or not. */
function viewport(phone: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: phone && query.includes("max-width: 767px"),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
}

/** The pill's controls, in the order Tab reaches them. */
function tabOrder(container: HTMLElement): string[] {
	return [...container.querySelectorAll("button, [role='slider']")].map(
		(control) => control.getAttribute("aria-label") ?? "",
	);
}

describe("the floating pill's Tab order follows its layout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("on a desktop: ⏮ ▶ ⏭, the scrubber, ⌖, the speed, ✕", () => {
		viewport(false);
		const { container } = render(ReadAloudPlayerPill, {
			props: { view: view(), actions: actions(), variant: "floating" },
		});
		expect(tabOrder(container)).toEqual([
			"Previous sentence",
			"Play",
			"Next sentence",
			"Sentence",
			"Go to where it's reading",
			"Speed: 1×",
			"Stop reading",
		]);
	});

	it("on a phone: the scrubber, then the speed, ⏮ ▶ ⏭, ⌖, ✕ (its two rows)", () => {
		viewport(true);
		const { container } = render(ReadAloudPlayerPill, {
			props: { view: view(), actions: actions(), variant: "floating" },
		});
		expect(tabOrder(container)).toEqual([
			"Sentence",
			"Speed: 1×",
			"Previous sentence",
			"Play",
			"Next sentence",
			"Go to where it's reading",
			"Stop reading",
		]);
	});

	it("the inline pill on a phone: the scrubber, then ⏮ ▶ ⏭", () => {
		viewport(true);
		const { container } = render(ReadAloudPlayerPill, {
			props: { view: view(), actions: actions(), variant: "inline" },
		});
		expect(tabOrder(container)).toEqual([
			"Sentence",
			"Previous sentence",
			"Play",
			"Next sentence",
		]);
	});
});

describe("ReadAloudPlayerPill", () => {
	it("spins its play button while the voice falls behind, and a press there pauses (the second re-walk's New 6)", async () => {
		const acts = actions();
		render(ReadAloudPlayerPill, {
			props: {
				view: view({ status: "playing", buffering: true }),
				actions: acts,
				variant: "floating",
			},
		});
		// It spins, and it is still what it does: a press pauses, as the speaker does.
		const play = screen.getByRole("button", { name: "Pause" });
		expect(play.querySelector(".mini-spinner")).toBeTruthy();
		await fireEvent.click(play);
		expect(acts.toggle).toHaveBeenCalledTimes(1);
		// The steps and the scrubber still work: only play spins.
		expect(
			(
				screen.getByRole("button", {
					name: "Next sentence",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("says what a press does in Hungarian too, while it spins", () => {
		uiLanguage.set("hu");
		render(ReadAloudPlayerPill, {
			props: {
				view: view({ status: "playing", buffering: true }),
				actions: actions(),
				variant: "floating",
			},
		});
		expect(screen.getByRole("button", { name: "Szünet" })).toBeTruthy();
	});

	it("the inline pill draws the transport and the scrubber, and no locate, speed or stop", () => {
		const { container } = render(ReadAloudPlayerPill, {
			props: {
				view: view({ status: "finished" }),
				actions: actions(),
				variant: "inline",
			},
		});
		expect(
			screen.getByRole("button", { name: "Previous sentence" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Next sentence" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
		expect(screen.getByRole("slider", { name: "Sentence" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Go to where it's reading" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop reading" })).toBeNull();
		expect(container.querySelector(".read-aloud-speed")).toBeNull();
		expect(container.querySelector(".read-aloud-finished")).toBeNull();
		const pill = container.querySelector(".read-aloud-pill") as HTMLElement;
		expect(pill.dataset.variant).toBe("inline");
	});

	it("the floating pill draws locate, the speed chip and stop", () => {
		const { container } = render(ReadAloudPlayerPill, {
			props: { view: view(), actions: actions(), variant: "floating" },
		});
		expect(
			screen.getByRole("button", { name: "Go to where it's reading" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop reading" })).toBeTruthy();
		expect(container.querySelector(".read-aloud-speed")).toBeTruthy();
		expect(container.querySelector(".read-aloud-finished")).toBeTruthy();
	});

	it("calls its actions", async () => {
		const act = actions();
		const { rerender } = render(ReadAloudPlayerPill, {
			props: { view: view(), actions: act, variant: "inline" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(act.toggle).toHaveBeenCalledTimes(1);
		await fireEvent.click(
			screen.getByRole("button", { name: "Previous sentence" }),
		);
		expect(act.seek).toHaveBeenLastCalledWith(0);
		await fireEvent.click(
			screen.getByRole("button", { name: "Next sentence" }),
		);
		expect(act.seek).toHaveBeenLastCalledWith(2);
		await rerender({
			view: view({ status: "stopped" }),
			actions: act,
			variant: "inline",
		});
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(act.retry).toHaveBeenCalledTimes(1);
		expect(act.toggle).toHaveBeenCalledTimes(1);
	});

	it("a pill with no sentences disables stepping and the scrubber", () => {
		render(ReadAloudPlayerPill, {
			props: {
				view: view({ count: 0, sentence: 0, notches: [] }),
				actions: actions(),
				variant: "inline",
			},
		});
		expect(
			(
				screen.getByRole("button", {
					name: "Previous sentence",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Next sentence",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			screen
				.getByRole("slider", { name: "Sentence" })
				.getAttribute("aria-disabled"),
		).toBe("true");
	});

	it("an inline note sits in the flow", () => {
		const { container } = render(ReadAloudNote, {
			props: {
				tone: "warn",
				icon: "alert",
				text: "Couldn't play the sample.",
				placement: "inline",
			},
		});
		// jsdom applies no component CSS, so the layout itself (no absolute position, the
		// full width) is held by the editor's end-to-end tests; here, the placement.
		const note = container.querySelector(".read-aloud-note") as HTMLElement;
		expect(note.dataset.placement).toBe("inline");
	});
});
