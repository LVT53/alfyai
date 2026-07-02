import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	assertModelAvailable,
	type BenchmarkReasoningDepth,
	type BenchmarkRunResult,
	type BenchmarkStats,
	LiveAiClient,
	runSingleStreamBenchmark,
	summarizeBenchmarkRuns,
} from "./benchmark-live-chat-stream";

const DEFAULT_BASE_URL = "https://ai.alfydesign.com";
const DEFAULT_RUNS_PER_PROMPT = 1;
const DEFAULT_TIMEOUT_MS = 240_000;

export type ReasoningDepthAbPromptCategory =
	| "simple_direct"
	| "complex_architecture_tradeoff"
	| "source_grounded_current"
	| "project_context_document_style"
	| "debugging_refactor"
	| "planning_recommendation"
	| "hungarian_prompt";

export type DepthAppliedProfile = "off" | "standard" | "extended" | "maximum";

type LocalDepthSignals = {
	groundingNeed: "none" | "possible" | "useful" | "required";
	contextBreadth: "narrow" | "normal" | "broad";
	outputRoom: "concise" | "normal" | "expanded";
	toolUse: "none" | "normal" | "source_heavy";
};

type PromptRubric = {
	minChars: number;
	maxChars: number;
	requiredKeywords?: string[];
	requiredSections?: string[];
	requiresEvidence?: boolean;
	mustUseHungarian?: boolean;
};

export type ReasoningDepthAbPrompt = {
	id: string;
	category: ReasoningDepthAbPromptCategory;
	title: string;
	prompt: string;
	rubric: PromptRubric;
};

export type ReasoningDepthAbVariant = {
	id: "lean_baseline_off" | "current_auto" | "local_heuristic_auto" | "max";
	label: string;
	requestReasoningDepth: BenchmarkReasoningDepth;
	description: string;
	usesLocalHeuristicOverlay?: boolean;
};

export type LocalAutoClassification = {
	expectedProfile: DepthAppliedProfile;
	signals: LocalDepthSignals;
	reasons: string[];
};

export type ReasoningDepthAbPlanRun = {
	runIndex: number;
	repetition: number;
	prompt: ReasoningDepthAbPrompt;
	variant: ReasoningDepthAbVariant;
	localClassification: LocalAutoClassification;
};

export type ReasoningDepthAbPlan = {
	generatedAt: string;
	modelId: string;
	runsPerPrompt: number;
	prompts: readonly ReasoningDepthAbPrompt[];
	variants: readonly ReasoningDepthAbVariant[];
	runQueue: ReasoningDepthAbPlanRun[];
};

export type ReasoningDepthAbScoreRow = {
	promptId: string;
	promptCategory: ReasoningDepthAbPromptCategory;
	promptTitle: string;
	variantId: ReasoningDepthAbVariant["id"];
	variantLabel: string;
	requestReasoningDepth: BenchmarkReasoningDepth;
	repetition: number;
	runIndex: number;
	outcome: BenchmarkRunResult["outcome"];
	score: number;
	passedChecks: string[];
	failedChecks: string[];
	answerLength: number;
	firstTokenMs?: number;
	endMs?: number;
	serverEndMs?: number;
	depthSelectionMs?: number;
	toolCallCount: number;
	toolCallNames: string[];
	localExpectedProfile: DepthAppliedProfile;
	actualRequestedDepth?: string;
	actualAppliedProfile?: string;
	classifierSource?: string;
	classifierAttempts?: number;
	controlModelClassifierMs?: number;
	depthFallback?: boolean;
	heuristicAgreement?: boolean | null;
	error?: string;
};

export type ReasoningDepthVariantSummary = {
	variantId: ReasoningDepthAbVariant["id"];
	variantLabel: string;
	requestReasoningDepth: BenchmarkReasoningDepth;
	runCount: number;
	okCount: number;
	errorCount: number;
	meanScore: number;
	score: BenchmarkStats;
	latency: {
		firstTokenMs?: BenchmarkStats;
		endMs?: BenchmarkStats;
		serverEndMs?: BenchmarkStats;
		depthSelectionMs?: BenchmarkStats;
	};
	localExpectedProfileCounts: Record<string, number>;
	actualAppliedProfileCounts: Record<string, number>;
	heuristicAgreementRate?: number;
};

