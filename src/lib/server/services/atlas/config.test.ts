import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetters = {
	getAtlasOverviewMaxOutputTokens: vi.fn(() => 12000),
	getAtlasInDepthMaxOutputTokens: vi.fn(() => 12000),
	getAtlasExhaustiveMaxOutputTokens: vi.fn(() => 16000),
};

vi.mock("$lib/server/config-store", () => mockGetters);

const { getAtlasProfileRuntimeConfig } = await import("./config");

import { ATLAS_PIPELINE_STAGES, ATLAS_PROFILES } from "./types";

beforeEach(() => {
	mockGetters.getAtlasOverviewMaxOutputTokens.mockReturnValue(12000);
	mockGetters.getAtlasInDepthMaxOutputTokens.mockReturnValue(12000);
	mockGetters.getAtlasExhaustiveMaxOutputTokens.mockReturnValue(16000);
});

afterEach(() => {
	vi.clearAllMocks();
});

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

	it("has increased maxOutputTokens for all profiles", () => {
		const configs = Object.fromEntries(
			ATLAS_PROFILES.map((profile) => [
				profile,
				getAtlasProfileRuntimeConfig(profile),
			]),
		);
		expect(configs.overview.maxOutputTokens).toBe(12000);
		expect(configs["in-depth"].maxOutputTokens).toBe(12000);
		expect(configs.exhaustive.maxOutputTokens).toBe(16000);
	});

	describe("default token caps from config-store", () => {
		it("uses getAtlasOverviewMaxOutputTokens for overview profile", () => {
			const cfg = getAtlasProfileRuntimeConfig("overview");
			expect(cfg.maxOutputTokens).toBe(12000);
			expect(mockGetters.getAtlasOverviewMaxOutputTokens).toHaveBeenCalled();
		});

		it("uses getAtlasInDepthMaxOutputTokens for in-depth profile", () => {
			const cfg = getAtlasProfileRuntimeConfig("in-depth");
			expect(cfg.maxOutputTokens).toBe(12000);
			expect(mockGetters.getAtlasInDepthMaxOutputTokens).toHaveBeenCalled();
		});

		it("uses getAtlasExhaustiveMaxOutputTokens for exhaustive profile", () => {
			const cfg = getAtlasProfileRuntimeConfig("exhaustive");
			expect(cfg.maxOutputTokens).toBe(16000);
			expect(mockGetters.getAtlasExhaustiveMaxOutputTokens).toHaveBeenCalled();
		});
	});

	describe("overrides from config-store", () => {
		it("reflects admin/env override for overview maxOutputTokens", () => {
			mockGetters.getAtlasOverviewMaxOutputTokens.mockReturnValue(10000);
			expect(getAtlasProfileRuntimeConfig("overview").maxOutputTokens).toBe(
				10000,
			);
		});

		it("reflects admin/env override for in-depth maxOutputTokens", () => {
			mockGetters.getAtlasInDepthMaxOutputTokens.mockReturnValue(16000);
			expect(getAtlasProfileRuntimeConfig("in-depth").maxOutputTokens).toBe(
				16000,
			);
		});

		it("reflects admin/env override for exhaustive maxOutputTokens", () => {
			mockGetters.getAtlasExhaustiveMaxOutputTokens.mockReturnValue(32000);
			expect(getAtlasProfileRuntimeConfig("exhaustive").maxOutputTokens).toBe(
				32000,
			);
		});
	});

	describe("invalid override fallback", () => {
		it("does not break when getter returns a very large number", () => {
			mockGetters.getAtlasOverviewMaxOutputTokens.mockReturnValue(999999);
			expect(getAtlasProfileRuntimeConfig("overview").maxOutputTokens).toBe(
				999999,
			);
		});

		it("does not break when getter returns 0 (clamped by config-store)", () => {
			mockGetters.getAtlasInDepthMaxOutputTokens.mockReturnValue(1);
			expect(getAtlasProfileRuntimeConfig("in-depth").maxOutputTokens).toBe(1);
		});

		it("returns a fresh object on each call (immutability smoke test)", () => {
			const a = getAtlasProfileRuntimeConfig("overview");
			const b = getAtlasProfileRuntimeConfig("overview");
			expect(a).not.toBe(b);
			expect(a).toEqual(b);
		});
	});
});
