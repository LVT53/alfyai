import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import { getAtlasAvailability } from "./availability";

function makeConfig(overrides: Record<string, unknown>): RuntimeConfig {
	return {
		atlasWorkerEnabled: true,
		...overrides,
	} as unknown as RuntimeConfig;
}

describe("getAtlasAvailability", () => {
	it("reports missing_parallel when the Parallel Search key is absent", () => {
		expect(getAtlasAvailability(makeConfig({ parallelApiKey: "" }))).toEqual({
			enabled: true,
			configured: false,
			reasonCode: "missing_parallel",
			reason: "Atlas requires Parallel Search API configuration.",
		});
	});

	it("is enabled and configured when the Parallel Search key is present", () => {
		expect(
			getAtlasAvailability(makeConfig({ parallelApiKey: "pk-123" })),
		).toEqual({
			enabled: true,
			configured: true,
			reasonCode: null,
			reason: null,
		});
	});

	it("reports disabled when the worker is off, tracking configured by the Parallel key", () => {
		expect(
			getAtlasAvailability(
				makeConfig({ atlasWorkerEnabled: false, parallelApiKey: "pk-123" }),
			),
		).toMatchObject({
			enabled: false,
			configured: true,
			reasonCode: "disabled",
		});
	});
});
