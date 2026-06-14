import { describe, expect, it } from "vitest";
import {
	buildOpenAICompatibleUrl,
	normalizeOpenAICompatibleBaseUrl,
} from "./openai-compatible-url";

describe("normalizeOpenAICompatibleBaseUrl", () => {
	it("adds v1 to Fireworks inference roots", () => {
		expect(
			normalizeOpenAICompatibleBaseUrl("https://api.fireworks.ai/inference"),
		).toBe("https://api.fireworks.ai/inference/v1");
	});

	it("keeps already-versioned provider base URLs unchanged", () => {
		expect(
			normalizeOpenAICompatibleBaseUrl("https://api.fireworks.ai/inference/v1"),
		).toBe("https://api.fireworks.ai/inference/v1");
	});

	it("normalizes accidental full endpoint URLs back to the API base", () => {
		expect(
			normalizeOpenAICompatibleBaseUrl(
				"https://api.fireworks.ai/inference/v1/chat/completions",
			),
		).toBe("https://api.fireworks.ai/inference/v1");
	});
});

describe("buildOpenAICompatibleUrl", () => {
	it("does not duplicate v1 when the provider base URL already includes it", () => {
		expect(
			buildOpenAICompatibleUrl(
				"https://api.fireworks.ai/inference/v1",
				"/v1/models",
			),
		).toBe("https://api.fireworks.ai/inference/v1/models");
	});

	it("adds v1 paths when the provider base URL is a root OpenAI-compatible host", () => {
		expect(
			buildOpenAICompatibleUrl(
				"https://api.example.com",
				"/v1/chat/completions",
			),
		).toBe("https://api.example.com/v1/chat/completions");
	});

	it("keeps provider path prefixes when normalizing v1 paths", () => {
		expect(
			buildOpenAICompatibleUrl(
				"https://api.fireworks.ai/inference",
				"/v1/chat/completions",
			),
		).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
	});
});
