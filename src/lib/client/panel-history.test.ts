import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPanelHistory,
	type PanelEntry,
	type PanelHistoryBrowser,
	type PanelLayer,
	panelPageState,
	parsePanelEntry,
	planPanelHistory,
	readPanelEntry,
	sameLayer,
} from "./panel-history";

const LIST: PanelLayer = { kind: "list" };
const item = (itemId: string): PanelLayer => ({ kind: "item", itemId });
const entry = (layer: PanelLayer, depth: 1 | 2): PanelEntry => ({
	layer,
	depth,
});

describe("planPanelHistory", () => {
	it("pushes an entry when the panel opens on the chat's own entry", () => {
		expect(planPanelHistory(null, LIST)).toEqual({
			do: "push",
			entry: entry(LIST, 1),
		});
		expect(planPanelHistory(null, item("a"))).toEqual({
			do: "push",
			entry: entry(item("a"), 1),
		});
	});

	it("does nothing while the panel and the entry say the same", () => {
		expect(planPanelHistory(null, null)).toEqual({ do: "none" });
		expect(planPanelHistory(entry(LIST, 1), LIST)).toEqual({ do: "none" });
		expect(planPanelHistory(entry(item("a"), 2), item("a"))).toEqual({
			do: "none",
		});
	});

	it("opens an item from the list as a second entry", () => {
		expect(planPanelHistory(entry(LIST, 1), item("a"))).toEqual({
			do: "push",
			entry: entry(item("a"), 2),
		});
	});

	it("pops every entry the panel added when it closes", () => {
		expect(planPanelHistory(entry(LIST, 1), null)).toEqual({
			do: "back",
			steps: 1,
		});
		expect(planPanelHistory(entry(item("a"), 1), null)).toEqual({
			do: "back",
			steps: 1,
		});
		expect(planPanelHistory(entry(item("a"), 2), null)).toEqual({
			do: "back",
			steps: 2,
		});
	});

	it("steps from an item opened over the list back to the list, by popping", () => {
		expect(planPanelHistory(entry(item("a"), 2), LIST)).toEqual({
			do: "back",
			steps: 1,
		});
	});

	it("rewrites the entry for a swap inside one layer, never adds one", () => {
		// Another item in the panel.
		expect(planPanelHistory(entry(item("a"), 1), item("b"))).toEqual({
			do: "replace",
			entry: entry(item("b"), 1),
		});
		expect(planPanelHistory(entry(item("a"), 2), item("b"))).toEqual({
			do: "replace",
			entry: entry(item("b"), 2),
		});
		// An item opened straight from a card, swapped for the list (no list entry below it).
		expect(planPanelHistory(entry(item("a"), 1), LIST)).toEqual({
			do: "replace",
			entry: entry(LIST, 1),
		});
	});
});

describe("what an entry is made of", () => {
	it("keeps only an entry this code wrote", () => {
		expect(parsePanelEntry(entry(item("a"), 2))).toEqual(entry(item("a"), 2));
		expect(parsePanelEntry(entry(LIST, 1))).toEqual(entry(LIST, 1));
		expect(parsePanelEntry(null)).toBeNull();
		expect(parsePanelEntry({ layer: { kind: "item" }, depth: 1 })).toBeNull();
		expect(
			parsePanelEntry({ layer: { kind: "item", itemId: "" }, depth: 1 }),
		).toBeNull();
		expect(parsePanelEntry({ layer: LIST, depth: 3 })).toBeNull();
		expect(parsePanelEntry({ layer: { kind: "drawer" }, depth: 1 })).toBeNull();
	});

	it("is found in the browser's history state wherever the router keeps the page state", () => {
		const stored = entry(item("a"), 1);
		const state = {
			"sveltekit:history": 1,
			"sveltekit:states": panelPageState(stored),
		};
		expect(readPanelEntry(state)).toEqual(stored);
		expect(readPanelEntry(panelPageState(stored))).toEqual(stored);
		expect(readPanelEntry({ "sveltekit:history": 1 })).toBeNull();
		expect(readPanelEntry(null)).toBeNull();
		expect(readPanelEntry(panelPageState(null))).toBeNull();
	});

	it("compares layers by what they show", () => {
		expect(sameLayer(null, null)).toBe(true);
		expect(sameLayer(LIST, null)).toBe(false);
		expect(sameLayer(LIST, LIST)).toBe(true);
		expect(sameLayer(item("a"), item("a"))).toBe(true);
		expect(sameLayer(item("a"), item("b"))).toBe(false);
		expect(sameLayer(item("a"), LIST)).toBe(false);
	});
});

