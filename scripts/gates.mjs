// The gate runner: every release gate in one command, the independent ones in
// parallel, one screen of summary at the end. `scripts/gates.sh` is the entry.
//
//   scripts/gates.sh release <out-dir> [options]
//       Every static gate, then the WHOLE Playwright suite minus the quarantine
//       list (tests/e2e/quarantine.json), so a new spec joins the gate by existing.
//   scripts/gates.sh agent <out-dir> [options] [spec ...]
//       Every static gate, then the specs it is given in full plus the @smoke
//       tests of every other file: what an agent runs once, at the end.
//
// Options
//   --workers N            Playwright workers (default: E2E_WORKERS, else the config's default)
//   --port P               first port of the e2e servers (default: E2E_PORT, else 5175); slot N uses P+N
//   --skip a,b             leave steps out: check, biome, migrations, vitest, build, chunks, fallow, playwright
//   --fallow-baseline F    Fallow baseline to compare against
//   --schedule S           "phased" (default): the static gates first, side by side, then the e2e run on a
//                          machine with nothing else on it; "overlap": vitest, Fallow and the e2e run share
//                          the machine (vitest on a few threads), a minute or two faster and noisier
//
// THE BUILD GOES FIRST. `npm run check` (`svelte-kit sync`) and vitest (its SvelteKit plugin
// syncs when it starts) both rewrite `.svelte-kit/`, which `vite build` reads. Run side by
// side, the build still exits 0 and its chunk check still passes, but the app it made does
// not hydrate (a page error, every input stays disabled) and the e2e run that follows spends
// forty minutes failing on 15-second timeouts. Measured: check + build started together
// broke the build, check started after it did not. So the build runs alone with respect to
// those two; biome, the migration check and Fallow, which never touch `.svelte-kit/`, run
// beside it. The build is about 16 s on its own.
//
// What the numbers mean and what the baselines are: docs/plans/claude-at-home-2/phase-5/common.md.
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The repo this script lives in, wherever it is run from; `<out-dir>` is the caller's.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The numbers the static gates are held to (phase-5/common.md, the M3 release gates). */
const BASELINE = {
	buildUnusedCss: 32,
	buildAria: 2,
	fallowCircular: 4,
	fallowFile: join(
		homedir(),
		".cache",
		"alfyai-artifacts",
		"fallow-baseline-00ef6d2a.json",
	),
};

const STEP_ORDER = [
	"check",
	"biome",
	"migrations",
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
		"usage: scripts/gates.sh <release|agent> <out-dir> [--workers N] [--port P] [--skip a,b] [--fallow-baseline F] [--schedule phased|overlap] [spec ...]",
	);
	process.exit(2);
}

