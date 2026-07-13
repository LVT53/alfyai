import { describe, expect, it } from "vitest";
import {
	formatMonthLabel,
	isNextDisabled,
	isPrevDisabled,
	stepMonth,
} from "./month-nav-logic";

const months = ["2026-04", "2026-05", "2026-06", "2026-07"];

describe("formatMonthLabel", () => {
	it("formats YYYY-MM as a localized Month YYYY string", () => {
		expect(formatMonthLabel("2026-07", "en-US")).toBe("July 2026");
		expect(formatMonthLabel("2026-01", "en-US")).toBe("January 2026");
	});

	it("returns the raw key for an unparseable value", () => {
		expect(formatMonthLabel("not-a-month")).toBe("not-a-month");
	});
});

describe("stepMonth", () => {
	it("steps to the previous (older) month", () => {
		expect(stepMonth(months, "2026-06", -1)).toBe("2026-05");
	});

	it("steps to the next (newer) month", () => {
		expect(stepMonth(months, "2026-06", 1)).toBe("2026-07");
	});

	it("clamps at the oldest month going back", () => {
		expect(stepMonth(months, "2026-04", -1)).toBe("2026-04");
	});

	it("clamps at the newest month going forward", () => {
		expect(stepMonth(months, "2026-07", 1)).toBe("2026-07");
	});

	it("enters the newest month when stepping back from all-time", () => {
		// Regression lock: previous-from-all-time enters the NEWEST month (one
		// step in), NOT the pre-rebuild bespoke nav's second-newest ("2026-06").
		// See the stepMonth doc comment for why the second-newest quirk was
		// intentionally dropped in favor of this intuitive behavior.
		expect(stepMonth(months, null, -1)).toBe("2026-07");
		expect(stepMonth(months, null, -1)).not.toBe("2026-06");
	});

	it("stays all-time when stepping forward from all-time", () => {
		expect(stepMonth(months, null, 1)).toBeNull();
	});

	it("returns selected unchanged when months is empty", () => {
		expect(stepMonth([], "2026-07", -1)).toBe("2026-07");
	});
});

describe("isPrevDisabled / isNextDisabled", () => {
	it("disables prev only at the oldest month", () => {
		expect(isPrevDisabled(months, "2026-04")).toBe(true);
		expect(isPrevDisabled(months, "2026-05")).toBe(false);
		expect(isPrevDisabled(months, null)).toBe(false);
	});

	it("disables next at the newest month and at all-time", () => {
		expect(isNextDisabled(months, "2026-07")).toBe(true);
		expect(isNextDisabled(months, "2026-06")).toBe(false);
		expect(isNextDisabled(months, null)).toBe(true);
	});

	it("disables both when months is empty", () => {
		expect(isPrevDisabled([], null)).toBe(true);
		expect(isNextDisabled([], null)).toBe(true);
	});
});