/**
 * A browser history: a stack of entries and the one it stands on, with the router's
 * `pushState` and `replaceState` and the browser's own Back, Forward and `go`, each
 * answered with a `popstate` a moment later, as the real thing does.
 */
function fakeBrowser() {
	const stack: Array<PanelEntry | null> = [null];
	let index = 0;
	let onMoved: (() => void) | null = null;
	let onThisPage = true;
	const move = (delta: number, then?: () => void) => {
		const target = index + delta;
		if (target < 0 || target >= stack.length) return;
		queueMicrotask(() => {
			index = target;
			then?.();
			onMoved?.();
		});
	};
	const browser: PanelHistoryBrowser = {
		readEntry: () => stack[index],
		go: (delta) => move(delta),
		listen(listener) {
			onMoved = listener;
			return () => {
				onMoved = null;
			};
		},
		onThisPage: () => onThisPage,
	};
	return {
		browser,
		stack,
		get index() {
			return index;
		},
		push(next: PanelEntry) {
			stack.splice(index + 1);
			stack.push(next);
			index += 1;
		},
		replace(next: PanelEntry | null) {
			stack[index] = next;
		},
		/** The reader's Back or Forward. */
		go(delta: number) {
			move(delta);
		},
		leaveForAnotherPage(delta: number) {
			move(delta, () => {
				onThisPage = false;
			});
		},
	};
}

async function flush() {
	await vi.advanceTimersByTimeAsync(5);
}

