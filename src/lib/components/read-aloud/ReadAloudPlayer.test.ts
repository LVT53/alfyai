import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadAloudController } from "$lib/client/read-aloud/controller";
import {
	idleReadAloudView,
	type ReadAloudView,
	setReadAloudView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import { MOTION_DURATION } from "$lib/utils/motion";
import ReadAloudPlayer from "./ReadAloudPlayer.svelte";

function fakeController(): ReadAloudController {
	return {
		start: vi.fn(),
		toggle: vi.fn(),
		seek: vi.fn(),
		retry: vi.fn(),
		beginDrag: vi.fn(),
		dragTo: vi.fn(),
		endDrag: vi.fn(),
		setSpeed: vi.fn(),
		stop: vi.fn(),
		locate: vi.fn(),
		sentencePreview: vi.fn(() => "2/3 · The second one…"),
		assessReadability: vi.fn(async () => ({ kind: "ready" as const })),
	};
}

const reading = (extra: Partial<ReadAloudView> = {}): ReadAloudView => ({
	...idleReadAloudView,
	status: "playing",
	key: "m1",
	segmentIds: ["m1"],
	sentence: 1,
	count: 3,
	notches: [0, 0.3, 0.7],
	progress: 0.4,
	elapsed: "0:09",
	total: "0:24",
	totalIsEstimate: true,
	...extra,
});

function player(
	props: Partial<{ conversationId: string; hushed: boolean }> = {},
) {
	const controller = fakeController();
	const result = render(ReadAloudPlayer, {
		props: { conversationId: "c1", hushed: false, controller, ...props },
	});
	const slot = () =>
		result.container.querySelector(".read-aloud-slot") as HTMLElement;
	const pill = () =>
		result.container.querySelector(".read-aloud-pill") as HTMLElement;
	return { ...result, controller, slot, pill };
}

beforeEach(() => {
	// Reduced motion: the slot opens and closes without waiting on animations.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("reduce"),
		media: query,
	}));
	uiLanguage.set("en");
	setReadAloudView(idleReadAloudView);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	setReadAloudView(idleReadAloudView);
});