export type ReasoningDepthComparisonRow = {
	variantId: ReasoningDepthAbVariant["id"];
	variantLabel: string;
	baselineVariantId: ReasoningDepthAbVariant["id"];
	deltaVsLeanBaseline: {
		firstTokenP50Ms?: number;
		endP50Ms?: number;
	};
	scoreDeltaVsLeanBaseline?: number;
	deltaVsCurrentAuto?: {
		firstTokenP50Ms?: number;
		endP50Ms?: number;
		scoreMean?: number;
	};
};

export type ReasoningDepthAbAggregate = {
	generatedAt: string;
	baseUrl: string;
	modelId: string;
	variantSummaries: Record<string, ReasoningDepthVariantSummary>;
	comparisonRows: ReasoningDepthComparisonRow[];
};

type ReasoningDepthAbConfig = {
	baseUrl: string;
	email: string;
	password: string;
	modelId: string;
	runsPerPrompt: number;
	outputDir: string;
	timeoutMs: number;
};

type QualityCheck = {
	id: string;
	weight: number;
	passed: boolean;
	passedId?: string;
	failedId?: string;
};

type RunArtifact = {
	generatedAt: string;
	baseUrl: string;
	modelId: string;
	plan: ReasoningDepthAbPlan;
	runs: Array<{
		promptId: string;
		promptCategory: ReasoningDepthAbPromptCategory;
		variantId: ReasoningDepthAbVariant["id"];
		repetition: number;
		localClassification: LocalAutoClassification;
		run: BenchmarkRunResult;
		score: ReasoningDepthAbScoreRow;
	}>;
};

export const REASONING_DEPTH_AB_PROMPTS: readonly ReasoningDepthAbPrompt[] = [
	{
		id: "simple_direct",
		category: "simple_direct",
		title: "Simple direct answer",
		prompt:
			"Reply in one short sentence: what does deterministic benchmarking mean for an AI chat stream? Do not use external tools.",
		rubric: {
			minChars: 24,
			maxChars: 260,
			requiredKeywords: ["benchmark"],
		},
	},
	{
		id: "complex_architecture_tradeoff",
		category: "complex_architecture_tradeoff",
		title: "Architecture tradeoff",
		prompt:
			"Compare three safe architectures for a small enterprise research assistant that can search, inspect uploaded notes, cite evidence, and write reports. Include tradeoffs, failure modes, and one recommendation.",
		rubric: {
			minChars: 500,
			maxChars: 5_000,
			requiredKeywords: ["architecture", "tradeoff", "recommendation"],
			requiredSections: ["tradeoffs", "failure", "recommendation"],
		},
	},
	{
		id: "source_grounded_current",
		category: "source_grounded_current",
		title: "Current/source-grounded",
		prompt:
			"Using current public information if available, summarize what an engineering team should verify before adopting Svelte 5 with SvelteKit 2 in production. Cite sources if you search.",
		rubric: {
			minChars: 350,
			maxChars: 4_500,
			requiredKeywords: ["evidence", "sources"],
			requiresEvidence: true,
		},
	},
	{
		id: "project_context_document_style",
		category: "project_context_document_style",
		title: "Document-style project memo",
		prompt:
			"Draft a concise engineering decision memo for adding stream observability to Normal Chat. Use the sections Context, Decision, Consequences, and Rollout.",
		rubric: {
			minChars: 450,
			maxChars: 4_000,
			requiredKeywords: ["latency", "observability", "rollout"],
			requiredSections: ["context", "decision", "consequences", "rollout"],
		},
	},
	{
		id: "debugging_refactor",
		category: "debugging_refactor",
		title: "Debugging/refactor",
		prompt:
			"Review this safe pseudocode for a chat stream timer: start timer, wait for headers, mark first byte, append chunks, finalize. Identify two likely bugs, propose minimal fixes, and name one regression test.",
		rubric: {
			minChars: 350,
			maxChars: 3_500,
			requiredKeywords: ["bug", "fix", "test"],
		},
	},
	{
		id: "planning_recommendation",
		category: "planning_recommendation",
		title: "Planning/recommendation",
		prompt:
			"Create a 30-day rollout plan for changing an AI model reasoning-depth setting. Include checkpoints, metrics, risks, rollback criteria, and who should review the data.",
		rubric: {
			minChars: 500,
			maxChars: 4_500,
			requiredKeywords: ["metrics", "risks", "rollback"],
			requiredSections: ["checkpoints", "metrics", "rollback"],
		},
	},
	{
		id: "hungarian_prompt",
		category: "hungarian_prompt",
		title: "Hungarian response",
		prompt:
			"Valaszolj magyarul. Hasonlitsd ossze roviden az automatikus es a maximalis gondolkodasi melyseget egy vallalati chat alkalmazasban, es adj gyakorlati javaslatot.",
		rubric: {
			minChars: 350,
			maxChars: 3_500,
			requiredKeywords: ["automatikus", "maximalis", "javaslat"],
			mustUseHungarian: true,
		},
	},
] as const;

