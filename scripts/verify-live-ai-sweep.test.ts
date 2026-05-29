import { describe, expect, it } from "vitest";
import {
	parseJsonObject,
	structuredRecallHasValue,
} from "./verify-live-ai-sweep";

describe("live AI sweep structured recall validation", () => {
	it("rejects non-JSON recall output even when prose includes an expected value", () => {
		const text = 'The strict JSON is {"reviewer":"Kende Farkas"}.';
		const parsed = parseJsonObject(text);

		expect(parsed).toBeNull();
		expect(
			structuredRecallHasValue({
				parsed,
				field: "reviewer",
				acceptedValues: ["Kende Farkas"],
			}),
		).toBe(false);
	});

	it("rejects expected recall values found only in the wrong JSON field", () => {
		const parsed = parseJsonObject(
			JSON.stringify({
				notes: "The reviewer is Kende Farkas.",
				reviewer: "Mira Kovacs",
			}),
		);

		expect(
			structuredRecallHasValue({
				parsed,
				field: "reviewer",
				acceptedValues: ["Kende Farkas"],
			}),
		).toBe(false);
	});

	it("accepts configured aliases only when they match the parsed field value", () => {
		const parsed = parseJsonObject(JSON.stringify({ envelope: "envelope 6F" }));

		expect(
			structuredRecallHasValue({
				parsed,
				field: "envelope",
				acceptedValues: ["6F", "envelope 6F"],
			}),
		).toBe(true);
	});
});
