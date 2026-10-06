import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { tourCountLabel, tourLead, tourStepNumbers } from "./campaign-labels";

afterEach(() => uiLanguage.set("en"));

describe("tourStepNumbers", () => {
	it("leaves the summary slide without a number and counts the steps 1, 2, 3", () => {
		expect(
			tourStepNumbers([
				{ kind: "summary" },
				{ kind: "standard" },
				{ kind: "standard" },
				{ kind: "standard" },
			]),
		).toEqual([null, 1, 2, 3]);
	});

	it("counts steps as a reader meets them, whatever place the summary slide holds", () => {
		expect(
			tourStepNumbers([
				{ kind: "standard" },
				{ kind: "summary" },
				{ kind: "standard" },
			]),
		).toEqual([1, null, 2]);
	});

	it("numbers every slide when there is no summary slide, and nothing when there are no slides", () => {
		expect(
			tourStepNumbers([{ kind: "standard" }, { kind: "standard" }]),
		).toEqual([1, 2]);
		expect(tourStepNumbers([])).toEqual([]);
	});
});

describe("tourCountLabel", () => {
	it("counts a tour by its steps and the empty-state line, never as slides", () => {
		expect(tourCountLabel(4, get(t))).toBe("3 steps + empty-state line");
	});

	it("says one step in the singular", () => {
		expect(tourCountLabel(2, get(t))).toBe("1 step + empty-state line");
	});

	it("never goes below none", () => {
		expect(tourCountLabel(1, get(t))).toBe("0 steps + empty-state line");
		expect(tourCountLabel(0, get(t))).toBe("0 steps + empty-state line");
	});

	it("says it in Hungarian", () => {
		uiLanguage.set("hu");
		expect(tourCountLabel(4, get(t))).toBe("3 lépés + üres állapot sora");
	});
});

describe("tourLead", () => {
	it("leads with Tour and the kind's own word", () => {
		expect(tourLead("canvas", get(t))).toEqual(["Tour", "Canvas"]);
		uiLanguage.set("hu");
		expect(tourLead("canvas", get(t))).toEqual(["Bemutató", "Tábla"]);
	});

	it("shows a release text that names no kind as it is, and says Tour alone for none", () => {
		expect(tourLead("2.1.0", get(t))).toEqual(["Tour", "2.1.0"]);
		expect(tourLead("  ", get(t))).toEqual(["Tour"]);
		expect(tourLead(null, get(t))).toEqual(["Tour"]);
	});
});
