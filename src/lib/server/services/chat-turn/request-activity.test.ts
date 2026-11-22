import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-foreground");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
it("tracks overlapping foreground work across database connections and releases on finish", async () => {
	const config = await import("$lib/server/config-store");
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightAdmissionKey: "synthetic-private",
		hindsightOvernightIdle: true,
	});
	const { beginForegroundRequest, readForegroundActivity } = await import(
		"./request-activity"
	);
	const releaseA = beginForegroundRequest();
	const releaseB = beginForegroundRequest();
	expect(readForegroundActivity()).toMatchObject({
		idle: true,
		active: true,
		healthy: true,
	});
	const second = await h.bootSecondProcess();
	expect(
		second.sqlite
			.prepare("SELECT count(*) AS n FROM memory_foreground_leases")
			.get(),
	).toMatchObject({ n: 2 });
	releaseA();
	expect(readForegroundActivity().active).toBe(true);
	releaseB();
	releaseB();
	expect(readForegroundActivity().active).toBe(false);
});
it("does not stop chat when auxiliary tracking fails and reports unhealthy", async () => {
	const config = await import("$lib/server/config-store");
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightAdmissionKey: "synthetic-private",
		hindsightOvernightIdle: true,
	});
	const { db } = await import("$lib/server/db");
	vi.spyOn(db, "insert").mockImplementation(() => {
		throw new Error("synthetic write outage");
	});
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { beginForegroundRequest, readForegroundActivity } = await import(
		"./request-activity"
	);
	let finish = () => {};
	expect(() => {
		finish = beginForegroundRequest();
	}).not.toThrow();
	expect(readForegroundActivity()).toMatchObject({
		healthy: false,
		active: true,
	});
	finish();
	expect(warning).toHaveBeenCalledWith(
		"[MEMORY] Foreground activity tracking unavailable; using conservative admission",
	);
});

it("reports activity under a separate SQLite writer and bounds a failed lease write", async () => {
	const config = await import("$lib/server/config-store");
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightAdmissionKey: "synthetic-private",
		hindsightOvernightIdle: true,
	});
	const { beginForegroundRequest, readForegroundActivity } = await import(
		"./request-activity"
	);
	const finish = beginForegroundRequest();
	const second = await h.bootSecondProcess();
	// Keep the red test short while proving that the normal write budget is restored.
	h.sqlite.pragma("busy_timeout = 400");
	second.sqlite.exec("BEGIN IMMEDIATE");
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		let start = performance.now();
		expect(readForegroundActivity()).toMatchObject({
			active: true,
			healthy: true,
		});
		expect(performance.now() - start).toBeLessThan(100);
		start = performance.now();
		const failedFinish = beginForegroundRequest();
		expect(performance.now() - start).toBeLessThan(100);
		expect(readForegroundActivity()).toMatchObject({
			active: true,
			healthy: false,
		});
		expect(h.sqlite.pragma("busy_timeout", { simple: true })).toBe(400);
		failedFinish();
	} finally {
		second.sqlite.exec("ROLLBACK");
		finish();
		warning.mockRestore();
	}
});
