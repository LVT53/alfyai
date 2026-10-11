import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareFallow,
	defineSteps,
	parseArgs,
	parseBuildLog,
	parseCheckLog,
	parseChunksLog,
	parseVitestLog,
	readPlaywrightReport,
	// @ts-expect-error — plain .mjs script, no type declarations
} from "./gates.mjs";

// The gate runner prints one line per step from the step's own log. These tests
// hold the readers to the logs the steps really write (the M3 gate logs, the
// chunk check on this branch), because a reader that stops understanding its log
// turns a gate green by saying nothing.

describe("the check step", () => {
	it("reads svelte-check's closing line, and fails on errors but not warnings", () => {
		expect(
			parseCheckLog(
				"1791378848811 COMPLETED 8411 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS\n",
			),
		).toEqual({ ok: true, text: "0 errors, 17 warnings in 8411 files" });
		expect(
			parseCheckLog(
				"COMPLETED 8411 FILES 2 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS",
			).ok,
		).toBe(false);
	});

	it("fails, with the log's last line, when it never got that far", () => {
		const result = parseCheckLog("Error: cannot find tsconfig\n");
		expect(result.ok).toBe(false);
		expect(result.text).toContain("cannot find tsconfig");
	});
});

describe("the vitest step", () => {
	const PASSED = `
 Test Files  1035 passed | 1 skipped (1036)
      Tests  17408 passed | 2 skipped (17410)
   Start at  14:14:10
   Duration  125.74s (transform 67.04s, setup 45.93s, import 499.07s, tests 450.08s, environment 497.81s)
`;

	it("reads the files and tests lines", () => {
		const result = parseVitestLog(PASSED);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("1035 passed");
		expect(result.text).toContain("17408 passed");
	});

	it("fails when any test or file failed, whatever the exit code said", () => {
		expect(
			parseVitestLog(
				" Test Files  2 failed | 1033 passed (1035)\n      Tests  3 failed | 17405 passed (17408)\n",
			).ok,
		).toBe(false);
	});

	it("fails when there is no summary at all (a crash before the run)", () => {
		expect(parseVitestLog("Error: spawn ENOENT").ok).toBe(false);
	});
});

describe("the build step", () => {
	const lines = (css: number, aria: number) =>
		[
			...Array(css).fill('WARNING "x.svelte" Unused CSS selector ".a"'),
			...Array(aria).fill("a11y: <div> must have an ARIA role"),
		].join("\n");

	it("passes at the known warning counts and says they are the baseline", () => {
		const result = parseBuildLog(lines(32, 2));
		expect(result.ok).toBe(true);
		expect(result.text).toBe("unused-css=32 aria=2 (baseline 32/2)");
	});

	it("fails on one more of either, naming it", () => {
		expect(parseBuildLog(lines(33, 2))).toMatchObject({ ok: false });
		expect(parseBuildLog(lines(33, 2)).text).toContain("NEW BUILD WARNINGS");
		expect(parseBuildLog(lines(32, 3)).ok).toBe(false);
		expect(parseBuildLog(lines(10, 0)).ok).toBe(true);
	});
});

describe("the chunks step", () => {
	const OK = `[artifact-chunks] CanvasEditor: _app/immutable/chunks/BGz8QRPi.js — 210.3 kB raw, 62.8 kB gzip; loads 12 chunk(s) of its own (229.6 kB raw, 70.9 kB gzip) and 31 shared
[artifact-chunks]   @xyflow: _app/immutable/chunks/BGz8QRPi.js
[artifact-chunks] chat route /(app)/chat/[conversationId]: 79 chunk(s), 543846 bytes gzip (information only, no budget)
[artifact-chunks]   chart.js: _app/immutable/chunks/COf3xiL22.js`;

	it("reports the editor's closure and the chat route's size, which is information", () => {
		const result = parseChunksLog(OK);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("editor closure 70.9 kB gzip");
		expect(result.text).toContain(
			"chat route first paint 543846 B gzip in 79 chunks",
		);
		expect(result.text).toContain("information only");
	});

	it("fails on any FAIL line and prints it", () => {
		const result = parseChunksLog(
			`${OK}\n[artifact-chunks] FAIL (chat-route) chart.js is in x.js, which the chat route loads statically`,
		);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("FAIL (chat-route) chart.js is in x.js");
	});

	it("fails when the check printed none of its numbers (no manifest, a crash)", () => {
		expect(
			parseChunksLog(
				"[artifact-chunks] No build manifest at x — run `npm run build` first.",
			).ok,
		).toBe(false);
	});
});

