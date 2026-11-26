// AlfyAI gate runner. Invoke it through scripts/gates.sh.
//
//   release <out-dir> [options] runs every check, all Vitest files, and all
//   Playwright specs outside the documented quarantine. The ten-minute target
//   is reported independently of the test verdict.
//   agent <out-dir> [options] [spec ...] runs static checks, targeted unit
//   tests, named specs and @smoke. A static failure stops remaining work.
//
// Heavy gates take turns on this Mac. A local worktree lock protects generated
// files. The shared Git directory holds the Mac lock and history. Use
// `node scripts/gates-history.mjs report --days 7` to inspect the history.
// A measured run held the shared queue, started without swap, and recorded
// neither another test run nor reduced process priority.
//
//   --workers N, --port P       Browser workers and first server port.
//   --skip a,b                  Agent-only: omit the named steps. Build is a step.
//   --base ref                  Compare an agent change with this ref (origin/main).
//   --all-unit-tests            Override agent selection.
//   --no-fail-fast              Collect all independent agent results.
//   --schedule phased|overlap   Run Vitest before Playwright or alongside it.
//   --fallow-baseline F         Fallow snapshot (default: .fallow/baseline.json).
//
// THE BUILD GOES FIRST. `npm run check` (`svelte-kit sync`) and vitest (its SvelteKit plugin
// syncs when it starts) both rewrite `.svelte-kit/`, which `vite build` reads. Run side by
// side, the build still exits 0 and its chunk check still passes, but the app it made does
// not hydrate (a page error, every input stays disabled) and the e2e run that follows spends
// forty minutes failing on 15-second timeouts. Measured: check + build started together
// broke the build, check started after it did not. So the build runs alone with respect to
// those two; biome, the migration check, the Python tests and Fallow, which never touch
// `.svelte-kit/`, run beside it. The build is about 16 s on its own.
//
// What the numbers mean and what the baselines are: docs/plans/claude-at-home-2/phase-5/common.md.
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	appendHistory,
	comparisonLines,
	historyEntry,
	previousRelease,
	readHistory,
} from "./gates-history.mjs";
import {
	machineLines,
	measuredVerdict,
	startMachineSampler,
} from "./gates-machine.mjs";
import {
	playwrightTimings,
	slowestUnitFiles,
	vitestSplit,
} from "./gates-measure.mjs";
import {
	acquireGateLock,
	gateStateDir,
	takesTheQueue,
} from "./gates-queue.mjs";

import {
	alwaysRunFiles,
	changedSince,
	chooseUnitTests,
	unitTestFiles,
} from "./unit-test-selection.mjs";

// The repo this script lives in, wherever it is run from; `<out-dir>` is the caller's.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The numbers the static gates are held to (phase-5/common.md, the M3 release gates). */
const BASELINE = {
	// The build prints no warning: one `Unused CSS selector` or `must have an ARIA role` line
	// fails the step. (phase-5/common.md records the 32 and 2 it was held at before
	// ToolActivityRow, ThinkingBlock and RouteItinerary were cleaned.)
	buildUnusedCss: 0,
	buildAria: 0,
	// Ratcheted to the one cycle left (chat-files, knowledge, memory-maintenance) when the
	// baseline was made again on 2026-11-24; a cycle more fails the step.
	fallowCircular: 1,
	// The `check` section of the report the pinned Fallow made at the last accepted state of
	// the tree. It lives in the repo, so every checkout and every agent compares with the same
	// one; AGENTS.md ("Fallow Audit Gate") says when and how it is made again.
	fallowFile: join(ROOT, ".fallow", "baseline.json"),
};

/**
 * A package.json spec for Fallow that names one release, or an error. A range would let the
 * release the gate runs drift from the one the committed baseline was made with.
 */
export function exactFallowVersion(spec) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec ?? "")) {
		throw new Error(
			`package.json must pin fallow to an exact version, and devDependencies.fallow is ${JSON.stringify(spec)}: run \`npm install -D -E fallow@<version>\``,
		);
	}
	return spec;
}

/**
 * The Fallow release the gate runs: package.json's pin. A bare `npx fallow` runs whatever
 * node_modules holds and, where it holds nothing (a fresh checkout, CI), fetches the latest
 * release, whose report is not the baseline's; `npx -y fallow@<this>` is the same report on
 * every machine.
 */
export function fallowVersion() {
	return exactFallowVersion(
		JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies
			?.fallow,
	);
}

// The six-browser/three-Vitest baseline grew swap by 311 MB on this Mac.
// Allow eight test workers across an overlapping run and keep phased
// Vitest below that ceiling. Recheck the defaults with the final timings.
const CAPS = { browser: 8, vitest: 6, overlap: 8 };
const RELEASE_TARGET_MS = 10 * 60_000;
const FAIL_FAST_STEPS = new Set([
	"check",
	"biome",
	"migrations",
	"fallow",
	"build",
]);

const STEP_ORDER = [
	"check",
	"biome",
	"migrations",
	"python",
	"vitest",
	"build",
	"chunks",
	"fallow",
	"playwright",
];

// ------------------------------------------------------------------ helpers

// The escape character is built, not written in the pattern: a literal one is a lint error.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (text) => text.replace(ANSI, "");
const lastLine = (text) =>
	stripAnsi(text).trim().split("\n").filter(Boolean).pop() ?? "";
const count = (text, needle) => text.split(needle).length - 1;
function minutes(ms) {
	const total = Math.round(ms / 1000);
	return total >= 60
		? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
		: `${total}s`;
}
const loadNow = () =>
	loadavg()
		.map((n) => n.toFixed(1))
		.join(" ");

