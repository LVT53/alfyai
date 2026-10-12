import { afterEach, describe, expect, it, vi } from "vitest";
import { removeChangePillSmoothly } from "./change-pill-removal";

// F18 (ruling 77): the pill that goes after Keep takes its own line with it, and
// what is below comes up over a moment. jsdom has no layout, so the rectangles
// and the Web Animations API are stood in for: what is under test is which
// blocks are moved, by how much, and that a second pill takes the first one's
// easing over instead of snapping.

function stubLayout(
	block: HTMLElement,
	topBefore: number,
	topAfter: number,
	state: { removed: boolean },
): void {
	block.getBoundingClientRect = () =>
		({ top: state.removed ? topAfter : topBefore }) as DOMRect;
}

function build() {
	document.body.innerHTML = `<div class="ProseMirror">
		<p id="own">The changed text<span class="change-pill-mount" data-change-id="c1"></span></p>
		<p id="next">What follows</p>
		<p id="last">And after that</p>
	</div>`;
	const state = { removed: false };
	const own = document.getElementById("own") as HTMLElement;
	const next = document.getElementById("next") as HTMLElement;
	const last = document.getElementById("last") as HTMLElement;
	stubLayout(own, 0, 0, state);
	stubLayout(next, 100, 72, state);
	stubLayout(last, 160, 132, state);
	return { state, own, next, last };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("removeChangePillSmoothly", () => {
	it("eases what is below the pill's line from where it stood to where it is", async () => {
		const { state, next, last, own } = build();
		const animate = vi.fn();
		for (const el of [own, next, last]) {
			el.animate = animate;
			el.getAnimations = () => [];
		}
		const remove = vi.fn(() => {
			state.removed = true;
		});

		await removeChangePillSmoothly(document, "c1", remove);

		expect(remove).toHaveBeenCalledTimes(1);
		// The two blocks after the pill's paragraph move; its own paragraph does not.
		expect(animate).toHaveBeenCalledTimes(2);
		const first = animate.mock.calls[0];
		expect(first[0]).toEqual([
			{ transform: "translateY(28px)" },
			{ transform: "none" },
		]);
		expect(first[1]).toMatchObject({ id: "change-pill-flip" });
	});

	it("takes over an easing that is still running, carrying what was left of it", async () => {
		const { state, next, last, own } = build();
		const cancel = vi.fn();
		const running = [
			{ id: "change-pill-flip", cancel },
			{ id: "other", cancel: vi.fn() },
		];
		next.animate = vi.fn();
		last.animate = vi.fn();
		own.animate = vi.fn();
		next.getAnimations = () => running as unknown as Animation[];
		last.getAnimations = () => [];
		own.getAnimations = () => [];

		await removeChangePillSmoothly(document, "c1", () => {
			state.removed = true;
		});

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(running[1].cancel).not.toHaveBeenCalled();
	});

	it("just removes the pill when it cannot be found or the reader asked for less motion", async () => {
		const { state, next } = build();
		next.animate = vi.fn();
		const remove = vi.fn(() => {
			state.removed = true;
		});
		await removeChangePillSmoothly(document, "nope", remove);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(next.animate).not.toHaveBeenCalled();

		const { state: state2, next: next2 } = build();
		next2.animate = vi.fn();
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		const remove2 = vi.fn(() => {
			state2.removed = true;
		});
		await removeChangePillSmoothly(document, "c1", remove2);
		expect(remove2).toHaveBeenCalledTimes(1);
		expect(next2.animate).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
