import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock, RUN_LOCK_PATH, readRunLock } from "../e2e/run-lock";

describe("the e2e run lock", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const root = () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-lock-"));
		roots.push(dir);
		return dir;
	};

	it("is taken by the first run and gone when it releases", () => {
		const dir = root();
		const release = acquireRunLock([5450, 5451], dir, process.pid);
		expect(readRunLock(dir)).toMatchObject({
			pid: process.pid,
			ports: [5450, 5451],
		});
		release();
		expect(existsSync(join(dir, RUN_LOCK_PATH))).toBe(false);
		// Releasing twice is harmless.
		release();
	});

	it("refuses a second run while the first process is alive, and says who has it", () => {
		const dir = root();
		acquireRunLock([5450], dir, process.pid);
		// Another process id that is certainly alive: our parent.
		expect(() => acquireRunLock([5460], dir, process.ppid)).toThrow(
			new RegExp(`process ${process.pid}, ports 5450`),
		);
	});

	it("takes over a lock whose process is gone", () => {
		const dir = root();
		// A pid far above what a machine hands out cannot be alive: the run that held it was killed.
		acquireRunLock([5450], dir, 2_000_000_000);
		expect(readRunLock(dir)?.pid).toBe(2_000_000_000);
		const release = acquireRunLock([5470], dir, process.pid);
		expect(readRunLock(dir)).toMatchObject({
			pid: process.pid,
			ports: [5470],
		});
		release();
	});

	it("does not remove a lock that another run has since taken", () => {
		const dir = root();
		const release = acquireRunLock([5450], dir, process.pid);
		writeFileSync(
			join(dir, RUN_LOCK_PATH),
			JSON.stringify({ pid: 2_000_000_001, ports: [1], since: "x" }),
		);
		release();
		expect(readRunLock(dir)?.pid).toBe(2_000_000_001);
	});
});
