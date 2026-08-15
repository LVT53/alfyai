#!/usr/bin/env tsx
//
// P3a (architecture-deepening programme, WAVE S) honesty audit harness —
// the prerequisite that must exist and be trustworthy BEFORE P3b's
// reasoning-phase classifier may be enabled in production. See
// docs/adr/0056-interim-thought-steps-are-durable-turn-state.md and
// docs/architecture-deepening-slices.md § P3a.
//
// WHAT THIS SCRIPT DOES NOT DO: it does not build, call, or enable the P3b
// classifier. It does not emit any Interim Thought Step. As of this slice,
// NOTHING in the app writes a `thoughtSteps` key onto a persisted message
// (see src/lib/server/services/chat-turn/thought-steps.ts's header) — so a
// `--mode=live` run against a real database is EXPECTED, honestly, to find
// zero persisted steps until P3b ships. That is not a bug in this harness;
// it is the harness correctly reporting that there is nothing to audit yet.
// `--mode=synthetic` runs the same scoring path over the hand-crafted
// corpus in scripts/eval/thought-step-fixtures.ts instead, so the report
// FORMAT — and the scorer's actual defect-detection behavior — is provable
// today, before any real classifier output exists. Per the task spec, a
// synthetic run of this report is what's committed to scripts/eval/results/
// for review.
//
// For each sampled turn (a completed assistant message with non-empty
// `thinking`) this script:
//   1. Reads the turn's persisted `messages.thinking` (the raw reasoning
//      text) and, from the message's `metadataJson`, whatever `thoughtSteps`
//      are attached to it (today: none — see above).
//   2. Reads the turn's REAL persisted tool-call ids from the existing
//      `messages.toolCalls` column — the ground truth an event-sourced
//      step's action claim must resolve against.
//   3. Scores every step against its anchor with the deterministic,
//      unit-tested pure functions in scripts/thought-step-scoring.ts (NOT
//      reimplemented here).
//   4. Writes a JSON + markdown report to scripts/eval/results/, stating
//      the P3 enable gate explicitly: >95% truthful AND zero fabricated
//      action claims.
//
// Unlike the sibling G0 harness (evaluate-tool-guidance-ab.ts), this script
// makes NO model call and NO network call — it only reads the local
// database and runs pure scoring — so `--mode=live` is safe and free to run
// at any time. It is NOT run as part of this repo's `npm test`/`npm run
// check` gate, mirroring the G0/G1 harness convention.

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dbDir = dirname(process.env.DATABASE_PATH);
if (!existsSync(dbDir)) {
	console.log(`Creating database directory: ${dbDir}`);
	mkdirSync(dbDir, { recursive: true });
}

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import {
	extractRealToolCallIds,
	parseThoughtSteps,
} from "$lib/server/services/chat-turn/thought-steps";
import type { InterimThoughtStep } from "$lib/types";
import { thoughtStepFixtures } from "./eval/thought-step-fixtures";
import {
	ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD,
	type EnableGateVerdict,
	evaluateEnableGate,
	scoreThoughtStep,
	summarizeThoughtStepAudit,
	type ThoughtStepAuditResult,
	type ThoughtStepAuditSummary,
} from "./thought-step-scoring";

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "scripts/eval/results");
const DEFAULT_LIVE_SAMPLE_LIMIT = 200;

// ── Sampling ──────────────────────────────────────────────────────────────

type SampledTurn = {
	turnId: string;
	conversationId: string | null;
	thinkingText: string;
	steps: InterimThoughtStep[];
	realToolCallIds: Set<string>;
};

/**
 * Samples up to `limit` completed turns from the real database: assistant
 * messages with non-empty persisted `thinking`, most recent first. For each,
 * reads whatever `thoughtSteps` are attached (today: none — see this file's
 * header) and the turn's real tool-call ids.
 */
