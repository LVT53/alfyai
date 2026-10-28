import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createModelCapabilitySet,
	type ModelCapabilitySet,
} from "$lib/model-capabilities";
import { modelCanSeeImages, setModelImageInput } from "$lib/model-image-input";
import type { ModelId } from "$lib/model-types";

const mocks = vi.hoisted(() => ({
	decryptApiKey: vi.fn(),
	getConfig: vi.fn(),
	getProviderByName: vi.fn(),
	getProviderModel: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	listEnabledProviderModels: vi.fn(),
}));

vi.mock("$lib/server/services/providers", () => ({
	decryptApiKey: mocks.decryptApiKey,
	getProviderByName: mocks.getProviderByName,
	getProviderWithSecrets: mocks.getProviderWithSecrets,
}));

vi.mock("$lib/server/services/provider-models", () => ({
	getProviderModel: mocks.getProviderModel,
	listEnabledProviderModels: mocks.listEnabledProviderModels,
}));

vi.mock("$lib/server/config-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/config-store")>();
	return { ...actual, getConfig: mocks.getConfig };
});

import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { resolveNormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import {
	legacyModelIdAliases,
	modelIdCanSeeImages,
	providerCanSeeImages,
} from "./model-vision";

const PROVIDER_MODEL_ID = "provider:provider-1:model-1" as ModelId;

const providerWithSecrets = {
	id: "provider-1",
	name: "local",
	displayName: "Local",
	baseUrl: "http://vllm.example/v1",
	apiKeyEncrypted: "encrypted",
	apiKeyIv: "iv",
	iconAssetId: null,
	enabled: true,
};

function modelRow(capabilitiesJson: string) {
	return {
		id: "model-1",
		providerId: "provider-1",
		name: "flash-next",
		displayName: "Flash-Next",
		aliases: [],
		iconAssetId: null,
		fallbackProviderModelId: null,
		maxModelContext: null,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: 4096,
		reasoningEffort: null,
		thinkingType: null,
		capabilitiesJson,
		enabled: true,
		sortOrder: 0,
	};
}

/** The provider the app builds for a row with this stored capabilities string. */
async function providerBuiltFrom(
	capabilitiesJson: string,
): Promise<NormalChatModelRunProvider> {
	mocks.listEnabledProviderModels.mockResolvedValue([
		modelRow(capabilitiesJson),
	]);
	return resolveNormalChatModelRunProvider(PROVIDER_MODEL_ID);
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.decryptApiKey.mockReturnValue("plain-secret");
	mocks.getProviderWithSecrets.mockResolvedValue(providerWithSecrets);
	mocks.getProviderByName.mockResolvedValue(null);
	mocks.listEnabledProviderModels.mockResolvedValue([]);
	mocks.getConfig.mockReturnValue({
		model1: {
			baseUrl: "http://builtin.example/v1",
			apiKey: "builtin-key",
			modelName: "builtin-model",
			displayName: "Built-in",
			systemPrompt: "",
			maxTokens: 2048,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2: { baseUrl: "", apiKey: "", modelName: "", displayName: "Two" },
		model2Enabled: true,
	});
});

describe("providerCanSeeImages", () => {
	it("is true for a provider whose imageMessageParts capability is supported", () => {
		const provider = {
			id: "p",
			name: "p",
			displayName: "P",
			baseUrl: "http://p.example/v1",
			modelName: "m",
			apiKey: "k",
			capabilities: createModelCapabilitySet({
				imageMessageParts: {
					state: "manual_override",
					supported: true,
					source: "manual_override",
				},
			}),
		} satisfies NormalChatModelRunProvider;

		expect(providerCanSeeImages(provider)).toBe(true);
	});

	it.each([
		["a provider with no capability evidence at all", undefined],
		["unknown", createModelCapabilitySet({})],
		[
			"detected as not supported",
			createModelCapabilitySet({
				imageMessageParts: { state: "not_detected" },
			}),
		],
		[
			"a manual override that says no",
			createModelCapabilitySet({
				imageMessageParts: { state: "manual_override", supported: false },
			}),
		],
	] satisfies Array<
		[string, ModelCapabilitySet | undefined]
	>)("is false for %s", (_label, capabilities) => {
		expect(
			providerCanSeeImages({
				id: "p",
				name: "p",
				displayName: "P",
				baseUrl: "http://p.example/v1",
				modelName: "m",
				apiKey: "k",
				capabilities,
			}),
		).toBe(false);
	});
});

// The admin form and the model list read the stored string with
// modelCanSeeImages; a chat turn reads the provider the run builds from the
// same string. One fact, one reading: the two must never disagree, whatever
// shape the stored entry has (probes write objects, older rows and hand edits
// wrote strings and booleans).
describe("a model the admin sees as able to see images is a provider that can", () => {
	const SHAPES: Array<{ shape: string; json: string; sees: boolean }> = [
		{
			shape: "the manual override the checkbox writes",
			json: setModelImageInput("{}", true),
			sees: true,
		},
		{
			shape: "the checkbox ticked beside other capabilities",
			json: setModelImageInput('{"tools":"detected","chat":true}', true),
			sees: true,
		},
		{
			shape: 'a string "detected"',
			json: '{"imageMessageParts":"detected"}',
			sees: true,
		},
		{
			shape: "a bare true",
			json: '{"imageMessageParts":true}',
			sees: true,
		},
		{
			shape: 'an object that only says state "detected"',
			json: '{"imageMessageParts":{"state":"detected"}}',
			sees: true,
		},
		{
			shape: "an object that only says supported true",
			json: '{"imageMessageParts":{"supported":true}}',
			sees: true,
		},
		{
			shape: "a probe's whole status entry",
			json: JSON.stringify(
				createModelCapabilitySet({
					imageMessageParts: { state: "detected", source: "probe" },
				}),
			),
			sees: true,
		},
		{
			shape: "an absent key",
			json: '{"tools":"detected"}',
			sees: false,
		},
		{ shape: "an empty object", json: "{}", sees: false },
		{ shape: "an empty string", json: "", sees: false },
		{
			shape: "the checkbox ticked and then cleared",
			json: setModelImageInput(setModelImageInput("{}", true), false),
			sees: false,
		},
		{
			shape: "a bare false",
			json: '{"imageMessageParts":false}',
			sees: false,
		},
		{
			shape: 'a string "not_detected"',
			json: '{"imageMessageParts":"not_detected"}',
			sees: false,
		},
		{
			shape: 'a string "unknown"',
			json: '{"imageMessageParts":"unknown"}',
			sees: false,
		},
		{
			shape: "a manual override that says no",
			json: '{"imageMessageParts":{"state":"manual_override","supported":false}}',
			sees: false,
		},
		{
			shape: 'a state "detected" that an explicit supported false contradicts',
			json: '{"imageMessageParts":{"state":"detected","supported":false}}',
			sees: false,
		},
		{
			shape: 'a state "detected" with supported null',
			json: '{"imageMessageParts":{"state":"detected","supported":null}}',
			sees: false,
		},
		{ shape: "text that is not JSON", json: "not json", sees: false },
		{ shape: "a JSON array", json: "[]", sees: false },
	];

	it.each(SHAPES)("agrees for $shape", async ({ json, sees }) => {
		const provider = await providerBuiltFrom(json);

		expect(modelCanSeeImages(json)).toBe(sees);
		expect(providerCanSeeImages(provider)).toBe(sees);
	});

	it("sees through a provider built from the row the checkbox writes", async () => {
		const provider = await providerBuiltFrom(setModelImageInput("{}", true));

		expect(providerCanSeeImages(provider)).toBe(true);
	});

	it("reads the image entry as the admin form does and no other entry differently", async () => {
		const provider = await providerBuiltFrom(
			'{"imageMessageParts":"detected","tools":"detected","chat":true,"streaming":{"state":"detected"}}',
		);

		expect(provider.capabilities?.imageMessageParts.supported).toBe(true);
		// The strict reading of every other key is what it was: a string or a bare
		// boolean is unknown there, and an object with a state is that state.
		expect(provider.capabilities?.tools.supported).toBeNull();
		expect(provider.capabilities?.chat.supported).toBeNull();
		expect(provider.capabilities?.streaming.supported).toBe(true);
	});
});

describe("modelIdCanSeeImages", () => {
	it("is true for a provider model the admin ticked", async () => {
		mocks.listEnabledProviderModels.mockResolvedValue([
			modelRow(setModelImageInput("{}", true)),
		]);

		await expect(modelIdCanSeeImages(PROVIDER_MODEL_ID)).resolves.toBe(true);
	});

	it("is false for a provider model that was not ticked", async () => {
		mocks.listEnabledProviderModels.mockResolvedValue([modelRow("{}")]);

		await expect(modelIdCanSeeImages(PROVIDER_MODEL_ID)).resolves.toBe(false);
	});

	it("resolves no model the way the turn does: as the default model", async () => {
		mocks.getProviderByName.mockImplementation(async (name: string) =>
			name === "model1" ? { ...providerWithSecrets, name: "model1" } : null,
		);
		mocks.listEnabledProviderModels.mockResolvedValue([
			modelRow(setModelImageInput("{}", true)),
		]);

		await expect(modelIdCanSeeImages(undefined)).resolves.toBe(true);
		expect(mocks.getProviderByName).toHaveBeenCalledWith("model1");
	});

	it("is false for a built-in model with no provider row, which has nowhere to be ticked", async () => {
		await expect(modelIdCanSeeImages("model1")).resolves.toBe(false);
		await expect(modelIdCanSeeImages(undefined)).resolves.toBe(false);
	});

	it("is false, without throwing, for a model that cannot be resolved", async () => {
		mocks.getProviderWithSecrets.mockResolvedValue(null);

		await expect(modelIdCanSeeImages(PROVIDER_MODEL_ID)).resolves.toBe(false);
		await expect(
			modelIdCanSeeImages("provider:gone:also-gone" as ModelId),
		).resolves.toBe(false);
	});

	it("is false when a built-in model is not configured", async () => {
		mocks.getConfig.mockReturnValue({
			model1: { baseUrl: "", modelName: "", displayName: "" },
			model2: { baseUrl: "", modelName: "", displayName: "" },
			model2Enabled: false,
		});

		await expect(modelIdCanSeeImages(undefined)).resolves.toBe(false);
	});
});

// Task 20, live on ai.dev: the default model id is the legacy "model1", which
// the run resolves to the provider row named "model1". The model list names
// that row "provider:<id>:<model>", so the composer could not find "model1"
// in it and held Send on a photo the server would have let through.
describe("legacyModelIdAliases", () => {
	it("maps a legacy id to the provider model the run resolves it to", async () => {
		mocks.getProviderByName.mockImplementation(async (name: string) =>
			name === "model1" ? { ...providerWithSecrets, name: "model1" } : null,
		);
		mocks.listEnabledProviderModels.mockResolvedValue([
			modelRow(setModelImageInput("{}", true)),
		]);

		const aliases = await legacyModelIdAliases();

		expect(aliases).toEqual({ model1: PROVIDER_MODEL_ID });
		// The alias names the row whose answer the send gate gives for "model1".
		await expect(modelIdCanSeeImages("model1")).resolves.toBe(true);
		await expect(modelIdCanSeeImages(aliases.model1)).resolves.toBe(true);
	});

	it("has no alias for a built-in model with no provider row: the list names it itself", async () => {
		await expect(legacyModelIdAliases()).resolves.toEqual({});
	});
});
