import { config as dotenvConfig } from "dotenv";

// Env + DB path MUST be set before importing any server module.
dotenvConfig();
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type Question = {
	id: string;
	tier: string;
	expected_mode: "quick" | "research";
	time_sensitive: boolean;
	question: string;
	gold_answer: string;
	gold_urls: string[];
	grading_notes?: string;
};

type ArmId =
	| "ours-quick"
	| "ours-research"
	| "parallel-turbo"
	| "parallel-advanced";

const ALL_ARMS: ArmId[] = [
	"ours-quick",
	"ours-research",
	"parallel-turbo",
	"parallel-advanced",
];

const ANSWER_SYSTEM = `You are answering a user's question using ONLY the provided web search results below. Rules:
- Use only the information in the provided results; do not rely on prior knowledge.
- Cite at least one source by including its URL (markdown link or bare URL).
- If the results do not contain the answer, say you could not find it in the results. Do not guess.
- Be concise: 1-4 sentences.`;

function env(name: string, fallback: string): string {
	const v = process.env[name];
	return v && v.trim() ? v.trim() : fallback;
}

async function main() {
	const questionsPath = env(
		"BENCH_QUESTIONS",
		path.join("scripts", "search-benchmark", "questions.json"),
	);
	const reps = Number(env("BENCH_REPS", "3"));
	// Inter-run delay. SearXNG proxies rate-limited upstream engines (Google/Bing),
	// so bursty benchmarking starves it; pace the ours-* arms generously.
	const delayMs = Number(env("BENCH_DELAY_MS", "150"));
	const onlyIds = env("BENCH_ONLY", "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const armsFilter = env("BENCH_ARMS", "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean) as ArmId[];
	const arms = armsFilter.length ? armsFilter : ALL_ARMS;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = env(
		"BENCH_OUTPUT_DIR",
		path.join("test-results", `search-bench-${stamp}`),
	);

	const parallelKey = process.env.PARALLEL_API_KEY ?? "";
	const needsParallel = arms.some((a) => a.startsWith("parallel"));
	if (needsParallel && !parallelKey) {
		throw new Error("PARALLEL_API_KEY required for parallel arms");
	}

	// Dynamic imports (after env is ready).
	const { researchWeb } = await import(
		"../../src/lib/server/services/web-research/index"
	);
	const { searchParallel } = await import("./lib/parallel-client");
	const grounding = await import("./lib/grounding");
	const { scoreRetrieval } = await import("./lib/scoring");
	const { stats, mean, sleep } = await import("./lib/util");
	const modelLib = await import("./lib/model");

	const doc = JSON.parse(readFileSync(questionsPath, "utf8"));
	let questions: Question[] = doc.questions;
	if (onlyIds.length) {
		questions = questions.filter((q) => onlyIds.includes(q.id));
	}

	console.log(
		`Benchmark: ${questions.length} questions x ${arms.length} arms x ${reps} reps -> ${questions.length * arms.length * reps} runs`,
	);
	console.log(`arms: ${arms.join(", ")}`);

	// Model under test + judge.
	const flash = await modelLib.resolveModelClient({
		providerName: "deepseek",
		apiModelName: "deepseek-v4-flash",
		requireKey: true,
	});
	if (!flash) throw new Error("could not resolve deepseek-v4-flash client");
	console.log(`model under test: ${flash.label}`);
	const judge = await modelLib.resolveJudge();
	if (!judge) throw new Error("no judge model available");

	await mkdir(outDir, { recursive: true });
	const rawPath = path.join(outDir, "raw-runs.jsonl");

	type Row = {
		questionId: string;
		tier: string;
		expectedMode: string;
		timeSensitive: boolean;
		arm: ArmId;
		rep: number;
		retrievalMs: number;
		candidateCount: number;
		// retrieval score
		hostHitAt3: boolean;
		hostHitAt8: boolean;
		urlHitAt8: boolean;
		mrrHost: number;
		hostRecall: number;
		firstHitRank: number | null;
		// answer
		answerMs: number;
		endToEndMs: number;
		answer: string;
		// judge
		score: number;
		correct: boolean;
		hallucination: boolean;
		citedUrl: boolean;
		judgeReason: string;
		error?: string;
		// diagnostics (ours only)
		diag?: Record<string, unknown>;
	};

	const rows: Row[] = [];

	async function runRetrieval(arm: ArmId, q: Question) {
		if (arm === "ours-quick" || arm === "ours-research") {
			const mode = arm === "ours-quick" ? "quick" : "research";
			const started = Date.now();
			const result = await researchWeb({ query: q.question, mode });
			const retrievalMs = Date.now() - started;
			return {
				retrievalMs,
				candidateUrls: grounding.oursCandidateUrls(result),
				context: grounding.buildOursContext(result),
				diag: {
					providerCalls: result.diagnostics.providerCalls?.map((c) => ({
						resultCount: c.resultCount,
						latencyMs: c.latencyMs,
						error: c.error,
					})),
					fetchedSourceCount: result.diagnostics.fetchedSourceCount,
					selectedSourceCount: result.diagnostics.selectedSourceCount,
					openedPageCount: result.diagnostics.openedPageCount,
					pageExtractionMs: result.diagnostics.pageExtraction?.totalLatencyMs,
					evidenceCandidateCount: result.diagnostics.evidenceCandidateCount,
					reranked: result.diagnostics.reranked,
					sourceReranked: result.diagnostics.sourceReranked,
					fallbackReasons: result.diagnostics.fallbackReasons,
				} as Record<string, unknown>,
			};
		}
		// Parallel arms
		const mode = arm === "parallel-turbo" ? "turbo" : "advanced";
		const call = await searchParallel({
			objective: q.question,
			searchQueries: [q.question],
			mode,
			apiKey: parallelKey,
		});
		return {
			retrievalMs: call.latencyMs,
			candidateUrls: grounding.parallelCandidateUrls(call),
			context: grounding.buildParallelContext(call),
			diag: {
				status: call.status,
				resultCount: call.results.length,
				error: call.error,
			} as Record<string, unknown>,
		};
	}

	let n = 0;
	const total = questions.length * arms.length * reps;
	for (const q of questions) {
		for (const arm of arms) {
			for (let rep = 1; rep <= reps; rep++) {
				n++;
				const label = `[${n}/${total}] ${q.id} ${arm} rep${rep}`;
				try {
					const r = await runRetrieval(arm, q);
					const rscore = scoreRetrieval(r.candidateUrls, q.gold_urls);
					const ans = await modelLib.callModel(flash, {
						system: ANSWER_SYSTEM,
						user: `Question: ${q.question}\n\nWeb search results:\n${r.context}`,
					});
					const jm = ans.error
						? {
								score: 0,
								correct: false,
								hallucination: false,
								citedUrl: false,
								reason: `answer model error: ${ans.error}`,
							}
						: await modelLib.judgeAnswer(judge, {
								question: q.question,
								goldAnswer: q.gold_answer,
								gradingNotes: q.grading_notes,
								candidateAnswer: ans.text,
							});
					const row: Row = {
						questionId: q.id,
						tier: q.tier,
						expectedMode: q.expected_mode,
						timeSensitive: q.time_sensitive,
						arm,
						rep,
						retrievalMs: r.retrievalMs,
						candidateCount: rscore.candidateCount,
						hostHitAt3: rscore.hostHitAt3,
						hostHitAt8: rscore.hostHitAt8,
						urlHitAt8: rscore.urlHitAt8,
						mrrHost: rscore.mrrHost,
						hostRecall: rscore.hostRecall,
						firstHitRank: rscore.firstHitRank,
						answerMs: ans.latencyMs,
						endToEndMs: r.retrievalMs + ans.latencyMs,
						answer: ans.text,
						score: jm.score,
						correct: jm.correct,
						hallucination: jm.hallucination,
						citedUrl: jm.citedUrl,
						judgeReason: jm.reason,
						...(ans.error ? { error: ans.error } : {}),
						diag: r.diag,
					};
					rows.push(row);
					await appendFile(rawPath, `${JSON.stringify(row)}\n`, "utf8");
					console.log(
						`${label}: ret=${r.retrievalMs}ms ans=${ans.latencyMs}ms score=${jm.score} hit@3=${rscore.hostHitAt3 ? "Y" : "n"} ${jm.reason.slice(0, 60)}`,
					);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					console.log(`${label}: ERROR ${msg}`);
					await appendFile(
						rawPath,
						`${JSON.stringify({ questionId: q.id, arm, rep, error: msg })}\n`,
						"utf8",
					);
				}
				await sleep(delayMs);
			}
		}
	}

	// --- Summaries ---
	const summarizeArm = (arm: ArmId) => {
		const armRows = rows.filter((r) => r.arm === arm);
		const okRows = armRows.filter((r) => !r.error);
		const rate = (pred: (r: Row) => boolean) =>
			okRows.length
				? Math.round(
						(okRows.filter(pred).length / okRows.length) * 1000,
					) / 10
				: 0;
		return {
			arm,
			runs: armRows.length,
			errors: armRows.filter((r) => r.error).length,
			answer: {
				meanScore: mean(okRows.map((r) => r.score)),
				correctPct: rate((r) => r.correct),
				hallucinationPct: rate((r) => r.hallucination),
				citedUrlPct: rate((r) => r.citedUrl),
			},
			retrieval: {
				hostHitAt3Pct: rate((r) => r.hostHitAt3),
				hostHitAt8Pct: rate((r) => r.hostHitAt8),
				urlHitAt8Pct: rate((r) => r.urlHitAt8),
				meanHostRecall: mean(okRows.map((r) => r.hostRecall)),
				meanMrrHost: mean(okRows.map((r) => r.mrrHost)),
			},
			latency: {
				retrievalMs: stats(okRows.map((r) => r.retrievalMs)),
				answerMs: stats(okRows.map((r) => r.answerMs)),
				endToEndMs: stats(okRows.map((r) => r.endToEndMs)),
			},
		};
	};

	const summary = {
		generatedAt: new Date().toISOString(),
		modelUnderTest: flash.label,
		judge: judge.label,
		reps,
		questionCount: questions.length,
		arms: arms.map(summarizeArm),
	};

	await writeFile(
		path.join(outDir, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		path.join(outDir, "rows.json"),
		`${JSON.stringify(rows, null, 2)}\n`,
		"utf8",
	);

	// Console table
	console.log(`\n=== SUMMARY (judge: ${judge.label}) ===`);
	console.log(
		`${"arm".padEnd(18)} ${"score".padStart(6)} ${"corr%".padStart(6)} ${"hall%".padStart(6)} ${"hit@3%".padStart(7)} ${"recall".padStart(6)} ${"ret p50/p95".padStart(14)} ${"e2e p50/p95".padStart(14)}`,
	);
	for (const s of summary.arms) {
		const ret = s.latency.retrievalMs;
		const e2e = s.latency.endToEndMs;
		console.log(
			`${s.arm.padEnd(18)} ${String(s.answer.meanScore).padStart(6)} ${String(s.answer.correctPct).padStart(6)} ${String(s.answer.hallucinationPct).padStart(6)} ${String(s.retrieval.hostHitAt3Pct).padStart(7)} ${String(s.retrieval.meanHostRecall).padStart(6)} ${`${ret?.p50 ?? "-"}/${ret?.p95 ?? "-"}`.padStart(14)} ${`${e2e?.p50 ?? "-"}/${e2e?.p95 ?? "-"}`.padStart(14)}`,
		);
	}
	console.log(`\nwrote ${outDir}/summary.json, rows.json, raw-runs.jsonl`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