function git(args) {
	const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return (out.stdout ?? "").trim();
}

function usage(message) {
	if (message) console.error(message);
	console.error(
		"usage: scripts/gates.sh <release|agent> <out-dir> [--workers N] [--port P] [--skip a,b] [--fallow-baseline F] [--schedule phased|overlap] [--base ref] [--all-unit-tests] [--no-fail-fast] [spec ...]",
	);
	console.error(`--skip takes the step names: ${STEP_ORDER.join(", ")}`);
	process.exit(2);
}

export function parseArgs(argv) {
	const [mode, outDir, ...rest] = argv;
	if (!["release", "agent"].includes(mode) || !outDir) usage();
	const args = {
		mode,
		outDir: resolve(outDir),
		workers: process.env.E2E_WORKERS,
		port: process.env.E2E_PORT,
		skip: new Set(),
		fallowBaseline: BASELINE.fallowFile,
		schedule: undefined,
		base: "origin/main",
		allUnitTests: false,
		failFast: mode === "agent",
		specs: [],
	};
	for (let i = 0; i < rest.length; i += 1) {
		const flag = rest[i];
		const value = () => {
			i += 1;
			if (rest[i] === undefined) usage(`${flag} needs a value`);
			return rest[i];
		};
		if (flag === "--workers") args.workers = value();
		else if (flag === "--port") args.port = value();
		else if (flag === "--skip")
			for (const name of value().split(",")) args.skip.add(name.trim());
		else if (flag === "--fallow-baseline") args.fallowBaseline = value();
		else if (flag === "--schedule") args.schedule = value();
		else if (flag === "--base") args.base = value();
		else if (flag === "--all-unit-tests") args.allUnitTests = true;
		else if (flag === "--no-fail-fast") args.failFast = false;
		else if (flag.startsWith("--")) usage(`unknown option ${flag}`);
		else args.specs.push(flag);
	}
	for (const name of args.skip) {
		if (!STEP_ORDER.includes(name)) {
			usage(`--skip: no step called "${name}" (${STEP_ORDER.join(", ")})`);
		}
	}
	args.schedule ??= mode === "release" ? "overlap" : "phased";
	if (!["phased", "overlap"].includes(args.schedule)) {
		usage('--schedule must be "phased" or "overlap"');
	}
	if (mode === "release" && (args.specs.length || args.skip.size)) {
		usage(
			"release mode runs every check and spec; use agent mode for a partial run",
		);
	}
	return args;
}

/** The e2e files that carry @smoke tests: an agent run adds just those tests of them. */
function filesWithSmokeTests() {
	const dir = join(ROOT, "tests", "e2e");
	return readdirSync(dir)
		.filter((name) => /\.(spec|test)\.[cm]?[jt]s$/.test(name))
		.filter((name) => readFileSync(join(dir, name), "utf8").includes("@smoke"))
		.map((name) => join("tests", "e2e", name));
}

// -------------------------------------------------------------- the steps

function gateWorkers(args) {
	const available = Math.max(2, Math.min(CAPS.overlap, cpus().length - 2));
	const requested = Number(args.workers || 6);
	if (!Number.isSafeInteger(requested) || requested < 1) {
		throw new Error("Browser worker count must be a positive whole number");
	}
	const overlap = args.schedule === "overlap";
	const sharesMachine =
		overlap && !args.skip.has("vitest") && !args.skip.has("playwright");
	const browser = Math.min(
		requested,
		CAPS.browser,
		available - Number(sharesMachine),
	);
	const preferred = overlap
		? Math.max(1, Math.floor(cpus().length / 4))
		: CAPS.vitest;
	const vitest = Math.min(
		preferred,
		CAPS.vitest,
		available - (sharesMachine ? browser : 0),
	);
	return { browser, vitest };
}

/**
 * One step: how to run it and how to read its log. `parse(log, code)` takes the log and the exit
 * code and returns `{ ok, text }`; a step passes when it exits 0 and `ok` holds.
 */
