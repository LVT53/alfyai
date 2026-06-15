import { describe, expect, it } from "vitest";
import { canUseProviderModelFallback } from "./model-fallback-compatibility";

describe("canUseProviderModelFallback", () => {
	it("rejects fallback choices when the source has an unknown hard capability", () => {
		const result = canUseProviderModelFallback(
			{
				capabilitiesJson: "{}",
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
					tools: "detected",
					structuredOutput: "detected",
					fileMessageParts: "detected",
					imageMessageParts: "detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			},
		);

		expect(result.compatible).toBe(false);
		if (result.compatible) return;
		expect(result.reason).toBe("source model must explicitly support chat");
	});

	it("does not require a fallback capability when the source explicitly lacks it", () => {
		const result = canUseProviderModelFallback(
			{
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
					tools: "not_detected",
					structuredOutput: "not_detected",
					fileMessageParts: "not_detected",
					imageMessageParts: "not_detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			},
		);

		expect(result.compatible).toBe(true);
	});

	it("requires reasoning controls only when the source model is configured for them", () => {
		const source = {
			capabilitiesJson: JSON.stringify({
				chat: "detected",
				streaming: "detected",
				tools: "detected",
				structuredOutput: "detected",
				fileMessageParts: "detected",
				imageMessageParts: "detected",
			}),
			reasoningEffort: "medium",
			thinkingType: null,
		};

		const incompatible = canUseProviderModelFallback(source, {
			capabilitiesJson: JSON.stringify({
				chat: "detected",
				streaming: "detected",
				tools: "detected",
				structuredOutput: "detected",
				fileMessageParts: "detected",
				imageMessageParts: "detected",
			}),
			reasoningEffort: null,
			thinkingType: null,
		});

		expect(incompatible.compatible).toBe(false);
		if (incompatible.compatible) return;
		expect(incompatible.reason).toBe(
			"fallback model must explicitly support reasoningControls",
		);

		expect(
			canUseProviderModelFallback(source, {
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
					tools: "detected",
					structuredOutput: "detected",
					fileMessageParts: "detected",
					imageMessageParts: "detected",
					reasoningControls: "detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			}).compatible,
		).toBe(true);
	});

	it("does not treat usage reporting or models endpoint as fallback blockers", () => {
		const result = canUseProviderModelFallback(
			{
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
					tools: "detected",
					structuredOutput: "detected",
					fileMessageParts: "detected",
					imageMessageParts: "detected",
					usageReporting: "not_detected",
					modelsEndpoint: "not_detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			},
			{
				capabilitiesJson: JSON.stringify({
					chat: "detected",
					streaming: "detected",
					tools: "detected",
					structuredOutput: "detected",
					fileMessageParts: "detected",
					imageMessageParts: "detected",
				}),
				reasoningEffort: null,
				thinkingType: null,
			},
		);

		expect(result.compatible).toBe(true);
	});
});
