/**
 * The panel's history entries (FB-5, ruling 77: F7).
 *
 * The panel has layers, and the browser's Back must close them one at a time
 * before it leaves the chat: a phone reader who opened the list and an item and
 * pressed Back used to land on the landing page, because nothing the panel showed
 * was in the browser's history.
 *
 * Two layers sit on top of the chat's own entry. The PANEL is the first: the list
 * the count button opens, or an item opened straight from a chat card. An item
 * opened from the list is the second. HISTORY, the mode an open item can be in
 * (ruling 76), is one more over the item (FX-2): a Back leaves History and the
 * item it belongs to stays. Each opening adds one entry, each entry says
 * which layer it shows (in SvelteKit's `page.state`, so the browser keeps it
 * across Back, Forward and a reload), and the chat's panel is made to follow the
 * entry the browser is on. Going the other way, when the panel itself closes (the
 * X, Escape, a press outside, the count button, the header's way back to the list)
 * its entries are taken with it, so the next Back leaves the chat instead of
 * landing on a chat whose panel is already shut.
 *
 * This file knows nothing about Svelte, SvelteKit or the page: it plans, and the
 * chat page hands it what the panel is now, how to put the panel somewhere, and
 * SvelteKit's `pushState` and `replaceState` (the only way an entry is written:
 * the router keeps its own index in the browser's state and a bare `history`
 * write would tear it).
 */

/**
 * What the panel is showing. Closed is `null` wherever a layer is asked for.
 * `history` is the open item's History mode: a layer over the item, never over
 * anything else.
 */
export type PanelLayer =
	| { kind: "list" }
	| { kind: "item"; itemId: string; history?: true };

/** What a history entry says about the panel. */
export interface PanelEntry {
	layer: PanelLayer;
	/**
	 * How many entries the panel holds above the chat's own, this one included: 1
	 * for the panel (the list, or an item opened straight from a card), 2 for an
	 * item opened from the list (the list's entry is under it), and one more for
	 * the History of an item (2 over a card's item, 3 over a list's).
	 */
	depth: 1 | 2 | 3;
}

/** The key an entry is kept under in the page state, and so in the browser's history state. */
const STATE_KEY = "alfyPanel";

/** The page state SvelteKit's `pushState` and `replaceState` are given for an entry (`null`: an entry that says nothing about the panel). */
export function panelPageState(entry: PanelEntry | null): App.PageState {
	return entry ? { alfyPanel: entry } : {};
}

function parseLayer(raw: unknown): PanelLayer | null {
	if (!raw || typeof raw !== "object") return null;
	const { kind, itemId } = raw as Record<string, unknown>;
	if (kind === "list") return { kind: "list" };
	if (kind === "item" && typeof itemId === "string" && itemId !== "") {
		return (raw as Record<string, unknown>).history === true
			? { kind: "item", itemId, history: true }
			: { kind: "item", itemId };
	}
	return null;
}

function isHistory(layer: PanelLayer): layer is PanelLayer & { history: true } {
	return layer.kind === "item" && layer.history === true;
}

/** An entry as it was stored, or `null` for anything that is not one (a state this code never wrote is not trusted). */
export function parsePanelEntry(raw: unknown): PanelEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const { layer, depth } = raw as Record<string, unknown>;
	const parsed = parseLayer(layer);
	if (!parsed || (depth !== 1 && depth !== 2 && depth !== 3)) return null;
	// Only History reaches the third entry: an item is at most two deep.
	if (depth === 3 && !isHistory(parsed)) return null;
	return { layer: parsed, depth };
}

/**
 * The entry in the browser's history state (`history.state`), where SvelteKit keeps
 * the page state under a key of its own: the value that holds ours is looked for
 * rather than the key assumed. A reload keeps `history.state` but not `page.state`,
 * so this is also how a reloaded page learns which entry it is on.
 */
export function readPanelEntry(historyState: unknown): PanelEntry | null {
	if (!historyState || typeof historyState !== "object") return null;
	const direct = (historyState as Record<string, unknown>)[STATE_KEY];
	if (direct !== undefined) return parsePanelEntry(direct);
	for (const value of Object.values(historyState)) {
		if (value && typeof value === "object" && STATE_KEY in value) {
			return parsePanelEntry((value as Record<string, unknown>)[STATE_KEY]);
		}
	}
	return null;
}

