#!/usr/bin/env tsx
//
// The artifact-contract eval harness's live orchestration script (Feature 2
// · Artifacts). Slice 5a lands the harness CORE here, on Slice 0's skeleton
// (decisions.md ruling 44): the flag table, the known-bad-first refusal, the
// sequential/one-retry/two-429-stop execution policy, and the "no suites
// registered yet" graceful exit (`0`). No suite is registered yet (cases.ts
// is empty), and this file writes NO suite of its own — each type slice
// appends its own `suites/<suite>.ts`, fixtures and `cases.ts` entry, and
// runs its own live gate before it is called done. A *live* run with no
// model endpoint configured is a different, harder failure (ruling 54): see
// client.ts's `resolveEvalArtifactsClient`, which throws instead of quietly
// doing nothing.
//
// The testable core (`parseArgv`, `runSuite`, `recordSuiteResponses`) is
// exported and takes its dependencies (the case registry, the model client,
// the scorer, a committed-response loader) as parameters, so run.test.ts can
// prove the known-bad gate, the retry/circuit-breaker policy, and the replay
// path against a FAKE suite and fixture set — without a model client and
// without mutating this file's own (empty) case registry. `main()` is the
// thin CLI wrapper that wires the real cases.ts/client.ts/scoring.ts
// together; it only runs when this file is executed directly (the guard at
// the bottom), never when imported by a test.
//
// Run with: npx tsx scripts/eval-artifact-contracts/run.ts --suite <name>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EVAL_CASES } from "./cases";
import {
	type EvalArtifactsModelClient,
	resolveEvalArtifactsClient,
} from "./client";
import {
	EVAL_ARTIFACTS_MAX_CONSECUTIVE_RATE_LIMIT_ERRORS,
	EVAL_ARTIFACTS_MAX_RETRIES_PER_CASE,
	type EvalArtifactsThinkingMode,
	resolveEvalArtifactsConfig,
} from "./config";
import { getSuiteEvaluator } from "./evaluators";
import { getSuiteScorer } from "./scoring";
import type {
	EvalAttempt,
	EvalCase,
	EvalCaseOutcome,
	EvalCommittedEvaluation,
	EvalCommittedResponse,
	EvalSuiteReport,
} from "./types";

const HELP_TEXT = `
Artifact-contract eval harness (Feature 2 · Artifacts)

Usage:
  npx tsx scripts/eval-artifact-contracts/run.ts --suite <name> [options]

Flags:
  --suite <name>   file, document, app, canvas, slides, verification, or all
  --replay         Re-score committed responses under fixtures/<suite>/responses.
                   No model client is constructed; no key is required.
  --skip-model     Alias of --replay (the App prototype's own env-switch
                   spelling, PROTO_APPS_SKIP_MODEL, offered as a flag too).
  --limit <n>      Cap the number of non-known-bad fixtures run.
  --only <ids>     Comma-separated fixture ids to run.
  --out <dir>      Override the results/ output directory.
  --help           Print this table.

Env switches (EVAL_ARTIFACTS_* prefixed; a flag above overrides its switch):
  EVAL_ARTIFACTS_SUITE, EVAL_ARTIFACTS_ONLY, EVAL_ARTIFACTS_LIMIT,
  EVAL_ARTIFACTS_REPLAY, EVAL_ARTIFACTS_SKIP_MODEL, EVAL_ARTIFACTS_SKIP_EVAL,
  EVAL_ARTIFACTS_THINKING, EVAL_ARTIFACTS_OUT, EVAL_ARTIFACTS_BASE_URL,
  EVAL_ARTIFACTS_MODEL, EVAL_ARTIFACTS_API_KEY.

Known-bad-first: each suite's declared known-bad fixtures run before anything
else and must all score "bad"; a real score is only trusted once every one of
them has. A suite with no known-bad fixtures declared passes this gate
vacuously, with a warning — it has not yet earned the harness's trust either.
`.trim();

export interface ParsedArgs {
	suite: string | null;
	replay: boolean;
	limit: number | null;
	only: string[] | null;
	out: string | null;
	help: boolean;
}

