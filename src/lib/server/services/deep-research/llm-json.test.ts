import { describe, expect, it } from "vitest";
import { parseModelJsonObject } from "./llm-json";

describe("parseModelJsonObject", () => {
	it("recovers an object after a dangling extra opening brace", () => {
		expect(parseModelJsonObject('{\n {"ok": true, "label": "valid"}')).toEqual({
			ok: true,
			label: "valid",
		});
	});

	it("prefers the final valid object when prose or reasoning contains earlier JSON", () => {
		expect(
			parseModelJsonObject(
				[
					'Reasoning note with {"task":"context_compression"} that is not the answer.',
					'{"goal":"Keep the deployment stable","currentState":"Ready"}',
				].join("\n"),
			),
		).toEqual({
			goal: "Keep the deployment stable",
			currentState: "Ready",
		});
	});
});
