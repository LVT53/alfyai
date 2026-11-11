import { afterEach, expect, it, vi } from "vitest";
import { runBoundedPlainTurn } from "./plain-turn-lifetime";

afterEach(() => vi.useRealTimers());
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
	await vi.advanceTimersByTimeAsync(1000);
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
	await vi.advanceTimersByTimeAsync(1000);
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
	await vi.advanceTimersByTimeAsync(1000);
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
	await vi.advanceTimersByTimeAsync(1000);
	await rejected;
	expect(finish).toHaveBeenCalledTimes(1);
});