export function parseArgv(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		suite: null,
		replay: false,
		limit: null,
		only: null,
		out: null,
		help: false,
	};
	let index = 0;
	while (index < argv.length) {
		const token = argv[index];
		index += 1;
		switch (token) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--replay":
			case "--skip-model":
				args.replay = true;
				break;
			case "--suite":
				args.suite = argv[index] ?? null;
				index += 1;
				break;
			case "--limit": {
				const raw = argv[index];
				index += 1;
				const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
				args.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
				break;
			}
			case "--only": {
				const raw = argv[index];
				index += 1;
				args.only = raw
					? raw
							.split(",")
							.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0)
					: null;
				break;
			}
			case "--out":
				args.out = argv[index] ?? null;
				index += 1;
				break;
			default:
				break;
		}
	}
	return args;
}

// ── Dependency injection surface ──────────────────────────────────────────
//
// `runSuite`/`recordSuiteResponses` never import client.ts, cases.ts or
// scoring.ts directly — they take this shape, so run.test.ts can exercise
// the real known-bad-gate/retry/circuit-breaker logic against a fake suite
// and a fake client with no model call and no mutation of the real registry.

export interface RunDeps {
	cases: Record<string, EvalCase[]>;
	client: EvalArtifactsModelClient | null;
	loadCommittedResponse: (
		suite: string,
		caseId: string,
	) => EvalCommittedResponse | null;
	score: (
		evalCase: EvalCase,
		attempt: EvalAttempt,
		evaluation?: unknown,
	) => { verdict: "good" | "acceptable" | "bad"; reasons: string[] };
	log: (message: string) => void;
	defaultThinking: EvalArtifactsThinkingMode;
	/**
	 * Ruling 56's optional per-suite step: runs (live) after a successful
	 * attempt, or is skipped under --replay in favor of
	 * `loadCommittedEvaluation` below. Always callable — a suite with none
	 * registered (document, canvas, slides, verification today) resolves
	 * `null`, mirroring how `score` falls back to a generic scorer for an
	 * unregistered suite rather than making the field itself optional.
	 */
	evaluate: (
		evalCase: EvalCase,
		attempt: EvalAttempt,
	) => Promise<unknown | null>;
	/** The committed counterpart for --replay — no browser, no model. */
	loadCommittedEvaluation: (suite: string, caseId: string) => unknown | null;
}

