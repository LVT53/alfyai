import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/inference-providers", () => ({
	getProviderById: vi.fn(async () => null),
	listProviders: vi.fn(async () => []),
}));

import { resolveUserModelPreference } from "./model-preferences";
import type { RuntimeConfig } from "$lib/server/config-store";

const config = {
	defaultNewUserModel: "model2",
	model1: { displayName: "Model 1" },
	model2: { displayName: "Model 2" },
	model2Enabled: true,
} as RuntimeConfig;

describe("model preference inheritance", () => {
	it("resolves system-mode users to the live default without requiring nullable storage", async () => {
		await expect(resolveUserModelPreference("model1", "system", config)).resolves.toEqual({
			preference: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});

	it("normalizes legacy rows whose stored model equals the current default to inherited", async () => {
		await expect(resolveUserModelPreference("model2", null, config)).resolves.toEqual({
			preference: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});

	it("preserves explicit non-default model choices", async () => {
		await expect(resolveUserModelPreference("model1", "explicit", config)).resolves.toEqual({
			preference: "model1",
			effectiveModel: "model1",
			systemDefaultModel: "model2",
		});
	});

	it("preserves explicit choices even when they currently match the admin default", async () => {
		await expect(resolveUserModelPreference("model2", "explicit", config)).resolves.toEqual({
			preference: "model2",
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});
});
