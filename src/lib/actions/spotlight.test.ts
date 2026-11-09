import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotlightId } from "$lib/app-places";
import {
	pendingSpotlight,
	requestSpotlight,
	SPOTLIGHT_REQUEST_TTL_MS,
	spotlightRequest,
} from "$lib/stores/spotlight";
import { SPOTLIGHT_RING_MS, spotlightTarget } from "./spotlight";
import { stubLayoutForSpotlight } from "./spotlight.test-helpers";

// The action waits for an animation frame and then for a timer. Vitest 4 fakes
// every timer by default, but a list says which ones this file depends on (a
// frame counts in `vi.getTimerCount()`, and `Date` is what a request's six
// seconds are read from), so a change of the default cannot make these
// tests wait for real.
const FAKED_BY_THESE_TESTS = [
	"setTimeout",
	"clearTimeout",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"Date",
] as const;

/** The two ways a control says it has no spotlight. */
const NO_ID = [undefined, null] as const;

type Mounted = {
	node: HTMLButtonElement;
	action: ReturnType<typeof spotlightTarget>;
};

let mounted: Mounted[] = [];
let restoreLayout: () => void = () => undefined;

/**
 * A control on the page, with the action on it. By default it has the layout
 * `stubLayoutForSpotlight` gives every element; `rendered: false` is a control
 * that is not on screen (`display: none`, the other form factor's copy). A
 * control that no entry points at has no id.
 */
function mount(
	spotlight: SpotlightId | null | undefined,
	{ rendered = true } = {},
): Mounted {
	const node = document.createElement("button");
	if (!rendered) node.getClientRects = () => [] as unknown as DOMRectList;
	document.body.append(node);
	const entry = { node, action: spotlightTarget(node, spotlight) };
	mounted.push(entry);
	return entry;
}

function scrolled(node: HTMLElement) {
	return vi.mocked(node.scrollIntoView);
}