function isRateLimitOrServerError(error: unknown): boolean {
	const status = (error as { status?: number } | null | undefined)?.status;
	return typeof status === "number" && (status === 429 || status >= 500);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type CaseAttemptOutcome = { attempt: EvalAttempt } | { error: unknown };

async function attemptCase(
	evalCase: EvalCase,
	options: { replay: boolean },
	deps: RunDeps,
): Promise<CaseAttemptOutcome> {
	if (options.replay) {
		const committed = deps.loadCommittedResponse(evalCase.suite, evalCase.id);
		if (!committed) {
			return {
				error: new Error(
					`No committed response for case "${evalCase.id}" (fixtures/${evalCase.suite}/responses/${evalCase.id}.json) — record one first (EVAL_ARTIFACTS_SKIP_EVAL) or run live.`,
				),
			};
		}
		return {
			attempt: {
				caseId: evalCase.id,
				suite: evalCase.suite,
				response: committed.response,
				durationMs: committed.durationMs,
			},
		};
	}
	if (!deps.client) {
		return { error: new Error("No model client configured") };
	}
	const startedAt = Date.now();
	let result: { text: string };
	try {
		result = await deps.client.send({
			prompt: evalCase.prompt,
			thinking: evalCase.thinking ?? deps.defaultThinking,
		});
	} catch (error) {
		// A rejected send() (a non-ok HTTP status, a network error) is exactly
		// what the retry/circuit-breaker policy below is for — it must come
		// back as a value here, never propagate and abort every later case.
		return { error };
	}
	return {
		attempt: {
			caseId: evalCase.id,
			suite: evalCase.suite,
			response: result.text,
			durationMs: Date.now() - startedAt,
		},
	};
}

/**
 * Strictly sequential, one retry maximum, stop after two consecutive
 * 429/5xx — the App prototype's own discipline, applied generically here
 * (config.ts's EVAL_ARTIFACTS_MAX_RETRIES_PER_CASE /
 * _MAX_CONSECUTIVE_RATE_LIMIT_ERRORS). A case that fails after its retry (or
 * has no committed response in replay) scores "bad" with the failure as its
 * reason, rather than throwing and losing every case after it.
 */
async function runCasesSequentially(
	cases: EvalCase[],
	options: { replay: boolean },
	deps: RunDeps,
): Promise<{
	results: EvalCaseOutcome[];
	stoppedEarly: boolean;
}> {
	const results: EvalCaseOutcome[] = [];
	let consecutiveRateLimitErrors = 0;

	for (const evalCase of cases) {
		let outcome = await attemptCase(evalCase, options, deps);
		let retriesLeft = options.replay ? 0 : EVAL_ARTIFACTS_MAX_RETRIES_PER_CASE;
		while ("error" in outcome && retriesLeft > 0) {
			retriesLeft -= 1;
			outcome = await attemptCase(evalCase, options, deps);
		}

		if ("error" in outcome) {
			// The triggering case's own outcome is recorded BEFORE the circuit
			// breaker returns, so a report never silently drops the case that
			// tripped it — "stopped early" means every case after this one was
			// never attempted, not that this one's result went unrecorded.
			results.push({
				caseId: evalCase.id,
				verdict: "bad",
				reasons: [
					`case ${evalCase.id}: call failed — ${errorMessage(outcome.error)}`,
				],
			});
			if (!options.replay && isRateLimitOrServerError(outcome.error)) {
				consecutiveRateLimitErrors += 1;
				if (
					consecutiveRateLimitErrors >=
					EVAL_ARTIFACTS_MAX_CONSECUTIVE_RATE_LIMIT_ERRORS
				) {
					deps.log(
						`Stopping after ${consecutiveRateLimitErrors} consecutive rate-limit/server errors.`,
					);
					return { results, stoppedEarly: true };
				}
			}
			continue;
		}

		consecutiveRateLimitErrors = 0;
		// Ruling 56: the evaluate step runs ONCE, on the winning attempt only
		// (never per retry) — live, or loaded from the committed fixture under
		// --replay, never both. The (still synchronous) scorer only reads
		// whatever comes back; it never awaits anything itself. A live
		// evaluate step that THROWS (a browser crash, a Playwright timeout)
		// degrades to "no evaluation available" rather than losing every case
		// after it — the same "never abort the whole run over one case" rule
		// the retry/circuit-breaker policy already applies to the model call.
		let evaluation: unknown | null = null;
		if (options.replay) {
			evaluation = deps.loadCommittedEvaluation(evalCase.suite, evalCase.id);
		} else {
			try {
				evaluation = await deps.evaluate(evalCase, outcome.attempt);
			} catch (error) {
				deps.log(
					`[${evalCase.suite}] case ${evalCase.id}: evaluate step failed — ${errorMessage(error)}`,
				);
			}
		}
		const score = deps.score(
			evalCase,
			outcome.attempt,
			evaluation ?? undefined,
		);
		results.push({
			caseId: evalCase.id,
			verdict: score.verdict,
			reasons: score.reasons,
			...(evaluation !== null && evaluation !== undefined
				? { evaluation }
				: {}),
		});
	}

	return { results, stoppedEarly: false };
}

/**
 * One suite's whole run: the known-bad fixtures first, checked in full
 * before anything else counts (ruling 25 — "the harness can be seen to
 * fail"), then the real cases. `options.limit` never applies to the
 * known-bad set: limiting the harness's own gate would defeat it.
 */
export async function runSuite(
	suiteName: string,
	options: { replay: boolean; limit: number | null; only: string[] | null },
	deps: RunDeps,
): Promise<EvalSuiteReport> {
	const allCases = deps.cases[suiteName] ?? [];

	// The known-bad set is computed from the FULL registry, before --only is
	// applied, and --only is never applied to it below: --only exists to
	// select which fixtures to iterate on (the README's "how to add a
	// fixture" workflow), and a developer naming a new regular fixture has no
	// reason to also name the suite's known-bad ids. Filtering known-bad by
	// --only would silently turn "not selected" into "not declared", which
	// downgrades the gate to a vacuous pass with only a log warning — exactly
	// the failure mode the known-bad-first rule exists to prevent.
	const knownBad = allCases.filter((evalCase) => evalCase.knownBad === true);
	let regular = allCases.filter((evalCase) => evalCase.knownBad !== true);
	if (options.only) {
		const onlyIds = new Set(options.only);
		regular = regular.filter((evalCase) => onlyIds.has(evalCase.id));
	}
	if (options.limit !== null) regular = regular.slice(0, options.limit);

	if (knownBad.length === 0) {
		deps.log(
			`[${suiteName}] no known-bad fixtures declared — the gate passes vacuously, but this suite has not proven the harness can see it fail.`,
		);
	}

	const knownBadRun = await runCasesSequentially(knownBad, options, deps);
	const knownBadFailures = knownBadRun.results
		.filter((result) => result.verdict !== "bad")
		.map((result) => result.caseId);

	if (knownBadFailures.length > 0) {
		return {
			suite: suiteName,
			knownBadFailedAsExpected: false,
			knownBadFailures,
			results: [],
			stoppedEarly: knownBadRun.stoppedEarly,
		};
	}

	const regularRun = knownBadRun.stoppedEarly
		? { results: [], stoppedEarly: true }
		: await runCasesSequentially(regular, options, deps);

	return {
		suite: suiteName,
		knownBadFailedAsExpected: true,
		knownBadFailures: [],
		results: regularRun.results,
		stoppedEarly: regularRun.stoppedEarly,
	};
}

/**
 * EVAL_ARTIFACTS_SKIP_EVAL: call the model, write raw responses, do not
 * score. How a suite's `fixtures/<suite>/responses/*.json` get (re)recorded
 * for `--replay` — never gated on the known-bad rule, because nothing here
 * is being trusted yet.
 */
export interface RecordedAttempt {
	attempt: EvalAttempt;
	/** Ruling 56: the evaluate step's result for THIS attempt, recorded next
	 * to it so both are committed together for --replay. `null` for a suite
	 * with no evaluate step, exactly like a live run's per-case result. */
	evaluation: unknown | null;
}

export async function recordSuiteResponses(
	suiteName: string,
	options: { limit: number | null; only: string[] | null },
	deps: Pick<RunDeps, "cases" | "client" | "defaultThinking" | "evaluate">,
): Promise<RecordedAttempt[]> {
	if (!deps.client) {
		throw new Error("recordSuiteResponses needs a configured model client");
	}
	let cases = deps.cases[suiteName] ?? [];
	if (options.only) {
		const onlyIds = new Set(options.only);
		cases = cases.filter((evalCase) => onlyIds.has(evalCase.id));
	}
	if (options.limit !== null) cases = cases.slice(0, options.limit);

	const recorded: RecordedAttempt[] = [];
	for (const evalCase of cases) {
		const startedAt = Date.now();
		const result = await deps.client.send({
			prompt: evalCase.prompt,
			thinking: evalCase.thinking ?? deps.defaultThinking,
		});
		const attempt: EvalAttempt = {
			caseId: evalCase.id,
			suite: suiteName,
			response: result.text,
			durationMs: Date.now() - startedAt,
		};
		// Recording (EVAL_ARTIFACTS_SKIP_EVAL) is what PRODUCES the committed
		// evaluation fixtures --replay later reads, so it must run the same
		// live evaluate step a real scoring run would (ruling 56).
		const evaluation = await deps.evaluate(evalCase, attempt);
		recorded.push({ attempt, evaluation });
	}
	return recorded;
}

// ── Disk I/O (the CLI's own concern; kept out of the testable core above) ──

export function loadCommittedResponseFromDisk(
	fixturesRoot: string,
	suite: string,
	caseId: string,
): EvalCommittedResponse | null {
	const path = join(fixturesRoot, suite, "responses", `${caseId}.json`);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<EvalCommittedResponse>;
		if (typeof raw.response !== "string") return null;
		return { response: raw.response, durationMs: raw.durationMs };
	} catch {
		return null;
	}
}