export function defineSteps(args) {
	const reportDir = args.reportDir ?? args.outDir;
	const jsonReport = join(reportDir, "playwright.json");
	const e2eArgs = [];
	const workers = gateWorkers(args);
	const e2eEnv = {
		...(args.port ? { E2E_PORT: String(args.port) } : {}),
		E2E_WORKERS: String(workers.browser),
		E2E_JSON_REPORT: jsonReport,
		E2E_APPLY_QUARANTINE: "1",
		E2E_AGENT_GATE: args.mode === "agent" ? "1" : "0",
		E2E_FULL_SPECS: args.mode === "agent" ? args.specs.join(",") : "",
		E2E_SERVER: "build",
		PLAYWRIGHT_REUSE_EXISTING_SERVER: "false",
	};
	if (args.mode === "agent") {
		// One Playwright run, two projects (playwright.config.ts): the named files in
		// full, and the @smoke tests of every other file, sharing the same workers.
		e2eArgs.push(...args.specs, ...filesWithSmokeTests());
	}
	const selection = args.unitSelection;
	const related = selection?.kind === "related" && selection.paths.length > 0;
	const vitestCommand = [
		"npx",
		"vitest",
		...(related ? ["related", "--run"] : ["run"]),
		`--maxWorkers=${workers.vitest}`,
		"--reporter=default",
		"--reporter=./scripts/gates-vitest-reporter.mjs",
		...(related ? selection.paths.map((path) => resolve(ROOT, path)) : []),
	];
	return {
		// `check` and `vitest` sync `.svelte-kit/`: never while the build is reading it.
		check: {
			// parseCheckLog consumes the COMPLETED machine record, not the human summary.
			cmd: ["npm", "run", "check", "--", "--output", "machine"],
			after: ["build"],
			parse: parseCheckLog,
		},
		biome: {
			cmd: ["npx", "biome", "check", "src", "scripts", "tests"],
			parse: (log) => ({ ok: true, text: lastLine(log) }),
		},
		migrations: {
			cmd: ["npm", "run", "check:migrations"],
			parse: (log) => ({ ok: true, text: lastLine(log) }),
		},
		// The admission queue's Python tests (deploy/hindsight/README.md, "Python tests"): every
		// test_admission_*.py there, which needs the standard library alone, so plain python3 runs
		// them. The other Python tests in that folder need the pinned Hindsight image and stay out.
		python: {
			cmd: [
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
			],
			env: { PYTHONDONTWRITEBYTECODE: "1" },
			parse: parsePythonLog,
		},
		vitest: {
			cmd: vitestCommand,
			env: { ALFYAI_VITEST_REPORT: join(reportDir, "vitest.json") },
			after: ["build"],
			parse: (log, code) =>
				parseVitestLog(log, code, { selection, total: args.unitFileCount }),
		},
		// SvelteKit's post-build `analyse` pass imports every server module, and
		// src/lib/server/db/index.ts opens DATABASE_PATH when it is imported. A fresh checkout has
		// no ./data/ (git ignores it, and the e2e setup makes it only after the build) and
		// better-sqlite3 will not make a directory, so the default path failed this step with
		// "Cannot open database because the directory does not exist". The build gets a scratch
		// file in the gate's own out-dir instead: that directory exists by construction, and the
		// build no longer opens (or creates) a developer's real data/chat.db, the rule
		// src/vitest-setup.ts keeps for the tests. Nothing of it is built in: the server reads
		// DATABASE_PATH when it starts.
		build: {
			cmd: ["npm", "run", "build"],
			env: { DATABASE_PATH: join(args.outDir, "build-analyse.db") },
			parse: parseBuildLog,
		},
		chunks: {
			// The Canvas editor's guard and the picture card's (plan 2b F6): both print
			// `[artifact-chunks]` lines, so one parse reads them.
			cmd: ["npm", "run", "check:chunks"],
			after: ["build"],
			parse: parseChunksLog,
		},
		// Fallow reads `.svelte-kit/tsconfig.json` when it exists and warns on stderr (fallow.log)
		// when it does not; the findings are the same either way (checked on the tree this baseline
		// was made from), so it needs no sync first and runs beside the build.
		fallow: {
			cmd: [
				"npx",
				"-y",
				`fallow@${fallowVersion()}`,
				"--no-cache",
				"--format",
				"json",
				"--quiet",
				"--score",
			],
			// The report is stdout. `--output-file` is refused outside the project root and the
			// system temp dir (Fallow 3), and the out-dir is the caller's to choose.
			stdout: join(args.outDir, "fallow.json"),
			parse: () =>
				compareFallow(join(args.outDir, "fallow.json"), args.fallowBaseline),
		},
		playwright: {
			cmd: ["npx", "playwright", "test", ...e2eArgs],
			env: e2eEnv,
			after: ["build"],
			parse: () => readPlaywrightReport(jsonReport),
		},
	};
}

// ---------------------------------------------------------- reading the logs
// Each reads one step's log and says whether the gate's own numbers hold; the
// exit code is judged on top of it.

export function parseCheckLog(log) {
	const text = stripAnsi(log);
	const done = text.match(/COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS/);
	if (done) {
		const [, files, errors, warnings] = done;
		// AGENTS.md ("Typecheck Gate") keeps svelte-check at 0 errors and 0 warnings, so a warning
		// is a regression and not a number to stay under. svelte-check itself exits 0 with
		// warnings, which is why the verdict is read here and not left to the exit code.
		return {
			ok: Number(errors) === 0 && Number(warnings) === 0,
			text: `${errors} errors, ${warnings} warnings in ${files} files${Number(warnings) > 0 ? "  NEW CHECK WARNINGS" : ""}`,
		};
	}
	// svelte-check 4.x prints this closing line instead of the COMPLETED summary.
	const modern = text.match(
		/svelte-check found (\d+) errors? and (\d+) warnings?/,
	);
	if (modern) {
		const [, errors, warnings] = modern;
		return {
			ok: Number(errors) === 0 && Number(warnings) === 0,
			text: `${errors} errors, ${warnings} warnings${Number(warnings) > 0 ? "  NEW CHECK WARNINGS" : ""}`,
		};
	}
	return { ok: false, text: lastLine(log) };
}

/**
 * Python's unittest: the last `Ran N tests` line and the verdict under it. A run passes only when it
 * ran a test and said OK, with or without skips. A pattern that found no file runs nothing, which
 * Python 3.12 and later say as NO TESTS RAN and older ones as OK, so the count decides that.
 */
export function parsePythonLog(log) {
	const text = stripAnsi(log);
	const ran = [...text.matchAll(/^Ran (\d+) tests? in [\d.]+s$/gm)].at(-1);
	if (!ran) return { ok: false, text: lastLine(log) || "no output" };
	const tests = Number(ran[1]);
	if (tests === 0) return { ok: false, text: "no tests ran" };
	const counted = `${tests} test${tests === 1 ? "" : "s"}`;
	const verdict =
		text
			.slice(ran.index + ran[0].length)
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const passed = verdict.match(/^OK(?: (\(.*\)))?$/);
	if (passed) {
		return {
			ok: true,
			text: `${counted} ok${passed[1] ? ` ${passed[1]}` : ""}`,
		};
	}
	// unittest heads each failed test's report with `FAIL: name (where)` or `ERROR: name (where)`.
	const failed = [...text.matchAll(/^((?:FAIL|ERROR): .+)$/gm)].map((match) =>
		match[1].slice(0, 170),
	);
	return {
		ok: false,
		text: [
			`${verdict || "no verdict"} in ${counted}`,
			...failed.slice(0, 6).map((line) => `      ${line}`),
		].join("\n"),
	};
}

