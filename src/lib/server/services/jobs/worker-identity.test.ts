import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
	belongsToDeadProcess,
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

describe("belongsToDeadProcess", () => {
	const self = parseWorkerId(createWorkerId("test"));
	const gone = () => false;
	const here = () => true;
	/** An id this host wrote, from a process that is not this one. */
	const foreign = (pid: number, nonce = "old-boot") =>
		`test:${self?.hostname}:${pid}:${nonce}`;

	it("reads an id from a process that is gone as dead", () => {
		expect(belongsToDeadProcess(foreign(999_999), self, gone)).toBe(true);
	});

	it("reads an id from a process that is still there as alive", () => {
		expect(belongsToDeadProcess(foreign(999_999), self, here)).toBe(false);
	});

	it("never calls this process dead, whatever slice wrote the id", () => {
		// The inline runner's id is a slice of its own with the same pid and nonce.
		expect(belongsToDeadProcess(createWorkerId("test"), self, gone)).toBe(
			false,
		);
		expect(
			belongsToDeadProcess(createWorkerId("test-inline"), self, gone),
		).toBe(false);
	});

	it("tells an earlier boot that had this pid from this boot", () => {
		// Same pid, a different boot nonce: the earlier process of that number is
		// gone. Whether the pid is alive is the process table's answer (it is: it
		// is us), and the conservative reading of a live pid is a live worker.
		expect(belongsToDeadProcess(foreign(process.pid), self, here)).toBe(false);
		expect(belongsToDeadProcess(foreign(process.pid), self, gone)).toBe(true);
	});

	it("leaves another host's ids alone: its process table is not ours to read", () => {
		expect(
			belongsToDeadProcess("test:another-box:999999:old-boot", self, gone),
		).toBe(false);
	});

	it("leaves an id in an older format to the stale window", () => {
		expect(belongsToDeadProcess("test:999999:some-uuid", self, gone)).toBe(
			false,
		);
		expect(belongsToDeadProcess("worker-a", self, gone)).toBe(false);
		expect(belongsToDeadProcess("", self, gone)).toBe(false);
		expect(belongsToDeadProcess(null, self, gone)).toBe(false);
	});

	it("says nothing when it does not know who it is", () => {
		expect(belongsToDeadProcess(foreign(999_999), null, gone)).toBe(false);
	});

	it("asks the real process table by default, where EPERM means alive", () => {
		expect(belongsToDeadProcess(foreign(1), self)).toBe(false);
		expect(belongsToDeadProcess(foreign(4_194_305), self)).toBe(true);
	});
});
