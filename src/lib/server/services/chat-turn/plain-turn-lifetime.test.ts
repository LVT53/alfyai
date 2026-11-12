import { afterEach, expect, it, vi } from "vitest";
import { TURN_FINALIZATION_WINDOW_MS } from "$lib/shared/normal-chat-completion";
import { runBoundedPlainTurn } from "./plain-turn-lifetime";

afterEach(() => vi.useRealTimers());
// The turn is cut off at its model deadline plus the finalization window
// (TURN_FINALIZATION_WINDOW_MS): the bound the tests below advance to. The
// engine's own deadline stays the model deadline (see the last tests).
it("bounds hanging preparation and prevents late dispatch", async () => {
	vi.useFakeTimers();
	let release!: () => void;
	let calls = 0;
	const held = new Promise<void>((r) => {
		release = r;
	});
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		await ctx.wait(held);
		calls++;
		return "done";
	});
	const rejected = expect(result).rejects.toThrow(/deadline/i);
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	await rejected;
	release();
	await Promise.resolve();
	expect(calls).toBe(0);
});
it("bounds precommit work and fences a late write", async () => {
	vi.useFakeTimers();
	let release!: () => void;
	let writes = 0;
	const held = new Promise<void>((r) => {
		release = r;
	});
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		await ctx.wait(
			(async () => {
				await held;
				ctx.persistenceSignal.throwIfAborted();
				writes++;
			})(),
		);
		return "done";
	});
	const rejected = expect(result).rejects.toThrow(/deadline/i);
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	await rejected;
	release();
	await Promise.resolve();
	expect(writes).toBe(0);
});
it("returns pending after commit starts and releases the receipt only after actual settlement", async () => {
	vi.useFakeTimers();
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	const finish = vi.fn(async (_id?: string) => {});
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		const model = await ctx.model(
			Promise.resolve({
				completionTurn: { segmentId: "s", getSnapshot: () => null, finish },
			}),
		);
		await ctx.finalize(
			(async () => {
				ctx.onPersistenceStarted();
				await held;
				await model.completionTurn?.finish("saved");
			})(),
		);
		return "done";
	});
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	expect(await result).toMatchObject({ state: "pending", segmentId: "s" });
	expect(finish).not.toHaveBeenCalled();
	release();
	await vi.advanceTimersByTimeAsync(0);
	expect(finish).toHaveBeenCalledExactlyOnceWith("saved");
});

it("bounds hanging receipt cleanup and calls it once", async () => {
	vi.useFakeTimers();
	const finish = vi.fn(() => new Promise<void>(() => {}));
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		await ctx.model(
			Promise.resolve({
				completionTurn: { segmentId: "s", getSnapshot: () => null, finish },
			}),
		);
		return "done";
	});
	const rejected = expect(result).rejects.toThrow(/deadline/i);
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	await rejected;
	expect(finish).toHaveBeenCalledTimes(1);
});

// The model engine legally uses its time up to the deadline it is given
// (`ctx.deadlineAt`). Finalization (the language call, the follow-up chips, the
// save) comes after it and has its own window (TURN_FINALIZATION_WINDOW_MS), so
// a reply whose model work ends at the deadline is still saved.
const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const receipt = (finish = vi.fn(async (_id?: string) => {})) => ({
	segmentId: "s",
	getSnapshot: () => null,
	finish,
});

it("finalizes a reply whose model work ends just before the engine deadline", async () => {
	vi.useFakeTimers();
	const finish = vi.fn(async (_id?: string) => {});
	let commits = 0;
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		const model = await ctx.model(
			delay(ctx.deadlineAt - 100 - Date.now()).then(() => ({
				completionTurn: receipt(finish),
			})),
		);
		// The language call after the reply runs past the engine deadline.
		await ctx.wait(delay(500));
		await ctx.finalize(
			(async () => {
				ctx.persistenceSignal.throwIfAborted();
				ctx.onPersistenceStarted();
				commits++;
				await model.completionTurn?.finish("saved");
			})(),
		);
		return "done";
	});
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	expect(await result).toEqual({ state: "complete", value: "done" });
	expect(commits).toBe(1);
	expect(finish).toHaveBeenCalledExactlyOnceWith("saved");
	// The watchdog's timers, the longer ones included, are cleared.
	expect(vi.getTimerCount()).toBe(0);
});

it("finalizes the partial a closing allowance leaves when the engine cuts it at the deadline", async () => {
	vi.useFakeTimers();
	const finish = vi.fn(async (_id?: string) => {});
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		// The engine's closing timer is the deadline itself; the run returns then.
		const model = await ctx.model(
			delay(ctx.deadlineAt - Date.now()).then(() => ({
				completionTurn: receipt(finish),
			})),
		);
		await ctx.finalize(
			(async () => {
				ctx.persistenceSignal.throwIfAborted();
				ctx.onPersistenceStarted();
				await model.completionTurn?.finish("saved");
			})(),
		);
		return "done";
	});
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS);
	expect(await result).toEqual({ state: "complete", value: "done" });
	expect(finish).toHaveBeenCalledExactlyOnceWith("saved");
	expect(vi.getTimerCount()).toBe(0);
});

it("still ends a hung finalization with an explicit failure when the finalization window closes, and not before", async () => {
	vi.useFakeTimers();
	const finish = vi.fn(async (_id?: string) => {});
	let writes = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result = runBoundedPlainTurn(1000, async (ctx) => {
		await ctx.model(Promise.resolve({ completionTurn: receipt(finish) }));
		// The language call after the reply never answers; a late answer must not
		// start the save.
		await ctx.wait(held);
		ctx.persistenceSignal.throwIfAborted();
		writes++;
		return "done";
	});
	let outcome: "resolved" | "rejected" | undefined;
	const settled = result.then(
		() => {
			outcome = "resolved";
		},
		() => {
			outcome = "rejected";
		},
	);
	// The engine deadline passes: finalization is still inside its window.
	await vi.advanceTimersByTimeAsync(1000 + TURN_FINALIZATION_WINDOW_MS - 1);
	expect(outcome).toBeUndefined();
	await vi.advanceTimersByTimeAsync(1);
	await settled;
	expect(outcome).toBe("rejected");
	await expect(result).rejects.toThrow(/deadline/i);
	release();
	await vi.advanceTimersByTimeAsync(0);
	expect(writes).toBe(0);
	expect(finish).toHaveBeenCalledTimes(1);
});

it("hands the engine the model deadline only, never the end of the finalization window", async () => {
	vi.useFakeTimers();
	const started = Date.now();
	let given = 0;
	await runBoundedPlainTurn(1000, async (ctx) => {
		given = ctx.deadlineAt;
		return "done";
	});
	expect(given).toBe(started + 1000);
	let explicit = 0;
	await runBoundedPlainTurn(
		1000,
		async (ctx) => {
			explicit = ctx.deadlineAt;
			return "done";
		},
		started + 700,
	);
	expect(explicit).toBe(started + 700);
});