export const REASONING_DEPTH_AB_VARIANTS: readonly ReasoningDepthAbVariant[] = [
	{
		id: "lean_baseline_off",
		label: "Lean baseline (Off)",
		requestReasoningDepth: "off",
		description:
			"Explicit reasoningDepth=off baseline. This is not a true Standard profile; it is the lean public request mode.",
	},
	{
		id: "current_auto",
		label: "Current Auto",
		requestReasoningDepth: "auto",
		description:
			"Live server Auto behavior for the deployed model and runtime configuration.",
	},
	{
		id: "local_heuristic_auto",
		label: "Local heuristic Auto overlay",
		requestReasoningDepth: "auto",
		description:
			"Sends reasoningDepth=auto and annotates each run with the harness-local deterministic expected profile.",
		usesLocalHeuristicOverlay: true,
	},
	{
		id: "max",
		label: "Max",
		requestReasoningDepth: "max",
		description: "Explicit reasoningDepth=max upper-bound comparison.",
	},
] as const;

export function buildReasoningDepthEvaluationPlan(params: {
	modelId: string;
	runsPerPrompt: number;
	generatedAt?: string;
	prompts?: readonly ReasoningDepthAbPrompt[];
	variants?: readonly ReasoningDepthAbVariant[];
}): ReasoningDepthAbPlan {
	const prompts = params.prompts ?? REASONING_DEPTH_AB_PROMPTS;
	const variants = params.variants ?? REASONING_DEPTH_AB_VARIANTS;
	const runQueue: ReasoningDepthAbPlanRun[] = [];
	let runIndex = 1;

	for (
		let repetition = 1;
		repetition <= params.runsPerPrompt;
		repetition += 1
	) {
		for (const prompt of prompts) {
			const localClassification = classifyPromptForLocalAuto(prompt);
			for (const variant of variants) {
				runQueue.push({
					runIndex,
					repetition,
					prompt,
					variant,
					localClassification,
				});
				runIndex += 1;
			}
		}
	}

	return {
		generatedAt: params.generatedAt ?? new Date().toISOString(),
		modelId: params.modelId,
		runsPerPrompt: params.runsPerPrompt,
		prompts,
		variants,
		runQueue,
	};
}

export function classifyPromptForLocalAuto(
	prompt: ReasoningDepthAbPrompt | string,
): LocalAutoClassification {
	const text = typeof prompt === "string" ? prompt : prompt.prompt;
	const category = typeof prompt === "string" ? undefined : prompt.category;
	const normalized = normalizeText(text);

	if (
		category === "simple_direct" ||
		(/\b(one|short|concise)\b/.test(normalized) &&
			/\b(sentence|define|reply)\b/.test(normalized) &&
			!mentionsEvidence(normalized))
	) {
		return {
			expectedProfile: "off",
			signals: {
				groundingNeed: "none",
				contextBreadth: "narrow",
				outputRoom: "concise",
				toolUse: "none",
			},
			reasons: ["Short direct answer with no evidence or context requirement."],
		};
	}

	if (category === "source_grounded_current" || mentionsEvidence(normalized)) {
		return {
			expectedProfile: "standard",
			signals: {
				groundingNeed: "useful",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "source_heavy",
			},
			reasons: [
				"Current/source-grounded task needs source tooling but should not auto-escalate to maximum.",
			],
		};
	}

	if (
		category === "complex_architecture_tradeoff" ||
		/\b(architecture|tradeoff|compare three|failure modes)\b/.test(normalized)
	) {
		return {
			expectedProfile: "maximum",
			signals: {
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "normal",
			},
			reasons: ["Broad synthesis and tradeoff analysis across alternatives."],
		};
	}

	if (
		category === "debugging_refactor" ||
		/\b(debug|bug|refactor|regression test|pseudocode)\b/.test(normalized)
	) {
		return {
			expectedProfile: "extended",
			signals: {
				groundingNeed: "none",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "none",
			},
			reasons: ["Code reasoning benefits from more than a lean response."],
		};
	}

	if (
		category === "planning_recommendation" ||
		category === "hungarian_prompt" ||
		/\b(rollout|plan|recommendation|javaslat)\b/.test(normalized)
	) {
		return {
			expectedProfile: "extended",
			signals: {
				groundingNeed: "possible",
				contextBreadth: "normal",
				outputRoom: "expanded",
				toolUse: "normal",
			},
			reasons: [
				"Planning/recommendation prompt with multiple evaluation axes.",
			],
		};
	}

	return {
		expectedProfile: "standard",
		signals: {
			groundingNeed: "possible",
			contextBreadth: "normal",
			outputRoom: "normal",
			toolUse: "normal",
		},
		reasons: ["Default deterministic local Auto profile."],
	};
}

