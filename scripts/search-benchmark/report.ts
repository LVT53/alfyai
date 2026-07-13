// Reads a results dir (summary.json + rows.json) and prints a markdown report.
// Usage: RESULTS_DIR=test-results/search-bench-full npx tsx scripts/search-benchmark/report.ts

import { readFileSync } from "node:fs";
import path from "node:path";

type Row = {
	questionId: string;
	tier: string;
	arm: string;
	rep: number;
	retrievalMs: number;
	hostHitAt3: boolean;
	hostRecall: number;
	mrrHost: number;
	answerMs: number;
	endToEndMs: number;
	answer: string;
	score: number;
	correct: boolean;
	hallucination: boolean;
	citedUrl: boolean;
	judgeReason: string;
	error?: string;
};

const dir = process.env.RESULTS_DIR ?? process.argv[2] ?? "test-results/search-bench-full";
const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
const rows: Row[] = JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf8"));

const ARMS: string[] = summary.arms.map((a: { arm: string }) => a.arm);
const TIERS = ["A", "B", "C", "D", "E"];
const ok = rows.filter((r) => !r.error);

function mean(xs: number[]): number {
	if (!xs.length) return 0;
	return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
}
function pct(xs: boolean[]): number {
	if (!xs.length) return 0;
	return Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10;
}

const out: string[] = [];
out.push(`# Search benchmark — SearXNG pipeline vs Parallel Search API\n`);
out.push(
	`Model under test: **${summary.modelUnderTest}** · Judge: **${summary.judge}** · Reps: ${summary.reps} · Questions: ${summary.questionCount} · Generated ${summary.generatedAt}\n`,
);

// --- Headline table ---
out.push(`## Headline (per arm)\n`);
out.push(
	`| Arm | Mean score /3 | Correct % | Halluc % | Cited-URL % | hit@3 % | Host recall | Ret p50/p95 (ms) | E2E p50/p95 (ms) |`,
);
out.push(`|---|---|---|---|---|---|---|---|---|`);
for (const a of summary.arms) {
	const ret = a.latency.retrievalMs;
	const e2e = a.latency.endToEndMs;
	out.push(
		`| ${a.arm} | ${a.answer.meanScore} | ${a.answer.correctPct} | ${a.answer.hallucinationPct} | ${a.answer.citedUrlPct} | ${a.retrieval.hostHitAt3Pct} | ${a.retrieval.meanHostRecall} | ${ret?.p50}/${ret?.p95} | ${e2e?.p50}/${e2e?.p95} |`,
	);
}

// --- Balance ranking: mean score vs e2e p50 latency ---
out.push(`\n## Speed / quality balance\n`);
out.push(`| Arm | Mean score /3 | E2E p50 (ms) | Score per second |`);
out.push(`|---|---|---|---|`);
const balance = summary.arms
	.map((a: { arm: string; answer: { meanScore: number }; latency: { endToEndMs: { p50: number } } }) => ({
		arm: a.arm,
		score: a.answer.meanScore,
		p50: a.latency.endToEndMs?.p50 ?? 0,
		eff: a.latency.endToEndMs?.p50
			? Math.round((a.answer.meanScore / (a.latency.endToEndMs.p50 / 1000)) * 100) / 100
			: 0,
	}))
	.sort((x: { eff: number }, y: { eff: number }) => y.eff - x.eff);
for (const b of balance) out.push(`| ${b.arm} | ${b.score} | ${b.p50} | ${b.eff} |`);

// --- Per-tier mean score matrix ---
out.push(`\n## Mean score by tier (0-3)\n`);
out.push(`| Tier | ${ARMS.join(" | ")} |`);
out.push(`|---|${ARMS.map(() => "---").join("|")}|`);
for (const t of TIERS) {
	const cells = ARMS.map((arm) =>
		mean(ok.filter((r) => r.tier === t && r.arm === arm).map((r) => r.score)),
	);
	out.push(`| ${t} | ${cells.join(" | ")} |`);
}

// --- Per-tier hit@3 ---
out.push(`\n## Retrieval hit@3 % by tier\n`);
out.push(`| Tier | ${ARMS.join(" | ")} |`);
out.push(`|---|${ARMS.map(() => "---").join("|")}|`);
for (const t of TIERS) {
	const cells = ARMS.map((arm) =>
		pct(ok.filter((r) => r.tier === t && r.arm === arm).map((r) => r.hostHitAt3)),
	);
	out.push(`| ${t} | ${cells.join(" | ")} |`);
}

// --- Divergences: questions where arms most disagree on mean score ---
out.push(`\n## Biggest score divergences (by question)\n`);
const qIds = [...new Set(ok.map((r) => r.questionId))];
const divergences = qIds
	.map((qid) => {
		const perArm = ARMS.map((arm) => ({
			arm,
			s: mean(ok.filter((r) => r.questionId === qid && r.arm === arm).map((r) => r.score)),
		}));
		const scores = perArm.map((p) => p.s);
		return { qid, spread: Math.max(...scores) - Math.min(...scores), perArm };
	})
	.filter((d) => d.spread > 0)
	.sort((a, b) => b.spread - a.spread)
	.slice(0, 8);
out.push(`| Question | Spread | ${ARMS.join(" | ")} |`);
out.push(`|---|---|${ARMS.map(() => "---").join("|")}|`);
for (const d of divergences) {
	out.push(
		`| ${d.qid} | ${Math.round(d.spread * 100) / 100} | ${d.perArm.map((p) => p.s).join(" | ")} |`,
	);
}

// --- Hallucinations & errors ---
const halls = ok.filter((r) => r.hallucination);
out.push(`\n## Hallucinations (${halls.length})\n`);
for (const h of halls.slice(0, 20)) {
	out.push(`- **${h.questionId}/${h.arm}** (score ${h.score}): ${h.judgeReason}`);
}
const errs = rows.filter((r) => r.error);
out.push(`\n## Errors (${errs.length})\n`);
for (const e of errs.slice(0, 20)) {
	out.push(`- ${e.questionId}/${e.arm}: ${e.error}`);
}

console.log(out.join("\n"));