export function sameLayer(a: PanelLayer | null, b: PanelLayer | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind !== b.kind) return false;
	return (
		a.kind === "list" ||
		(b.kind === "item" &&
			a.itemId === b.itemId &&
			isHistory(a) === isHistory(b))
	);
}

/** What to do to the browser's history so that it says what the panel shows. */
export type PanelStep =
	| { do: "none" }
	| { do: "push"; entry: PanelEntry }
	| { do: "replace"; entry: PanelEntry }
	| { do: "back"; steps: 1 | 2 | 3 };

const NONE: PanelStep = { do: "none" };

/**
 * What the history has to do now that the panel is showing `next` while the browser
 * stands on `here` (`null`: the chat's own entry, which says nothing of a panel).
 *
 * A layer that opens adds an entry; an item opened from the list adds a second one,
 * and its History a third. A layer that closes pops the entries it added, all of
 * them when the panel closes, and one when an item gives way to the list it was
 * opened from. A move that stays in the same layer (another item in the panel, an
 * item swapped for the list in the panel that came straight from a card) is a
 * rewrite of the entry it is on, never another entry: Back is for leaving a layer,
 * not for undoing a swap inside it.
 *
 * History is the top layer of its item and gives way first, whatever the panel
 * shows next (the item it belongs to, the list, another item): its entry is popped
 * and what is left to do is planned afresh from the entry below it, once the
 * browser has landed there.
 */
export function planPanelHistory(
	here: PanelEntry | null,
	next: PanelLayer | null,
): PanelStep {
	if (!here) {
		return next ? { do: "push", entry: { layer: next, depth: 1 } } : NONE;
	}
	if (!next) return { do: "back", steps: here.depth };
	if (sameLayer(here.layer, next)) return NONE;
	if (isHistory(here.layer)) return { do: "back", steps: 1 };
	if (isHistory(next)) {
		// Over the item the browser is on, History is one more entry; anything else
		// is an entry for a layer that has nothing under it, rewritten as it stands.
		return here.layer.kind === "item" && here.layer.itemId === next.itemId
			? {
					do: "push",
					entry: { layer: next, depth: here.depth === 1 ? 2 : 3 },
				}
			: { do: "replace", entry: { layer: next, depth: here.depth } };
	}
	if (here.depth === 2) {
		// An item over the list's own entry: the list is one entry down, and
		// another item replaces this one.
		return next.kind === "list"
			? { do: "back", steps: 1 }
			: { do: "replace", entry: { layer: next, depth: 2 } };
	}
	// One entry up. From the list an item opens over it (a second entry); anything
	// else is the same layer showing something else.
	return here.layer.kind === "list" && next.kind === "item"
		? { do: "push", entry: { layer: next, depth: 2 } }
		: { do: "replace", entry: { layer: next, depth: 1 } };
}

/** The browser, as far as the panel's history needs it. Real by default; a test brings its own. */
export interface PanelHistoryBrowser {
	/** The entry the browser is on now. */
	readEntry(): PanelEntry | null;
	/** Moves through the history (`go(-2)` is two Backs, and one `popstate`). */
	go(delta: number): void;
	/** Calls back when the browser has moved through its history. Returns the way to stop. */
	listen(onMoved: () => void): () => void;
	/** Whether the browser is on this chat's page (a Back that leaves it is the router's, not the panel's). */
	onThisPage(): boolean;
}

export interface PanelHistoryOptions {
	/** What the panel shows now (`null`: it is closed). */
	current(): PanelLayer | null;
	/** Puts the panel in a layer because the history moved. It may end up somewhere else (an item that has gone): the history then follows the panel. */
	apply(layer: PanelLayer | null): void;
	/** Writes an entry through SvelteKit's `pushState`. */
	push(entry: PanelEntry): void;
	/** Rewrites the entry the browser is on through SvelteKit's `replaceState` (`null`: leaves it saying nothing of a panel). */
	replace(entry: PanelEntry | null): void;
	/** The browser; the window's own when left out. */
	browser?: PanelHistoryBrowser;
}

