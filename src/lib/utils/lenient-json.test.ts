import { describe, expect, it } from "vitest";
import { parseJsonLenient, repairJson } from "./lenient-json";

// The exact ```chart body from the production message that would not render:
// 11 `{` vs 10 `}` — the top-level closing brace is missing.
const CHART_ONE_MISSING_BRACE = `{
  "type": "line",
  "data": {
    "labels": ["W1", "W2", "W3", "W4", "W5", "W6"],
    "datasets": [
      {"label": "Push-ups", "data": [20, 25, 30, 35, 42, 48], "tension": 0.3},
      {"label": "Squats", "data": [50, 60, 70, 80, 90, 100], "tension": 0.3},
      {"label": "Pull-ups", "data": [5, 7, 8, 10, 12, 14], "tension": 0.3}
    ]
  },
  "options": {
    "plugins": {"title": {"display": true, "text": "Estimated max reps, week by week"}},
    "scales": {"y": {"beginAtZero": true, "title": {"display": true, "text": "Max reps"}}
  }
}`;

describe("parseJsonLenient", () => {
	it("returns valid JSON unchanged (strict parse wins)", () => {
		const obj = { type: "bar", data: { labels: ["A"], datasets: [] } };
		expect(parseJsonLenient(JSON.stringify(obj))).toEqual(obj);
	});

	it("recovers the production chart with a missing top-level brace", () => {
		const parsed = parseJsonLenient(CHART_ONE_MISSING_BRACE) as Record<
			string,
			unknown
		>;
		expect(parsed).toBeTruthy();
		expect(parsed.type).toBe("line");
		const data = parsed.data as { datasets: unknown[] };
		expect(data.datasets).toHaveLength(3);
		const options = parsed.options as {
			scales: { y: { beginAtZero: boolean } };
		};
		expect(options.scales.y.beginAtZero).toBe(true);
	});

	it("strips a trailing comma before a closer", () => {
		expect(parseJsonLenient('{"a": 1, "b": [1, 2,],}')).toEqual({
			a: 1,
			b: [1, 2],
		});
	});

	it("closes multiple unclosed brackets at EOF", () => {
		expect(parseJsonLenient('{"a": {"b": [1, 2')).toEqual({ a: { b: [1, 2] } });
	});

	it("returns undefined for input it cannot repair", () => {
		expect(parseJsonLenient("this is not json at all")).toBeUndefined();
		expect(parseJsonLenient('{"a": }')).toBeUndefined();
	});
});

describe("repairJson", () => {
	it("never disturbs braces, brackets, or commas inside string values", () => {
		const withBracey = '{"text": "a } b ] c , d {"}';
		// Already valid — repair must round-trip it byte-for-byte.
		expect(repairJson(withBracey)).toBe(withBracey);
		expect(JSON.parse(repairJson(withBracey))).toEqual({
			text: "a } b ] c , d {",
		});
	});

	it("does not strip a comma that lives inside a string before a closer", () => {
		const input = '{"label": "Push-ups, squats,"}';
		expect(JSON.parse(repairJson(input))).toEqual({
			label: "Push-ups, squats,",
		});
	});
});