export function parseVitestLog(
	log,
	code = 0,
	{ selection, total: available } = {},
) {
	const text = stripAnsi(log);
	const files = text.match(/Test Files\s+(.*)/)?.[1]?.trim();
	const tests = text.match(/\n\s*Tests\s+(.*)/)?.[1]?.trim();
	const failed = /\bfailed\b/.test(`${files ?? ""} ${tests ?? ""}`);
	const split = vitestSplit(text);
	const workerTime = split
		? "; worker time: " +
			Object.entries(split)
				.sort((a, b) => b[1] - a[1])
				.map(([name, seconds]) => `${name} ${Math.floor(seconds)}s`)
				.join(", ")
		: "";
	const availableText =
		available === undefined ? "" : ` of ${available.toLocaleString("en-US")}`;
	const chosen =
		selection?.kind === "all"
			? `; chose: all (${selection.reason})`
			: selection?.kind === "related"
				? `; chose: ${selection.changed} changed since ${selection.mergeBase.slice(0, 7)} and ${selection.alwaysRun} always-run`
				: "";
	if (
		code === 0 &&
		selection?.kind === "related" &&
		/No test files found/.test(text)
	) {
		return {
			ok: true,
			text: `files 0${availableText}${chosen}`,
			counts: { files: 0, tests: 0 },
		};
	}
	const total = (line) => {
		const count = line?.match(/\((\d+)\)$/)?.[1];
		return count === undefined ? null : Number(count);
	};
	return {
		ok: Boolean(tests) && !failed,
		text: `files ${files ?? "?"}${availableText}; tests ${tests ?? "?"}${chosen}${workerTime}`,
		counts: { files: total(files), tests: total(tests) },
	};
}

// Why a build failed, which is the FIRST lines of its own error report and not its last line (what
// `lastLine` gives the other steps): a Vite failure ends in a stack trace and a closing brace, a
// Node process that died in its version line, an out-of-memory crash in native frames. The log
// before the report can run to a thousand lines of chunk sizes, some of them for files with
// "error" in the name, so the report is found by how a line starts: Vite's "error during build:",
// the name of a thrown error ("TypeError: ...", "RolldownError: ...", "FATAL ERROR: ..."), or the
// "failed" line one of the build's own scripts prints after its [tag].
const BUILD_ERROR_START =
	/^(?:error during build\b|(?:fatal )?\w*error\b|\[[\w-]+\].*\bfailed\b)/i;
// Where the report stops being a message: the first stack frame, or the heading of a native one.
const BUILD_STACK_START = /^(?:at\s|-{3,} .*stack trace)/i;
const BUILD_REASON_LINES = 4;
const BUILD_REASON_WIDTH = 160;

function buildFailure(log) {
	const lines = stripAnsi(log)
		// a path in the repo is shown as a repo path
		.replaceAll(`${ROOT}/`, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const start = lines.findIndex((line) => BUILD_ERROR_START.test(line));
	// No report to be found: what the other steps show, the log's last line, or that there is none.
	if (start === -1)
		return (lines.at(-1) ?? "no output").slice(0, BUILD_REASON_WIDTH);
	const reason = [];
	for (const line of lines.slice(start)) {
		if (BUILD_STACK_START.test(line) || reason.length === BUILD_REASON_LINES) {
			break;
		}
		reason.push(line.slice(0, BUILD_REASON_WIDTH));
	}
	return reason.join("\n      ");
}

/**
 * Judge the build from its log and its exit code. One that did not exit 0 says why it failed;
 * one that did is held to the warning counts.
 */
export function parseBuildLog(log, code = 0) {
	// The counts of a build that never finished are no news (`unused-css=0 aria=0` read as if it
	// had been fine); why it stopped is what its line on the screen is for.
	if (code !== 0) return { ok: false, text: buildFailure(log) };
	const css = count(log, "Unused CSS selector");
	const aria = count(log, "must have an ARIA role");
	const over = css > BASELINE.buildUnusedCss || aria > BASELINE.buildAria;
	return {
		ok: !over,
		text: `unused-css=${css} aria=${aria} (baseline ${BASELINE.buildUnusedCss}/${BASELINE.buildAria})${over ? "  NEW BUILD WARNINGS" : ""}`,
	};
}

export function parseChunksLog(log) {
	const text = stripAnsi(log);
	const parts = [];
	const editor = text.match(
		/loads \d+ chunk\(s\) of its own \([\d.]+ kB raw, ([\d.]+) kB gzip\)/,
	);
	if (editor) parts.push(`editor closure ${editor[1]} kB gzip`);
	const chat = text.match(
		/chat route [^\n]*?: (\d+) chunk\(s\), (\d+) bytes gzip/,
	);
	if (chat) {
		parts.push(
			`chat route first paint ${chat[2]} B gzip in ${chat[1]} chunks (information only)`,
		);
	}
	const fails = text
		.split("\n")
		.filter((line) => line.includes("FAIL"))
		.map((line) => line.replace("[artifact-chunks] ", "").slice(0, 150));
	return {
		ok: fails.length === 0 && parts.length > 0,
		text: [...parts, ...fails].join("; ") || lastLine(log),
	};
}

// Fallow: the comparison wave-2-5/gates.sh made in python. A finding is its kind (the list it
// sits in), its path and its name. What only says where it is, or how Fallow words it, is
// dropped from it, so a finding that moved down a file, or that Fallow 3 dresses with an id,
// suggested actions, a severity or a reachability note, is not a new one.
const POSITION_KEYS = new Set([
	"line",
	"col",
	"column",
	"start",
	"end",
	"span",
	"span_start",
	"span_end",
	"offset",
	"line_number",
	"start_line",
	"end_line",
]);
// Not part of what a finding IS. The id is a hash that moves with the finding, the actions are
// advice that each release words its own way, the severity follows the rules, and the caveats
// appear when an import could not be resolved in that run (no node_modules, no .svelte-kit
// yet). The id, the severity and the caveats are new in Fallow 3; 2.96 already had the actions.
const DRESSING_KEYS = new Set([
	"finding_id",
	"actions",
	"effective_severity",
	"reachability_caveats",
]);
function normalise(value) {
	if (Array.isArray(value)) return value.map(normalise);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.filter((key) => !POSITION_KEYS.has(key) && !DRESSING_KEYS.has(key))
				.sort()
				.map((key) => [key, normalise(value[key])]),
		);
	}
	return value;
}

