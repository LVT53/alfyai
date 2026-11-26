// @always-run: reads the committed Fallow baseline and Playwright spec inventory.
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	parsePythonLog,
	parseVitestLog,
	readPlaywrightReport,
	runSteps,
	summarise,
	// @ts-expect-error — plain .mjs script, no type declarations
} from "./gates.mjs";

// The gate runner prints one line per step from the step's own log. These tests
// hold the readers to the logs the steps really write (the M3 gate logs, the
// chunk check on this branch), because a reader that stops understanding its log
// turns a gate green by saying nothing.

// What a gate run is made from, as parseArgs makes it.
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

describe("the check step", () => {
	it("requests machine output to match the strict svelte-check log parser", () => {
		expect(defineSteps(options).check.cmd).toEqual([
			"npm",
			"run",
			"check",
			"--",
			"--output",
			"machine",
		]);
	});

	it("reads svelte-check's closing line and passes a clean one", () => {
		expect(
			parseCheckLog(
				"1791378848811 COMPLETED 8411 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS\n",
			),
		).toEqual({ ok: true, text: "0 errors, 0 warnings in 8411 files" });
	});

	it("reads svelte-check 4.x's closing line too", () => {
		expect(
			parseCheckLog("svelte-check found 0 errors and 0 warnings\n"),
		).toEqual({
			ok: true,
			text: "0 errors, 0 warnings",
		});
		const warned = parseCheckLog("svelte-check found 0 errors and 1 warning\n");
		expect(warned.ok).toBe(false);
		expect(warned.text).toContain("0 errors, 1 warnings");
		expect(warned.text).toContain("NEW CHECK WARNINGS");
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
		expect(result.counts).toEqual({ files: 1036, tests: 17410 });
		expect(result.text).toContain("worker time: import 499s, environment 497s");
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

	// The analyse pass at the end of `npm run build` imports the server, which opens
	// DATABASE_PATH. On a fresh checkout ./data/ does not exist (the e2e setup makes it, after
	// the build) and the default path failed the step: "Cannot open database because the
	// directory does not exist". So the step opens a file in the out-dir, which the gate made.
	it("builds against a scratch database in the out-dir, so a checkout without data/ builds", () => {
		const { env } = defineSteps(options).build;
		expect(env.DATABASE_PATH).toBe(
			"/somewhere/outside/the/repo/build-analyse.db",
		);
	});
});

// What `npm run build` writes when it fails, as it really did for the failures a developer meets
// (Vite 8, whose Rolldown report follows `error during build:`), trimmed to the lines that matter,
// colour codes and all. The reason is in the FIRST lines of the report. The last line is a closing
// brace, a stack frame or Node's version, so the reader that shows a step's last line (`lastLine`)
// says nothing here, and a build that failed looked as innocent as `unused-css=0 aria=0`.
const ESC = "\u001b";
const BUILD_START = [
	"",
	"> alfyai@2.2.0 build",
	"> NODE_OPTIONS=--no-deprecation vite build && node scripts/patch-body-size-limit.mjs && npm run check:worker-assets",
	"",
	"vite v8.1.3 building ssr environment for production...",
];
const ROLLDOWN_STACK = [
	"    at aggregateBindingErrorsIntoJsError (file:///repo/node_modules/rolldown/dist/shared/error-BlQ0-ek7.mjs:48:18)",
	"    at unwrapBindingResult (file:///repo/node_modules/rolldown/dist/shared/error-BlQ0-ek7.mjs:18:128)",
	"    at async CAC.<anonymous> (file:///repo/node_modules/vite/dist/node/cli.js:777:3) {",
	"  errors: [Getter/Setter]",
	"}",
];
// `export const broken = ;` at the end of src/lib/model-context-defaults.ts
const BUILD_SYNTAX_ERROR = [
	...BUILD_START,
	`${ESC}[2Ktransforming...✓ 5356 modules transformed.`,
	"✗ Build failed in 4.09s",
	"error during build:",
	"Build failed with 1 error:",
	"",
	`${ESC}[31m[builtin:vite-transform] ${ESC}[0mUnexpected token`,
	`    ${ESC}[38;5;246m╭${ESC}[0m${ESC}[38;5;246m─${ESC}[0m${ESC}[38;5;246m[${ESC}[0m src/lib/model-context-defaults.ts:89:23 ${ESC}[38;5;246m]${ESC}[0m`,
	`    ${ESC}[38;5;246m│${ESC}[0m`,
	` ${ESC}[38;5;246m89 │${ESC}[0m export const broken = ;`,
	`${ESC}[38;5;240m   │${ESC}[0m                       ┬  `,
	`${ESC}[38;5;246m────╯${ESC}[0m`,
	"",
	...ROLLDOWN_STACK,
].join("\n");
// `<p>{#if}</p>` at the end of src/routes/+error.svelte: the path comes out absolute.
const REPO = join(import.meta.dirname, "..");
const BUILD_SVELTE_ERROR = [
	...BUILD_START,
	"transforming...✓ 5356 modules transformed.",
	"✗ Build failed in 3.98s",
	"error during build:",
	"Build failed with 1 error:",
	"",
	`[plugin vite-plugin-svelte:compile] ${REPO}/src/routes/+error.svelte:43:7`,
	`RolldownError: ${REPO}/src/routes/+error.svelte:43:7 Expected whitespace`,
	"https://svelte.dev/e/expected_whitespace",
	" 41 |    </div>",
	" 43 |  <p>{#if}</p>",
	"              ^",
	...ROLLDOWN_STACK,
].join("\n");
// The post-build analyse pass opening a DATABASE_PATH whose directory is missing: a Node process
// that dies, with no Vite report at all.
const BUILD_NODE_CRASH = [
	...BUILD_START,
	`${ESC}[2Ktransforming...✓ 5357 modules transformed.`,
	"rendering chunks...",
	"",
	"node:internal/event_target:1118",
	"  process.nextTick(() => { throw err; });",
	"                           ^",
	"TypeError: Cannot open database because the directory does not exist",
	"    at new Database (/repo/node_modules/better-sqlite3/lib/database.js:65:9)",
	"    at file:///repo/.svelte-kit/output/server/chunks/db.js:59:14",
	"    at async analyse (file:///repo/node_modules/@sveltejs/kit/src/core/postbuild/analyse.js:75:16)",
	"",
	"Node.js v22.23.3",
].join("\n");
// The second script of the build failing, after a listing of every chunk it made: some of them
// have "error" in their name.
const BUILD_LATE_FAILURE = [
	...BUILD_START,
	".svelte-kit/output/server/chunks/provider-model-route-errors.js     0.27 kB │ gzip:   0.18 kB",
	".svelte-kit/output/server/chunks/error-message.js                   0.61 kB │ gzip:   0.39 kB",
	".svelte-kit/output/server/entries/pages/_error.svelte.js            2.00 kB │ gzip:   0.80 kB",
	"✓ built in 11.58s",
	"",
	"> Using @sveltejs/adapter-node",
	"Circular dependency: node_modules/d3-interpolate/src/value.js -> node_modules/d3-interpolate/src/array.js -> node_modules/d3-interpolate/src/value.js",
	"  ✔ done",
	"[build] Failed to patch BODY_SIZE_LIMIT default: Error: ENOENT: no such file or directory, open '/repo/build/handler.js'",
	"    at async open (node:internal/fs/promises:639:25)",
	"    at async main (file:///repo/scripts/patch-body-size-limit.mjs:11:17) {",
	"  errno: -2,",
	"  code: 'ENOENT',",
	"}",
].join("\n");

// V8 out of memory, which a build on a machine busy with other gates can meet: it ends in native
// frames.
const BUILD_OUT_OF_MEMORY = [
	...BUILD_START,
	"",
	"<--- Last few GCs --->",
	"",
	"[75569:0x768340c000]       46 ms: Mark-Compact 20.2 (49.8) -> 19.5 (52.8) MB, pooled: 0 MB, 2.71 / 0.00 ms",
	"",
	"<--- JS stacktrace --->",
	"",
	"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
	"----- Native stack trace -----",
	"",
	" 1: 0x105ae56c8 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/opt/homebrew/Cellar/node@22/22.23.3_2/lib/libnode.127.dylib]",
	" 2: 0x10505dc50 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [/opt/homebrew/Cellar/node@22/22.23.3_2/lib/libnode.127.dylib]",
].join("\n");

describe("the build step, when the build failed", () => {
	it("gives the first lines of the build's own error report, where its reason is", () => {
		const result = parseBuildLog(BUILD_SYNTAX_ERROR, 1);
		expect(result.ok).toBe(false);
		expect(result.text).toBe(
			[
				"error during build:",
				"      Build failed with 1 error:",
				"      [builtin:vite-transform] Unexpected token",
				"      ╭─[ src/lib/model-context-defaults.ts:89:23 ]",
			].join("\n"),
		);
	});

	it("does not report the warning counts of a build that never finished", () => {
		const { text } = parseBuildLog(BUILD_SYNTAX_ERROR, 1);
		expect(text).not.toContain("unused-css");
		expect(text).not.toContain("aria=");
	});

	it("shows a path in the repo as a repo path", () => {
		const { text } = parseBuildLog(BUILD_SVELTE_ERROR, 1);
		expect(text).toBe(
			[
				"error during build:",
				"      Build failed with 1 error:",
				"      [plugin vite-plugin-svelte:compile] src/routes/+error.svelte:43:7",
				"      RolldownError: src/routes/+error.svelte:43:7 Expected whitespace",
			].join("\n"),
		);
		expect(text).not.toContain(REPO);
	});

	it("starts at the error of a Node process that died, not at Node's version line", () => {
		const { ok, text } = parseBuildLog(BUILD_NODE_CRASH, 1);
		expect(ok).toBe(false);
		expect(text).toBe(
			"TypeError: Cannot open database because the directory does not exist",
		);
	});

	it("gives the FATAL ERROR line of an out-of-memory crash, without its native frames", () => {
		expect(parseBuildLog(BUILD_OUT_OF_MEMORY, 134)).toEqual({
			ok: false,
			text: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
		});
	});

	it("is not led astray by chunk names with error in them in a long listing", () => {
		const { text } = parseBuildLog(BUILD_LATE_FAILURE, 1);
		expect(text).toBe(
			"[build] Failed to patch BODY_SIZE_LIMIT default: Error: ENOENT: no such file or directory, open '/repo/build/handler.js'",
		);
	});

	it("shows the last line of a log with no error report in it, as the other steps do", () => {
		const log =
			"> alfyai@2.2.0 check:worker-assets\n[worker-assets] No client build at /x/client — run `npm run build` first.\n";
		expect(parseBuildLog(log, 1)).toEqual({
			ok: false,
			text: "[worker-assets] No client build at /x/client — run `npm run build` first.",
		});
	});

	it("says there was no output when the command wrote none, as when it never started", () => {
		expect(parseBuildLog("", 127)).toEqual({ ok: false, text: "no output" });
	});

	it("cuts a line too long for the screen", () => {
		const { text } = parseBuildLog(
			`error during build:\n${"x".repeat(500)}`,
			1,
		);
		expect(text.split("\n").every((line: string) => line.length < 200)).toBe(
			true,
		);
	});

	it("still judges a build that exited 0 by its warnings, whether or not it is told the exit code", () => {
		const unusedCss = (count: number) =>
			Array(count)
				.fill('WARNING "x.svelte" Unused CSS selector ".a"')
				.join("\n");
		expect(parseBuildLog(unusedCss(0), 0).ok).toBe(true);
		expect(parseBuildLog(unusedCss(1), 0).ok).toBe(false);
		expect(parseBuildLog(unusedCss(0)).text).toBe(
			"unused-css=0 aria=0 (baseline 0/0)",
		);
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

// The admission queue's Python tests in deploy/hindsight, which need the standard library alone,
// run with plain python3: every test_admission_*.py file there. The other Python tests in that
// folder need the pinned Hindsight image (test_admission.py imports fastapi and the engine), so
// the pattern must leave them out.
describe("the python step", () => {
	it("runs the admission queue's tests with plain python3 and writes no bytecode", () => {
		const step = defineSteps(options).python;
		expect(step.cmd).toEqual([
			"python3",
			"-B",
			"-m",
			"unittest",
			"discover",
			"-v",
			"-s",
			"deploy/hindsight",
			"-t",
			"deploy/hindsight",
			"-p",
			"test_admission_*.py",
		]);
		expect(step.env).toEqual({ PYTHONDONTWRITEBYTECODE: "1" });
	});

	it("picks the files that need the standard library alone and not test_admission.py, which needs the image", () => {
		const { cmd } = defineSteps(options).python;
		const pattern: string = cmd[cmd.indexOf("-p") + 1];
		const glob = new RegExp(
			`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`,
		);
		const picked = readdirSync(
			join(import.meta.dirname, "..", "deploy", "hindsight"),
		).filter((name) => glob.test(name));
		expect(picked).toEqual(
			expect.arrayContaining([
				"test_admission_queue.py",
				"test_admission_acceptance.py",
			]),
		);
		expect(picked).not.toContain("test_admission.py");
	});
});

// What `python3 -m unittest discover -v` writes, as Python 3.15 wrote it on this Mac (stderr; the
// step's log keeps both streams).
const PYTHON_RULE = "-".repeat(70);
const pythonLog = (lines: string[], ran: string, verdict: string) =>
	[...lines, "", PYTHON_RULE, ran, "", verdict, ""].join("\n");
const PYTHON_PASSED = pythonLog(
	[
		"test_a_call_over_the_budget_waits_for_the_slot_instead_of_being_refused (test_admission_queue.WaitingTests.test_a_call_over_the_budget_waits_for_the_slot_instead_of_being_refused) ... ok",
		"test_twenty_four_calls_behind_a_busy_model_all_get_their_turn (test_admission_acceptance.HeldBusyTests.test_twenty_four_calls_behind_a_busy_model_all_get_their_turn) ... ok",
	],
	"Ran 34 tests in 1.074s",
	"OK",
);
const PYTHON_FAILED = pythonLog(
	[
		"test_boom (test_admission_queue.Queue.test_boom) ... ERROR",
		"test_fine (test_admission_queue.Queue.test_fine) ... ok",
		"test_order (test_admission_queue.Queue.test_order) ... FAIL",
		"",
		"=".repeat(70),
		"ERROR: test_boom (test_admission_queue.Queue.test_boom)",
		PYTHON_RULE,
		"Traceback (most recent call last):",
		'  File "deploy/hindsight/test_admission_queue.py", line 4, in test_boom',
		"RuntimeError: synthetic",
		"",
		"=".repeat(70),
		"FAIL: test_order (test_admission_queue.Queue.test_order)",
		PYTHON_RULE,
		"Traceback (most recent call last):",
		'  File "deploy/hindsight/test_admission_queue.py", line 3, in test_order',
		"AssertionError: Lists differ: [1, 2] != [2, 1]",
	],
	"Ran 3 tests in 0.000s",
	"FAILED (failures=1, errors=1)",
);
// A file the pattern picked that imports what only the image has.
const PYTHON_IMPORT_ERROR = pythonLog(
	[
		"test_admission_image (unittest.loader._FailedTest.test_admission_image) ... ERROR",
		"",
		"=".repeat(70),
		"ERROR: test_admission_image (unittest.loader._FailedTest.test_admission_image)",
		PYTHON_RULE,
		"ImportError: Failed to import test module: test_admission_image",
		"ModuleNotFoundError: No module named 'fastapi'",
	],
	"Ran 1 test in 0.000s",
	"FAILED (errors=1)",
);

describe("the python step's log", () => {
	it("passes a run that ran its tests and said OK, and counts them", () => {
		expect(parsePythonLog(PYTHON_PASSED)).toEqual({
			ok: true,
			text: "34 tests ok",
		});
		expect(parsePythonLog(pythonLog([], "Ran 1 test in 0.001s", "OK"))).toEqual(
			{ ok: true, text: "1 test ok" },
		);
	});

	it("passes a run with skipped tests and says how many", () => {
		expect(
			parsePythonLog(pythonLog([], "Ran 2 tests in 0.000s", "OK (skipped=1)")),
		).toEqual({ ok: true, text: "2 tests ok (skipped=1)" });
	});

	it("reads the colours Python 3.14 and later may print", () => {
		const coloured = pythonLog(
			[],
			"Ran 2 tests in 0.000s",
			`${ESC}[32mOK${ESC}[0m (${ESC}[33mskipped=1${ESC}[0m)`,
		);
		expect(parsePythonLog(coloured)).toEqual({
			ok: true,
			text: "2 tests ok (skipped=1)",
		});
	});

	it("fails a run that said FAILED, and names each failed test", () => {
		expect(parsePythonLog(PYTHON_FAILED)).toEqual({
			ok: false,
			text: [
				"FAILED (failures=1, errors=1) in 3 tests",
				"      ERROR: test_boom (test_admission_queue.Queue.test_boom)",
				"      FAIL: test_order (test_admission_queue.Queue.test_order)",
			].join("\n"),
		});
	});

	it("fails a run in which a picked file could not be imported", () => {
		const { ok, text } = parsePythonLog(PYTHON_IMPORT_ERROR);
		expect(ok).toBe(false);
		expect(text).toContain("FAILED (errors=1) in 1 test");
		expect(text).toContain("ERROR: test_admission_image");
	});

	it("fails a run that ran no test, as Python 3.12 and later say it and as older ones did", () => {
		for (const verdict of ["NO TESTS RAN", "OK"]) {
			expect(
				parsePythonLog(pythonLog([], "Ran 0 tests in 0.000s", verdict)),
			).toEqual({ ok: false, text: "no tests ran" });
		}
	});

	it("fails, with the log's last line, when unittest never got to its summary", () => {
		expect(parsePythonLog("env: python3: No such file or directory\n")).toEqual(
			{ ok: false, text: "env: python3: No such file or directory" },
		);
		expect(parsePythonLog("")).toEqual({ ok: false, text: "no output" });
	});
});

// A bare `npx fallow` runs what node_modules holds, and where that is nothing (a fresh
// checkout, CI) npx fetches the latest release, which reports differently from the baseline's.
// So the step names the release package.json pins, and says where the report goes: stdout,
// because Fallow 3 refuses `--output-file` outside the project root and the system temp dir.
describe("the Fallow step", () => {
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
			counts: {
				passed: 686,
				skipped: 23,
				failed: 0,
				flaky: 0,
				workers: undefined,
			},
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

			it("writes a Vitest JSON report alongside the human log", () => {
				expect(steps.vitest.cmd).toEqual(
					expect.arrayContaining([
						"npx",
						"vitest",
						"run",
						"--reporter=default",
						"--reporter=./scripts/gates-vitest-reporter.mjs",
					]),
				);
			});

			it.each(["check", "vitest"])(
				"%s waits for the build: it syncs .svelte-kit/, which the build reads",
				(name) => {
					expect(steps[name].after).toContain("build");
				},
			);

			it("lets the end-to-end run wait for the build it serves", () => {
				expect(steps.playwright.after).toContain("build");
			});

			it.each(["biome", "migrations", "python", "fallow"])(
				"starts %s with the build: it never touches .svelte-kit/",
				(name) => {
					expect(steps[name].after ?? []).toEqual([]);
				},
			);
		});
	}
});

// Release hides vitest behind the e2e run (8.5 minutes in three green runs against 10.7 phased);
// an agent's run is a few spec files that finish in a minute, so vitest on three threads would be
// its longest step (7 minutes against 2.5): there the static gates go first.
describe("gate scope", () => {
	it("sets agent selection flags and leaves release on the full suite", () => {
		const agent = parseArgs([
			"agent",
			"/tmp/gates-test",
			"--base",
			"develop",
			"--all-unit-tests",
			"--no-fail-fast",
		]);
		expect(agent).toMatchObject({
			base: "develop",
			allUnitTests: true,
			failFast: false,
		});
		const release = parseArgs(["release", "/tmp/gates-test"]);
		expect(release.failFast).toBe(false);
		const e2e = defineSteps(release).playwright;
		expect(e2e.env).toMatchObject({
			E2E_AGENT_GATE: "0",
			E2E_FULL_SPECS: "",
			E2E_SERVER: "build",
		});
	});

	it("passes explicit related files as absolute CLI arguments in agent mode", () => {
		const args = parseArgs(["agent", "/tmp/gates-test"]);
		args.unitSelection = {
			kind: "related",
			paths: ["scripts/gates.test.ts", "-literal.ts"],
		};
		const cmd = defineSteps(args).vitest.cmd;
		expect(cmd).toContain("related");
		expect(cmd.at(-1)).toMatch(/\/-literal\.ts$/);
	});

	it("reports a valid empty related run separately from a crash", () => {
		const selection = {
			kind: "related",
			changed: 1,
			alwaysRun: 0,
			mergeBase: "123456789",
		};
		expect(
			parseVitestLog("No test files found", 0, { selection, total: 1507 }),
		).toMatchObject({
			ok: true,
			text: "files 0 of 1,507; chose: 1 changed since 1234567 and 0 always-run",
		});
		expect(parseVitestLog("No test files found", 1, { selection }).ok).toBe(
			false,
		);
	});
});

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

// The gate runner without its processes. `runSteps` starts the steps and `summarise` writes the
// screen; the test hands `runSteps` a stand-in for the command each step runs, so nothing really
// starts and the same code that runs the gates is what is read here.
describe("running the steps", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * One run of the steps as `defineSteps` makes them, for the arguments after `agent <out-dir>`.
	 * `exits` and `logs` say how a step's stand-in command ends and what it wrote, by step name; a
	 * step reads its log as fine unless `real` names it, so a test about which steps run does not
	 * need a believable log for each of the nine.
	 */
	async function gate(
		argv: string[],
		{
			exits = {},
			logs = {},
			real = [],
			failFast = false,
		}: {
			exits?: Record<string, number>;
			logs?: Record<string, string>;
			real?: string[];
			failFast?: boolean;
		} = {},
	) {
		const outDir = mkdtempSync(join(tmpdir(), "gates-run-"));
		dirs.push(outDir);
		const args = parseArgs([
			"agent",
			outDir,
			...(failFast ? [] : ["--no-fail-fast"]),
			...argv,
		]);
		const steps: Record<string, { parse: unknown }> = defineSteps(args);
		for (const [name, step] of Object.entries(steps)) {
			if (!real.includes(name)) {
				step.parse = () => ({ ok: true, text: `${name} read fine` });
			}
		}
		const started: string[] = [];
		const run = async (
			_step: unknown,
			name: string,
			dir: string,
			signal: AbortSignal,
		) => {
			started.push(name);
			const logPath = join(dir, `${name}.log`);
			writeFileSync(logPath, logs[name] ?? "");
			if (failFast && name === "vitest" && exits.check) {
				if (!signal.aborted)
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				return { stopped: true };
			}
			const now = Date.now();
			return { code: exits[name] ?? 0, startedAt: now, endedAt: now, logPath };
		};
		const results = await runSteps(args, steps, { run, log: () => {} });
		const { summary, passed }: { summary: string; passed: boolean } = summarise(
			{
				header: ["gates agent at the header"],
				results,
				startedAt: 0,
				endedAt: 0,
				outDir,
			},
		);
		return { started, results, summary, lines: summary.split("\n"), passed };
	}
	it("reports the first failing static check and stops independent lanes", async () => {
		const { results, started, summary } = await gate([], {
			failFast: true,
			exits: { build: 1 },
		});
		expect(results.build.ok).toBe(false);
		expect(results.vitest).toEqual({ blocked: "not run: build failed" });
		expect(started).not.toContain("playwright");
		expect(summary).toContain("(stopped:");
	});

	it("aborts a running test when typecheck fails", async () => {
		const { started, results } = await gate([], {
			failFast: true,
			exits: { check: 1 },
		});
		expect(started).toContain("vitest");
		expect(results.vitest).toEqual({ stopped: "check failed" });
		expect(results.playwright).toEqual({ stopped: "check failed" });
	});

	it("warns on a release over ten minutes without changing the verdict", async () => {
		const { results } = await gate([]);
		const render = (mode: string, counts: boolean) =>
			summarise({
				header: [],
				results,
				startedAt: 0,
				endedAt: 600_001,
				outDir: "/tmp/gates-test",
				mode,
				measured: { counts },
			});
		expect(render("release", true)).toMatchObject({
			passed: true,
			summary: expect.stringContaining("OVER THE 10-MINUTE TARGET"),
		});
		expect(render("release", false).summary).toContain(
			"over 10 minutes, but not a measured run",
		);
		expect(render("agent", true).summary).not.toContain("10-MINUTE TARGET");
	});

	it("keeps running other lanes after a unit-test failure", async () => {
		const { started, results } = await gate([], {
			failFast: true,
			exits: { vitest: 1 },
		});
		expect(started).toContain("playwright");
		expect(results.playwright.ok).toBe(true);
	});

	const everyStep = Object.keys(defineSteps(options));
	const needsTheBuild = ["check", "vitest", "chunks", "playwright"];

	it("starts every step when none is skipped, those that need the build after it", async () => {
		const { started, passed } = await gate([]);
		expect([...started].sort()).toEqual([...everyStep].sort());
		for (const name of needsTheBuild) {
			expect(started.indexOf("build")).toBeLessThan(started.indexOf(name));
		}
		expect(passed).toBe(true);
	});

	it("starts no step it is told to skip, and the screen says it was skipped", async () => {
		const { started, lines } = await gate(["--skip", "check,vitest"]);
		expect(started).not.toContain("check");
		expect(started).not.toContain("vitest");
		expect(lines).toContain("check      skip");
		expect(lines).toContain("vitest     skip");
	});

	it("does not start the steps that wait for a build that failed, and says they were not run", async () => {
		const { started, lines, passed } = await gate([], { exits: { build: 1 } });
		for (const name of needsTheBuild) {
			expect(started).not.toContain(name);
			expect(lines).toContain(`${name.padEnd(10)} FAIL not run: build failed`);
		}
		// Those that never needed the build still ran.
		for (const name of ["biome", "migrations", "python", "fallow"]) {
			expect(started).toContain(name);
		}
		expect(passed).toBe(false);
		expect(lines.find((line) => line.startsWith("total"))).toContain(
			"FAILED: check, vitest, build, chunks, playwright",
		);
	});

	// A failed build used to read `exit=1 FAIL ... :: unused-css=0 aria=0 (baseline 0/0)`: the reason
	// was only in build.log. The line now carries the first lines of the build's own error report, in
	// the layout the other steps use for a second line (Fallow's NEW lines, Playwright's FAILED), and
	// the steps blocked behind it say they were blocked, as before.
	it("shows why a build failed on the build's own line, and the steps behind it still say they were not run", async () => {
		const { lines } = await gate([], {
			real: ["build"],
			exits: { build: 1 },
			logs: { build: BUILD_SYNTAX_ERROR },
		});
		const at = lines.findIndex((line) => line.startsWith("build"));
		expect(lines[at]).toMatch(
			/^build {6}exit=1 FAIL\s+0s \(\+0s\) :: error during build:$/,
		);
		expect(lines.slice(at + 1, at + 4)).toEqual([
			"      Build failed with 1 error:",
			"      [builtin:vite-transform] Unexpected token",
			"      ╭─[ src/lib/model-context-defaults.ts:89:23 ]",
		]);
		expect(lines.join("\n")).not.toContain("unused-css");
		for (const name of needsTheBuild) {
			expect(lines).toContain(`${name.padEnd(10)} FAIL not run: build failed`);
		}
	});

	it("writes the screen in the order of the steps: the header, a line for each, the verdict, the logs", async () => {
		const { lines } = await gate([]);
		expect(lines[0]).toBe("gates agent at the header");
		const stepLines = lines.slice(1, 1 + everyStep.length);
		expect(stepLines.map((line) => line.split(" ")[0])).toEqual([
			"check",
			"biome",
			"migrations",
			"python",
			"vitest",
			"build",
			"chunks",
			"fallow",
			"playwright",
		]);
		expect(stepLines[0]).toMatch(
			/^check {6}exit=0 ok {3}\s+0s \(\+0s\) :: check read fine$/,
		);
		expect(lines[1 + everyStep.length]).toMatch(
			/^total 0s; load at end [\d. ]+; ALL GATES PASSED$/,
		);
		expect(lines.at(-1)).toMatch(/^logs: /);
	});

	// Every step the caller does not skip runs. The build used to start only as the thing another
	// step waits for, so with check, vitest, chunks and playwright all skipped nothing asked for
	// it: it never ran and its line was missing from the screen (Fallow alone showed no `build`
	// line at all), and a run that skipped everything ran nothing and printed ALL GATES PASSED.
	it.each(everyStep)(
		"runs %s, and only it, when every other step is skipped",
		async (name) => {
			const others = everyStep.filter((other) => other !== name);
			const { started, results, lines, passed } = await gate([
				"--skip",
				others.join(","),
			]);
			expect(started).toEqual([name]);
			expect(passed).toBe(true);
			// Every step has a result, skipped or run, and so a line on the screen.
			expect(Object.keys(results).sort()).toEqual([...everyStep].sort());
			for (const other of others) {
				expect(lines).toContain(`${other.padEnd(10)} skip`);
			}
		},
	);

	it("fails a run that skipped every step, and says that nothing ran", async () => {
		const { started, lines, passed } = await gate([
			"--skip",
			everyStep.join(","),
		]);
		expect(started).toEqual([]);
		expect(passed).toBe(false);
		for (const name of everyStep) {
			expect(lines).toContain(`${name.padEnd(10)} skip`);
		}
		const total = lines.find((line) => line.startsWith("total")) ?? "";
		expect(total).toContain(
			"FAILED: nothing ran (every step was skipped), so nothing was checked",
		);
		expect(total).not.toContain("ALL GATES PASSED");
	});

	// AGENTS.md ("Fallow Audit Gate") tells an agent to run the Fallow step alone with this command.
	// The test holds both the text there and what the command does.
	const fallowAlone =
		"check,biome,migrations,python,vitest,build,chunks,playwright";
	it("still runs Fallow alone with the command AGENTS.md documents", async () => {
		const agents = readFileSync(
			join(import.meta.dirname, "..", "AGENTS.md"),
			"utf8",
		);
		expect(agents).toContain(
			`scripts/gates.sh agent "$TMPDIR/alfyai-gates" --skip ${fallowAlone}`,
		);
		const { started, passed } = await gate(["--skip", fallowAlone]);
		expect(started).toEqual(["fallow"]);
		expect(passed).toBe(true);
	});
});

// The real script, for the part only a process shows: its exit code and what it prints. Skipping
// every step starts nothing, so this needs no stand-in and takes no time.
describe("the gate runner as a command", () => {
	it("exits 1, says nothing ran and prints no pass when every step is skipped", () => {
		const outDir = mkdtempSync(join(tmpdir(), "gates-command-"));
		try {
			const run = spawnSync(
				process.execPath,
				[
					join(import.meta.dirname, "gates.mjs"),
					"agent",
					outDir,
					"--skip",
					Object.keys(defineSteps(options)).join(","),
				],
				{ encoding: "utf8" },
			);
			expect(run.status).toBe(1);
			expect(run.stdout).toContain("FAILED: nothing ran");
			expect(run.stdout).not.toContain("ALL GATES PASSED");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("the check command and its log reader", () => {
	it("requests the machine format consumed by parseCheckLog", () => {
		expect(defineSteps(options).check.cmd).toEqual([
			"npm",
			"run",
			"check",
			"--",
			"--output",
			"machine",
		]);
	});
});
