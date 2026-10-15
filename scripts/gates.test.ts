import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareFallow,
	defineSteps,
	exactFallowVersion,
	fallowVersion,
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
	it("reads svelte-check's closing line and passes a clean one", () => {
		expect(
			parseCheckLog(
				"1791378848811 COMPLETED 8411 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS\n",
			),
		).toEqual({ ok: true, text: "0 errors, 0 warnings in 8411 files" });
	});

	it("fails on a single warning, naming it (svelte-check itself exits 0 on warnings)", () => {
		const result = parseCheckLog(
			"COMPLETED 8411 FILES 0 ERRORS 1 WARNINGS 1 FILES_WITH_PROBLEMS",
		);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("0 errors, 1 warnings in 8411 files");
		expect(result.text).toContain("NEW CHECK WARNINGS");
	});

	it("fails on errors, and on the 17 warnings it once let through", () => {
		expect(
			parseCheckLog(
				"COMPLETED 8411 FILES 2 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS",
			).ok,
		).toBe(false);
		expect(
			parseCheckLog(
				"COMPLETED 8411 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS",
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

	it("passes on a build with no warning and says the baseline is none", () => {
		const result = parseBuildLog(lines(0, 0));
		expect(result.ok).toBe(true);
		expect(result.text).toBe("unused-css=0 aria=0 (baseline 0/0)");
	});

	it("fails on a single warning of either kind, naming it", () => {
		expect(parseBuildLog(lines(1, 0))).toMatchObject({ ok: false });
		expect(parseBuildLog(lines(1, 0)).text).toContain("NEW BUILD WARNINGS");
		expect(parseBuildLog(lines(0, 1)).ok).toBe(false);
	});

	it("no longer lets through the 32 and 2 it was once held at", () => {
		expect(parseBuildLog(lines(32, 2)).ok).toBe(false);
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

// A bare `npx fallow` runs what node_modules holds, and where that is nothing (a fresh
// checkout, CI) npx fetches the latest release, which reports differently from the baseline's.
// So the step names the release package.json pins, and says where the report goes: stdout,
// because Fallow 3 refuses `--output-file` outside the project root and the system temp dir.
describe("the Fallow step", () => {
	const options = {
		mode: "release",
		outDir: "/somewhere/outside/the/repo",
		workers: undefined,
		port: undefined,
		skip: new Set(),
		fallowBaseline: "/tmp/none.json",
		schedule: "overlap",
		specs: [],
	};
	const pinned = JSON.parse(
		readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
	).devDependencies.fallow;

	it("runs exactly the release package.json pins, installed or not", () => {
		expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
		expect(fallowVersion()).toBe(pinned);
		const { cmd } = defineSteps(options).fallow;
		expect(cmd.slice(0, 3)).toEqual(["npx", "-y", `fallow@${pinned}`]);
	});

	it("takes the report from stdout, so the out-dir can be anywhere", () => {
		const step = defineSteps(options).fallow;
		expect(step.cmd).not.toContain("--output-file");
		expect(step.stdout).toBe("/somewhere/outside/the/repo/fallow.json");
	});

	it("refuses a range, a tag or nothing as the pin", () => {
		expect(exactFallowVersion("3.33.1")).toBe("3.33.1");
		expect(exactFallowVersion("3.34.0-beta.1")).toBe("3.34.0-beta.1");
		for (const spec of [
			"^3.33.1",
			"~3.33.1",
			">=3.33",
			"latest",
			"3",
			"",
			undefined,
		]) {
			expect(() => exactFallowVersion(spec)).toThrow(/exact version/);
		}
	});
});

describe("the Fallow comparison", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	// `extra` is the rest of the report beside its `check` section (health, dupes, version).
	function files(baseline: unknown, current: unknown, extra: object = {}) {
		const dir = mkdtempSync(join(tmpdir(), "gates-fallow-"));
		dirs.push(dir);
		const baselinePath = join(dir, "baseline.json");
		const currentPath = join(dir, "current.json");
		writeFileSync(baselinePath, JSON.stringify({ check: baseline }));
		writeFileSync(currentPath, JSON.stringify({ check: current, ...extra }));
		return { baselinePath, currentPath };
	}
	const unused = (path: string, name: string, line: number) => ({
		path,
		export_name: name,
		line,
		col: 3,
	});
	// A finding the way Fallow 3.33 writes it: the same kind, path and name as 2.x, and an id,
	// advice, a severity and (when an import was unresolved in that run) a reachability note.
	const unused3 = (path: string, name: string, line: number) => ({
		path,
		export_name: name,
		is_type_only: false,
		is_re_export: false,
		line,
		col: 1,
		span_start: line * 40,
		finding_id: `dc1:unused-export:${path}:${line}`,
		actions: [
			{
				type: "remove-export",
				auto_fixable: true,
				description: "Remove the unused export from the public API",
			},
			{
				type: "suppress-line",
				auto_fixable: false,
				description: "Suppress with an inline comment above the line",
				comment: `// fallow-ignore-next-line unused-export ${line}`,
			},
		],
		effective_severity: line > 100 ? "warn" : "error",
		...(line > 100
			? { reachability_caveats: ["incomplete-import-graph"] }
			: {}),
	});
	const cycle = (a: string) => ({ files: [a, "b.ts"] });
	// What a 3.x report carries beside `check` that the summary line shows.
	const SCORED = {
		version: "3.33.1",
		health: {
			health_score: { score: 85.1, grade: "A" },
			vital_signs: { total_loc: 1023784 },
		},
		dupes: { stats: { duplication_percentage: 4.383930057744735 } },
	};
	const clean = { total_issues: 0, circular_dependencies: [] };

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

	it("passes when a Fallow 3 finding moved: its position, id, advice and severity are not its identity", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				unused_exports: [unused3("a.ts", "x", 10)],
				circular_dependencies: [],
			},
			{
				total_issues: 1,
				unused_exports: [unused3("a.ts", "x", 142)],
				circular_dependencies: [],
			},
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("new_vs_baseline=0 gone_vs_baseline=0");
	});

	it("passes a Fallow 3 finding against a 2.96 baseline that holds the same kind, path and name", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				// Fallow 2.96's shape: no id and no severity, and advice worded its own way
				unused_exports: [
					{
						path: "a.ts",
						export_name: "x",
						is_type_only: false,
						line: 3,
						col: 1,
						span_start: 120,
						is_re_export: false,
						actions: [
							{ type: "remove-export", description: "Remove the export" },
						],
					},
				],
				circular_dependencies: [],
			},
			{
				total_issues: 1,
				unused_exports: [unused3("a.ts", "x", 3)],
				circular_dependencies: [],
			},
		);
		expect(compareFallow(currentPath, baselinePath).ok).toBe(true);
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

	it("names a new Fallow 3 finding by its path and name, not by what Fallow wrote around it", () => {
		const { baselinePath, currentPath } = files(
			{
				total_issues: 1,
				unused_exports: [unused3("a.ts", "x", 1)],
				circular_dependencies: [],
			},
			{
				total_issues: 2,
				unused_exports: [
					unused3("a.ts", "x", 1),
					unused3("new.ts", "fresh", 5),
				],
				circular_dependencies: [],
			},
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("new_vs_baseline=1");
		expect(result.text).toContain('"export_name":"fresh"');
		expect(result.text).toContain('"path":"new.ts"');
		expect(result.text).not.toContain("finding_id");
		expect(result.text).not.toContain("suppress-line");
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

	it("says what Fallow said when its stdout is an error and not a report", () => {
		const { baselinePath, currentPath } = files({}, {});
		writeFileSync(
			currentPath,
			JSON.stringify({
				error: true,
				message: "the path is outside the project root",
				exit_code: 2,
			}),
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(false);
		expect(result.text).toBe(
			"Fallow failed: the path is outside the project root",
		);
		writeFileSync(currentPath, JSON.stringify({ kind: "combined" }));
		expect(compareFallow(currentPath, baselinePath)).toEqual({
			ok: false,
			text: "the Fallow report has no check section",
		});
	});

	it("shows the health score and grade, duplication and size, as information", () => {
		const { baselinePath, currentPath } = files(clean, clean, SCORED);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(true);
		expect(result.text).toBe(
			"total=0 circular=0 new_vs_baseline=0 gone_vs_baseline=0; fallow 3.33.1: health 85.1 (A), duplication 4.4%, 1,023,784 LOC (information only)",
		);
	});

	it("never judges by them: a failing score, heavy duplication and a huge tree still pass", () => {
		const { baselinePath, currentPath } = files(clean, clean, {
			version: "3.33.1",
			health: {
				health_score: { score: 3, grade: "F" },
				vital_signs: { total_loc: 9_000_000_000 },
			},
			dupes: { stats: { duplication_percentage: 99.94 } },
		});
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("health 3.0 (F), duplication 99.9%");
	});

	it("leaves out what the report does not carry", () => {
		const bare = files(clean, clean);
		expect(compareFallow(bare.currentPath, bare.baselinePath).text).toBe(
			"total=0 circular=0 new_vs_baseline=0 gone_vs_baseline=0",
		);
		const partial = files(clean, clean, {
			version: "3.33.1",
			dupes: { stats: { duplication_percentage: 2 } },
			health: { health_score: null, vital_signs: {} },
		});
		expect(compareFallow(partial.currentPath, partial.baselinePath).text).toBe(
			"total=0 circular=0 new_vs_baseline=0 gone_vs_baseline=0; fallow 3.33.1: duplication 2.0% (information only)",
		);
	});

	it("keeps the information on a failing line too, after the count and before the names", () => {
		const { baselinePath, currentPath } = files(
			clean,
			{
				total_issues: 1,
				unused_exports: [unused3("new.ts", "fresh", 5)],
				circular_dependencies: [],
			},
			SCORED,
		);
		const result = compareFallow(currentPath, baselinePath);
		expect(result.ok).toBe(false);
		const [first, second] = result.text.split("\n");
		expect(first).toContain("new_vs_baseline=1");
		expect(first).toContain("health 85.1 (A)");
		expect(second).toContain("NEW unused_exports");
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

// The baseline is a file in the repo, made by the release package.json pins. One made by another
// release is the comparison the gate used to get wrong (a 2.96 baseline against a 3.x report), so
// bumping Fallow and making the baseline again are one change, and this is what says so.
describe("the committed Fallow baseline", () => {
	const baselinePath = join(
		import.meta.dirname,
		"..",
		".fallow",
		"baseline.json",
	);

	it("is what the gate compares with unless told otherwise", () => {
		expect(parseArgs(["agent", "/tmp/gates-test"]).fallowBaseline).toBe(
			baselinePath,
		);
		expect(
			parseArgs(["agent", "/tmp/gates-test", "--fallow-baseline", "/x.json"])
				.fallowBaseline,
		).toBe("/x.json");
	});

	it("holds only the check section, made by the release package.json pins", () => {
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
		expect(Object.keys(baseline)).toEqual(["check"]);
		expect(
			baseline.check.version,
			"the baseline was made by another Fallow release than package.json pins: make it again (AGENTS.md, Fallow Audit Gate)",
		).toBe(fallowVersion());
	});

	it("is a baseline the comparison can read, and the tree it describes passes against it", () => {
		const result = compareFallow(baselinePath, baselinePath);
		expect(result.text).toContain("new_vs_baseline=0 gone_vs_baseline=0");
		expect(result.ok).toBe(true);
	});
});