/**
 * Health score, duplication and size from the report, for the summary line. Information only:
 * nothing here is ever read by the gate, and a report that lacks a value just leaves it out.
 */
function fallowInformation(report) {
	const parts = [];
	const health = report.health?.health_score;
	if (typeof health?.score === "number") {
		parts.push(
			`health ${health.score.toFixed(1)}${health.grade ? ` (${health.grade})` : ""}`,
		);
	}
	const duplication = report.dupes?.stats?.duplication_percentage;
	if (typeof duplication === "number") {
		parts.push(`duplication ${duplication.toFixed(1)}%`);
	}
	const lines = report.health?.vital_signs?.total_loc;
	if (typeof lines === "number") {
		parts.push(`${lines.toLocaleString("en-US")} LOC`);
	}
	if (parts.length === 0) return "";
	return `; fallow ${report.version ?? "?"}: ${parts.join(", ")} (information only)`;
}

export function compareFallow(currentPath, baselinePath) {
	let report;
	let baseline;
	try {
		report = JSON.parse(readFileSync(currentPath, "utf8"));
	} catch {
		return { ok: false, text: "no Fallow report was written" };
	}
	// The report is the step's stdout, so a Fallow that failed to start its analysis leaves its
	// error here as JSON, with no check section.
	const current = report?.check;
	if (!current || typeof current !== "object") {
		return {
			ok: false,
			text: report?.error
				? `Fallow failed: ${String(report.message).slice(0, 200)}`
				: "the Fallow report has no check section",
		};
	}
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf8")).check;
		if (!baseline || typeof baseline !== "object") throw new Error("no check");
	} catch {
		return {
			ok: false,
			text: `no Fallow baseline at ${baselinePath} (--fallow-baseline FILE)`,
		};
	}
	const added = [];
	let gone = 0;
	for (const [key, value] of Object.entries(current)) {
		if (!Array.isArray(value)) continue;
		const before = new Set(
			(baseline[key] ?? []).map((item) => JSON.stringify(normalise(item))),
		);
		const now = new Set(value.map((item) => JSON.stringify(normalise(item))));
		for (const entry of now) {
			if (!before.has(entry)) added.push(`${key}: ${entry.slice(0, 120)}`);
		}
		for (const entry of before) if (!now.has(entry)) gone += 1;
	}
	const circular = current.circular_dependencies?.length ?? 0;
	const text = `total=${current.total_issues} circular=${circular} new_vs_baseline=${added.length} gone_vs_baseline=${gone}${fallowInformation(report)}`;
	return {
		ok: added.length === 0 && circular <= BASELINE.fallowCircular,
		text:
			added.length > 0
				? `${text}\n      NEW ${added.slice(0, 6).join("\n      NEW ")}`
				: text,
	};
}

function playwrightCost(report, path) {
	const cost = playwrightTimings(report);
	try {
		const total = JSON.parse(readFileSync(`${path}.sign-in.json`, "utf8"));
		if (Number.isFinite(total) && total >= 0) cost.signInMs = total;
	} catch {
		// Older reports only contain sign-in steps from the test body.
	}
	return cost;
}

export function readPlaywrightReport(path) {
	let report;
	try {
		report = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {
			ok: false,
			text: "no Playwright report was written (see playwright.log)",
		};
	}
	const { expected, unexpected, flaky, skipped } = report.stats;
	const failed = [];
	const walk = (suite, inherited) => {
		const file = suite.file ?? inherited;
		for (const spec of suite.specs ?? []) {
			if (!spec.ok)
				failed.push(`${file ?? "?"}:${spec.line} ${spec.title}`.slice(0, 170));
		}
		for (const child of suite.suites ?? []) walk(child, file);
	};
	for (const suite of report.suites ?? []) walk(suite, undefined);
	// How many workers the run really used (the config's number, or fewer when there were
	// fewer files than workers), so a summary says what it measured.
	const workers = report.config?.projects?.[0]?.metadata?.actualWorkers;
	const lines = [
		`${expected} passed, ${skipped} skipped, ${unexpected} failed, ${flaky} flaky${workers ? ` on ${workers} workers` : ""}`,
	];
	for (const title of failed.slice(0, 12)) lines.push(`      FAILED ${title}`);
	const cost = playwrightCost(report, path);
	if (cost.files.length)
		lines.push(
			`      slowest: ${cost.files
				.slice(0, 5)
				.map(({ file, ms }) => `${file} ${minutes(ms)}`)
				.join(", ")}`,
		);
	if (cost.workers.length)
		lines.push(
			`      workers: ${cost.workers.length}, the first idle ${minutes(cost.tailMs)} before the end; sign-in ${minutes(cost.signInMs)} in all`,
		);
	return {
		ok: unexpected === 0 && flaky === 0,
		text: lines.join("\n"),
		counts: { passed: expected, failed: unexpected, flaky, skipped, workers },
	};
}

