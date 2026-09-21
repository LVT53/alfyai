import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
	createWorkerId,
	isProcessAlive,
	parseWorkerId,
} from "./worker-identity";

describe("createWorkerId", () => {
	it("carries the slice, this host and this pid, and is stable per process", () => {
		const first = parseWorkerId(createWorkerId("extraction"));
		const second = parseWorkerId(createWorkerId("file-production"));

		expect(first).toMatchObject({
			slice: "extraction",
			hostname: (hostname() || "unknown").split(":").join(""),
			pid: process.pid,
		});
		expect(second?.slice).toBe("file-production");
		// One boot nonce per process, shared by both workers: it is what makes
		// "this attempt is ours" answerable after a pid is reused.
		expect(second?.nonce).toBe(first?.nonce);
	});
});

describe("parseWorkerId", () => {
	it("reads the current format back", () => {
		expect(parseWorkerId("extraction:box-1:4242:nonce-a")).toEqual({
			raw: "extraction:box-1:4242:nonce-a",
			slice: "extraction",
			hostname: "box-1",
			pid: 4242,
			nonce: "nonce-a",
		});
	});

	it("returns null for the previous format and for anything malformed", () => {
		// Load-bearing: "I cannot tell whose process this was" must never be read
		// as "it is dead". Rows written before this format fall back to the
		// stale-window path.
		expect(parseWorkerId("extraction:4242:some-uuid")).toBeNull();
		expect(parseWorkerId("extraction:box-1:notapid:nonce")).toBeNull();
		expect(parseWorkerId("extraction:box-1:0:nonce")).toBeNull();
		expect(parseWorkerId("extraction:box-1:4242:nonce:extra")).toBeNull();
		expect(parseWorkerId("")).toBeNull();
		expect(parseWorkerId(null)).toBeNull();
	});
});

describe("isProcessAlive", () => {
	it("says yes about this very process", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("says no about a pid that cannot exist", () => {
		// 2^22 + 1 is above every default pid_max; ESRCH is the answer.
		expect(isProcessAlive(4_194_305)).toBe(false);
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
	});

	it("treats pid 1 as alive, which is also the EPERM answer", () => {
		// init/launchd exists and is usually not signalable by this user. Reading
		// EPERM as dead would let one worker reclaim another's live attempt.
		expect(isProcessAlive(1)).toBe(true);
	});
});