export function scoreReasoningDepthRun(params: {
	run: BenchmarkRunResult;
	prompt: ReasoningDepthAbPrompt;
	variant: ReasoningDepthAbVariant;
	repetition: number;
}): ReasoningDepthAbScoreRow {
	const { run, prompt, variant } = params;
	const localClassification = classifyPromptForLocalAuto(prompt);
	const answerText = run.answerText?.trim() ?? "";
	const answerLength = answerText.length || run.textLength || 0;
	const actualRequestedDepth = readString(run.depthMetadata?.requested);
	const actualAppliedProfile = readString(run.depthMetadata?.appliedProfile);
	const depthTiming = readRecord(run.depthMetadata?.timing);
	const classifierSource =
		readString(depthTiming?.classifierSource) ??
		readString(run.depthMetadata?.classifierSource);
	const classifierAttempts = readFiniteNumber(depthTiming?.classifierAttempts);
	const depthSelectionMs = readFiniteNumber(depthTiming?.totalMs);
	const controlModelClassifierMs = readFiniteNumber(
		depthTiming?.controlModelClassifierMs,
	);
	const checks = buildQualityChecks({
		run,
		prompt,
		answerText,
		answerLength,
	});
	const passedChecks = checks
		.filter((check) => check.passed)
		.map((check) => check.passedId ?? check.id);
	const failedChecks = checks
		.filter((check) => !check.passed)
		.map((check) => check.failedId ?? check.id);
	const totalWeight = checks.reduce((total, check) => total + check.weight, 0);
	const passedWeight = checks
		.filter((check) => check.passed)
		.reduce((total, check) => total + check.weight, 0);
	const rawScore = totalWeight === 0 ? 0 : (passedWeight / totalWeight) * 100;
	const score = run.outcome === "ok" ? roundNumber(rawScore) : 0;
	const toolCallNames = run.toolCallNames ?? [];

	return {
		promptId: prompt.id,
		promptCategory: prompt.category,
		promptTitle: prompt.title,
		variantId: variant.id,
		variantLabel: variant.label,
		requestReasoningDepth: variant.requestReasoningDepth,
		repetition: params.repetition,
		runIndex: run.runIndex,
		outcome: run.outcome,
		score,
		passedChecks,
		failedChecks,
		answerLength,
		...(run.firstTokenMs !== undefined
			? { firstTokenMs: run.firstTokenMs }
			: {}),
		...(run.endMs !== undefined ? { endMs: run.endMs } : {}),
		...(run.serverTimeline?.end !== undefined
			? { serverEndMs: run.serverTimeline.end }
			: {}),
		...(depthSelectionMs !== undefined ? { depthSelectionMs } : {}),
		toolCallCount: run.toolCallCount ?? 0,
		toolCallNames,
		localExpectedProfile: localClassification.expectedProfile,
		...(actualRequestedDepth ? { actualRequestedDepth } : {}),
		...(actualAppliedProfile ? { actualAppliedProfile } : {}),
		...(classifierSource ? { classifierSource } : {}),
		...(classifierAttempts !== undefined ? { classifierAttempts } : {}),
		...(controlModelClassifierMs !== undefined
			? { controlModelClassifierMs }
			: {}),
		...(typeof run.depthMetadata?.fallback === "boolean"
			? { depthFallback: run.depthMetadata.fallback }
			: {}),
		heuristicAgreement: actualAppliedProfile
			? actualAppliedProfile === localClassification.expectedProfile
			: null,
		...(run.error ? { error: run.error } : {}),
	};
}