// ------------------------------------------------------------------ running

function childEnv() {
	const path = process.env.PATH ?? "";
	const node22 = "/opt/homebrew/opt/node@22/bin";
	return existsSync(node22) && !path.includes(node22)
		? { ...process.env, PATH: `${node22}:${path}` }
		: { ...process.env };
}

const active = new Set();
const workerGroups = new Set();
let releaseQueue;
let queueWorkers;
let shuttingDown = false;

function signalGroups(signal) {
	for (const pid of workerGroups) {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if (error.code === "ESRCH") workerGroups.delete(pid);
		}
	}
}

async function forceStopGroups() {
	signalGroups("SIGKILL");
	const deadline = performance.now() + 1500;
	while (workerGroups.size && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		signalGroups(0);
	}
}
/**
 * Stop what the gates started, politely first: Playwright tears its servers down on
 * SIGINT (and only on SIGINT), so SIGINT goes to every group, and what is still alive
 * after the grace period is killed.
 */
async function shutDown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	signalGroups("SIGINT");
	const deadline = Date.now() + 8000;
	while (active.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await forceStopGroups();
	await releaseQueue?.(forceStopGroups);
	process.exit(code);
}
process.on("SIGINT", () => shutDown(130));
process.on("SIGTERM", () => shutDown(143));

function runCommand(step, name, outDir, signal) {
	const logPath = join(outDir, `${name}.log`);
	const startedAt = Date.now();
	return new Promise((done) => {
		const fd = openSync(logPath, "w");
		// A step whose result is its stdout (Fallow's JSON report) gets a file for it, and the
		// log keeps stderr.
		const out = step.stdout ? openSync(step.stdout, "w") : fd;
		const command = queueWorkers
			? [
					"/bin/sh",
					"-c",
					'IFS= read -r instruction && [ "$instruction" = start ] && exec "$@" </dev/null',
					"gate-worker",
					...step.cmd,
				]
			: step.cmd;
		const child = spawn(command[0], command.slice(1), {
			cwd: ROOT,
			env: {
				...childEnv(),
				...(step.env ?? {}),
				ALFYAI_GATE_WORKER_GROUP: "1",
			},
			stdio: [queueWorkers ? "pipe" : "ignore", out, fd],
			detached: true,
		});
		closeSync(fd);
		if (out !== fd) closeSync(out);
		active.add(child);
		if (child.pid) workerGroups.add(child.pid);
		let killTimer;
		const signalGroup = (kind) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, kind);
			} catch {
				// The process group may already have exited.
			}
		};
		const abort = () => {
			signalGroup("SIGINT");
			killTimer = setTimeout(() => signalGroup("SIGKILL"), 8000);
			killTimer.unref();
		};
		const clearAbort = () => {
			signal.removeEventListener("abort", abort);
			if (!workerGroups.has(child.pid)) clearTimeout(killTimer);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.on("error", () => {
			clearAbort();
			active.delete(child);
			done({ code: 127, startedAt, endedAt: Date.now(), logPath });
		});
		child.on("exit", (code, exitSignal) => {
			signalGroups(0);
			if (!workerGroups.has(child.pid)) queueWorkers?.unregister(child.pid);
			clearAbort();
			active.delete(child);
			done({
				code: code ?? (exitSignal ? 128 : 1),
				stopped: signal.aborted,
				startedAt,
				endedAt: Date.now(),
				logPath,
			});
		});
		if (queueWorkers && child.pid) {
			child.stdin.on("error", () => {});
			queueWorkers.register(child.pid, (error) => {
				child.stdin.end(
					error || shuttingDown || signal.aborted ? undefined : "start\n",
				);
			});
		}
	});
}

/**
 * Run the steps for `args` and return how each went, by step name: `{ skipped }`, `{ blocked }` (a
 * step it waits for failed) or `{ code, ok, ms, startOffset, text }`. `run(step, name, outDir)` starts
 * one step's command and says how it ended: `runCommand`, or in a test one that starts nothing. `log`
 * prints the one-line note each step leaves when it is done.
 */