function stubReducedMotion(reduce: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: reduce,
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

describe("spotlightTarget", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: [...FAKED_BY_THESE_TESTS] });
		restoreLayout = stubLayoutForSpotlight();
		stubReducedMotion(false);
		spotlightRequest.set(null);
	});

	afterEach(() => {
		for (const { action } of mounted) action.destroy();
		mounted = [];
		document.body.innerHTML = "";
		spotlightRequest.set(null);
		restoreLayout();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("rings a rendered target for two seconds when its request arrives", () => {
		const { node } = mount("composer.atlas");

		requestSpotlight("composer.atlas");

		// The request is taken at once; the scroll and the ring wait one frame.
		expect(get(spotlightRequest)).toBeNull();
		expect(node).not.toHaveClass("spotlight-ring");
		expect(scrolled(node)).not.toHaveBeenCalled();

		vi.advanceTimersToNextFrame();
		expect(node).toHaveClass("spotlight-ring");
		expect(scrolled(node)).toHaveBeenCalledTimes(1);
		expect(scrolled(node)).toHaveBeenCalledWith({
			block: "center",
			behavior: "smooth",
		});

		expect(SPOTLIGHT_RING_MS).toBe(2000);
		vi.advanceTimersByTime(SPOTLIGHT_RING_MS - 1);
		expect(node).toHaveClass("spotlight-ring");
		vi.advanceTimersByTime(1);
		expect(node).not.toHaveClass("spotlight-ring");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rings a target that mounts after the request", () => {
		requestSpotlight("settings.data");

		// A menu row, a tab or a drawer that opens late: the action finds the
		// request waiting when it starts.
		const { node } = mount("settings.data");
		expect(get(spotlightRequest)).toBeNull();

		vi.advanceTimersToNextFrame();
		expect(node).toHaveClass("spotlight-ring");
		expect(scrolled(node)).toHaveBeenCalledTimes(1);
	});

	it("leaves a target with no layout alone", () => {
		const { node } = mount("sidebar.search", { rendered: false });

		requestSpotlight("sidebar.search");
		vi.advanceTimersToNextFrame();

		expect(node).not.toHaveClass("spotlight-ring");
		expect(scrolled(node)).not.toHaveBeenCalled();
		// Not taken: the copy that is on screen, or a row that opens a moment
		// later, can still have it.
		expect(pendingSpotlight(get(spotlightRequest))).toBe("sidebar.search");

		const later = mount("sidebar.search");
		vi.advanceTimersToNextFrame();
		expect(later.node).toHaveClass("spotlight-ring");
		expect(node).not.toHaveClass("spotlight-ring");
	});

	it("scrolls without animation under reduced motion", () => {
		stubReducedMotion(true);
		const { node } = mount("composer.thinking");

		requestSpotlight("composer.thinking");
		vi.advanceTimersToNextFrame();

		expect(scrolled(node)).toHaveBeenCalledWith({
			block: "center",
			behavior: "auto",
		});
		// The ring itself still shows; app.css makes it instant.
		expect(node).toHaveClass("spotlight-ring");
	});

	it("stops cleanly when destroyed mid-ring", () => {
		const { node, action } = mount("composer.thinking");
		requestSpotlight("composer.thinking");
		vi.advanceTimersToNextFrame();
		vi.advanceTimersByTime(500);
		expect(node).toHaveClass("spotlight-ring");
		expect(vi.getTimerCount()).toBe(1);

		action.destroy();

		expect(node).not.toHaveClass("spotlight-ring");
		expect(vi.getTimerCount()).toBe(0);

		// It has let go of the store too: a new request is left for others.
		requestSpotlight("composer.thinking");
		vi.advanceTimersToNextFrame();
		expect(node).not.toHaveClass("spotlight-ring");
		expect(pendingSpotlight(get(spotlightRequest))).toBe("composer.thinking");
	});

	it("rings nothing when destroyed before the frame", () => {
		const { node, action } = mount("composer.library");
		requestSpotlight("composer.library");
		// The request is taken and the frame is waiting.
		expect(vi.getTimerCount()).toBe(1);

		action.destroy();

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(SPOTLIGHT_RING_MS);
		expect(node).not.toHaveClass("spotlight-ring");
		expect(scrolled(node)).not.toHaveBeenCalled();
	});

	it("does nothing once destroyed, even if the store still calls it", () => {
		// A store tells its subscribers through a queue, so a call queued before
		// an unsubscribe still arrives after it. Here the first subscriber
		// destroys the action while the request is being told to everyone.
		let target: Mounted | undefined;
		const stopWatching = spotlightRequest.subscribe((request) => {
			if (request) target?.action.destroy();
		});
		target = mount("composer.library");

		requestSpotlight("composer.library");
		vi.advanceTimersToNextFrame();

		expect(target.node).not.toHaveClass("spotlight-ring");
		expect(scrolled(target.node)).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		stopWatching();
	});

	it("does not answer to another control's request", () => {
		const { node } = mount("settings.data");

		requestSpotlight("settings.activity");
		vi.advanceTimersToNextFrame();

		expect(node).not.toHaveClass("spotlight-ring");
		expect(scrolled(node)).not.toHaveBeenCalled();
		expect(pendingSpotlight(get(spotlightRequest))).toBe("settings.activity");
	});

	it("does not ring for a request that lapsed before the target mounted", () => {
		requestSpotlight("settings.skills");
		vi.advanceTimersByTime(SPOTLIGHT_REQUEST_TTL_MS);

		const { node } = mount("settings.skills");
		vi.advanceTimersToNextFrame();

		expect(node).not.toHaveClass("spotlight-ring");
		expect(scrolled(node)).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rings only one of the controls that answer to the same request", () => {
		// The same control drawn twice, say a desktop and a phone copy: the one
		// that is not on screen leaves the request, the first on screen takes
		// it, and a second on screen finds it gone.
		const hidden = mount("sidebar.search", { rendered: false });
		const shown = mount("sidebar.search");
		const also = mount("sidebar.search");

		requestSpotlight("sidebar.search");
		vi.advanceTimersToNextFrame();

		expect(hidden.node).not.toHaveClass("spotlight-ring");
		expect(shown.node).toHaveClass("spotlight-ring");
		expect(also.node).not.toHaveClass("spotlight-ring");
		// The stub is one mock for every element; its contexts say which
		// element each call was made on.
		expect(scrolled(shown.node).mock.contexts).toEqual([shown.node]);
	});

	describe("when it is asked for again", () => {
		it("restarts the ring if the control is still ringing, with one timer", () => {
			const { node } = mount("composer.atlas");
			requestSpotlight("composer.atlas");
			vi.advanceTimersToNextFrame();
			vi.advanceTimersByTime(1500);
			expect(node).toHaveClass("spotlight-ring");

			requestSpotlight("composer.atlas");
			vi.advanceTimersToNextFrame();

			// Long past where the first ring would have ended.
			vi.advanceTimersByTime(SPOTLIGHT_RING_MS - 1);
			expect(node).toHaveClass("spotlight-ring");
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(1);
			expect(node).not.toHaveClass("spotlight-ring");
			expect(vi.getTimerCount()).toBe(0);
			expect(scrolled(node)).toHaveBeenCalledTimes(2);
		});

		it("scrolls and rings once if it is asked twice before the frame", () => {
			const { node } = mount("composer.atlas");

			requestSpotlight("composer.atlas");
			requestSpotlight("composer.atlas");
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersToNextFrame();
			expect(scrolled(node)).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(SPOTLIGHT_RING_MS);
			expect(node).not.toHaveClass("spotlight-ring");
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	// A tab bar puts the action on every tab and only some tabs have a Show me
	// pointing at them, and an action cannot be put on some of them only.
	describe("when it has no control to answer to", () => {
		it.each(NO_ID)("never takes a request while its id is %s", (none) => {
			const { node } = mount(none);

			requestSpotlight("knowledge.library");
			vi.advanceTimersToNextFrame();

			expect(node).not.toHaveClass("spotlight-ring");
			expect(scrolled(node)).not.toHaveBeenCalled();
			expect(pendingSpotlight(get(spotlightRequest))).toBe("knowledge.library");
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(NO_ID)("leaves a waiting request while its id is %s", (none) => {
			requestSpotlight("knowledge.memory");

			const { node } = mount(none);
			vi.advanceTimersToNextFrame();

			expect(node).not.toHaveClass("spotlight-ring");
			expect(pendingSpotlight(get(spotlightRequest))).toBe("knowledge.memory");
		});

		it("leaves the request to the tab that has the id", () => {
			const plain = mount(undefined);
			const memory = mount("knowledge.memory");
			const library = mount("knowledge.library");

			requestSpotlight("knowledge.memory");
			vi.advanceTimersToNextFrame();

			expect(plain.node).not.toHaveClass("spotlight-ring");
			expect(library.node).not.toHaveClass("spotlight-ring");
			expect(memory.node).toHaveClass("spotlight-ring");
			expect(scrolled(memory.node).mock.contexts).toEqual([memory.node]);
		});
	});

	describe("when the control it answers to changes", () => {
		it.each(NO_ID)("stops answering when it becomes %s", (none) => {
			const { node, action } = mount("composer.library");
			action.update(none);

			requestSpotlight("composer.library");
			vi.advanceTimersToNextFrame();

			expect(node).not.toHaveClass("spotlight-ring");
			expect(scrolled(node)).not.toHaveBeenCalled();
			expect(pendingSpotlight(get(spotlightRequest))).toBe("composer.library");
		});

		it("lets a ring that is under way finish when it stops answering", () => {
			const { node, action } = mount("composer.library");
			requestSpotlight("composer.library");
			vi.advanceTimersToNextFrame();
			expect(node).toHaveClass("spotlight-ring");

			action.update(undefined);

			vi.advanceTimersByTime(SPOTLIGHT_RING_MS - 1);
			expect(node).toHaveClass("spotlight-ring");
			vi.advanceTimersByTime(1);
			expect(node).not.toHaveClass("spotlight-ring");
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each(NO_ID)("takes a waiting request once given an id (%s)", (none) => {
			const { node, action } = mount(none);
			requestSpotlight("knowledge.library");
			expect(get(spotlightRequest)).not.toBeNull();

			action.update("knowledge.library");

			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(node).toHaveClass("spotlight-ring");
		});

		it("leaves that request alone, as a new subscription would, if it has no layout", () => {
			const { node, action } = mount(undefined, { rendered: false });
			requestSpotlight("knowledge.library");

			action.update("knowledge.library");
			vi.advanceTimersToNextFrame();

			expect(node).not.toHaveClass("spotlight-ring");
			expect(pendingSpotlight(get(spotlightRequest))).toBe("knowledge.library");
		});

		it("answers to the new one and no longer to the old", () => {
			const { node, action } = mount("composer.attach");
			action.update("composer.library");

			requestSpotlight("composer.attach");
			vi.advanceTimersToNextFrame();
			expect(node).not.toHaveClass("spotlight-ring");
			expect(pendingSpotlight(get(spotlightRequest))).toBe("composer.attach");

			requestSpotlight("composer.library");
			vi.advanceTimersToNextFrame();
			expect(node).toHaveClass("spotlight-ring");
		});

		it("takes a request that is already waiting for the new one", () => {
			const { node, action } = mount("composer.attach");
			requestSpotlight("composer.library");
			expect(get(spotlightRequest)).not.toBeNull();

			action.update("composer.library");

			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(node).toHaveClass("spotlight-ring");
		});

		it("leaves a waiting request alone if it has no layout", () => {
			const { node, action } = mount("composer.attach", { rendered: false });
			requestSpotlight("composer.library");

			action.update("composer.library");
			vi.advanceTimersToNextFrame();

			expect(node).not.toHaveClass("spotlight-ring");
			expect(pendingSpotlight(get(spotlightRequest))).toBe("composer.library");
		});
	});
});

describe("stubLayoutForSpotlight", () => {
	it("gives every element a layout and a scroll, and puts both back", () => {
		const getClientRects = Element.prototype.getClientRects;
		const scrollIntoView = Element.prototype.scrollIntoView;
		const element = document.createElement("div");
		expect(element.getClientRects()).toHaveLength(0);

		const restore = stubLayoutForSpotlight();
		expect(element.getClientRects()).toHaveLength(1);
		element.scrollIntoView({ block: "center" });
		expect(vi.mocked(element.scrollIntoView)).toHaveBeenCalledWith({
			block: "center",
		});

		restore();
		expect(Element.prototype.getClientRects).toBe(getClientRects);
		expect(Element.prototype.scrollIntoView).toBe(scrollIntoView);
		expect(element.getClientRects()).toHaveLength(0);
	});
});

describe("the ring's look", () => {
	// The class the action adds is only a name until app.css gives it a look.
	// The rule may share its selector with other lit spots, so find the block
	// the class belongs to rather than the exact line.
	const appCss = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app.css"),
		"utf-8",
	);

	const block = appCss.match(/\.spotlight-ring\b[^{}]*\{([^}]*)\}/)?.[1];

	it("is the accent outline with a soft halo, eased over the standard duration", () => {
		expect(block).toBeDefined();
		expect(block).toMatch(
			/box-shadow:\s*0 0 0 2px var\(--accent\),\s*0 0 0 6px var\(--accent-tint\)\s*(?:!important)?;/,
		);
		// Straight to the semicolon: the transition is not !important.
		expect(block).toMatch(
			/transition:\s*box-shadow var\(--duration-standard\);/,
		);
	});

	it("shows over a control's own shadow, an active tab's and a focus ring", () => {
		// A component's rule is scoped to two classes (three with :focus-visible)
		// and the ring's selector is one, so only !important beats them all. The
		// real controls that lost to it: Home's incognito button and the
		// Knowledge page's active tab.
		expect(block).toMatch(/box-shadow:[^;]*\s!important;/);
	});
});
