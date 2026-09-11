import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isPhoneViewport,
	PHONE_MEDIA_QUERY,
	resolveDialogPresentation,
	watchPhoneViewport,
} from "./viewport";

describe("resolveDialogPresentation", () => {
	it("keeps every requested mode centred above the breakpoint", () => {
		expect(resolveDialogPresentation("centered", false)).toBe("centered");
		expect(resolveDialogPresentation("sheet", false)).toBe("centered");
		expect(resolveDialogPresentation("fullSheet", false)).toBe("centered");
	});

	it("honours the requested mode on a phone", () => {
		expect(resolveDialogPresentation("sheet", true)).toBe("sheet");
		expect(resolveDialogPresentation("fullSheet", true)).toBe("fullSheet");
	});

	it("leaves an opted-out dialog centred on a phone too", () => {
		// The default has to be inert: a dialog owned by another surface must
		// not change shape because this capability was added.
		expect(resolveDialogPresentation("centered", true)).toBe("centered");
	});
});

describe("isPhoneViewport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is false where matchMedia does not exist", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(isPhoneViewport()).toBe(false);
	});

	it("asks matchMedia for the one breakpoint", () => {
		const matchMedia = vi.fn(() => ({ matches: true }));
		vi.stubGlobal("matchMedia", matchMedia);
		expect(isPhoneViewport()).toBe(true);
		expect(matchMedia).toHaveBeenCalledWith(PHONE_MEDIA_QUERY);
	});
});

describe("watchPhoneViewport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns a no-op teardown where matchMedia does not exist", () => {
		vi.stubGlobal("matchMedia", undefined);
		const stop = watchPhoneViewport(() => undefined);
		expect(() => stop()).not.toThrow();
	});

	it("reports crossings and detaches on teardown", () => {
		let listener: ((event: MediaQueryListEvent) => void) | null = null;
		const removeEventListener = vi.fn();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: false,
				addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
					listener = fn;
				},
				removeEventListener,
			})),
		);

		const seen: boolean[] = [];
		const stop = watchPhoneViewport((isPhone) => seen.push(isPhone));
		listener?.({ matches: true } as MediaQueryListEvent);
		listener?.({ matches: false } as MediaQueryListEvent);
		expect(seen).toEqual([true, false]);

		stop();
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});

	it("falls back to the legacy addListener API", () => {
		const addListener = vi.fn();
		const removeListener = vi.fn();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: false, addListener, removeListener })),
		);
		const stop = watchPhoneViewport(() => undefined);
		expect(addListener).toHaveBeenCalledTimes(1);
		stop();
		expect(removeListener).toHaveBeenCalledTimes(1);
	});
});