describe("createPanelHistory", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * A page whose panel is `initial`, with the controller wired to a fake browser.
	 * `reach` is what the page can really show of a layer it is asked for (an item
	 * that has gone is not there to show).
	 */
	async function page(
		initial: PanelLayer | null = null,
		reach: (asked: PanelLayer | null) => PanelLayer | null = (asked) => asked,
	) {
		const fake = fakeBrowser();
		let layer: PanelLayer | null = initial;
		const applied: Array<PanelLayer | null> = [];
		const history = createPanelHistory({
			current: () => layer,
			apply: (next) => {
				applied.push(next);
				layer = reach(next);
				// The page's own effect: the panel changed, so the history is looked at.
				queueMicrotask(() => history.sync());
			},
			push: (next) => fake.push(next),
			replace: (next) => fake.replace(next),
			browser: fake.browser,
		});
		const stop = history.start();
		await flush();
		return {
			fake,
			applied,
			history,
			stop,
			/** The panel changes by the reader's own click. */
			show(next: PanelLayer | null) {
				layer = next;
				history.sync();
			},
			get layer() {
				return layer;
			},
		};
	}

	it("writes nothing before the router has started, then reconciles what the page already shows", async () => {
		const fake = fakeBrowser();
		const push = vi.fn((next: PanelEntry) => fake.push(next));
		const history = createPanelHistory({
			current: () => item("a"),
			apply: () => {},
			push,
			replace: (next) => fake.replace(next),
			browser: fake.browser,
		});
		const stop = history.start();
		history.sync();
		expect(push).not.toHaveBeenCalled();
		await flush();
		expect(push).toHaveBeenCalledWith(entry(item("a"), 1));
		stop();
	});

	it("adds an entry for each layer that opens and Back closes one layer at a time", async () => {
		const p = await page();
		p.show(LIST);
		p.show(item("a"));
		expect(p.fake.stack).toEqual([null, entry(LIST, 1), entry(item("a"), 2)]);

		p.fake.go(-1);
		await flush();
		expect(p.applied).toEqual([LIST]);
		p.fake.go(-1);
		await flush();
		expect(p.applied).toEqual([LIST, null]);
		expect(p.fake.index).toBe(0);
	});

	it("lands where it started after a Back and a Forward", async () => {
		const p = await page();
		p.show(LIST);
		p.show(item("a"));
		p.fake.go(-2);
		await flush();
		expect(p.layer).toBeNull();
		p.fake.go(1);
		await flush();
		expect(p.layer).toEqual(LIST);
		p.fake.go(1);
		await flush();
		expect(p.layer).toEqual(item("a"));
		expect(p.fake.stack).toHaveLength(3);
	});

	it("takes the panel's entries with it when the panel closes itself, in one move", async () => {
		const p = await page();
		p.show(LIST);
		p.show(item("a"));
		p.show(null);
		await flush();
		expect(p.fake.index).toBe(0);
		// The browser's answer to its own Back changes nothing in the panel.
		expect(p.applied).toEqual([]);
		expect(p.layer).toBeNull();
	});

	it("steps from an item opened over the list to the list by popping, and rewrites a swap", async () => {
		const p = await page();
		p.show(LIST);
		p.show(item("a"));
		p.show(item("b"));
		expect(p.fake.stack).toEqual([null, entry(LIST, 1), entry(item("b"), 2)]);
		p.show(LIST);
		await flush();
		expect(p.fake.index).toBe(1);
		expect(p.fake.stack[1]).toEqual(entry(LIST, 1));
	});

	it("is one entry for an item opened straight from a card", async () => {
		const p = await page();
		p.show(item("a"));
		expect(p.fake.stack).toEqual([null, entry(item("a"), 1)]);
		p.fake.go(-1);
		await flush();
		expect(p.layer).toBeNull();
		expect(p.fake.index).toBe(0);
	});

	it("holds a change that comes while its own Back is under way, and plans it afterwards", async () => {
		const p = await page();
		p.show(LIST);
		p.show(item("a"));
		p.show(null); // go(-2) is on its way
		p.show(item("b")); // before the browser has answered
		await flush();
		expect(p.layer).toEqual(item("b"));
		expect(p.fake.index).toBe(1);
		expect(p.fake.stack).toEqual([null, entry(item("b"), 1)]);
	});

	it("puts the panel where an entry says when the page arrives on it, and builds on it", async () => {
		const p = await page();
		p.fake.stack[0] = entry(item("a"), 1);
		p.history.arrive();
		expect(p.applied).toEqual([item("a")]);
		expect(p.fake.stack).toHaveLength(1);
	});

	it("asks the entry for nothing when it says nothing: the panel the page remembers is pushed", async () => {
		const p = await page(item("a"));
		expect(p.fake.stack).toEqual([null, entry(item("a"), 1)]);
		expect(p.applied).toEqual([]);
	});

	it("follows the history down when the page cannot show what the entry says", async () => {
		// The item has gone since its entry was made: the page can show the list, not it.
		const p = await page(null, (asked) =>
			asked?.kind === "item" ? LIST : asked,
		);
		p.show(LIST);
		p.show(item("a"));
		p.fake.go(-1);
		await flush();
		expect(p.layer).toEqual(LIST);
		p.fake.go(1);
		await flush();
		// The entry said the item; the page fell back to the list, so the history
		// steps back to the list's own entry rather than keep an entry that lies.
		expect(p.applied).toEqual([LIST, item("a")]);
		expect(p.layer).toEqual(LIST);
		expect(p.fake.index).toBe(1);
		expect(p.fake.stack[1]).toEqual(entry(LIST, 1));
	});

	it("leaves a Back that goes to another page to the router", async () => {
		const p = await page();
		p.show(LIST);
		p.fake.leaveForAnotherPage(-1);
		await flush();
		p.fake.leaveForAnotherPage(-1);
		await flush();
		expect(p.applied).toEqual([]);
	});

	it("gives up on a Back the browser never answers, and plans from the entry it is on", async () => {
		const fake = fakeBrowser();
		let layer: PanelLayer | null = LIST;
		const replace = vi.fn((next: PanelEntry | null) => fake.replace(next));
		fake.stack[0] = entry(LIST, 1); // an entry with no entry below it: `go(-1)` goes nowhere
		const history = createPanelHistory({
			current: () => layer,
			apply: (next) => {
				layer = next;
			},
			push: (next) => fake.push(next),
			replace,
			browser: fake.browser,
		});
		history.start();
		await vi.advanceTimersByTimeAsync(5);
		layer = null;
		history.sync();
		await vi.advanceTimersByTimeAsync(1100);
		expect(replace).toHaveBeenCalledWith(null);
		expect(fake.stack[0]).toBeNull();
	});

	it("stops listening when stopped", async () => {
		const p = await page();
		p.show(LIST);
		p.stop();
		p.fake.go(-1);
		await flush();
		expect(p.applied).toEqual([]);
	});
});