export interface PanelHistory {
	/** Starts following the browser; returns the way to stop. Nothing is written before the router has started. */
	start(): () => void;
	/** The panel's layer changed: make the history say so. Safe to call as often as is convenient. */
	sync(): void;
	/** The page has just arrived on an entry (a load, a reload, a Back or Forward into the chat, a switch to another chat): what the entry says wins over what was remembered. */
	arrive(): void;
}

/** A Back the browser never answers (nothing to go back to) must not hold the panel's history forever. */
const TRAVERSAL_GIVE_UP_MS = 1000;

function windowBrowser(isThisPage: () => boolean): PanelHistoryBrowser {
	return {
		readEntry: () => readPanelEntry(window.history.state),
		go: (delta) => window.history.go(delta),
		listen(onMoved) {
			window.addEventListener("popstate", onMoved);
			return () => window.removeEventListener("popstate", onMoved);
		},
		onThisPage: isThisPage,
	};
}

/**
 * Keeps the browser's history and the panel saying the same thing.
 *
 * The page calls `sync()` whenever the panel's layer changes and `arrive()` when it
 * lands on an entry; the browser's own moves (Back, Forward, a swipe) come in through
 * `popstate` and put the panel where the entry says. A move the panel asked for
 * itself (closing pops its entries with `history.go`) arrives as a `popstate` too, to
 * a place the panel is already in, and changes nothing.
 */
export function createPanelHistory(
	options: PanelHistoryOptions & { isThisPage?: () => boolean },
): PanelHistory {
	let browser: PanelHistoryBrowser | null = options.browser ?? null;
	let ready = false;
	let traversing = false;
	let giveUp: ReturnType<typeof setTimeout> | null = null;

	const where = (): PanelHistoryBrowser => {
		browser ??= windowBrowser(options.isThisPage ?? (() => true));
		return browser;
	};

	function settle(): void {
		traversing = false;
		if (giveUp !== null) clearTimeout(giveUp);
		giveUp = null;
	}

	function sync(): void {
		// A Back of the panel's own is under way: what the panel shows is planned
		// from where the browser lands (`moved`), not from where it still stands.
		if (!ready || traversing) return;
		const step = planPanelHistory(where().readEntry(), options.current());
		switch (step.do) {
			case "none":
				return;
			case "push":
				options.push(step.entry);
				return;
			case "replace":
				options.replace(step.entry);
				return;
			case "back":
				traversing = true;
				giveUp = setTimeout(() => {
					// The browser did not move: it has nothing below this entry. The entry
					// stops claiming a panel, and the history is planned afresh from there.
					settle();
					options.replace(null);
					sync();
				}, TRAVERSAL_GIVE_UP_MS);
				where().go(-step.steps);
				return;
		}
	}

	function moved(): void {
		const b = where();
		const ownBack = traversing;
		settle();
		// A Back that left the chat for another page is the router's; the panel
		// follows only what happens on this page.
		if (!b.onThisPage()) return;
		if (ownBack) {
			// The panel asked for this move itself and is already where it wants to
			// be (it may even have changed again since): the history is planned anew
			// from where the browser landed.
			sync();
			return;
		}
		const layer = b.readEntry()?.layer ?? null;
		if (!sameLayer(layer, options.current())) options.apply(layer);
	}

	function arrive(): void {
		const here = where().readEntry();
		if (here && !sameLayer(here.layer, options.current())) {
			options.apply(here.layer);
		}
		sync();
	}

	return {
		start() {
			const stop = where().listen(moved);
			// Nothing is written before the router is up: SvelteKit refuses a
			// `pushState` until it has started, which is after the page hydrates.
			// The page that has just loaded is an arrival like any other.
			const readyTimer = setTimeout(() => {
				ready = true;
				arrive();
			}, 0);
			return () => {
				clearTimeout(readyTimer);
				stop();
				settle();
				ready = false;
			};
		},
		sync,
		arrive() {
			// Before `start()` has made the page ready, the first arrival is its own.
			if (ready) arrive();
		},
	};
}
