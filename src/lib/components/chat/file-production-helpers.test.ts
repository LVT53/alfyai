import { describe, expect, it } from "vitest";
import { formatElapsed, isStaleJob } from "./file-production-helpers";

describe("formatElapsed", () => {
	it("formats zero elapsed as 0:00", () => {
		expect(formatElapsed(0, 0)).toBe("0:00");
	});

	it("formats sub-minute elapsed as 0:ss with zero-padded seconds", () => {
		expect(formatElapsed(0, 5_000)).toBe("0:05");
		expect(formatElapsed(1_000, 30_000)).toBe("0:29");
		expect(formatElapsed(0, 59_999)).toBe("0:59");
	});

	it("formats elapsed over a minute as m:ss", () => {
		expect(formatElapsed(0, 60_000)).toBe("1:00");
		expect(formatElapsed(0, 75_000)).toBe("1:15");
		expect(formatElapsed(0, 125_000)).toBe("2:05");
	});

	it("caps the display at 59:59 for very long durations", () => {
		// 3599999 ms = 59:59.999 — just under the cap
		expect(formatElapsed(0, 3_599_999)).toBe("59:59");
		// 1 hour
		expect(formatElapsed(0, 3_600_000)).toBe("59:59");
		// well beyond an hour
		expect(formatElapsed(0, 7_200_000)).toBe("59:59");
	});

	it("treats a negative elapsed (future createdAt) as zero", () => {
		expect(formatElapsed(10_000, 0)).toBe("0:00");
	});
});

describe("isStaleJob", () => {
	it("is not stale when elapsed is under 90 seconds", () => {
		expect(isStaleJob(0, 89_000)).toBe(false);
	});

	it("is stale when elapsed exceeds 90 seconds", () => {
		expect(isStaleJob(0, 91_000)).toBe(true);
	});

	it("is not stale at exactly the 90000ms boundary", () => {
		expect(isStaleJob(0, 90_000)).toBe(false);
	});

	it("is stale well beyond the threshold", () => {
		expect(isStaleJob(0, 600_000)).toBe(true);
	});

	it("is not stale for a future createdAt (negative elapsed)", () => {
		expect(isStaleJob(10_000, 0)).toBe(false);
	});
});
