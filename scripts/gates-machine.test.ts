import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import * as machine from "./gates-machine.mjs";

test("reads swap usage and keeps missing measurements unknown", () => {
	expect(
		machine.parseSwapUsedMb(
			"total = 2048.00M  used = 1234.50M  free = 813.50M",
		),
	).toBe(1234.5);
	expect(machine.parseSwapUsedMb("used = 0.00M")).toBe(0);
	expect(machine.parseSwapUsedMb("unavailable")).toBeNull();
});

test("excludes the gate's own descendants and MCP", () => {
	const ps = [
		"100 1 node gates.mjs",
		"101 100 npm exec vitest",
		"102 101 node vitest/vitest.mjs",
		"200 1 node /x/node_modules/.bin/playwright test",
		"300 1 npm exec @playwright/mcp",
		"301 300 node playwright-mcp",
		"302 1 /bin/zsh -lc cat example-vitest.log",
		"303 1 node /tmp/probe.mjs --discuss-vitest",
		"400 399 node /work/node_modules/vitest/dist/workers/forks.js",
	].join("\n");
	expect(machine.otherTestRuns(ps, 100)).toEqual([
		{ pid: 200, command: "node /x/node_modules/.bin/playwright test" },
		{
			pid: 400,
			command: "node /work/node_modules/vitest/dist/workers/forks.js",
		},
	]);
});

test("uses the final sample to reject a throttled release measurement", () => {
	let now = 0;
	const sampler = machine.startMachineSampler({
		now: () => now,
		probe: () => ({
			swapMb: 0,
			freeMb: 1000 - now / 10,
			priority: now ? 4 : 31,
			others: [],
		}),
	});
	now = 5000;
	const report = sampler.stop();
	expect(report).toMatchObject({
		samples: 2,
		priorityLowest: 4,
		clampedMs: 5000,
		freeLowMb: 500,
	});
	expect(machine.measuredVerdict(report, { held: true }).counts).toBe(false);
});

test("does not qualify a run when a probe is unavailable", () => {
	const report = machine
		.startMachineSampler({
			probe: () => ({
				swapMb: null,
				freeMb: 1000,
				priority: null,
				others: null,
			}),
		})
		.stop();
	expect(machine.measuredVerdict(report, { held: true }).counts).toBe(false);
});