describe("the Fallow comparison", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function files(baseline: unknown, current: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "gates-fallow-"));
		dirs.push(dir);
		const baselinePath = join(dir, "baseline.json");
		const currentPath = join(dir, "current.json");
		writeFileSync(baselinePath, JSON.stringify({ check: baseline }));
		writeFileSync(currentPath, JSON.stringify({ check: current }));
		return { baselinePath, currentPath };
	}
	const unused = (path: string, name: string, line: number) => ({
		path,
		export_name: name,
		line,
		col: 3,
	});
	const cycle = (a: string) => ({ files: [a, "b.ts"] });

	it("passes when only a finding's position moved", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				unused_exports: [unused("a.ts", "x", 10)],
				circular_dependencies: [],
			},
			{
				total_issues: 1,
				unused_exports: [unused("a.ts", "x", 42)],
				circular_dependencies: [],
			},
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("new_vs_baseline=0");
	});

	it("fails on a finding the baseline did not have, and names it", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				unused_exports: [unused("a.ts", "x", 1)],
				circular_dependencies: [],
			},
			{
				total_issues: 2,
				unused_exports: [unused("a.ts", "x", 1), unused("new.ts", "fresh", 5)],
				circular_dependencies: [],
			},
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("new_vs_baseline=1");
		expect(result.text).toContain("fresh");
	});

	it("counts what is gone, and does not fail for it", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				unused_exports: [unused("a.ts", "x", 1)],
				circular_dependencies: [],
			},
			{ total_issues: 0, unused_exports: [], circular_dependencies: [] },
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("gone_vs_baseline=1");
	});

	it("fails on a fifth circular dependency even if it is the same list shape", () => {
		const four = ["a", "c", "d", "e"].map(cycle);
		const { baselinePath, currentPath } = files(
			{ total_issues: 4, circular_dependencies: four },
			{ total_issues: 5, circular_dependencies: [...four, cycle("z")] },
		);
		expect(compareFallow(currentPath, baselinePath).ok).toBe(false);
	});

	it("says so when there is no report or no baseline", () => {
		const { baselinePath, currentPath } = files({}, {});
		expect(compareFallow("/nonexistent/fallow.json", baselinePath).ok).toBe(
			false,
		);
		expect(
			compareFallow(currentPath, "/nonexistent/baseline.json").text,
		).toContain("no Fallow baseline");
	});
});

describe("the Playwright report", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});
	function report(body: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "gates-pw-"));
		dirs.push(dir);
		const path = join(dir, "report.json");
		writeFileSync(path, JSON.stringify(body));
		return path;
	}

	it("counts passed, skipped, failed and flaky, and passes only when none failed or flaked", () => {
		const green = readPlaywrightReport(
			report({
				stats: { expected: 686, skipped: 23, unexpected: 0, flaky: 0 },
				suites: [],
			}),
		);
		expect(green).toEqual({
			ok: true,
			text: "686 passed, 23 skipped, 0 failed, 0 flaky",
		});
		expect(
			readPlaywrightReport(
				report({
					stats: { expected: 685, skipped: 23, unexpected: 0, flaky: 1 },
					suites: [],
				}),
			).ok,
		).toBe(false);
	});

	it("says how many workers the run used, when the report knows", () => {
		const result = readPlaywrightReport(
			report({
				config: { projects: [{ metadata: { actualWorkers: 6 } }] },
				stats: { expected: 965, skipped: 60, unexpected: 0, flaky: 0 },
				suites: [],
			}),
		);
		expect(result.text).toBe(
			"965 passed, 60 skipped, 0 failed, 0 flaky on 6 workers",
		);
	});

	it("names each failed test with its file and line", () => {
		const result = readPlaywrightReport(
			report({
				stats: { expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
				suites: [
					{
						file: "chat.spec.ts",
						suites: [
							{
								specs: [{ ok: false, line: 34, title: "sends a message" }],
							},
						],
					},
				],
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("FAILED chat.spec.ts:34 sends a message");
	});

	it("fails when no report was written", () => {
		expect(readPlaywrightReport("/nonexistent/report.json").ok).toBe(false);
	});
});

// The build goes first. `npm run check` and vitest sync `.svelte-kit/` (the SvelteKit
// plugin does it at start-up); started beside `vite build` they leave an app that
// builds, passes its chunk check, and does not hydrate, and the e2e run that follows
// fails every test on a 15-second timeout. Measured on this branch: check and build
// started together broke the build; check started after it did not.
describe("the schedule", () => {
	const options = (schedule: string) => ({
		mode: "release",
		outDir: "/tmp/gates-test",
		workers: undefined,
		port: undefined,
		skip: new Set(),
		fallowBaseline: "/tmp/none.json",
		schedule,
		specs: [],
	});

	for (const schedule of ["phased", "overlap"]) {
		describe(`(${schedule})`, () => {
			const steps = defineSteps(options(schedule));

			it.each([
				"check",
				"vitest",
			])("%s waits for the build: it syncs .svelte-kit/, which the build reads", (name) => {
				expect(steps[name].after).toContain("build");
			});

			it("lets the end-to-end run wait for the build it serves", () => {
				expect(steps.playwright.after).toContain("build");
			});

			it.each([
				"biome",
				"migrations",
				"fallow",
			])("starts %s with the build: it never touches .svelte-kit/", (name) => {
				expect(steps[name].after ?? []).toEqual([]);
			});
		});
	}
});

// Release hides vitest behind the e2e run (8.5 minutes in three green runs against 10.7 phased);
// an agent's run is a few spec files that finish in a minute, so vitest on three threads would be
// its longest step (7 minutes against 2.5): there the static gates go first.
describe("the default schedule", () => {
	it("is overlap for the release gate and phased for an agent's run", () => {
		expect(parseArgs(["release", "/tmp/gates-test"]).schedule).toBe("overlap");
		expect(parseArgs(["agent", "/tmp/gates-test"]).schedule).toBe("phased");
	});

	it("is whatever --schedule says", () => {
		expect(
			parseArgs(["release", "/tmp/gates-test", "--schedule", "phased"])
				.schedule,
		).toBe("phased");
		expect(
			parseArgs(["agent", "/tmp/gates-test", "--schedule", "overlap"]).schedule,
		).toBe("overlap");
	});
});
