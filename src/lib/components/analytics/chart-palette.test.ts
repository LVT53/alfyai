import { describe, expect, it } from "vitest";
import {
	ACCENT_FALLBACK,
	CATEGORICAL,
	categoricalColor,
	getAccent,
	SERIES,
} from "./chart-palette";

describe("chart-palette", () => {
	it("SERIES exposes distinct turbo/extract colors", () => {
		expect(SERIES.turbo).toBe("#0d9488");
		expect(SERIES.extract).toBe("#d97706");
		expect(SERIES.turbo).not.toBe(SERIES.extract);
	});

	it("SERIES.llm follows the live accent (falls back to terracotta)", () => {
		// jsdom root has no --accent set, so it falls back.
		expect(SERIES.llm).toBe(getAccent());
	});

	it("getAccent falls back to terracotta when no token is set", () => {
		// jsdom document root has no inline --accent, so the computed value is empty.
		expect(getAccent()).toBe(ACCENT_FALLBACK);
	});

	it("CATEGORICAL has 6 distinct colors led by terracotta", () => {
		expect(CATEGORICAL[0]).toBe("#c15f3c");
		expect(new Set(CATEGORICAL).size).toBe(CATEGORICAL.length);
		expect(CATEGORICAL.length).toBe(6);
	});

	it("categoricalColor wraps around the palette", () => {
		expect(categoricalColor(0)).toBe(CATEGORICAL[0]);
		expect(categoricalColor(6)).toBe(CATEGORICAL[0]);
		expect(categoricalColor(7)).toBe(CATEGORICAL[1]);
	});
});