export function summarizeReasoningDepthEvaluation(params: {
	generatedAt: string;
	baseUrl: string;
	modelId: string;
	rows: readonly ReasoningDepthAbScoreRow[];
}): ReasoningDepthAbAggregate {
	const variantSummaries: Record<string, ReasoningDepthVariantSummary> = {};
	const knownVariants = new Map(
		REASONING_DEPTH_AB_VARIANTS.map((variant) => [variant.id, variant]),
	);
	const variantIds = [...new Set(params.rows.map((row) => row.variantId))];

	for (const variantId of variantIds) {
		const rows = params.rows.filter((row) => row.variantId === variantId);
		const variant = knownVariants.get(variantId);
		const scoreStats = createStats(rows.map((row) => row.score)) ?? {
			count: 0,
			min: 0,
			p50: 0,
			p95: 0,
			mean: 0,
		};
		const firstTokenStats = createStats(readNumericRows(rows, "firstTokenMs"));
		const endStats = createStats(readNumericRows(rows, "endMs"));
		const serverEndStats = createStats(readNumericRows(rows, "serverEndMs"));
		const depthSelectionStats = createStats(
			readNumericRows(rows, "depthSelectionMs"),
		);
		const agreementRows = rows.filter(
			(row) => typeof row.heuristicAgreement === "boolean",
		);
		variantSummaries[variantId] = {
			variantId,
			variantLabel: variant?.label ?? rows[0]?.variantLabel ?? variantId,
			requestReasoningDepth:
				variant?.requestReasoningDepth ??
				rows[0]?.requestReasoningDepth ??
				"auto",
			runCount: rows.length,
			okCount: rows.filter((row) => row.outcome === "ok").length,
			errorCount: rows.filter((row) => row.outcome !== "ok").length,
			meanScore: scoreStats.mean,
			score: scoreStats,
			latency: {
				...(firstTokenStats ? { firstTokenMs: firstTokenStats } : {}),
				...(endStats ? { endMs: endStats } : {}),
				...(serverEndStats ? { serverEndMs: serverEndStats } : {}),
				...(depthSelectionStats
					? { depthSelectionMs: depthSelectionStats }
					: {}),
			},
			localExpectedProfileCounts: countValues(
				rows.map((row) => row.localExpectedProfile),
			),
			actualAppliedProfileCounts: countValues(
				rows
					.map((row) => row.actualAppliedProfile)
					.filter((value): value is string => Boolean(value)),
			),
			...(agreementRows.length > 0
				? {
						heuristicAgreementRate: roundNumber(
							(agreementRows.filter((row) => row.heuristicAgreement).length /
								agreementRows.length) *
								100,
						),
					}
				: {}),
		};
	}

	return {
		generatedAt: params.generatedAt,
		baseUrl: params.baseUrl,
		modelId: params.modelId,
		variantSummaries,
		comparisonRows: buildComparisonRows(variantSummaries),
	};
}

function formatReasoningDepthEvaluationConsoleSummary(
	aggregate: ReasoningDepthAbAggregate,
): string {
	const lines = [
		"Reasoning Depth A/B summary",
		`${"variant".padEnd(30)} ${"ok".padStart(5)} ${"score".padStart(7)} ${"depth p50/p95".padStart(17)} ${"first p50/p95".padStart(17)} ${"end p50/p95".padStart(17)} ${"score delta".padStart(12)}`,
		"-".repeat(111),
	];
	const comparisonByVariant = new Map(
		aggregate.comparisonRows.map((row) => [row.variantId, row]),
	);

	for (const variant of REASONING_DEPTH_AB_VARIANTS) {
		const summary = aggregate.variantSummaries[variant.id];
		if (!summary) continue;
		const comparison = comparisonByVariant.get(variant.id);
		lines.push(
			[
				summary.variantLabel.padEnd(30),
				`${summary.okCount}/${summary.runCount}`.padStart(5),
				summary.meanScore.toFixed(1).padStart(7),
				formatP50P95(summary.latency.depthSelectionMs).padStart(17),
				formatP50P95(summary.latency.firstTokenMs).padStart(17),
				formatP50P95(summary.latency.endMs).padStart(17),
				formatDelta(comparison?.scoreDeltaVsLeanBaseline).padStart(12),
			].join(" "),
		);
	}

	return lines.join("\n");
}

