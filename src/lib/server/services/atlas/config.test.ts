import { describe, expect, it } from "vitest";
import { getAtlasProfileRuntimeConfig } from "./config";
import { ATLAS_PIPELINE_STAGES, ATLAS_PROFILES } from "./types";

describe("Atlas profile runtime config", () => {
	it("keeps the same bounded architecture for every profile while varying only caps", () => {
		const configs = Object.fromEntries(
			ATLAS_PROFILES.map((profile) => [
				profile,
				getAtlasProfileRuntimeConfig(profile),
			]),
		);

		const normalizedArchitecture = ATLAS_PROFILES.map((profile) => {
			const { gapFillCaps, ...sharedArchitecture } =
				configs[profile].architecture;
			return sharedArchitecture;
		});

		expect(normalizedArchitecture).toEqual([
			normalizedArchitecture[0],
			normalizedArchitecture[0],
			normalizedArchitecture[0],
		]);
		for (const profile of ATLAS_PROFILES) {
			expect(configs[profile].architecture.stageOrder).toEqual([
				...ATLAS_PIPELINE_STAGES,
			]);
			expect(configs[profile].architecture.stageOrder).toContain(
				"coverage-review",
			);
		}
		expect(configs.overview.architecture.gapFillCaps).toEqual({
			maxRounds: 0,
			maxSearchQueries: 1,
			maxAcceptedWebSources: 2,
		});
		expect(configs["in-depth"].architecture.gapFillCaps).toEqual({
			maxRounds: 1,
			maxSearchQueries: 2,
			maxAcceptedWebSources: 4,
		});
		expect(configs.exhaustive.architecture.gapFillCaps).toEqual({
			maxRounds: 2,
			maxSearchQueries: 3,
			maxAcceptedWebSources: 6,
		});
	});
});
