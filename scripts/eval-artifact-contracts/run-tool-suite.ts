#!/usr/bin/env tsx
import { dirname, join, resolve } from "node:path";
//
// The live runner for a suite whose contract is a TOOL CALL (decisions.md
// ruling 62: every suite's live run goes through the real tool description and
// schema). `run.ts`'s client sends one bare user message and reads text, so it
// cannot carry a tool; ruling 44 keeps `run.ts`, `config.ts` and `client.ts`
// closed to type slices. This runner reuses the harness's OWN `runSuite` —
// the known-bad-first gate, the one retry, the two-consecutive-5xx circuit
// breaker, the report — and hands it a client built on `tool-path.ts`:
//
//   - a real case is sent through the tools as its suite asks (`requestFor`)
//   - a known-bad case is never sent: `runSuite` serves its hand-written answer
//     from disk (ruling 59) for every suite, so a live run cannot pass its gate
//     because a model happened to misbehave
//
// `--replay` needs no runner of its own: `run.ts --suite <name> --replay`
// re-scores the committed responses with no model and no key.
//
// Run with (the tunnel opens and closes in the same command as its user):
//   ssh -N -o ExitOnForwardFailure=yes -L 30020:192.168.1.96:30000 alfyroot & T=$!; sleep 2; \
//   EVAL_ARTIFACTS_BASE_URL=http://127.0.0.1:30020/v1 EVAL_ARTIFACTS_MODEL=qwen3-6-27b \
//   npx tsx scripts/eval-artifact-contracts/run-tool-suite.ts --suite canvas; kill $T
//
// Flags beyond run.ts's (`--suite --only --limit --out`):
//   --write-responses   record each real answer under fixtures/<suite>/responses/
//                       (how the committed set for `--replay` is made)
//   --thinking on|off   override the cases' own thinking policy for this run
//   --repeat <n>        run the suite n times, to estimate a rate (not with
//                       --write-responses)
//   --responses-out <d> keep every real answer under <d>/run-<i>/ for a closer
//                       look, without touching the committed fixtures
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EVAL_CASES } from "./cases";
import type { EvalArtifactsModelClient } from "./client";
import { resolveEvalArtifactsConfig } from "./config";
import {
	loadCommittedResponseFromDisk,
	parseArgv,
	type RunDeps,
	runSuite,
	writeCommittedResponseToDisk,
	writeResultsJson,
} from "./run";
import { getSuiteScorer } from "./scoring";
import { CANVAS_TOOL_SUITE } from "./suites/canvas";
import {
	sendThroughTools,
	type ToolPathEndpoint,
	type ToolSuite,
} from "./tool-path";
import type { EvalCase, EvalSuiteReport, EvalUsage } from "./types";

/** The suites whose live run goes through a tool. A type slice appends its own. */
export const TOOL_SUITES: Record<string, ToolSuite> = {
	canvas: CANVAS_TOOL_SUITE,
};

export interface ToolSuiteRunOptions {
	suite: string;
	only: string[] | null;
	limit: number | null;
	/** Overrides the cases' own thinking policy for this run. */
	thinking: "on" | "off" | null;
	writeResponses?: boolean;
}

export interface ToolSuiteRunDeps {
	endpoint: ToolPathEndpoint;
	cases: Record<string, EvalCase[]>;
	fixturesRoot: string;
	send: typeof sendThroughTools;
	log: (message: string) => void;
	score: RunDeps["score"];
	defaultThinking: "on" | "off";
}

export interface CapturedAttempt {
	caseId: string;
	text: string;
	usage?: EvalUsage;
	durationMs: number;
}

