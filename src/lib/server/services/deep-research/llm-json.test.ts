import { describe, expect, it } from "vitest";
import { parseModelJsonObject } from "./llm-json";

describe("parseModelJsonObject", () => {
	it("recovers an object after a dangling extra opening brace", () => {
		expect(parseModelJsonObject('{\n {"ok": true, "label": "valid"}')).toEqual({
			ok: true,
			label: "valid",
		});
	});
});
