import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, dismissToast, showToast, toasts } from "./toast";

describe("toast store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearToasts();
	});

	afterEach(() => {
		clearToasts();
		vi.useRealTimers();
	});

	it("starts empty", () => {
		expect(get(toasts)).toEqual([]);
	});

	it("push makes a visible entry available with the given type and message", () => {
		showToast({ type: "success", message: "Copied to clipboard" });

		const entries = get(toasts);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "success",
			message: "Copied to clipboard",
		});
		expect(entries[0].id).toEqual(expect.any(String));
	});

	it("supports pushing multiple entries that stack in order", () => {
		showToast({ type: "success", message: "First" });
		showToast({ type: "error", message: "Second" });

		const entries = get(toasts);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "success", message: "First" });
		expect(entries[1]).toMatchObject({ type: "error", message: "Second" });
	});

	it("auto-dismisses an entry after the default duration", () => {
		showToast({ type: "error", message: "Couldn't copy to clipboard" });
		expect(get(toasts)).toHaveLength(1);

		vi.advanceTimersByTime(3999);
		expect(get(toasts)).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(get(toasts)).toHaveLength(0);
	});

	it("auto-dismisses only the entry whose timer elapsed, leaving others", () => {
		showToast({ type: "success", message: "First", duration: 1000 });
		showToast({ type: "success", message: "Second", duration: 5000 });

		vi.advanceTimersByTime(1000);

		const entries = get(toasts);
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe("Second");
	});

	it("never auto-dismisses when duration is 0", () => {
		showToast({ type: "success", message: "Sticky", duration: 0 });

		vi.advanceTimersByTime(60_000);

		expect(get(toasts)).toHaveLength(1);
	});

	it("dismissToast removes a specific entry immediately and clears its pending timer", () => {
		const id = showToast({ type: "success", message: "First" });
		showToast({ type: "success", message: "Second" });

		dismissToast(id);

		const entries = get(toasts);
		expect(entries).toHaveLength(1);
		expect(entries[0].message).toBe("Second");

		// The dismissed entry's timer must not fire later and throw or
		// resurrect/duplicate anything.
		vi.advanceTimersByTime(10_000);
		expect(get(toasts)).toHaveLength(0);
	});

	it("clearToasts empties the queue and cancels every pending timer", () => {
		showToast({ type: "success", message: "First" });
		showToast({ type: "error", message: "Second" });

		clearToasts();

		expect(get(toasts)).toEqual([]);

		// No stray timers firing after clear (would be a no-op update to an
		// already-empty list, but assert the list stays empty either way).
		vi.advanceTimersByTime(10_000);
		expect(get(toasts)).toEqual([]);
	});
});
