import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnWatchdog } from "./turn-watchdog";

afterEach(() => vi.useRealTimers());
describe("admitted turn watchdog", () => {
	it("fences an already expired admission before any task can start", () => {
		const controller = new AbortController();
		const timer = createTurnWatchdog(controller, Date.now() - 1);
		expect(controller.signal.aborted).toBe(true);
		timer.dispose();
	});
	it("bounds an idle turn before its overall deadline", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const timer = createTurnWatchdog(controller, Date.now() + 300_000);
		await vi.advanceTimersByTimeAsync(149_999);
		expect(controller.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(controller.signal.reason.name).toBe("TimeoutError");
		timer.dispose();
	});
	it("meaningful tool activity resets idle but cannot extend overall time", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const timer = createTurnWatchdog(controller, Date.now() + 300_000);
		await vi.advanceTimersByTimeAsync(140_000);
		timer.touch();
		await vi.advanceTimersByTimeAsync(140_000);
		expect(controller.signal.aborted).toBe(false);
		timer.touch();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(controller.signal.aborted).toBe(true);
		timer.dispose();
	});
	it("does not relabel an explicit Stop and still bounds receipt settlement", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const timer = createTurnWatchdog(controller, Date.now() + 300_000);
		const stop = new DOMException("User stopped", "AbortError");
		controller.abort(stop);
		expect(await timer.wait(Promise.resolve("saved"), true)).toBe("saved");
		await expect(timer.wait(Promise.resolve("new work"))).rejects.toBe(stop);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(controller.signal.reason).toBe(stop);
		expect(timer.timeoutSignal.reason.name).toBe("TimeoutError");
		timer.dispose();
	});
});
