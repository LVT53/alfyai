import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetProactiveConnectorContextCacheForTests,
	readProactiveConnectorContextCache,
	writeProactiveConnectorContextCache,
} from "./proactive-connector-cache";

const key = {
	userId: "user-1",
	connectionId: "conn-1",
	capability: "calendar",
};

describe("proactive connector context cache", () => {
	beforeEach(() => {
		__resetProactiveConnectorContextCacheForTests();
	});

	it("returns null on a miss", () => {
		expect(readProactiveConnectorContextCache(key, 0)).toBeNull();
	});

	it("returns the cached value within the TTL", () => {
		writeProactiveConnectorContextCache(key, ["- line one"], 0, 60_000);

		expect(readProactiveConnectorContextCache(key, 30_000)).toEqual([
			"- line one",
		]);
	});

	it("caches an empty result (fetched successfully, nothing to show) distinctly from a miss", () => {
		writeProactiveConnectorContextCache(key, [], 0, 60_000);

		expect(readProactiveConnectorContextCache(key, 1_000)).toEqual([]);
	});

	it("expires an entry once the TTL has elapsed", () => {
		writeProactiveConnectorContextCache(key, ["- line one"], 0, 60_000);

		expect(readProactiveConnectorContextCache(key, 60_001)).toBeNull();
	});

	it("keys by userId:connectionId:capability, not by message content", () => {
		writeProactiveConnectorContextCache(key, ["- line one"], 0, 60_000);

		expect(
			readProactiveConnectorContextCache(
				{ ...key, capability: "email" },
				1_000,
			),
		).toBeNull();
		expect(
			readProactiveConnectorContextCache(
				{ ...key, connectionId: "conn-2" },
				1_000,
			),
		).toBeNull();
		expect(
			readProactiveConnectorContextCache({ ...key, userId: "user-2" }, 1_000),
		).toBeNull();
	});

	it("does not write when ttlMs is zero or negative", () => {
		writeProactiveConnectorContextCache(key, ["- line one"], 0, 0);

		expect(readProactiveConnectorContextCache(key, 0)).toBeNull();
	});

	it("evicts the oldest entry once the cache is at capacity", () => {
		const capacity = 256;
		for (let i = 0; i < capacity; i += 1) {
			writeProactiveConnectorContextCache(
				{ userId: `user-${i}`, connectionId: "conn", capability: "calendar" },
				[`- entry ${i}`],
				0,
				60_000,
			);
		}
		// The very first entry written should still be present...
		expect(
			readProactiveConnectorContextCache(
				{ userId: "user-0", connectionId: "conn", capability: "calendar" },
				1_000,
			),
		).toEqual(["- entry 0"]);

		// ...until one more entry pushes the cache over capacity, evicting it.
		writeProactiveConnectorContextCache(
			{ userId: "user-overflow", connectionId: "conn", capability: "calendar" },
			["- overflow"],
			0,
			60_000,
		);
		expect(
			readProactiveConnectorContextCache(
				{ userId: "user-0", connectionId: "conn", capability: "calendar" },
				1_000,
			),
		).toBeNull();
		expect(
			readProactiveConnectorContextCache(
				{
					userId: "user-overflow",
					connectionId: "conn",
					capability: "calendar",
				},
				1_000,
			),
		).toEqual(["- overflow"]);
	});
});