export async function runSteps(
	args,
	steps,
	{ startedAt = Date.now(), run = runCommand, log = console.log } = {},
) {
	const results = {};
	const memo = new Map();
	const controller = new AbortController();
	const { signal } = controller;
	const runStep = (name) => {
		if (memo.has(name)) return memo.get(name);
		const promise = (async () => {
			const step = steps[name];
			if (args.skip.has(name)) return { skipped: true };
			if (signal.aborted) return { stopped: signal.reason };
			if (shuttingDown) return { blocked: "stopped during shutdown" };
			for (const dependency of step.after ?? []) {
				const before = await runStep(dependency);
				if (!before.skipped && !before.ok && !before.stopped) {
					return { blocked: `not run: ${dependency} failed` };
				}
			}
			if (signal.aborted) return { stopped: signal.reason };
			if (shuttingDown) return { blocked: "stopped during shutdown" };
			const ran = await run(step, name, args.outDir, signal);
			if (ran.stopped || signal.aborted) return { stopped: signal.reason };
			const verdict = step.parse(readFileSync(ran.logPath, "utf8"), ran.code);
			const result = {
				code: ran.code,
				ok: ran.code === 0 && verdict.ok,
				ms: ran.endedAt - ran.startedAt,
				startOffset: ran.startedAt - startedAt,
				text: verdict.text,
				...(verdict.counts && { counts: verdict.counts }),
			};
			if (
				!result.ok &&
				args.mode === "agent" &&
				args.failFast &&
				FAIL_FAST_STEPS.has(name)
			) {
				controller.abort(`${name} failed`);
			}
			log(
				`  ${name.padEnd(10)} ${result.ok ? "ok  " : "FAIL"} ${minutes(result.ms)}`,
			);
			return result;
		})().then((result) => {
			results[name] = result;
			return result;
		});
		memo.set(name, promise);
		return promise;
	};

	// The schedule. Every step is a lane of its own, so what the caller did not skip always runs:
	// the build too, which was no lane and started only as the step another one waits for, so with
	// check, vitest, chunks and playwright all skipped nothing asked for it and the gate ran
	// nothing and passed. The build starts at once, with biome, the migration check, the Python
	// tests and Fallow beside it (none of them touches `.svelte-kit/`); check, vitest and the
	// chunk check start when the build is done (see the header: a sync during the build breaks
	// the app it makes).
	// Phased: the e2e run starts when vitest, which wants every core, is done, so the
	// browsers do not share the machine with it. Overlap: nothing waits for vitest, which
	// shares the machine on a few threads.
	await Promise.all(
		STEP_ORDER.map((name) =>
			name === "playwright" && args.schedule === "phased"
				? runStep("vitest").then(() => runStep("playwright"))
				: runStep(name),
		),
	);
	return results;
}

/**
 * The summary screen for a run, and whether the run passed: the header, a line for each step, then
 * the total and the verdict. A run passes when at least one step ran and none failed. A run that
 * skipped every step checked nothing, and says so instead of passing.
 */
export function summarise({
	header,
	results,
	startedAt,
	endedAt,
	outDir,
	extraLines = [],
	cleanupError,
	mode,
	measured,
}) {
	const out = [...header];
	const failed = [];
	const stopped = [];
	// Every step has a result, skipped or run, and so a line: one that is missing is a bug in the
	// runner and stops it here, where it once dropped off the screen without a word.
	for (const name of STEP_ORDER) {
		const r = results[name];
		if (r.skipped) {
			out.push(`${name.padEnd(10)} skip`);
		} else if (r.stopped) {
			stopped.push(name);
			out.push(`${name.padEnd(10)} stop not finished: ${r.stopped}`);
		} else if (r.blocked) {
			failed.push(name);
			out.push(`${name.padEnd(10)} FAIL ${r.blocked}`);
		} else {
			if (!r.ok) failed.push(name);
			out.push(
				`${name.padEnd(10)} exit=${r.code} ${r.ok ? "ok  " : "FAIL"} ${minutes(r.ms).padStart(6)} (+${minutes(r.startOffset)}) :: ${r.text}`,
			);
		}
	}
	if (cleanupError) failed.push("queue cleanup");
	out.push(...extraLines);
	const nothingRan = STEP_ORDER.every((name) => results[name].skipped);
	let verdict = "ALL GATES PASSED";
	if (nothingRan) {
		verdict =
			"FAILED: nothing ran (every step was skipped), so nothing was checked";
	} else if (failed.length || stopped.length) {
		verdict = `FAILED: ${failed.join(", ") || "incomplete run"}${stopped.length ? ` (stopped: ${stopped.join(", ")})` : ""}`;
	}
	const elapsed = endedAt - startedAt;
	const target =
		mode === "release" && elapsed > RELEASE_TARGET_MS
			? measured?.counts
				? "; OVER THE 10-MINUTE TARGET"
				: "; over 10 minutes, but not a measured run"
			: "";
	out.push(
		`total ${minutes(elapsed)}; load at end ${loadNow()}; ${verdict}${target}`,
		`logs: ${relative(ROOT, outDir) || outDir}`,
	);
	return {
		summary: out.join("\n"),
		passed: !nothingRan && failed.length === 0 && stopped.length === 0,
	};
}