async function runReasoningDepthAbEvaluation(config: ReasoningDepthAbConfig) {
	const generatedAt = new Date().toISOString();
	const client = new LiveAiClient(config.baseUrl);
	await client.login(config.email, config.password);
	await assertModelAvailable(client, config.modelId);

	const plan = buildReasoningDepthEvaluationPlan({
		modelId: config.modelId,
		runsPerPrompt: config.runsPerPrompt,
		generatedAt,
	});
	const artifact: RunArtifact = {
		generatedAt,
		baseUrl: config.baseUrl,
		modelId: config.modelId,
		plan,
		runs: [],
	};
	const scoreRows: ReasoningDepthAbScoreRow[] = [];

	for (const item of plan.runQueue) {
		console.log(
			`run ${item.runIndex}/${plan.runQueue.length}: ${item.variant.id} ${item.prompt.id} rep ${item.repetition}`,
		);
		const run = await runSingleStreamBenchmark(client, {
			runIndex: item.runIndex,
			prompt: item.prompt.prompt,
			modelId: config.modelId,
			timeoutMs: config.timeoutMs,
			reasoningDepth: item.variant.requestReasoningDepth,
		});
		const score = scoreReasoningDepthRun({
			run,
			prompt: item.prompt,
			variant: item.variant,
			repetition: item.repetition,
		});
		scoreRows.push(score);
		artifact.runs.push({
			promptId: item.prompt.id,
			promptCategory: item.prompt.category,
			variantId: item.variant.id,
			repetition: item.repetition,
			localClassification: item.localClassification,
			run,
			score,
		});
		console.log(
			`run ${item.runIndex}/${plan.runQueue.length}: ${run.outcome} score=${score.score.toFixed(
				1,
			)} firstToken=${formatMaybeMs(run.firstTokenMs)} end=${formatMaybeMs(
				run.endMs,
			)} applied=${score.actualAppliedProfile ?? "n/a"}`,
		);
	}

	const aggregate = summarizeReasoningDepthEvaluation({
		generatedAt,
		baseUrl: config.baseUrl,
		modelId: config.modelId,
		rows: scoreRows,
	});
	const benchmarkSummaries = createBenchmarkSummariesByVariant(artifact);

	await mkdir(config.outputDir, { recursive: true });
	await writeJsonFile(path.join(config.outputDir, "raw-runs.json"), artifact);
	await writeJsonFile(path.join(config.outputDir, "variant-summaries.json"), {
		generatedAt,
		variantSummaries: aggregate.variantSummaries,
		benchmarkSummaries,
	});
	await writeJsonFile(
		path.join(config.outputDir, "score-rows.json"),
		scoreRows,
	);
	await writeJsonFile(
		path.join(config.outputDir, "aggregate-comparison.json"),
		aggregate,
	);

	console.log(formatReasoningDepthEvaluationConsoleSummary(aggregate));
	console.log(`wrote ${path.join(config.outputDir, "raw-runs.json")}`);
	console.log(`wrote ${path.join(config.outputDir, "variant-summaries.json")}`);
	console.log(`wrote ${path.join(config.outputDir, "score-rows.json")}`);
	console.log(
		`wrote ${path.join(config.outputDir, "aggregate-comparison.json")}`,
	);
}

