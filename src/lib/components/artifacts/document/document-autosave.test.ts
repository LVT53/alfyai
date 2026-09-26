import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentAutosave } from "./document-autosave";

describe("createDocumentAutosave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits the full debounce before saving, and only saves once for a burst of schedules", async () => {
		const save = vi.fn().mockResolvedValue({ ok: true, version: 1 });
		const autosave = createDocumentAutosave({ save, delayMs: 800 });

		autosave.schedule("a");
		vi.advanceTimersByTime(400);
		autosave.schedule("ab");
		vi.advanceTimersByTime(400);
		autosave.schedule("abc");
		expect(save).not.toHaveBeenCalled();

		vi.advanceTimersByTime(800);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		expect(save).toHaveBeenCalledWith("abc");
	});

	it("uses the default 800ms delay when none is given", async () => {
		const save = vi.fn().mockResolvedValue({ ok: true, version: 1 });
		const autosave = createDocumentAutosave({ save });

		autosave.schedule("x");
		vi.advanceTimersByTime(799);
		expect(save).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
	});

	it("a thrown save (offline) reports ok:false reason:offline and keeps the loop running for the next schedule", async () => {
		const save = vi.fn().mockRejectedValueOnce(new Error("network down"));
		save.mockResolvedValueOnce({ ok: true, version: 2 });
		const onResult = vi.fn();
		const autosave = createDocumentAutosave({ save, onResult, delayMs: 100 });

		autosave.schedule("first");
		vi.advanceTimersByTime(100);
		await vi.waitFor(() =>
			expect(onResult).toHaveBeenCalledWith(
				{ ok: false, reason: "offline" },
				"first",
			),
		);
		expect(autosave.stopped).toBe(false);

		autosave.schedule("second");
		vi.advanceTimersByTime(100);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
		expect(onResult).toHaveBeenLastCalledWith(
			{ ok: true, version: 2 },
			"second",
		);
	});

	it("stop() silences further schedules until resume()", async () => {
		const save = vi.fn().mockResolvedValue({ ok: false, reason: "too_large" });
		const autosave = createDocumentAutosave({ save, delayMs: 50 });

		autosave.schedule("huge");
		vi.advanceTimersByTime(50);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

		autosave.stop();
		autosave.schedule("still huge");
		vi.advanceTimersByTime(1000);
		expect(save).toHaveBeenCalledTimes(1);

		autosave.resume();
		autosave.schedule("trimmed");
		vi.advanceTimersByTime(50);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
	});

	it("flush() saves immediately and cancels the pending timer", async () => {
		const save = vi.fn().mockResolvedValue({ ok: true, version: 3 });
		const autosave = createDocumentAutosave({ save, delayMs: 5000 });

		autosave.schedule("now please");
		const result = await autosave.flush();
		expect(save).toHaveBeenCalledWith("now please");
		expect(result).toEqual({ ok: true, version: 3 });

		// The cancelled timer must not fire a second save later.
		vi.advanceTimersByTime(5000);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("flush() with nothing pending resolves without calling save", async () => {
		const save = vi.fn().mockResolvedValue({ ok: true, version: 1 });
		const autosave = createDocumentAutosave({ save, delayMs: 100 });

		const result = await autosave.flush();
		expect(save).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});
});
