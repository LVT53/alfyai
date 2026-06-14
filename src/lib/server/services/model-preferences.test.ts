import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: vi.fn(async (name: string) =>
		name === "openrouter" ? { id: "provider-1", enabled: true } : null,
	),
	getProviderWithSecrets: vi.fn(async (id: string) =>
		id === "provider-1"
			? { id: "provider-1", name: "openrouter", enabled: true }
			: null,
	),
}));

vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: vi.fn(async (providerId: string) =>
		providerId === "provider-1"
			? [
					{ id: "model-a", name: "vendor/model-a", enabled: true },
					{ id: "model-b", name: "vendor/model-b", enabled: true },
				]
			: [],
	),
}));

import type { RuntimeConfig } from "$lib/server/config-store";
import { resolveUserModelPreference } from "./model-preferences";

const config = {
	defaultNewUserModel: "model2",
	model1: { displayName: "Model 1" },
	model2: { displayName: "Model 2" },
	model2Enabled: true,
} as RuntimeConfig;

describe("model preference inheritance", () => {
	it("resolves system-mode users to the live default without requiring nullable storage", async () => {
		await expect(
			resolveUserModelPreference("model1", "system", config),
		).resolves.toEqual({
			preference: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});

	it("normalizes legacy rows whose stored model equals the current default to inherited", async () => {
		await expect(
			resolveUserModelPreference("model2", null, config),
		).resolves.toEqual({
			preference: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});

	it("preserves explicit non-default model choices", async () => {
		await expect(
			resolveUserModelPreference("model1", "explicit", config),
		).resolves.toEqual({
			preference: "model1",
			effectiveModel: "model1",
			systemDefaultModel: "model2",
		});
	});

	it("preserves explicit choices even when they currently match the admin default", async () => {
		await expect(
			resolveUserModelPreference("model2", "explicit", config),
		).resolves.toEqual({
			preference: "model2",
			effectiveModel: "model2",
			systemDefaultModel: "model2",
		});
	});

	it("preserves explicit provider model choices", async () => {
		await expect(
			resolveUserModelPreference(
				"provider:provider-1:model-b",
				"explicit",
				config,
			),
		).resolves.toEqual({
			preference: "provider:provider-1:model-b",
			effectiveModel: "provider:provider-1:model-b",
			systemDefaultModel: "model2",
		});
	});

	it("maps provider-level defaults to the first enabled provider model", async () => {
		await expect(
			resolveUserModelPreference("model1", "system", {
				...config,
				defaultNewUserModel: "provider:provider-1",
			} as RuntimeConfig),
		).resolves.toEqual({
			preference: null,
			effectiveModel: "provider:provider-1:model-a",
			systemDefaultModel: "provider:provider-1:model-a",
		});
	});
});