export async function runToolSuite(
	options: ToolSuiteRunOptions,
	deps: ToolSuiteRunDeps,
): Promise<{ report: EvalSuiteReport; captured: CapturedAttempt[] }> {
	const toolSuite = TOOL_SUITES[options.suite];
	if (!toolSuite) {
		throw new Error(
			`Suite "${options.suite}" has no tool path. Suites that go through a tool: ${Object.keys(TOOL_SUITES).join(", ")}. Use run.ts for the others.`,
		);
	}
	const suiteCases = deps.cases[options.suite] ?? [];
	const byPrompt = new Map(suiteCases.map((c) => [c.prompt, c]));
	const captured: CapturedAttempt[] = [];

	const client: EvalArtifactsModelClient = {
		baseUrl: deps.endpoint.baseUrl,
		model: deps.endpoint.model,
		async send({ prompt, signal }) {
			const evalCase = byPrompt.get(prompt);
			if (!evalCase) {
				throw new Error(
					`run-tool-suite: no ${options.suite} case has this prompt; cases are told apart by their prompt`,
				);
			}
			// `runSuite` serves a known-bad case's hand-written answer from disk and
			// never calls this client for one (ruling 59): reaching it is a bug.
			if (evalCase.knownBad) {
				throw new Error(
					`run-tool-suite: known-bad case ${evalCase.id} reached the model client; its answer is served from disk, never sent (ruling 59)`,
				);
			}
			const spec = toolSuite.requestFor(evalCase);
			if (options.thinking) spec.thinking = options.thinking;
			const started = Date.now();
			const result = await deps.send(deps.endpoint, spec, { signal });
			captured.push({
				caseId: evalCase.id,
				text: result.text,
				usage: result.usage,
				durationMs: Date.now() - started,
			});
			return result;
		},
	};

	const report = await runSuite(
		options.suite,
		{ replay: false, limit: options.limit, only: options.only },
		{
			cases: deps.cases,
			client,
			loadCommittedResponse: (suite, caseId) =>
				loadCommittedResponseFromDisk(deps.fixturesRoot, suite, caseId),
			loadCommittedEvaluation: () => null,
			score: deps.score,
			evaluate: async () => null,
			log: deps.log,
			defaultThinking: deps.defaultThinking,
		},
	);

	if (options.writeResponses) {
		for (const attempt of captured) {
			writeCommittedResponseToDisk(deps.fixturesRoot, {
				caseId: attempt.caseId,
				suite: options.suite,
				response: attempt.text,
				durationMs: attempt.durationMs,
				usage: attempt.usage,
			});
		}
	}
	return { report, captured };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function readFlag(argv: string[], name: string): string | null {
	const at = argv.indexOf(name);
	return at >= 0 ? (argv[at + 1] ?? null) : null;
}

function clip(text: string, length = 200): string {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const args = parseArgv(argv);
	const config = resolveEvalArtifactsConfig();
	const suite = args.suite ?? config.suite;
	if (args.help || !TOOL_SUITES[suite]) {
		console.log(
			`Usage: tsx scripts/eval-artifact-contracts/run-tool-suite.ts --suite <${Object.keys(TOOL_SUITES).join("|")}> [--only ids] [--limit n] [--write-responses] [--thinking on|off] [--repeat n] [--out dir]`,
		);
		return args.help ? 0 : 1;
	}
	if (!config.baseUrl || !config.model) {
		console.error(
			"[eval-tool-suite] EVAL_ARTIFACTS_BASE_URL and EVAL_ARTIFACTS_MODEL are both required — see the tunnel recipe in scripts/eval-artifact-contracts/README.md.",
		);
		return 1;
	}
	const thinkingFlag = readFlag(argv, "--thinking");
	const thinking =
		thinkingFlag === "on" || thinkingFlag === "off" ? thinkingFlag : null;
	const writeResponses = argv.includes("--write-responses");
	const responsesOut = readFlag(argv, "--responses-out");
	const repeat = Math.max(
		1,
		Number.parseInt(readFlag(argv, "--repeat") ?? "1", 10) || 1,
	);
	if (writeResponses && repeat > 1) {
		console.error(
			"[eval-tool-suite] --write-responses records one run; drop --repeat.",
		);
		return 1;
	}

	const fixturesRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		"fixtures",
	);
	const log = (message: string) => console.log(`[eval-tool-suite] ${message}`);
	const outDir = resolve(process.cwd(), args.out ?? config.outDir);
	let failed = false;

	for (let run = 1; run <= repeat; run += 1) {
		const { report, captured } = await runToolSuite(
			{
				suite,
				only: args.only ?? config.only,
				limit: args.limit ?? config.limit,
				thinking,
				writeResponses,
			},
			{
				endpoint: {
					baseUrl: config.baseUrl,
					model: config.model,
					apiKey: config.apiKey,
				},
				cases: EVAL_CASES,
				fixturesRoot,
				send: sendThroughTools,
				log,
				score: (evalCase, attempt, evaluation) =>
					getSuiteScorer(evalCase.suite)(evalCase, attempt, evaluation),
				defaultThinking: config.thinking,
			},
		);

		if (responsesOut) {
			const root = resolve(process.cwd(), responsesOut, `run-${run}`);
			for (const attempt of captured) {
				writeCommittedResponseToDisk(root, {
					caseId: attempt.caseId,
					suite,
					response: attempt.text,
					durationMs: attempt.durationMs,
					usage: attempt.usage,
				});
			}
		}
		log(
			`${suite} run ${run}/${repeat}${thinking ? ` (thinking ${thinking})` : ""}`,
		);
		if (!report.knownBadFailedAsExpected) {
			console.error(
				`[eval-tool-suite] known-bad answers did not fail as declared (${report.knownBadFailures.join(", ")}). Refusing to trust this suite's scores.`,
			);
			failed = true;
			continue;
		}
		for (const result of report.results) {
			log(`  ${result.verdict.padEnd(10)} ${result.caseId}`);
			for (const reason of result.reasons) log(`      ${clip(reason)}`);
		}
		const counts = {
			good: report.results.filter((r) => r.verdict === "good").length,
			acceptable: report.results.filter((r) => r.verdict === "acceptable")
				.length,
			bad: report.results.filter((r) => r.verdict === "bad").length,
		};
		if (counts.bad > 0) failed = true;
		const tokens = report.results
			.map((r) => r.usage?.completionTokens)
			.filter((n): n is number => typeof n === "number");
		const seconds = report.results
			.map((r) => r.durationMs)
			.filter((n): n is number => typeof n === "number")
			.map((ms) => ms / 1000);
		log(
			`${suite}: ${report.results.length} case(s): ${counts.good} good, ${counts.acceptable} acceptable, ${counts.bad} bad` +
				(report.stoppedEarly ? " (stopped early: repeated 5xx/429)" : "") +
				(tokens.length > 0
					? `; completion tokens ${Math.min(...tokens)}–${Math.max(...tokens)}`
					: "") +
				(seconds.length > 0
					? `; ${Math.min(...seconds).toFixed(1)}–${Math.max(...seconds).toFixed(1)}s`
					: ""),
		);
		const path = writeResultsJson(
			repeat > 1 ? join(outDir, `run-${run}`) : outDir,
			[report],
		);
		log(`results written to ${path}`);
	}
	return failed ? 1 : 0;
}

// Only runs when this file is the process entry point — never on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error("[eval-tool-suite] Unexpected error:", error);
			process.exitCode = 1;
		});
}
