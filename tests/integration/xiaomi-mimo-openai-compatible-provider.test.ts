import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runPlainNormalChatModelRun } from "$lib/server/services/normal-chat-model";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_PLAIN_TEXT,
	AI_SMOKE_SCENARIOS,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";

const provider = createOpenAICompatibleProviderHarness();

describe("Xiaomi MiMo OpenAI-compatible provider smoke", () => {
	afterAll(async () => {
		await provider.stop();
	});

	beforeEach(async () => {
		await provider.start();
		await provider.reset();
	});

	it("sends MiMo max output as max_completion_tokens", async () => {
		const result = await runPlainNormalChatModelRun({
			provider: {
				id: "xiaomi-mimo-provider",
				name: "xiaomi_mimo",
				displayName: "Xiaomi MiMo",
				baseUrl: provider.baseURL,
				modelName: "mimo-v2.5-pro",
				apiKey: AI_SMOKE_API_KEY,
				maxOutputTokens: 321,
			},
			headers: {
				"x-ai-smoke-scenario": AI_SMOKE_SCENARIOS.mimoRejectsMaxTokens,
			},
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Say hello deterministically." }],
				},
			],
		});

		expect(result.text).toBe(AI_SMOKE_PLAIN_TEXT);
		expect(result.model.requestedModelName).toBe("mimo-v2.5-pro");
		expect(provider.requests()).toMatchObject([
			{
				method: "POST",
				path: "/v1/chat/completions",
				scenario: AI_SMOKE_SCENARIOS.mimoRejectsMaxTokens,
				body: {
					model: "mimo-v2.5-pro",
					max_completion_tokens: 321,
				},
			},
		]);
		expect(provider.requests()[0]?.body).not.toHaveProperty("max_tokens");
	});
});