describe("ReadAloudPlayer", () => {
	it("opens its slot when a reading starts and closes it after ✕", async () => {
		const t = player();
		expect(t.slot().hasAttribute("data-open")).toBe(false);
		setReadAloudView(reading({ status: "opening" }));
		await tick();
		// The speaker spins first; the player rises with the first audio.
		expect(t.slot().hasAttribute("data-open")).toBe(false);
		setReadAloudView(reading());
		await tick();
		expect(t.slot().hasAttribute("data-open")).toBe(true);
		const pill = within(t.pill());
		expect(screen.getByRole("group", { name: "Read aloud player" })).toBe(
			t.pill(),
		);
		expect(t.pill().textContent).toContain("0:09");
		expect(t.pill().textContent).toContain("≈0:24");
		await fireEvent.click(pill.getByRole("button", { name: "Stop reading" }));
		expect(t.controller.stop).toHaveBeenCalled();
		setReadAloudView(idleReadAloudView);
		await tick();
		await vi.waitFor(() =>
			expect(t.slot().hasAttribute("data-open")).toBe(false),
		);
	});

	it("wires its buttons to the controller", async () => {
		const t = player();
		setReadAloudView(reading());
		await tick();
		const pill = within(t.pill());
		await fireEvent.click(pill.getByRole("button", { name: "Pause" }));
		expect(t.controller.toggle).toHaveBeenCalled();
		await fireEvent.click(
			pill.getByRole("button", { name: "Previous sentence" }),
		);
		expect(t.controller.seek).toHaveBeenLastCalledWith(0);
		await fireEvent.click(pill.getByRole("button", { name: "Next sentence" }));
		expect(t.controller.seek).toHaveBeenLastCalledWith(2);
		await fireEvent.click(
			pill.getByRole("button", { name: "Go to where it's reading" }),
		);
		expect(t.controller.locate).toHaveBeenCalled();
		await fireEvent.keyDown(pill.getByRole("slider"), { key: "End" });
		expect(t.controller.seek).toHaveBeenLastCalledWith(2);
		setReadAloudView(reading({ status: "paused" }));
		await tick();
		expect(pill.getByRole("button", { name: "Play" })).toBeTruthy();
	});

	it("play shows the spinner while seeking or waiting", async () => {
		const t = player();
		for (const status of ["seeking", "waiting"] as const) {
			setReadAloudView(
				reading({ status, failure: status === "waiting" ? "offline" : null }),
			);
			await tick();
			const play = within(t.pill()).getByRole("button", {
				name: "Waiting to continue",
			});
			expect(play.querySelector(".mini-spinner")).toBeTruthy();
		}
		// The scrubber and the steps wait too.
		expect(
			within(t.pill()).getByRole("slider").getAttribute("aria-disabled"),
		).toBe("true");
		expect(
			(
				within(t.pill()).getByRole("button", {
					name: "Next sentence",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("stopped shows Try again and the amber edge", async () => {
		const t = player();
		setReadAloudView(reading({ status: "stopped", failure: "voice" }));
		await tick();
		expect(t.pill().hasAttribute("data-failed")).toBe(true);
		const note = screen.getByRole("status");
		expect(note.textContent).toContain(
			"Reading stopped. The voice stopped answering.",
		);
		await fireEvent.click(
			within(note).getByRole("button", { name: "Try again" }),
		);
		expect(t.controller.retry).toHaveBeenCalledTimes(1);
		const play = within(t.pill()).getByRole("button", { name: "Try again" });
		expect(play.querySelector(".lucide-rotate-ccw")).toBeTruthy();
		await fireEvent.click(play);
		expect(t.controller.retry).toHaveBeenCalledTimes(2);
	});

	it("shows the offline and the update notes without Try again", async () => {
		const t = player();
		setReadAloudView(reading({ status: "waiting", failure: "offline" }));
		await tick();
		expect(screen.getByRole("status").textContent).toContain(
			"You're offline. Reading continues when you're back.",
		);
		expect(within(screen.getByRole("status")).queryByRole("button")).toBeNull();
		setReadAloudView(reading({ status: "waiting", failure: "updating" }));
		await tick();
		expect(screen.getByRole("status").textContent).toContain(
			"AlfyAI is updating. Reading continues when it is back.",
		);
		expect(t.pill().hasAttribute("data-failed")).toBe(false);
	});

	it("shows Finished", async () => {
		const t = player();
		setReadAloudView(reading({ status: "finished", progress: 1 }));
		await tick();
		expect(t.slot().hasAttribute("data-open")).toBe(true);
		expect(
			t.pill().querySelector(".read-aloud-finished")?.textContent,
		).toContain("Finished");
		expect(t.pill().hasAttribute("data-finished")).toBe(true);
	});

	it("hushed keeps its room and hides it", async () => {
		const t = player({ hushed: true });
		setReadAloudView(reading());
		await tick();
		expect(t.slot().hasAttribute("data-open")).toBe(true);
		expect(t.slot().hasAttribute("data-hushed")).toBe(true);
	});

	it("stops when the chat changes, and when it goes", async () => {
		const t = player();
		setReadAloudView(reading());
		await tick();
		expect(t.controller.stop).not.toHaveBeenCalled();
		await t.rerender({
			conversationId: "c2",
			hushed: false,
			controller: t.controller,
		});
		expect(t.controller.stop).toHaveBeenCalledTimes(1);
		t.unmount();
		expect(t.controller.stop).toHaveBeenCalledTimes(2);
	});

	describe("with motion", () => {
		beforeEach(() => {
			vi.stubGlobal("matchMedia", (query: string) => ({
				matches: false,
				media: query,
			}));
		});

		const opened = async (t: ReturnType<typeof player>) =>
			vi.waitFor(() => expect(t.slot().hasAttribute("data-open")).toBe(true));

		it("draws the pill closed before its room opens, so it can rise and fade in", async () => {
			const t = player();
			setReadAloudView(reading());
			flushSync();
			// The pill's first frame is its own start (faded out, 8 px down), not the open one.
			expect(t.pill()).toBeTruthy();
			expect(t.slot().hasAttribute("data-open")).toBe(false);
			await opened(t);
		});

		it("keeps the pill while its room closes, so the thread follows it down", async () => {
			const t = player();
			setReadAloudView(reading());
			await opened(t);
			vi.useFakeTimers();
			setReadAloudView(idleReadAloudView);
			await tick();
			expect(t.slot().hasAttribute("data-leaving")).toBe(true);
			vi.advanceTimersByTime(MOTION_DURATION.standard);
			await tick();
			// Its room is closing, with the faded pill still in it.
			expect(t.slot().hasAttribute("data-open")).toBe(false);
			expect(t.pill()).toBeTruthy();
			vi.advanceTimersByTime(MOTION_DURATION.emphasis);
			await tick();
			expect(t.pill()).toBeNull();
		});

		it("keeps its last controls while it leaves", async () => {
			const t = player();
			setReadAloudView(reading({ sentence: 2, elapsed: "0:15" }));
			await opened(t);
			setReadAloudView(idleReadAloudView);
			await tick();
			expect(t.slot().hasAttribute("data-leaving")).toBe(true);
			const pill = within(t.pill());
			expect(t.pill().textContent).toContain("0:15");
			expect(pill.getByRole("slider").getAttribute("aria-valuetext")).toBe(
				"Sentence 3 of 3",
			);
			expect(pill.getByRole("button", { name: "Pause" })).toBeTruthy();
		});

		it("keeps Finished over the end's controls while it leaves", async () => {
			const t = player();
			setReadAloudView(
				reading({ status: "finished", progress: 1, elapsed: "0:24" }),
			);
			await opened(t);
			setReadAloudView(idleReadAloudView);
			await tick();
			expect(t.slot().hasAttribute("data-leaving")).toBe(true);
			expect(t.pill().hasAttribute("data-finished")).toBe(true);
			expect(t.pill().textContent).toContain("0:24");
		});
	});

	it("changes the speed from its chip", async () => {
		const t = player();
		setReadAloudView(reading({ speed: 1 }));
		await tick();
		await fireEvent.click(
			within(t.pill()).getByRole("button", { name: /Speed/ }),
		);
		await fireEvent.click(
			within(t.pill()).getByRole("menuitemradio", { name: "1.5×" }),
		);
		expect(t.controller.setSpeed).toHaveBeenCalledWith(1.5);
	});
});
