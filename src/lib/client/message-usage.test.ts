import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageUsageRefresher } from "./message-usage";

const ready = {
	status: "ready",
	costUsd: 0.125,
	generationDurationMs: 2500,
	totalCostUsdMicros: 125000,
	totalTokens: 50,
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("live message accounting", () => {
	it("a new chat can refresh while a cancelled old response is still in flight", async () => {
		vi.useFakeTimers();
		let resolveOld!: (response: Response) => void;
		const fetch = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockResolvedValueOnce(json(ready));
		vi.stubGlobal("fetch", fetch);
		const apply = vi.fn();
		const refresher = createMessageUsageRefresher(apply);
		refresher.refresh("old-chat", "old-message");
		refresher.refresh("new-chat", "new-message");
		resolveOld(json({ ...ready, totalCostUsdMicros: 999999 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(apply).toHaveBeenCalledExactlyOnceWith(
			"new-chat",
			"new-message",
			ready,
		);
		refresher.clear();
	});

	it("updates after pending accounting and a transient failure, without reading full conversation detail", async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(json({ status: "pending" }, 202))
			.mockRejectedValueOnce(new TypeError("network"))
			.mockResolvedValueOnce(json(ready));
		vi.stubGlobal("fetch", fetch);
		const apply = vi.fn();
		const refresher = createMessageUsageRefresher(apply);
		refresher.refresh("conv-1", "assistant-1");
		await vi.advanceTimersByTimeAsync(0);
		expect(apply).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5000);
		expect(apply).toHaveBeenCalledExactlyOnceWith(
			"conv-1",
			"assistant-1",
			ready,
		);
		expect(
			fetch.mock.calls.every(
				([url]) =>
					url === "/api/conversations/conv-1/messages/assistant-1/usage",
			),
		).toBe(true);
		refresher.clear();
	});
	it("does not apply an old chat's response after cancellation even when fetch ignores abort", async () => {
		vi.useFakeTimers();
		let resolve!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((r) => {
						resolve = r;
					}),
			),
		);
		const apply = vi.fn();
		const refresher = createMessageUsageRefresher(apply);
		refresher.refresh("conv-1", "assistant-1");
		refresher.clear();
		resolve(json(ready));
		await vi.advanceTimersByTimeAsync(0);
		expect(apply).not.toHaveBeenCalled();
	});
	it("settles recorded zero cost and stops for incognito or deleted messages", async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(json({ ...ready, costUsd: 0 }))
			.mockResolvedValueOnce(json({ status: "untracked" }))
			.mockResolvedValueOnce(json({ error: "Message not found" }, 404));
		vi.stubGlobal("fetch", fetch);
		const apply = vi.fn();
		const refresher = createMessageUsageRefresher(apply);
		refresher.refresh("conv-1", "zero");
		refresher.refresh("conv-1", "incognito");
		refresher.refresh("conv-1", "deleted");
		await vi.advanceTimersByTimeAsync(60000);
		expect(apply).toHaveBeenCalledExactlyOnceWith("conv-1", "zero", {
			...ready,
			costUsd: 0,
		});
		expect(fetch).toHaveBeenCalledTimes(3);
		refresher.clear();
	});
	it("bounds pending polling and deduplicates requests for the same message", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => json({ status: "pending" }, 202));
		vi.stubGlobal("fetch", fetch);
		const refresher = createMessageUsageRefresher(vi.fn());
		refresher.refresh("conv-1", "assistant-1");
		refresher.refresh("conv-1", "assistant-1");
		await vi.advanceTimersByTimeAsync(120000);
		const reads = fetch.mock.calls.length;
		expect(reads).toBeGreaterThan(1);
		expect(reads).toBeLessThanOrEqual(40);
		await vi.advanceTimersByTimeAsync(120000);
		expect(fetch).toHaveBeenCalledTimes(reads);
		refresher.clear();
	});
});
