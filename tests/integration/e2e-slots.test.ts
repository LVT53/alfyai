import { describe, expect, it } from "vitest";
import {
	DEFAULT_BUILD_WORKERS,
	e2eBaseUrl,
	e2eDatabasePath,
	e2ePort,
	e2eReusesServers,
	e2eServerMode,
	e2eSlot,
	e2eWorkerCount,
} from "../e2e/e2e-env";

describe("the e2e run's slots", () => {
	it("gives each slot its own port, counting up from E2E_PORT", () => {
		const env = { E2E_PORT: "5450" };
		expect([0, 1, 2, 7].map((slot) => e2ePort(slot, env))).toEqual([
			5450, 5451, 5452, 5457,
		]);
		expect(e2eBaseUrl(3, env)).toBe("http://127.0.0.1:5453");
		expect(e2eBaseUrl(0, {})).toBe("http://127.0.0.1:5175");
	});

	it("gives each slot its own database file, slot 0 keeping the established path", () => {
		const cwd = "/repo";
		expect(e2eDatabasePath(0, {}, cwd)).toBe(
			"/repo/data/playwright-e2e-chat.db",
		);
		expect(e2eDatabasePath(2, {}, cwd)).toBe(
			"/repo/data/playwright-e2e-chat-w2.db",
		);
		const custom = { E2E_DATABASE_PATH: "/tmp/run/e2e.sqlite" };
		expect(e2eDatabasePath(0, custom, cwd)).toBe("/tmp/run/e2e.sqlite");
		expect(e2eDatabasePath(3, custom, cwd)).toBe("/tmp/run/e2e-w3.sqlite");
		// A name with no extension, and a dot in a directory name, still keep slots apart.
		expect(e2eDatabasePath(1, { E2E_DATABASE_PATH: "/tmp/a.b/e2e" }, cwd)).toBe(
			"/tmp/a.b/e2e-w1",
		);
	});

	it("never gives two slots the same file or port", () => {
		const slots = [0, 1, 2, 3, 4, 5, 6, 7];
		const env = { E2E_PORT: "5450" };
		expect(new Set(slots.map((slot) => e2eDatabasePath(slot, env))).size).toBe(
			slots.length,
		);
		expect(new Set(slots.map((slot) => e2ePort(slot, env))).size).toBe(
			slots.length,
		);
	});

	it("reads the slot from Playwright's stable parallel index, and is slot 0 in the runner", () => {
		expect(e2eSlot({ TEST_PARALLEL_INDEX: "4" })).toBe(4);
		expect(e2eSlot({})).toBe(0);
		expect(e2eSlot({ TEST_PARALLEL_INDEX: "" })).toBe(0);
		expect(e2eSlot({ TEST_PARALLEL_INDEX: "nope" })).toBe(0);
		// The worker index changes when a worker is replaced; only the parallel index names a slot.
		expect(e2eSlot({ TEST_WORKER_INDEX: "9", TEST_PARALLEL_INDEX: "1" })).toBe(
			1,
		);
	});
});

describe("the e2e server mode and worker count", () => {
	it("runs the production build unless asked for vite dev", () => {
		expect(e2eServerMode({})).toBe("build");
		expect(e2eServerMode({ E2E_SERVER: "dev" })).toBe("dev");
		expect(e2eServerMode({ E2E_SERVER: " BUILD " })).toBe("build");
		expect(() => e2eServerMode({ E2E_SERVER: "preview" })).toThrow(
			/E2E_SERVER/,
		);
	});

	it("takes E2E_WORKERS when it is a whole number, and says so when it is not", () => {
		expect(e2eWorkerCount({ E2E_WORKERS: "3" })).toBe(3);
		expect(e2eWorkerCount({ E2E_WORKERS: "1" })).toBe(1);
		for (const bad of ["0", "-2", "2.5", "many"]) {
			expect(() => e2eWorkerCount({ E2E_WORKERS: bad })).toThrow(/E2E_WORKERS/);
		}
	});

	it("defaults to several workers on the build and one on vite dev", () => {
		expect(e2eWorkerCount({})).toBe(DEFAULT_BUILD_WORKERS);
		expect(DEFAULT_BUILD_WORKERS).toBeGreaterThan(1);
		expect(e2eWorkerCount({ E2E_SERVER: "dev" })).toBe(1);
		expect(e2eWorkerCount({ E2E_SERVER: "dev", E2E_WORKERS: "2" })).toBe(2);
		expect(e2eWorkerCount({ E2E_WORKERS: "" })).toBe(DEFAULT_BUILD_WORKERS);
	});

	it("reuses a listening server only when told to", () => {
		expect(e2eReusesServers({})).toBe(false);
		expect(e2eReusesServers({ PLAYWRIGHT_REUSE_EXISTING_SERVER: "true" })).toBe(
			true,
		);
		expect(e2eReusesServers({ PLAYWRIGHT_REUSE_EXISTING_SERVER: "1" })).toBe(
			false,
		);
	});
});