function unitSelectionFor(args) {
	if (args.mode === "release") return { kind: "all", reason: "release gate" };
	if (args.allUnitTests) return { kind: "all", reason: "--all-unit-tests" };
	try {
		const changes = changedSince(ROOT, args.base);
		const selection = chooseUnitTests({
			changes,
			alwaysRun: alwaysRunFiles(ROOT),
			base: args.base,
		});
		if (selection.kind === "related" && selection.paths.length === 0) {
			return { kind: "all", reason: "no selectable paths" };
		}
		return selection;
	} catch (error) {
		return { kind: "all", reason: `selection unavailable (${error.message})` };
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const outputRoot = args.outDir;
	mkdirSync(outputRoot, { recursive: true });
	args.outDir = mkdtempSync(join(outputRoot, "run-"));
	args.reportDir = args.outDir;
	if (!args.skip.has("vitest")) {
		args.unitSelection = unitSelectionFor(args);
		try {
			args.unitFileCount = unitTestFiles(ROOT).length;
		} catch {
			// The full run still owns discovery if Git cannot list files.
		}
		writeFileSync(
			join(args.outDir, "unit-selection.json"),
			JSON.stringify(args.unitSelection, null, 2),
		);
	}
	const workers = gateWorkers(args);
	const steps = defineSteps(args);
	const stateDir = gateStateDir(ROOT);
	const head = git(["rev-parse", "HEAD"]);
	const heavy = takesTheQueue(args);
	const holder = {
		pid: process.pid,
		mode: args.mode,
		worktree: ROOT,
		head,
		since: Date.now(),
	};
	const locks = [];
	const stopIfLost = (lock) => {
		if (!lock.held) return;
		locks.push(lock);
		void lock.lost.then((reason) => {
			if (reason) {
				console.error(`queue: ${reason}. Stopping the gate.`);
				void shutDown(1);
			}
		});
	};
	releaseQueue = async (stopWorkers) => {
		const errors = await Promise.all(
			locks.map((lock) => lock.release(stopWorkers)),
		);
		return errors.filter(Boolean).join(", ") || null;
	};
	if (heavy && process.platform === "darwin") {
		const local = await acquireGateLock({
			dir: join(ROOT, "data", "gate-worktree"),
			holder,
			pollMs: 500,
			maxWaitMs: 5000,
			log: (line) => {
				if (line.startsWith("queue: waiting"))
					console.log(line.replace("queue:", "worktree queue:"));
			},
		});
		if (!local.held)
			throw new Error(`worktree queue unavailable: ${local.reason}`);
		stopIfLost(local);
	}
	const shared = heavy
		? await acquireGateLock({ dir: stateDir, holder })
		: { held: false, waitedMs: 0, reason: "no heavy step" };
	stopIfLost(shared);
	const queue = {
		held: shared.held,
		waitedMs: shared.waitedMs,
		reason: shared.reason,
	};
	if (locks.length) {
		queueWorkers = {
			register(pid, callback) {
				Promise.all(
					locks.map(
						(lock) => new Promise((resolve) => lock.register(pid, resolve)),
					),
				).then((errors) => callback(errors.find(Boolean)));
			},
			unregister(pid) {
				for (const lock of locks) lock.unregister(pid);
			},
		};
	}
	const startedAt = Date.now();
	const header = [
		`gates ${args.mode} at ${git(["log", "--oneline", "-1"]).slice(0, 72)} — ${new Date(startedAt).toTimeString().slice(0, 8)}`,
		`machine: ${cpus().length} cores, load at start ${loadNow()}; e2e workers ${workers.browser}, vitest workers ${workers.vitest}; schedule ${args.schedule}`,
		queue.held
			? `queue: held${queue.waitedMs >= 1000 ? ` (waited ${minutes(queue.waitedMs)})` : ""}`
			: queue.reason === "no heavy step"
				? "queue: not needed (no heavy step)"
				: `queue: not taken: ${queue.reason}`,
	];
	for (const line of header) console.log(line);

	const sampler = startMachineSampler();
	const results = await runSteps(args, steps, { startedAt });
	const machine = sampler.stop();
	const measured = measuredVerdict(machine, queue);

	const endedAt = Date.now();
	const cleanupError = await releaseQueue?.(forceStopGroups);
	const cost = {};
	for (const suite of ["playwright", "vitest"]) {
		if (!("code" in results[suite])) continue;
		try {
			const path = join(args.reportDir, `${suite}.json`);
			const report = JSON.parse(readFileSync(path, "utf8"));
			cost[suite] =
				suite === "playwright"
					? playwrightCost(report, path)
					: {
							split: vitestSplit(
								stripAnsi(
									readFileSync(join(args.outDir, "vitest.log"), "utf8"),
								),
							),
							slowest: slowestUnitFiles(report, 5, ROOT),
						};
		} catch {
			// Timing is diagnostic and a crashed test process may have no report.
		}
	}
	const { passed } = summarise({
		header,
		results,
		startedAt,
		endedAt,
		outDir: args.outDir,
		cleanupError,
	});
	const entry = historyEntry({
		mode: args.mode,
		head,
		branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
		worktree: ROOT,
		startedAt,
		endedAt,
		passed,
		results,
		cost,
		machine,
		measured,
		queue,
		selection: args.unitSelection,
	});
	const extraLines = machineLines(machine, measured);
	if (cleanupError) extraLines.push(`queue: ${cleanupError}`);
	if (args.mode === "release") {
		extraLines.push(
			...comparisonLines(
				entry,
				previousRelease(readHistory(stateDir), entry.at),
			),
		);
	}
	const historyWarning = appendHistory(stateDir, entry);
	if (historyWarning) extraLines.push(historyWarning);
	const { summary } = summarise({
		header,
		results,
		startedAt,
		endedAt,
		outDir: args.outDir,
		extraLines,
		cleanupError,
		mode: args.mode,
		measured,
	});
	console.log(`\n${summary}`);
	const summaryJson = JSON.stringify(
		{
			mode: args.mode,
			head,
			results,
			cost,
			reportDir: args.reportDir,
			workers,
			queue,
			machine,
			measured,
			selection: args.unitSelection,
			totalMs: endedAt - startedAt,
		},
		null,
		2,
	);
	for (const [name, body] of [
		["summary.txt", `${summary}\n`],
		["summary.json", `${summaryJson}\n`],
	]) {
		writeFileSync(join(args.outDir, name), body);
		// The output root exposes the latest complete summary; its reportDir
		// identifies this run's immutable logs, even if a caller reuses the root.
		const pending = join(outputRoot, `.${name}.${process.pid}.tmp`);
		writeFileSync(pending, body);
		renameSync(pending, join(outputRoot, name));
	}

	if (shuttingDown) return;
	process.exit(passed ? 0 : 1);
}

// Only run when executed directly, so the unit test can import the readers.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch(async (error) => {
		await forceStopGroups();
		await releaseQueue?.(forceStopGroups);
		console.error(error);
		process.exit(1);
	});
}
