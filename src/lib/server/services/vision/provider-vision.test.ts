import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";

// Where a model runs is decided by one rule: its provider's base URL names a
// private, loopback or link-local host (connections/host-locality.ts). The
// connector gate asks it of a model id (`isCloudModel`, locality.ts); the model
// run asks it of the provider it is about to call (`providerRunsLocally`), and
// the two must never disagree.

const mocks = vi.hoisted(() => ({
	resolveNormalChatModelRunProvider: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-model", () => ({
	resolveNormalChatModelRunProvider: mocks.resolveNormalChatModelRunProvider,
}));

import { isCloudModel } from "$lib/server/services/connections/locality";
import { providerCanSeeImages, providerRunsLocally } from "./provider-vision";

function providerAt(baseUrl: string) {
	return {
		id: "p",
		name: "p",
		displayName: "P",
		baseUrl,
		modelName: "m",
		apiKey: "k",
	};
}

const ON_THE_BOX = [
	"http://127.0.0.1:8000/v1",
	"http://localhost:11434/v1",
	"http://192.168.1.96:30000/v1",
	"http://10.0.0.5/v1",
	"http://172.16.0.9:8000/v1",
	"http://172.31.255.1/v1",
	"http://169.254.10.2/v1",
	"http://[::1]:8080/v1",
	"http://alfyroot.local:8000/v1",
];

const ELSEWHERE = [
	"https://api.deepseek.com/v1",
	"https://vllm.example/v1",
	"http://inference.alfycomms.com/v1",
	"http://172.32.0.9/v1",
	"http://8.8.8.8/v1",
	// Tailscale's range is not a private range to this rule, and the gate says
	// the same of it.
	"http://100.64.12.3:8000/v1",
	"http://alfyroot:8000/v1",
	"not a url",
	"",
];

describe("providerRunsLocally", () => {
	it.each(ON_THE_BOX)("is true for %s", (baseUrl) => {
		expect(providerRunsLocally(providerAt(baseUrl))).toBe(true);
	});

	it.each(ELSEWHERE)("is false for %s", (baseUrl) => {
		expect(providerRunsLocally(providerAt(baseUrl))).toBe(false);
	});

	describe("and the connector gate's answer for the same provider", () => {
		beforeEach(() => {
			mocks.resolveNormalChatModelRunProvider.mockReset();
		});

		it.each([
			...ON_THE_BOX,
			...ELSEWHERE,
		])("is the opposite of isCloudModel for %s", async (baseUrl) => {
			mocks.resolveNormalChatModelRunProvider.mockResolvedValue(
				providerAt(baseUrl),
			);

			expect(await isCloudModel("provider:p:m")).toBe(
				!providerRunsLocally(providerAt(baseUrl)),
			);
		});
	});
});

describe("providerCanSeeImages", () => {
	it("is still only an explicit yes", () => {
		const seeing = {
			...providerAt("http://127.0.0.1:8000/v1"),
			capabilities: createModelCapabilitySet({
				imageMessageParts: {
					state: "manual_override",
					supported: true,
					source: "manual_override",
				},
			}),
		};

		expect(providerCanSeeImages(seeing)).toBe(true);
		expect(providerCanSeeImages(providerAt("http://127.0.0.1:8000/v1"))).toBe(
			false,
		);
	});
});
