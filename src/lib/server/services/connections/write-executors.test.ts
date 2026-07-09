import { describe, expect, it } from "vitest";
import {
	__resetWriteExecutorsForTest,
	getWriteExecutor,
	listRegisteredWriteExecutorProviders,
	registerWriteExecutor,
	type WriteExecutor,
} from "./write-executors";

// Issue 6.0 — registry unit tests for the write-executor registry that
// confirmPendingWrite (pending-writes.ts) dispatches through. Mirrors the
// adapters.ts/registry.test.ts style: pure round-trip + last-wins semantics,
// no database or network involved.

function makeExecutor(provider: string): WriteExecutor {
	return {
		provider,
		async execute() {
			return { ok: true };
		},
	};
}

describe("write-executors registry", () => {
	it("round-trips: a registered executor is returned by getWriteExecutor for its provider", () => {
		__resetWriteExecutorsForTest();
		const exec = makeExecutor("test-provider-a");
		registerWriteExecutor(exec);

		expect(getWriteExecutor("test-provider-a")).toBe(exec);
	});

	it("returns undefined for a provider with no registered executor", () => {
		__resetWriteExecutorsForTest();
		expect(getWriteExecutor("no-such-provider")).toBeUndefined();
	});

	it("last registration for a given provider wins (matches registerConnectionAdapter's overwrite semantics)", () => {
		__resetWriteExecutorsForTest();
		const first = makeExecutor("test-provider-b");
		const second = makeExecutor("test-provider-b");
		registerWriteExecutor(first);
		registerWriteExecutor(second);

		expect(getWriteExecutor("test-provider-b")).toBe(second);
		expect(getWriteExecutor("test-provider-b")).not.toBe(first);
	});

	it("listRegisteredWriteExecutorProviders reflects every distinct registered provider", () => {
		__resetWriteExecutorsForTest();
		registerWriteExecutor(makeExecutor("test-provider-c"));
		registerWriteExecutor(makeExecutor("test-provider-d"));

		const providers = listRegisteredWriteExecutorProviders();
		expect(providers).toContain("test-provider-c");
		expect(providers).toContain("test-provider-d");
		expect(providers).toHaveLength(2);
	});

	it("__resetWriteExecutorsForTest clears the registry", () => {
		registerWriteExecutor(makeExecutor("test-provider-e"));
		__resetWriteExecutorsForTest();
		expect(getWriteExecutor("test-provider-e")).toBeUndefined();
		expect(listRegisteredWriteExecutorProviders()).toHaveLength(0);
	});
});
