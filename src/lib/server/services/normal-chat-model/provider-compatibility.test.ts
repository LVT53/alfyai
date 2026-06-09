import { describe, expect, it } from "vitest";
import {
	buildNormalChatModelRunCompatibilityProviderOptions,
	transformNormalChatModelRunRequestBody,
	type NormalChatModelRunCompatibilityProvider,
} from "./provider-compatibility";

const mimoProvider: NormalChatModelRunCompatibilityProvider = {
	name: "xiaomi_mimo",
	displayName: "Xiaomi MiMo",
	baseUrl: "https://api.xiaomimimo.com/v1",
	modelName: "mimo-v2.5-pro",
};

describe("Xiaomi MiMo provider compatibility", () => {
	it("uses max_completion_tokens instead of max_tokens", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "mimo-v2.5-pro",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 4096,
			},
			mimoProvider,
		);

		expect(transformed).toMatchObject({
			model: "mimo-v2.5-pro",
			max_completion_tokens: 4096,
		});
		expect(transformed).not.toHaveProperty("max_tokens");
	});

	it("detects MiMo from model name even when provider metadata is generic", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "mimo-v2.5-pro",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 1024,
			},
			{
				name: "model1",
				displayName: "Primary Model",
				baseUrl: "https://gateway.example.test/v1",
				modelName: "mimo-v2.5-pro",
			},
		);

		expect(transformed).toMatchObject({ max_completion_tokens: 1024 });
		expect(transformed).not.toHaveProperty("max_tokens");
	});

	it("leaves MiMo reasoning controls under model/UI configuration", () => {
		const options = buildNormalChatModelRunCompatibilityProviderOptions(
			{
				...mimoProvider,
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
			"on",
		);

		expect(options).toEqual({
			reasoningEffort: "high",
			thinking: { type: "enabled" },
		});
	});

	it("does not rewrite max_tokens for otherwise generic providers", () => {
		const transformed = transformNormalChatModelRunRequestBody(
			{
				model: "generic-chat-model",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 512,
			},
			{
				name: "generic",
				displayName: "Generic",
				baseUrl: "https://gateway.example.test/v1",
				modelName: "generic-chat-model",
			},
		);

		expect(transformed).toMatchObject({ max_tokens: 512 });
		expect(transformed).not.toHaveProperty("max_completion_tokens");
	});
});