async function sampleLiveTurns(limit: number): Promise<SampledTurn[]> {
	const rows = await db
		.select({
			id: messages.id,
			conversationId: messages.conversationId,
			thinking: messages.thinking,
			toolCalls: messages.toolCalls,
			metadataJson: messages.metadataJson,
		})
		.from(messages)
		.where(
			and(
				eq(messages.role, "assistant"),
				isNotNull(messages.thinking),
				ne(messages.thinking, ""),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(limit);

	return rows.map((row) => ({
		turnId: row.id,
		conversationId: row.conversationId,
		thinkingText: row.thinking ?? "",
		steps: parseThoughtSteps(row.metadataJson),
		realToolCallIds: extractRealToolCallIds(row.toolCalls),
	}));
}

/**
 * "Samples" the synthetic fixture corpus as if each fixture were its own
 * one-step completed turn — same shape `sampleLiveTurns` produces, so the
 * exact same scoring/report path runs in both modes.
 */
function sampleSyntheticTurns(): SampledTurn[] {
	return thoughtStepFixtures.map((fixture) => ({
		turnId: fixture.id,
		conversationId: null,
		thinkingText: fixture.thinkingText,
		steps: [fixture.step],
		realToolCallIds: new Set(fixture.realToolCallIds),
	}));
}

// ── Scoring / report data model ──────────────────────────────────────────

type AuditedStep = {
	turnId: string;
	conversationId: string | null;
	stepId: string;
	source: InterimThoughtStep["source"];
	activityClass: string;
	impliesExternalAction: boolean;
	result: ThoughtStepAuditResult;
};

type ThoughtStepHonestyMode = "live" | "synthetic";

type FullAuditReport = {
	generatedAt: string;
	mode: ThoughtStepHonestyMode;
	turnsSampled: number;
	turnsWithSteps: number;
	summary: ThoughtStepAuditSummary;
	enableGate: {
		thresholdTruthfulRate: number;
		verdict: EnableGateVerdict;
		statement: string;
	};
	steps: AuditedStep[];
	limitations: string[];
};

const LIVE_LIMITATIONS = [
	'P3a ships before P3b: nothing in the app currently writes a `thoughtSteps` key onto a persisted message, so a --mode=live run is expected to find zero steps to audit until P3b lands (see this script\'s header and src/lib/server/services/chat-turn/thought-steps.ts). A live run reporting `turnsWithSteps: 0` and enableGate.verdict: "not_applicable" is this harness working correctly, not a defect.',
	"Sampling is recency-ordered (most recent completed assistant turns with non-empty `thinking`), not randomized — a --limit smaller than the database's real turn count is a recency-biased sample, not a uniform one.",
];

const SYNTHETIC_LIMITATIONS = [
	"This report was generated with --mode=synthetic: every 'turn' below is one hand-crafted fixture from scripts/eval/thought-step-fixtures.ts (a synthetic thinking-text chunk + a synthetic Interim Thought Step with a KNOWN-CORRECT verdict), not real production data. It exists to prove the report FORMAT and the scorer's defect-detection behavior are correct before any real classifier output exists (P3b is not built yet) — treat its numbers as a scorer self-check, not a production honesty measurement. A --mode=live run against a real database is the production-facing report; see its own limitations note for why that currently finds zero steps.",
	"The fixture corpus is deliberately small and adversarial (one or two fixtures per required defect category) rather than representative of real turn volume or step-class distribution — its truthful rate is an artifact of how many truthful-vs-defective fixtures were authored, not a claim about real-world step quality.",
];

function buildEnableGateStatement(
	verdict: EnableGateVerdict,
	summary: ThoughtStepAuditSummary,
): string {
	const gateDescription = `P3 enable gate (ADR-0056 / architecture-deepening-slices.md § P3a): >${(ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD * 100).toFixed(0)}% truthful AND zero fabricated action claims.`;
	if (verdict === "not_applicable") {
		return `${gateDescription} Verdict: NOT APPLICABLE — 0 steps were sampled, so the gate has nothing to evaluate. This is expected before P3b ships.`;
	}
	const truthfulPct =
		summary.truthfulRate === null
			? "n/a"
			: `${(summary.truthfulRate * 100).toFixed(1)}%`;
	const verdictLabel = verdict === "pass" ? "PASS" : "FAIL";
	return (
		`${gateDescription} Verdict: ${verdictLabel} — ${truthfulPct} truthful ` +
		`(${summary.truthfulCount}/${summary.total}), ${summary.fabricatedActionCount} ` +
		`fabricated action claim(s), ${summary.unanchoredCount} unanchored step(s).`
	);
}

function buildReport(
	mode: ThoughtStepHonestyMode,
	turns: SampledTurn[],
): FullAuditReport {
	const auditedSteps: AuditedStep[] = [];
	for (const turn of turns) {
		for (const step of turn.steps) {
			const result = scoreThoughtStep(step, {
				thinkingText: turn.thinkingText,
				realToolCallIds: turn.realToolCallIds,
			});
			auditedSteps.push({
				turnId: turn.turnId,
				conversationId: turn.conversationId,
				stepId: step.id,
				source: step.source,
				activityClass: step.activityClass,
				impliesExternalAction: step.impliesExternalAction,
				result,
			});
		}
	}

	const summary = summarizeThoughtStepAudit(auditedSteps.map((s) => s.result));
	const verdict = evaluateEnableGate(summary);

	return {
		generatedAt: new Date().toISOString(),
		mode,
		turnsSampled: turns.length,
		turnsWithSteps: turns.filter((t) => t.steps.length > 0).length,
		summary,
		enableGate: {
			thresholdTruthfulRate: ENABLE_GATE_TRUTHFUL_RATE_THRESHOLD,
			verdict,
			statement: buildEnableGateStatement(verdict, summary),
		},
		steps: auditedSteps,
		limitations: mode === "live" ? LIVE_LIMITATIONS : SYNTHETIC_LIMITATIONS,
	};
}

// ── Report rendering ──────────────────────────────────────────────────────

function renderMarkdownReport(report: FullAuditReport): string {
	const lines: string[] = [];
	lines.push("# Thought Step Honesty Audit Report (P3a)");
	lines.push("");
	lines.push(`Generated at: ${report.generatedAt}`);
	lines.push(`Mode: ${report.mode}`);
	lines.push(`Turns sampled: ${report.turnsSampled}`);
	lines.push(`Turns with at least one Thought Step: ${report.turnsWithSteps}`);
	lines.push("");
	lines.push("## Enable gate");
	lines.push("");
	lines.push(report.enableGate.statement);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("| --- | --- |");
	lines.push(`| Steps audited | ${report.summary.total} |`);
	lines.push(
		`| % truthful | ${report.summary.truthfulRate === null ? "n/a" : `${(report.summary.truthfulRate * 100).toFixed(1)}%`} (${report.summary.truthfulCount}/${report.summary.total}) |`,
	);
	lines.push(
		`| Fabricated action claims | ${report.summary.fabricatedActionCount} |`,
	);
	lines.push(`| Unanchored steps | ${report.summary.unanchoredCount} |`);
	lines.push(
		`| Unsupported-entity steps | ${report.summary.unsupportedEntityCount} |`,
	);
	lines.push("");
	lines.push("## Limitations");
	lines.push("");
	for (const limitation of report.limitations) {
		lines.push(`- ${limitation}`);
	}
	lines.push("");
	lines.push("## Per-step results");
	lines.push("");
	lines.push(
		"| turn | step | source | class | implies action | truthful | fabricated | unanchored | unsupported entity |",
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const s of report.steps) {
		lines.push(
			`| ${s.turnId} | ${s.stepId} | ${s.source} | ${s.activityClass} | ${s.impliesExternalAction ? "yes" : "no"} | ${s.result.truthful ? "✅" : "❌"} | ${s.result.fabricatedAction ? "❌" : "—"} | ${s.result.unanchored ? "❌" : "—"} | ${s.result.unsupportedEntity ? "❌" : "—"} |`,
		);
	}
	if (report.steps.length === 0) {
		lines.push("| (none — 0 steps found in the sample) | | | | | | | | |");
	}
	lines.push("");

	return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────

type CliArgs = {
	mode: ThoughtStepHonestyMode;
	limit: number;
	outPath: string | null;
	help: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
	let mode: ThoughtStepHonestyMode = "live";
	let limit = DEFAULT_LIVE_SAMPLE_LIMIT;
	let outPath: string | null = null;
	let help = false;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg.startsWith("--mode=")) {
			const value = arg.slice("--mode=".length).trim();
			if (value !== "live" && value !== "synthetic") {
				throw new Error(`--mode must be "live" or "synthetic", got: ${value}`);
			}
			mode = value;
		} else if (arg.startsWith("--limit=")) {
			const value = Number(arg.slice("--limit=".length));
			if (!Number.isInteger(value) || value < 1) {
				throw new Error("--limit must be a positive integer");
			}
			limit = value;
		} else if (arg.startsWith("--out=")) {
			outPath = arg.slice("--out=".length);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return { mode, limit, outPath, help };
}

function printUsage() {
	console.log(
		[
			"Usage: npx tsx scripts/audit-thought-step-honesty.ts [options]",
			"",
			"Options:",
			"  --mode=live|synthetic  live: sample N real completed turns from the DB",
			"                         (DATABASE_PATH, default ./data/chat.db) and audit",
			"                         whatever Interim Thought Steps are persisted on",
			"                         them (today: none — see this file's header).",
			"                         synthetic: audit the hand-crafted corpus in",
			"                         scripts/eval/thought-step-fixtures.ts instead — no",
			"                         DB required. (default: live)",
			"  --limit=<n>            Live mode only: max turns to sample, most recent",
			`                         first (default: ${DEFAULT_LIVE_SAMPLE_LIMIT})`,
			"  --out=<path>           Report output path (.md); a sibling .json is also",
			"                         written",
			"  --help                 Show this message",
			"",
			"Makes no model call and no network call — safe and free to run any time.",
		].join("\n"),
	);
}

async function main(argv = process.argv.slice(2)) {
	const args = parseCliArgs(argv);
	if (args.help) {
		printUsage();
		return;
	}

	const turns =
		args.mode === "live"
			? await sampleLiveTurns(args.limit)
			: sampleSyntheticTurns();

	console.log(
		`[audit-thought-step-honesty] mode=${args.mode} turnsSampled=${turns.length}`,
	);

	const report = buildReport(args.mode, turns);

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath =
		args.outPath ??
		path.join(
			DEFAULT_OUTPUT_DIR,
			`thought-step-honesty-audit-${args.mode}-${timestamp}.md`,
		);

	const outDir = dirname(outPath);
	await mkdir(outDir, { recursive: true });
	const markdown = renderMarkdownReport(report);
	await writeFile(outPath, markdown, "utf8");
	const jsonPath = outPath.replace(/\.md$/, ".json");
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log(`Report written to ${outPath}`);
	console.log(`Report JSON written to ${jsonPath}`);
	console.log(report.enableGate.statement);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
	main().catch((error) => {
		const message =
			error instanceof Error
				? error.message
				: `Unknown error: ${String(error)}`;
		console.error(message);
		process.exitCode = 1;
	});
}

export {
	buildEnableGateStatement,
	buildReport,
	parseCliArgs,
	renderMarkdownReport,
	sampleSyntheticTurns,
};