function buildQualityChecks(params: {
	run: BenchmarkRunResult;
	prompt: ReasoningDepthAbPrompt;
	answerText: string;
	answerLength: number;
}): QualityCheck[] {
	const { run, prompt, answerText, answerLength } = params;
	const normalized = normalizeText(answerText);
	const checks: QualityCheck[] = [
		{ id: "run_ok", weight: 20, passed: run.outcome === "ok" },
		{
			id: "answer_length",
			weight: 15,
			passed:
				answerLength >= prompt.rubric.minChars &&
				answerLength <= prompt.rubric.maxChars,
		},
		{
			id: "refusal_or_error",
			passedId: "no_refusal_or_error",
			failedId: "refusal_or_error",
			weight: 15,
			passed: run.outcome === "ok" && !containsRefusalOrError(normalized),
		},
	];

	if (prompt.rubric.requiredKeywords?.length) {
		checks.push({
			id: "required_keywords",
			weight: 20,
			passed: prompt.rubric.requiredKeywords.every((keyword) =>
				normalized.includes(normalizeText(keyword)),
			),
		});
	}

	if (prompt.rubric.requiredSections?.length) {
		checks.push({
			id: "required_sections",
			weight: 15,
			passed: prompt.rubric.requiredSections.every((section) =>
				normalized.includes(normalizeText(section)),
			),
		});
	}

	if (prompt.rubric.requiresEvidence) {
		checks.push({
			id: "evidence_visible",
			weight: 15,
			passed: hasVisibleEvidence(answerText, run),
		});
	}

	if (prompt.rubric.mustUseHungarian) {
		checks.push({
			id: "hungarian_language",
			weight: 15,
			passed: looksHungarian(normalized),
		});
	}

	return checks;
}

function mentionsEvidence(normalized: string): boolean {
	return /\b(current|latest|source|sources|cite|citation|evidence|public information)\b/.test(
		normalized,
	);
}

function hasVisibleEvidence(
	answerText: string,
	run: BenchmarkRunResult,
): boolean {
	return (
		(run.toolCallCount ?? 0) > 0 ||
		/https?:\/\/\S+/.test(answerText) ||
		/\[[^\]]+\]\([^)]+\)/.test(answerText) ||
		/\[\d+\]/.test(answerText)
	);
}

function containsRefusalOrError(normalized: string): boolean {
	return /\b(i cannot|i can't|sorry|as an ai|error|failed|failure to answer)\b/.test(
		normalized,
	);
}

function looksHungarian(normalized: string): boolean {
	return /\b(az|egy|es|vagy|hogy|javaslat|vallalati|alkalmazasban|gondolkodasi|melyseget)\b/.test(
		normalized,
	);
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function readNumericRows(
	rows: readonly ReasoningDepthAbScoreRow[],
	key: "firstTokenMs" | "endMs" | "serverEndMs" | "depthSelectionMs",
) {
	return rows
		.map((row) => row[key])
		.filter((value): value is number => Number.isFinite(value));
}

function countValues(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

function createStats(values: readonly number[]): BenchmarkStats | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		min: roundNumber(sorted[0]),
		p50: roundNumber(nearestRankPercentile(sorted, 0.5)),
		p95: roundNumber(nearestRankPercentile(sorted, 0.95)),
		mean: roundNumber(sum / sorted.length),
	};
}

function nearestRankPercentile(
	sortedValues: readonly number[],
	percentile: number,
) {
	const index = Math.max(
		0,
		Math.min(
			sortedValues.length - 1,
			Math.ceil(sortedValues.length * percentile) - 1,
		),
	);
	return sortedValues[index];
}

function buildComparisonRows(
	summaries: Record<string, ReasoningDepthVariantSummary>,
): ReasoningDepthComparisonRow[] {
	const baseline = summaries.lean_baseline_off;
	if (!baseline) return [];
	const currentAuto = summaries.current_auto;
	const rows: ReasoningDepthComparisonRow[] = [];

	for (const variant of REASONING_DEPTH_AB_VARIANTS) {
		if (variant.id === "lean_baseline_off") continue;
		const summary = summaries[variant.id];
		if (!summary) continue;
		rows.push({
			variantId: variant.id,
			variantLabel: summary.variantLabel,
			baselineVariantId: "lean_baseline_off",
			deltaVsLeanBaseline: {
				firstTokenP50Ms: delta(
					summary.latency.firstTokenMs?.p50,
					baseline.latency.firstTokenMs?.p50,
				),
				endP50Ms: delta(
					summary.latency.endMs?.p50,
					baseline.latency.endMs?.p50,
				),
			},
			scoreDeltaVsLeanBaseline: delta(summary.meanScore, baseline.meanScore),
			...(currentAuto && variant.id !== "current_auto"
				? {
						deltaVsCurrentAuto: {
							firstTokenP50Ms: delta(
								summary.latency.firstTokenMs?.p50,
								currentAuto.latency.firstTokenMs?.p50,
							),
							endP50Ms: delta(
								summary.latency.endMs?.p50,
								currentAuto.latency.endMs?.p50,
							),
							scoreMean: delta(summary.meanScore, currentAuto.meanScore),
						},
					}
				: {}),
		});
	}

	return rows;
}