export function writeCommittedResponseToDisk(
	fixturesRoot: string,
	attempt: EvalAttempt,
): string {
	const dir = join(fixturesRoot, attempt.suite, "responses");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${attempt.caseId}.json`);
	const payload: EvalCommittedResponse = {
		response: attempt.response,
		durationMs: attempt.durationMs,
	};
	writeFileSync(path, JSON.stringify(payload, null, 2));
	return path;
}

/**
 * Ruling 56's committed counterpart to the response above, under
 * `fixtures/<suite>/evaluations/<caseId>.json` — read by --replay instead of
 * running a real browser. Returns `null` (never throws) for a suite/case
 * with no recorded evaluation, same as `loadCommittedResponseFromDisk`.
 */
export function loadCommittedEvaluationFromDisk(
	fixturesRoot: string,
	suite: string,
	caseId: string,
): unknown | null {
	const path = join(fixturesRoot, suite, "evaluations", `${caseId}.json`);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<EvalCommittedEvaluation>;
		return "evaluation" in raw ? (raw.evaluation ?? null) : null;
	} catch {
		return null;
	}
}

export function writeCommittedEvaluationToDisk(
	fixturesRoot: string,
	suite: string,
	caseId: string,
	evaluation: unknown,
): string {
	const dir = join(fixturesRoot, suite, "evaluations");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${caseId}.json`);
	const payload: EvalCommittedEvaluation = { evaluation };
	writeFileSync(path, JSON.stringify(payload, null, 2));
	return path;
}

