import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeViewportState,
	initViewportTracking,
	isTouchDevice,
	viewportStore,
	viewportTier,
} from "./viewport.svelte";

/**
 * Helpers for simulating window.matchMedia + innerWidth in jsdom.
 */
function stubMatchMedia(matches: boolean) {
	const mm = (query: string) => ({
		matches,
		media: query,
		onchange: null,
		addListener: () => undefined,
		removeListener: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => false,
	});
	vi.stubGlobal("matchMedia", vi.fn(mm));
}

function setInnerWidth(width: number) {
	vi.stubGlobal("innerWidth", width);
}

/**
 * Simulate an SSR environment (no `window` global). jsdom defines `window`, so
 * we stash the original descriptor and replace it with `undefined`, restoring
 * it in afterEach.
 */
let originalWindowDescriptor: PropertyDescriptor | undefined;

function simulateNoWindow() {
	originalWindowDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"window",
	);
	Object.defineProperty(globalThis, "window", {
		writable: true,
		configurable: true,
		value: undefined,
	});
}

function restoreWindow() {
	if (originalWindowDescriptor) {
		Object.defineProperty(globalThis, "window", originalWindowDescriptor);
		originalWindowDescriptor = undefined;
	}
}

beforeEach(() => {
	// Default jsdom state: non-touch desktop-ish.
	stubMatchMedia(false);
	setInnerWidth(1024);
});

afterEach(() => {
	restoreWindow();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("isTouchDevice", () => {
	it("returns false when window is undefined (SSR)", () => {
		simulateNoWindow();
		expect(isTouchDevice()).toBe(false);
	});

	it("returns true when matchMedia reports a coarse pointer with no hover", () => {
		stubMatchMedia(true);
		expect(isTouchDevice()).toBe(true);
	});

	it("returns false when matchMedia reports no coarse pointer", () => {
		stubMatchMedia(false);
		expect(isTouchDevice()).toBe(false);
	});

	it("returns false when window exists but matchMedia is missing (defensive)", () => {
		// Some test/incomplete runtimes define window without matchMedia.
		// The legacy call-sites guarded this; the helper must too.
		vi.stubGlobal("matchMedia", undefined);
		expect(isTouchDevice()).toBe(false);
	});
});

describe("viewportTier", () => {
	it("returns desktop during SSR (window undefined)", () => {
		simulateNoWindow();
		expect(viewportTier()).toBe("desktop");
	});

	it("returns phone for widths below 640", () => {
		setInnerWidth(500);
		expect(viewportTier()).toBe("phone");
	});

	it("returns tablet for widths in the 640–1023 range", () => {
		setInnerWidth(800);
		expect(viewportTier()).toBe("tablet");
	});

	it("returns desktop for widths >= 1024", () => {
		setInnerWidth(1200);
		expect(viewportTier()).toBe("desktop");
	});

	it("treats the 640 boundary as tablet", () => {
		setInnerWidth(640);
		expect(viewportTier()).toBe("tablet");
	});

	it("treats 1023 as tablet (still below desktop threshold)", () => {
		setInnerWidth(1023);
		expect(viewportTier()).toBe("tablet");
	});

	it("treats 1024 as desktop", () => {
		setInnerWidth(1024);
		expect(viewportTier()).toBe("desktop");
	});
});

describe("computeViewportState (pure helper)", () => {
	it("returns a sensible default when window is undefined", () => {
		simulateNoWindow();
		const state = computeViewportState();
		expect(state).toEqual({ touch: false, tier: "desktop" });
	});

	it("computes touch=true + phone tier for a narrow coarse-pointer window", () => {
		stubMatchMedia(true);
		setInnerWidth(500);
		expect(computeViewportState()).toEqual({ touch: true, tier: "phone" });
	});

	it("computes touch=false + tablet tier for a mid-range hover window", () => {
		stubMatchMedia(false);
		setInnerWidth(800);
		expect(computeViewportState()).toEqual({ touch: false, tier: "tablet" });
	});

	it("computes touch=false + desktop tier for a wide hover window", () => {
		stubMatchMedia(false);
		setInnerWidth(1200);
		expect(computeViewportState()).toEqual({ touch: false, tier: "desktop" });
	});

	it("falls back to the default when window exists but matchMedia is missing", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(computeViewportState()).toEqual({ touch: false, tier: "desktop" });
	});
});

describe("viewportStore", () => {
	it("exposes an SSR-safe default (touch=false, tier=desktop) before init", () => {
		simulateNoWindow();
		expect(viewportStore).toEqual({ touch: false, tier: "desktop" });
		expect(viewportStore.touch).toBe(false);
		expect(viewportStore.tier).toBe("desktop");
	});

	it("reflects the live viewport once initViewportTracking runs client-side", () => {
		stubMatchMedia(true);
		setInnerWidth(500);
		initViewportTracking();
		expect(viewportStore.touch).toBe(true);
		expect(viewportStore.tier).toBe("phone");
	});

	it("updates reactively when resize fires", () => {
		stubMatchMedia(false);
		setInnerWidth(1200);
		initViewportTracking();
		expect(viewportStore.tier).toBe("desktop");

		setInnerWidth(800);
		window.dispatchEvent(new Event("resize"));
		expect(viewportStore.tier).toBe("tablet");
	});

	it("updates reactively when orientationchange fires", () => {
		stubMatchMedia(false);
		setInnerWidth(1200);
		initViewportTracking();
		stubMatchMedia(true);
		window.dispatchEvent(new Event("orientationchange"));
		expect(viewportStore.touch).toBe(true);
	});

	it("is idempotent: calling init twice does not register duplicate listeners", () => {
		stubMatchMedia(false);
		setInnerWidth(1200);
		initViewportTracking();
		initViewportTracking();

		const before = viewportStore.tier;
		setInnerWidth(500);
		window.dispatchEvent(new Event("resize"));
		expect(viewportStore.tier).toBe("phone");

		// A second resize still applies exactly once (no compounding).
		setInnerWidth(1200);
		window.dispatchEvent(new Event("resize"));
		expect(viewportStore.tier).toBe("desktop");
		expect(before).toBe("desktop");
	});
});