function delta(value: number | undefined, baseline: number | undefined) {
	if (value === undefined || baseline === undefined) return undefined;
	return roundNumber(value - baseline);
}

function roundNumber(value: number): number {
	return Math.round(value * 10) / 10;
}

function formatP50P95(stats: BenchmarkStats | undefined): string {
	if (!stats) return "n/a";
	return `${stats.p50.toFixed(0)}/${stats.p95.toFixed(0)}ms`;
}

function formatDelta(value: number | undefined): string {
	if (value === undefined) return "n/a";
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatMaybeMs(value: number | undefined): string {
	return value === undefined ? "n/a" : `${value.toFixed(1)}ms`;
}

function createBenchmarkSummariesByVariant(artifact: RunArtifact) {
	const result: Record<string, ReturnType<typeof summarizeBenchmarkRuns>> = {};
	for (const variant of REASONING_DEPTH_AB_VARIANTS) {
		const runs = artifact.runs
			.filter((item) => item.variantId === variant.id)
			.map((item) => item.run);
		if (runs.length === 0) continue;
		result[variant.id] = summarizeBenchmarkRuns(runs, {
			baseUrl: artifact.baseUrl,
			modelId: artifact.modelId,
			generatedAt: artifact.generatedAt,
		});
	}
	return result;
}

function readReasoningDepthAbConfig(
	env: NodeJS.ProcessEnv,
): ReasoningDepthAbConfig {
	const baseUrl = normalizeBaseUrl(env.LIVE_AI_BASE_URL ?? DEFAULT_BASE_URL);
	const modelId =
		env.LIVE_AI_AB_MODEL_ID?.trim() || env.LIVE_AI_BENCH_MODEL_ID?.trim();
	if (!modelId) {
		throw new Error(
			"LIVE_AI_AB_MODEL_ID or LIVE_AI_BENCH_MODEL_ID is required",
		);
	}
	const runsPerPrompt = readPositiveIntegerEnv(
		env.LIVE_AI_AB_RUNS,
		DEFAULT_RUNS_PER_PROMPT,
		"LIVE_AI_AB_RUNS",
	);
	const timeoutMs = readPositiveIntegerEnv(
		env.LIVE_AI_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS,
		"LIVE_AI_TIMEOUT_MS",
	);
	const outputDir =
		env.LIVE_AI_OUTPUT_DIR ??
		path.join(
			process.cwd(),
			"test-results",
			`reasoning-depth-ab-${new Date().toISOString().replace(/[:.]/g, "-")}`,
		);

	return {
		baseUrl,
		email: requireEnv(env, "LIVE_AI_EMAIL"),
		password: requireEnv(env, "LIVE_AI_PASSWORD"),
		modelId,
		runsPerPrompt,
		outputDir,
		timeoutMs,
	};
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value?.trim()) {
		throw new Error(`${name} is required`);
	}
	return value.trim();
}

function readPositiveIntegerEnv(
	rawValue: string | undefined,
	fallback: number,
	name: string,
): number {
	if (rawValue === undefined || rawValue.trim() === "") {
		return fallback;
	}
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	url.search = "";
	url.hash = "";
	return url.toString();
}

async function writeJsonFile(filePath: string, value: unknown) {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(argv = process.argv.slice(2)) {
	if (argv.length > 0 && (argv[0] === "--help" || argv[0] === "-h")) {
		console.log(
			"Usage: LIVE_AI_BASE_URL=https://ai.example LIVE_AI_EMAIL=... LIVE_AI_PASSWORD=... LIVE_AI_AB_MODEL_ID=provider:local:qwen npx tsx scripts/evaluate-reasoning-depth-ab.ts",
		);
		return;
	}
	if (argv.length > 0) {
		throw new Error("Usage: npx tsx scripts/evaluate-reasoning-depth-ab.ts");
	}
	await runReasoningDepthAbEvaluation(readReasoningDepthAbConfig(process.env));
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