/**
 * `results/results.json` — gitignored (never source). No screenshot gallery
 * here: that is a per-suite concern (Canvas's own arrangement screenshots,
 * named in slice-5.md) for whichever type slice needs one, not this core.
 */
export function writeResultsJson(
	outDir: string,
	reports: EvalSuiteReport[],
): string {
	mkdirSync(outDir, { recursive: true });
	const path = join(outDir, "results.json");
	writeFileSync(
		path,
		JSON.stringify(
			{ generatedAt: new Date().toISOString(), suites: reports },
			null,
			2,
		),
	);
	return path;
}

function resolveSuiteNames(
	suiteArg: string,
	cases: Record<string, EvalCase[]>,
): string[] {
	return suiteArg === "all" ? Object.keys(cases) : [suiteArg];
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const args = parseArgv(argv);
	if (args.help) {
		console.log(HELP_TEXT);
		return 0;
	}

	const config = resolveEvalArtifactsConfig();
	const suiteArg = args.suite ?? config.suite;
	const replay = args.replay || config.replay;
	const limit = args.limit ?? config.limit;
	const only = args.only ?? config.only;
	const outDir = args.out ?? config.outDir;

	const suiteNames = resolveSuiteNames(suiteArg, EVAL_CASES);
	const registeredSuites = suiteNames.filter(
		(name) => (EVAL_CASES[name] ?? []).length > 0,
	);

	if (registeredSuites.length === 0) {
		console.log(
			`[eval-artifact-contracts] No cases are registered ${
				suiteArg === "all" ? "for any suite" : `for suite "${suiteArg}"`
			} yet. This is the Slice 0/5a skeleton: each type slice appends its own ` +
				"suite (document, app, verification, canvas, slides) as it lands. Exiting 0.",
		);
		return 0;
	}

	// A live run REQUIRES EVAL_ARTIFACTS_BASE_URL/_MODEL (ruling 54: no more
	// ~/.config/opencode/opencode.json fallback). resolveEvalArtifactsClient
	// throws one message naming both, with no network call, when either is
	// missing; caught here so the harness fails with that one message rather
	// than the generic "Unexpected error" wrapper below. `--replay` never
	// reaches this at all.
	let client: EvalArtifactsModelClient | null = null;
	if (!replay) {
		try {
			client = resolveEvalArtifactsClient({
				baseUrl: config.baseUrl,
				model: config.model,
				apiKey: config.apiKey,
			});
		} catch (error) {
			console.error(
				`[eval-artifact-contracts] ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return 1;
		}
	}

	// dirname(fileURLToPath(import.meta.url)), NOT
	// fileURLToPath(new URL(".", import.meta.url)): the latter matches
	// Vite's own static asset-URL convention, so a test harness that loads
	// this file through Vite (vitest) — unlike plain `tsx` — would rewrite
	// it into a dev-server URL instead of resolving the real `file:` path.
	// See config.ts's `DEFAULT_OUT_DIR` comment for the full story.
	const fixturesRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		"fixtures",
	);
	const log = (message: string) =>
		console.log(`[eval-artifact-contracts] ${message}`);

	if (config.skipEval) {
		if (replay) {
			console.log(
				"[eval-artifact-contracts] --replay and EVAL_ARTIFACTS_SKIP_EVAL together make no sense " +
					"(replay never calls a model). Exiting 0 without recording anything.",
			);
			return 0;
		}
		for (const suite of registeredSuites) {
			const recorded = await recordSuiteResponses(
				suite,
				{ limit, only },
				{
					cases: EVAL_CASES,
					client,
					defaultThinking: config.thinking,
					evaluate: (evalCase, attempt) =>
						(getSuiteEvaluator(evalCase.suite) ?? (async () => null))(
							evalCase,
							attempt,
						),
				},
			);
			for (const { attempt, evaluation } of recorded) {
				const path = writeCommittedResponseToDisk(fixturesRoot, attempt);
				log(`recorded ${path}`);
				if (evaluation !== null && evaluation !== undefined) {
					const evalPath = writeCommittedEvaluationToDisk(
						fixturesRoot,
						attempt.suite,
						attempt.caseId,
						evaluation,
					);
					log(`recorded ${evalPath}`);
				}
			}
		}
		return 0;
	}

	const deps: RunDeps = {
		cases: EVAL_CASES,
		client,
		loadCommittedResponse: (suite, caseId) =>
			loadCommittedResponseFromDisk(fixturesRoot, suite, caseId),
		loadCommittedEvaluation: (suite, caseId) =>
			loadCommittedEvaluationFromDisk(fixturesRoot, suite, caseId),
		score: (evalCase, attempt, evaluation) =>
			getSuiteScorer(evalCase.suite)(evalCase, attempt, evaluation),
		evaluate: (evalCase, attempt) =>
			(getSuiteEvaluator(evalCase.suite) ?? (async () => null))(
				evalCase,
				attempt,
			),
		log,
		defaultThinking: config.thinking,
	};

	let sawFailure = false;
	const reports: EvalSuiteReport[] = [];
	for (const suite of registeredSuites) {
		const report = await runSuite(suite, { replay, limit, only }, deps);
		reports.push(report);

		if (!report.knownBadFailedAsExpected) {
			sawFailure = true;
			console.error(
				`[eval-artifact-contracts] Suite "${suite}": known-bad fixture(s) did not fail as declared ` +
					`(${report.knownBadFailures.join(", ")}). Refusing to trust this suite's scores.`,
			);
			continue;
		}

		const badCount = report.results.filter(
			(result) => result.verdict === "bad",
		).length;
		if (badCount > 0) sawFailure = true;
		log(
			`Suite "${suite}": ${report.results.length} case(s) scored` +
				(report.stoppedEarly
					? " (stopped early — rate-limit/server errors)"
					: "") +
				`, ${badCount} bad.`,
		);
	}

	// resolve (not join): an absolute --out/EVAL_ARTIFACTS_OUT path must be
	// used as given, not concatenated onto the current directory.
	const resultsPath = writeResultsJson(resolve(process.cwd(), outDir), reports);
	log(`results written to ${resultsPath}`);
	return sawFailure ? 1 : 0;
}

// Only runs when this file is the process entry point — never on import, so
// run.test.ts can exercise parseArgv/runSuite/recordSuiteResponses freely.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			console.error("[eval-artifact-contracts] Unexpected error:", error);
			process.exitCode = 1;
		});
}
