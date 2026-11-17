import { describe, expect, it } from "vitest";
import { createRequestAbortSignal } from "./request-abort-signal";

describe("createRequestAbortSignal", () => {
	it("is nothing with no signal and no timeout", () => {
		expect(createRequestAbortSignal(0)).toBeUndefined();
		expect(createRequestAbortSignal(Number.NaN)).toBeUndefined();
	});

	it("is the caller's own signal when there is no timeout", () => {
		const own = new AbortController().signal;
		expect(createRequestAbortSignal(0, own)).toBe(own);
	});

	it("fires on the caller's stop or the timeout, whichever comes first", () => {
		const own = new AbortController();
		const combined = createRequestAbortSignal(60_000, own.signal);
		expect(combined).toBeDefined();
		expect(combined?.aborted).toBe(false);
		own.abort(new Error("stopped"));
		expect(combined?.aborted).toBe(true);
	});
});
