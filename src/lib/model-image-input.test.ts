import { describe, expect, it } from "vitest";
import { canUseProviderModelFallback } from "./model-fallback-compatibility";
import { modelCanSeeImages, setModelImageInput } from "./model-image-input";

const IMAGE_OVERRIDE = {
	state: "manual_override",
	supported: true,
	source: "manual_override",
};

describe("model image input", () => {
	it("writes a manual override when enabled", () => {
		const json = setModelImageInput('{"tools":"detected"}', true);
		expect(JSON.parse(json)).toEqual({
			tools: "detected",
			imageMessageParts: {
				state: "manual_override",
				supported: true,
				source: "manual_override",
			},
		});
		expect(modelCanSeeImages(json)).toBe(true);
	});

	it("removes the key when disabled, never writing false", () => {
		const json = setModelImageInput(setModelImageInput("{}", true), false);
		expect(JSON.parse(json)).toEqual({});
	});

	it("counts only an explicit true", () => {
		expect(modelCanSeeImages("{}")).toBe(false);
		expect(modelCanSeeImages('{"imageMessageParts":"unknown"}')).toBe(false);
		expect(modelCanSeeImages("not json")).toBe(false);
	});

	it("keeps a non-seeing fallback acceptable", () => {
		const source = {
			capabilitiesJson: setModelImageInput("{}", true),
			reasoningEffort: null,
			thinkingType: null,
		};
		const fallback = {
			capabilitiesJson: setModelImageInput("{}", false),
			reasoningEffort: null,
			thinkingType: null,
		};
		expect(canUseProviderModelFallback(source, fallback)).toEqual({
			compatible: true,
		});
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["an empty string", ""],
		["text that is not JSON", "not json"],
		["a JSON array", "[]"],
		["a JSON null", "null"],
		["a JSON string", '"detected"'],
		["a JSON number", "42"],
	])("treats %s as an empty capability set", (_label, input) => {
		expect(modelCanSeeImages(input)).toBe(false);
		expect(JSON.parse(setModelImageInput(input, true))).toEqual({
			imageMessageParts: IMAGE_OVERRIDE,
		});
		expect(setModelImageInput(input, false)).toBe("{}");
	});

	it("leaves every other capability exactly as it was", () => {
		const stored = {
			chat: "detected",
			tools: {
				state: "manual_override",
				supported: false,
				source: "manual_override",
			},
			reasoningControls: "not_detected",
		};

		const enabled = setModelImageInput(JSON.stringify(stored), true);
		expect(JSON.parse(enabled)).toEqual({
			...stored,
			imageMessageParts: IMAGE_OVERRIDE,
		});

		const disabled = setModelImageInput(enabled, false);
		expect(JSON.parse(disabled)).toEqual(stored);
	});

	it("replaces a detected or refused image entry instead of stacking a second one", () => {
		for (const previous of ["detected", "not_detected", "unknown"]) {
			const json = setModelImageInput(
				JSON.stringify({ imageMessageParts: previous }),
				true,
			);
			expect(JSON.parse(json)).toEqual({ imageMessageParts: IMAGE_OVERRIDE });
		}
		expect(
			setModelImageInput(
				JSON.stringify({ imageMessageParts: { state: "not_detected" } }),
				false,
			),
		).toBe("{}");
	});

	it("gives the same result when the same choice is applied twice", () => {
		const once = setModelImageInput('{"chat":"detected"}', true);
		expect(setModelImageInput(once, true)).toBe(once);

		const off = setModelImageInput(once, false);
		expect(setModelImageInput(off, false)).toBe(off);
	});

	it("reads an explicit supported flag in either stored shape", () => {
		expect(
			modelCanSeeImages(JSON.stringify({ imageMessageParts: IMAGE_OVERRIDE })),
		).toBe(true);
		expect(
			modelCanSeeImages(
				JSON.stringify({ imageMessageParts: { supported: true } }),
			),
		).toBe(true);
		expect(modelCanSeeImages('{"imageMessageParts":true}')).toBe(true);

		expect(modelCanSeeImages('{"imageMessageParts":false}')).toBe(false);
		expect(modelCanSeeImages('{"imageMessageParts":"not_detected"}')).toBe(
			false,
		);
		expect(
			modelCanSeeImages(
				JSON.stringify({
					imageMessageParts: { ...IMAGE_OVERRIDE, supported: false },
				}),
			),
		).toBe(false);
		expect(
			modelCanSeeImages(
				JSON.stringify({
					imageMessageParts: { state: "manual_override", supported: null },
				}),
			),
		).toBe(false);
	});

	it("ignores a seeing flag on any other capability", () => {
		expect(
			modelCanSeeImages('{"fileMessageParts":"detected","tools":true}'),
		).toBe(false);
	});
});