function parseArgs(argv) {
	const [mode, outDir, ...rest] = argv;
	if (!["release", "agent"].includes(mode) || !outDir) usage();
	const args = {
		mode,
		outDir: resolve(outDir),
		workers: process.env.E2E_WORKERS,
		port: process.env.E2E_PORT,
		skip: new Set(),
		fallowBaseline: BASELINE.fallowFile,
		schedule: "phased",
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
		else if (flag.startsWith("--")) usage(`unknown option ${flag}`);
		else args.specs.push(flag);
	}
	for (const name of args.skip) {
		if (!STEP_ORDER.includes(name)) {
			usage(`--skip: no step called "${name}" (${STEP_ORDER.join(", ")})`);
		}
	}
	if (!["phased", "overlap"].includes(args.schedule)) {
		usage('--schedule must be "phased" or "overlap"');
	}
	if (mode === "release" && args.specs.length > 0) {
		usage("release mode runs the whole suite; it takes no spec files");
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

/**
 * One step: how to run it and how to read its log. `parse(log)` returns
 * `{ ok, text }`; a step passes when it exits 0 and `ok` holds.
 */
export function defineSteps(args) {
	const jsonReport = join(args.outDir, "playwright.json");
	const e2eArgs = [];
	const e2eEnv = {
		...(args.port ? { E2E_PORT: String(args.port) } : {}),
		...(args.workers ? { E2E_WORKERS: String(args.workers) } : {}),
		E2E_JSON_REPORT: jsonReport,
		E2E_APPLY_QUARANTINE: "1",
	};
	if (args.mode === "agent") {
		// One Playwright run, two projects (playwright.config.ts): the named files in
		// full, and the @smoke tests of every other file, sharing the same workers.
		if (args.specs.length > 0) e2eEnv.E2E_FULL_SPECS = args.specs.join(",");
		e2eArgs.push(...args.specs, ...filesWithSmokeTests());
	}
	// Beside the e2e run, vitest gets a few threads so the browsers keep the cores
	// their timing-sensitive specs were written on; on its own it takes them all.
	const vitestThreads = Math.max(2, Math.floor(cpus().length / 4));
	return {
		// `check` and `vitest` sync `.svelte-kit/`: never while the build is reading it.
		check: {
			cmd: ["npm", "run", "check"],
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
		vitest: {
			cmd:
				args.schedule === "overlap"
					? ["npx", "vitest", "run", `--maxWorkers=${vitestThreads}`]
					: ["npm", "test"],
			after: ["build"],
			parse: parseVitestLog,
		},
		build: { cmd: ["npm", "run", "build"], parse: parseBuildLog },
		chunks: {
			cmd: ["npm", "run", "check:artifact-chunks"],
			after: ["build"],
			parse: parseChunksLog,
		},
		fallow: {
			cmd: [
				"npx",
				"fallow",
				"--no-cache",
				"--format",
				"json",
				"--quiet",
				"--score",
				"--output-file",
				join(args.outDir, "fallow.json"),
			],
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
	const done = stripAnsi(log).match(
		/COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS/,
	);
	if (!done) return { ok: false, text: lastLine(log) };
	return {
		ok: Number(done[2]) === 0,
		text: `${done[2]} errors, ${done[3]} warnings in ${done[1]} files`,
	};
}

export function parseVitestLog(log) {
	const text = stripAnsi(log);
	const files = text.match(/Test Files\s+(.*)/)?.[1]?.trim();
	const tests = text.match(/\n\s*Tests\s+(.*)/)?.[1]?.trim();
	const failed = /\bfailed\b/.test(`${files ?? ""} ${tests ?? ""}`);
	return {
		ok: Boolean(tests) && !failed,
		text: `files ${files ?? "?"}; tests ${tests ?? "?"}`,
	};
}

export function parseBuildLog(log) {
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

// Fallow: the comparison wave-2-5/gates.sh made in python. Positions are dropped
// from each finding, so a finding that only moved down a file is not a new one.
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
function normalise(value) {
	if (Array.isArray(value)) return value.map(normalise);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.filter((key) => !POSITION_KEYS.has(key))
				.sort()
				.map((key) => [key, normalise(value[key])]),
		);
	}
	return value;
}
export function compareFallow(currentPath, baselinePath) {
	let current;
	let baseline;
	try {
		current = JSON.parse(readFileSync(currentPath, "utf8")).check;
	} catch {
		return { ok: false, text: "no Fallow report was written" };
	}
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf8")).check;
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
	const text = `total=${current.total_issues} circular=${circular} new_vs_baseline=${added.length} gone_vs_baseline=${gone}`;
	return {
		ok: added.length === 0 && circular <= BASELINE.fallowCircular,
		text:
			added.length > 0
				? `${text}\n      NEW ${added.slice(0, 6).join("\n      NEW ")}`
				: text,
	};
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
	const lines = [
		`${expected} passed, ${skipped} skipped, ${unexpected} failed, ${flaky} flaky`,
	];
	for (const title of failed.slice(0, 12)) lines.push(`      FAILED ${title}`);
	return { ok: unexpected === 0 && flaky === 0, text: lines.join("\n") };
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
function signalGroups(signal) {
	for (const child of active) {
		try {
			process.kill(-child.pid, signal);
		} catch {
			// already gone
		}
	}
}
/**
 * Stop what the gates started, politely first: Playwright tears its servers down on
 * SIGINT (and only on SIGINT), so SIGINT goes to every group, and what is still alive
 * after the grace period is killed.
 */
async function shutDown(code) {
	signalGroups("SIGINT");
	const deadline = Date.now() + 8000;
	while (active.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	signalGroups("SIGKILL");
	process.exit(code);
}
process.on("SIGINT", () => shutDown(130));
process.on("SIGTERM", () => shutDown(143));

function runCommand(step, name, outDir) {
	const logPath = join(outDir, `${name}.log`);
	const startedAt = Date.now();
	return new Promise((done) => {
		const fd = openSync(logPath, "w");
		const child = spawn(step.cmd[0], step.cmd.slice(1), {
			cwd: ROOT,
			env: { ...childEnv(), ...(step.env ?? {}) },
			stdio: ["ignore", fd, fd],
			detached: true,
		});
		closeSync(fd);
		active.add(child);
		child.on("error", () => {
			active.delete(child);
			done({ code: 127, startedAt, endedAt: Date.now(), logPath });
		});
		child.on("exit", (code, signal) => {
			active.delete(child);
			done({
				code: code ?? (signal ? 128 : 1),
				startedAt,
				endedAt: Date.now(),
				logPath,
			});
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.outDir, { recursive: true });
	const steps = defineSteps(args);
	const startedAt = Date.now();
	const header = [
		`gates ${args.mode} at ${git(["log", "--oneline", "-1"]).slice(0, 72)} — ${new Date(startedAt).toTimeString().slice(0, 8)}`,
		`machine: ${cpus().length} cores, load at start ${loadNow()}; e2e workers ${args.workers ?? "default"}; schedule ${args.schedule}`,
	];
	for (const line of header) console.log(line);

	const results = {};
	const memo = new Map();
	const runStep = (name) => {
		if (memo.has(name)) return memo.get(name);
		const promise = (async () => {
			const step = steps[name];
			if (args.skip.has(name)) return { skipped: true };
			for (const dependency of step.after ?? []) {
				const before = await runStep(dependency);
				if (!before.skipped && !before.ok) {
					return { blocked: `not run: ${dependency} failed` };
				}
			}
			const ran = await runCommand(step, name, args.outDir);
			const verdict = step.parse(readFileSync(ran.logPath, "utf8"));
			const result = {
				code: ran.code,
				ok: ran.code === 0 && verdict.ok,
				ms: ran.endedAt - ran.startedAt,
				startOffset: ran.startedAt - startedAt,
				text: verdict.text,
			};
			console.log(
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

	// The schedule. The build starts at once, with biome, the migration check and Fallow beside
	// it (none of them touches `.svelte-kit/`); check, vitest and the chunk check start when
	// the build is done (see the header: a sync during the build breaks the app it makes).
	// Phased: the e2e run starts when vitest, which wants every core, is done, so the
	// browsers do not share the machine with it. Overlap: nothing waits for vitest, which
	// shares the machine on a few threads.
	const lanes = [
		runStep("check"),
		runStep("biome"),
		runStep("migrations"),
		runStep("fallow"),
		runStep("chunks"),
		runStep("vitest"),
	];
	lanes.push(
		(async () => {
			if (args.schedule === "phased") await runStep("vitest");
			await runStep("playwright");
		})(),
	);
	await Promise.all(lanes);

	const endedAt = Date.now();
	const out = [...header];
	const failed = [];
	for (const name of STEP_ORDER) {
		const r = results[name];
		if (!r) continue;
		if (r.skipped) {
			out.push(`${name.padEnd(10)} skip`);
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
	out.push(
		`total ${minutes(endedAt - startedAt)}; load at end ${loadNow()}; ${failed.length === 0 ? "ALL GATES PASSED" : `FAILED: ${failed.join(", ")}`}`,
		`logs: ${relative(ROOT, args.outDir) || args.outDir}`,
	);
	const summary = out.join("\n");
	console.log(`\n${summary}`);
	writeFileSync(join(args.outDir, "summary.txt"), `${summary}\n`);
	writeFileSync(
		join(args.outDir, "summary.json"),
		JSON.stringify(
			{
				mode: args.mode,
				head: git(["rev-parse", "HEAD"]),
				results,
				totalMs: endedAt - startedAt,
			},
			null,
			2,
		),
	);
	process.exit(failed.length === 0 ? 0 : 1);
}

// Only run when executed directly, so the unit test can import the readers.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		signalGroups("SIGKILL");
		console.error(error);
		process.exit(1);
	});
}
