#!/usr/bin/env tsx
//
// Standalone A/B evaluation harness for the skill-pack instructions upgrade
// (see ~/.claude/plans/write-this-into-a-zippy-hamming.md, "Live evaluation"
// section). For each built-in skill pack it runs a BEFORE (current) and AFTER
// (proposed) instructions variant through the REAL prompt-assembly code
// (`buildSkillSystemPromptAppendix`), sends both to the configured DeepSeek
// model, scores the outputs with deterministic structural signals, and asks
// the same model to blind-judge each BEFORE/AFTER pair.
//
// This script performs LIVE API calls when run normally. Use --smoke for a
// single cheap connectivity check, or --help for usage.
//
// SECURITY: this script must never print, log, or persist the resolved
// model slot's apiKey, nor the full RuntimeConfig object. Only displayName,
// modelName, and baseUrl are ever logged.

// Load environment variables from .env file first (mirrors scripts/seed-user.ts).
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// Set required environment variables if not set (or empty) — mirrors
// scripts/seed-user.ts exactly, since getConfig() reads from the DB and the
// DB module resolves its path from these env vars at import time.
if (!process.env.SESSION_SECRET) {
	// Match env.ts's fallback (src/lib/server/env.ts:264) EXACTLY. The app runs
	// without a .env, so provider API keys were encrypted with this default
	// SESSION_SECRET; the harness must use the same value or decryptApiKey() fails.
	process.env.SESSION_SECRET = "mock-session-secret-for-dev-testing-only";
}
if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

// Import node modules
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Ensure the database directory exists (must be done before importing db module).
const dbDir = dirname(process.env.DATABASE_PATH);
if (!existsSync(dbDir)) {
	console.log(`Creating database directory: ${dbDir}`);
	mkdirSync(dbDir, { recursive: true });
}

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
// Import our application modules (now safe - env vars are already set and directory exists).
import { ALFYAI_NEMOTRON_PROMPT, getSystemPrompt } from "$lib/server/prompts";
import type { SkillPromptContext } from "$lib/server/services/chat-turn/types";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import {
	decryptApiKey,
	getProvider,
	getProviderWithSecrets,
} from "$lib/server/services/providers";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import {
	type SkillEvalFixture,
	type SkillEvalPack,
	skillEvalPacks,
} from "./skill-eval-fixtures";
import {
	buildJudgePrompt,
	type JudgeResponse,
	parseJudgeResponse,
	type StructuralSignal,
	scoreDelta,
	structuralSignals,
} from "./skill-eval-scoring";

const DEFAULT_FIXTURES_PER_PACK = 2;
const DEFAULT_JUDGE_REPEATS = 2;
const DEFAULT_OUTPUT_DIR =
	"/tmp/claude-1000/-home-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/b9fb8607-d73b-4262-85e5-bcd3c6de3165/scratchpad";
const DEFAULT_OUTPUT_BASENAME = "skill-eval-report-BEFORE";
const GENERATION_TEMPERATURE = 0.2;
const GENERATION_MAX_OUTPUT_TOKENS = 1200;
const JUDGE_TEMPERATURE = 0.2;
const JUDGE_MAX_OUTPUT_TOKENS = 800;

const JUDGE_RUBRIC_CRITERIA = [
	"structure",
	"input-gating",
	"source-vs-reasoned separation",
	"decisiveness/actionability",
	"concreteness",
];

// --- CLI arg parsing --------------------------------------------------------

type CliArgs = {
	packs: string[] | "all";
	fixturesPerPack: number;
	judgeRepeats: number;
	smoke: boolean;
	outPath: string;
	help: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
	let packs: string[] | "all" = "all";
	let fixturesPerPack = DEFAULT_FIXTURES_PER_PACK;
	let judgeRepeats = DEFAULT_JUDGE_REPEATS;
	let smoke = false;
	let outPath = path.join(DEFAULT_OUTPUT_DIR, `${DEFAULT_OUTPUT_BASENAME}.md`);
	let help = false;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--smoke") {
			smoke = true;
		} else if (arg.startsWith("--packs=")) {
			const value = arg.slice("--packs=".length).trim();
			packs =
				value === "all" || value === ""
					? "all"
					: value.split(",").map((s) => s.trim());
		} else if (arg.startsWith("--fixtures=")) {
			const value = Number(arg.slice("--fixtures=".length));
			if (!Number.isInteger(value) || value < 1) {
				throw new Error("--fixtures must be a positive integer");
			}
			fixturesPerPack = value;
		} else if (arg.startsWith("--judge-repeats=")) {
			const value = Number(arg.slice("--judge-repeats=".length));
			if (!Number.isInteger(value) || value < 1) {
				throw new Error("--judge-repeats must be a positive integer");
			}
			judgeRepeats = value;
		} else if (arg.startsWith("--out=")) {
			outPath = arg.slice("--out=".length);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return { packs, fixturesPerPack, judgeRepeats, smoke, outPath, help };
}

function printUsage() {
	console.log(
		[
			"Usage: npx tsx scripts/evaluate-skill-instructions-ab.ts [options]",
			"",
			"Options:",
			'  --packs=<comma ids or "all">   Which skill packs to evaluate (default: all)',
			"  --fixtures=<n>                 Fixtures per pack to run (default: 2)",
			"  --judge-repeats=<n>            Blind judge repeats per pair (default: 2)",
			"  --smoke                        Run ONE generation for one pack/fixture and exit",
			"  --out=<path>                   Report output path (.md); a sibling .json is also written",
			"  --help                         Show this message",
		].join("\n"),
	);
}

// --- Model resolution --------------------------------------------------------

type ResolvedModelSlot = {
	baseURL: string;
	apiKey: string;
	modelName: string;
	displayName: string;
};

/**
 * Resolves the DeepSeek V4 Flash model from the `providers` / `provider_models`
 * tables (where UI-added providers live), NOT the legacy MODEL_1/MODEL_2
 * env/getConfig path (admin_config is empty for this model).
 *
 * Resolution:
 *  1. List enabled provider models; find one whose displayName is
 *     "DeepSeek V4 Flash" (case-insensitive exact), falling back to the first
 *     whose displayName contains "deepseek".
 *  2. Look up its provider to get the baseUrl.
 *  3. Resolve the API key: prefer DEEPSEEK_API_KEY from env (skip decryption);
 *     otherwise decrypt the stored encrypted key via decryptApiKey (which
 *     derives its key from SESSION_SECRET internally).
 *
 * SECURITY: the returned object's apiKey must never be logged or persisted,
 * and neither must the provider secrets or SESSION_SECRET. Only
 * displayName/modelName/baseURL may be logged.
 */
async function resolveDeepSeekModelSlot(): Promise<ResolvedModelSlot> {
	const models = await listEnabledProviderModels();

	const exact = models.find(
		(m) => m.displayName.trim().toLowerCase() === "deepseek v4 flash",
	);
	const model =
		exact ??
		models.find((m) => m.displayName.trim().toLowerCase().includes("deepseek"));

	if (!model) {
		const available = models.map((m) => m.displayName).join(", ") || "(none)";
		throw new Error(
			'No enabled provider model found with displayName "DeepSeek V4 Flash" ' +
				`(or containing "deepseek"). Available model displayNames: ${available}. ` +
				"Add the model via the admin UI before running this harness.",
		);
	}

	const modelName = model.name;
	const providerId = model.providerId;

	const provider = await getProvider(providerId);
	if (!provider) {
		throw new Error(
			`Provider "${providerId}" for model "${model.displayName}" was not found.`,
		);
	}
	const baseURL = provider.baseUrl;

	const envKey = process.env.DEEPSEEK_API_KEY;
	let apiKey: string;
	if (envKey && envKey.trim() !== "") {
		apiKey = envKey;
	} else {
		const secrets = await getProviderWithSecrets(providerId);
		if (!secrets) {
			throw new Error(
				`Provider secrets for "${providerId}" (model "${model.displayName}") were not found.`,
			);
		}
		try {
			apiKey = decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv);
		} catch {
			throw new Error(
				"Could not decrypt the stored provider key. Set DEEPSEEK_API_KEY in .env, " +
					"or ensure SESSION_SECRET matches the app instance that added the model.",
			);
		}
	}

	return {
		baseURL,
		apiKey,
		modelName,
		displayName: model.displayName,
	};
}

function createDeepSeekModel(slot: ResolvedModelSlot) {
	const provider = createOpenAICompatible({
		name: "deepseek",
		apiKey: slot.apiKey,
		baseURL: slot.baseURL,
	});
	return provider.languageModel(slot.modelName);
}

// --- Minimal SkillPromptContext construction --------------------------------

function minimalContext(params: {
	skillId: string;
	displayName: string;
	instructions: string;
}): SkillPromptContext {
	return {
		source: "pending_skill",
		skillId: params.skillId,
		skillOwnership: "system",
		skillKind: "skill_pack",
		skillDisplayName: params.displayName,
		skillDescription: params.displayName,
		skillInstructions: params.instructions,
		durationPolicy: "session",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "current_conversation",
		skillVersion: 1,
		linkedSources: [],
	};
}

function buildSystemPrompt(
	instructions: string,
	pack: { skillId: string; displayName: string },
): string {
	const base = getSystemPrompt("alfyai-nemotron") || ALFYAI_NEMOTRON_PROMPT;
	const appendix = buildSkillSystemPromptAppendix(
		minimalContext({
			skillId: pack.skillId,
			displayName: pack.displayName,
			instructions,
		}),
	);
	return appendix ? `${base}\n\n${appendix}` : base;
}

function buildUserMessage(fixture: SkillEvalFixture): string {
	if (!fixture.attachedDoc) return fixture.userMessage;
	return [
		"[Selected source attached to this turn]",
		fixture.attachedDoc,
		"",
		fixture.userMessage,
	].join("\n");
}

// --- Generation --------------------------------------------------------------

type Variant = "before" | "after";

type GenerationResult = {
	packId: string;
	fixtureId: string;
	variant: Variant;
	text: string;
};

async function generateForFixture(params: {
	model: ReturnType<typeof createDeepSeekModel>;
	pack: SkillEvalPack;
	fixture: SkillEvalFixture;
	variant: Variant;
}): Promise<GenerationResult> {
	const { model, pack, fixture, variant } = params;
	const instructions = variant === "before" ? pack.before : pack.after;
	const system = buildSystemPrompt(instructions, pack);
	const userMessage = buildUserMessage(fixture);

	const result = await generateText({
		model,
		system,
		messages: [{ role: "user", content: userMessage }],
		temperature: GENERATION_TEMPERATURE,
		maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
	});

	return {
		packId: pack.skillId,
		fixtureId: fixture.id,
		variant,
		text: result.text,
	};
}

// --- Judging -------------------------------------------------------------

type JudgeRun = {
	judgeResponse: JudgeResponse | null;
	/** Which slot ("r1"/"r2") the AFTER output was placed in for this repeat. */
	afterSlot: "r1" | "r2";
};

async function judgePair(params: {
	model: ReturnType<typeof createDeepSeekModel>;
	beforeText: string;
	afterText: string;
	repeats: number;
}): Promise<JudgeRun[]> {
	const { model, beforeText, afterText, repeats } = params;
	const runs: JudgeRun[] = [];

	for (let i = 0; i < repeats; i++) {
		// Randomize which slot (Response 1 / Response 2) the AFTER variant
		// lands in, to damp position bias, and record the mapping so scoring
		// can attribute wins correctly regardless of judge model bias toward
		// a particular slot.
		const afterIsResponse1 = Math.random() < 0.5;
		const response1 = afterIsResponse1 ? afterText : beforeText;
		const response2 = afterIsResponse1 ? beforeText : afterText;
		const afterSlot: "r1" | "r2" = afterIsResponse1 ? "r1" : "r2";

		const prompt = buildJudgePrompt(
			response1,
			response2,
			JUDGE_RUBRIC_CRITERIA,
		);
		const result = await generateText({
			model,
			system:
				"You are a strict, impartial evaluator. Follow the user's instructions exactly and respond with strict JSON only.",
			messages: [{ role: "user", content: prompt }],
			temperature: JUDGE_TEMPERATURE,
			maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
		});

		runs.push({ judgeResponse: parseJudgeResponse(result.text), afterSlot });
	}

	return runs;
}

// --- Report data model -----------------------------------------------------

type FixtureReport = {
	fixtureId: string;
	userMessage: string;
	before: { text: string; signals: StructuralSignal[] };
	after: { text: string; signals: StructuralSignal[] };
	scoreDelta: ReturnType<typeof scoreDelta>;
	judgeRuns: JudgeRun[];
};

type PackReport = {
	skillId: string;
	displayName: string;
	fixtures: FixtureReport[];
	structuralHitRateBefore: number;
	structuralHitRateAfter: number;
	judgeAfterWinRate: number | null;
};

type FullReport = {
	generatedAt: string;
	model: { displayName: string; modelName: string; baseUrl: string };
	fixturesPerPack: number;
	judgeRepeats: number;
	packs: PackReport[];
};

function hitRate(signals: StructuralSignal[]): number {
	if (signals.length === 0) return 0;
	return signals.filter((s) => s.hit).length / signals.length;
}

/** Wins for the AFTER variant, correctly attributed via the recorded afterSlot mapping. */
function judgeAfterWinCount(runs: JudgeRun[]): {
	afterWins: number;
	decided: number;
} {
	let afterWins = 0;
	let decided = 0;
	for (const run of runs) {
		const winner = run.judgeResponse?.winner;
		if (winner === undefined || winner === null) continue;
		if (winner === "tie") {
			decided += 1;
			continue;
		}
		decided += 1;
		const winnerSlot = winner === 1 ? "r1" : "r2";
		if (winnerSlot === run.afterSlot) afterWins += 1;
	}
	return { afterWins, decided };
}

// --- Report rendering --------------------------------------------------------

function renderMarkdownReport(report: FullReport): string {
	const lines: string[] = [];
	lines.push("# Skill Instructions A/B Evaluation Report");
	lines.push("");
	lines.push(`Generated at: ${report.generatedAt}`);
	lines.push(
		`Model: ${report.model.displayName} (${report.model.modelName}) @ ${report.model.baseUrl}`,
	);
	lines.push(
		`Fixtures per pack: ${report.fixturesPerPack}, judge repeats: ${report.judgeRepeats}`,
	);
	lines.push("");
	lines.push("## Overall summary");
	lines.push("");
	lines.push(
		"| Pack | Structural hit-rate (before) | Structural hit-rate (after) | Judge win-rate (after) |",
	);
	lines.push("| --- | --- | --- | --- |");
	for (const pack of report.packs) {
		lines.push(
			`| ${pack.displayName} | ${(pack.structuralHitRateBefore * 100).toFixed(0)}% | ${(pack.structuralHitRateAfter * 100).toFixed(0)}% | ${pack.judgeAfterWinRate === null ? "n/a" : `${(pack.judgeAfterWinRate * 100).toFixed(0)}%`} |`,
		);
	}
	lines.push("");

	for (const pack of report.packs) {
		lines.push(`## ${pack.displayName} (${pack.skillId})`);
		lines.push("");
		lines.push(
			`Structural hit-rate: before ${(pack.structuralHitRateBefore * 100).toFixed(0)}%, after ${(pack.structuralHitRateAfter * 100).toFixed(0)}%`,
		);
		lines.push(
			`Judge win-rate (after vs before): ${pack.judgeAfterWinRate === null ? "n/a (no decided judge runs)" : `${(pack.judgeAfterWinRate * 100).toFixed(0)}%`}`,
		);
		lines.push("");
		for (const fixture of pack.fixtures) {
			lines.push(`### Fixture: ${fixture.fixtureId}`);
			lines.push("");
			lines.push(`User message: ${fixture.userMessage}`);
			lines.push("");
			lines.push(
				`Structural signals — before hits ${fixture.scoreDelta.beforeHits}, after hits ${fixture.scoreDelta.afterHits}, delta ${fixture.scoreDelta.delta}`,
			);
			lines.push("");
			lines.push("Before signals:");
			for (const s of fixture.before.signals) {
				lines.push(`- ${s.signal}: ${s.hit ? "hit" : "miss"}`);
			}
			lines.push("");
			lines.push("After signals:");
			for (const s of fixture.after.signals) {
				lines.push(`- ${s.signal}: ${s.hit ? "hit" : "miss"}`);
			}
			lines.push("");
			const { afterWins, decided } = judgeAfterWinCount(fixture.judgeRuns);
			lines.push(
				`Judge: after won ${afterWins}/${decided} decided repeats (of ${fixture.judgeRuns.length} total).`,
			);
			lines.push("");
		}
	}

	return lines.join("\n");
}

// --- Main orchestration -------------------------------------------------

function selectPacks(packs: string[] | "all"): SkillEvalPack[] {
	if (packs === "all") return skillEvalPacks;
	const wanted = new Set(packs);
	const selected = skillEvalPacks.filter((p) => wanted.has(p.skillId));
	if (selected.length === 0) {
		throw new Error(
			`No matching packs for --packs=${[...wanted].join(",")}. Known ids: ${skillEvalPacks.map((p) => p.skillId).join(", ")}`,
		);
	}
	return selected;
}

async function runSmoke(
	model: ReturnType<typeof createDeepSeekModel>,
	slot: ResolvedModelSlot,
) {
	const pack = skillEvalPacks[0];
	const fixture = pack.fixtures[0];
	console.log(
		`[smoke] Using model displayName=${slot.displayName} modelName=${slot.modelName}`,
	);
	const result = await generateForFixture({
		model,
		pack,
		fixture,
		variant: "before",
	});
	console.log(`[smoke] ${slot.displayName} / ${slot.modelName} ok`);
	console.log(`[smoke] First 200 chars: ${result.text.slice(0, 200)}`);
}

async function runFullEvaluation(args: CliArgs) {
	const slot = await resolveDeepSeekModelSlot();
	const model = createDeepSeekModel(slot);

	console.log(
		`[evaluate-skill-instructions-ab] Using model displayName=${slot.displayName} modelName=${slot.modelName} baseUrl=${slot.baseURL}`,
	);

	const packs = selectPacks(args.packs);
	const packReports: PackReport[] = [];

	for (const pack of packs) {
		const fixtures = pack.fixtures.slice(0, args.fixturesPerPack);
		const fixtureReports: FixtureReport[] = [];

		for (const fixture of fixtures) {
			console.log(
				`[pack=${pack.skillId}] fixture=${fixture.id} generating BEFORE...`,
			);
			const beforeResult = await generateForFixture({
				model,
				pack,
				fixture,
				variant: "before",
			});
			console.log(
				`[pack=${pack.skillId}] fixture=${fixture.id} generating AFTER...`,
			);
			const afterResult = await generateForFixture({
				model,
				pack,
				fixture,
				variant: "after",
			});

			const beforeSignals = structuralSignals(pack.skillId, beforeResult.text, {
				inputText: fixture.userMessage,
			});
			const afterSignals = structuralSignals(pack.skillId, afterResult.text, {
				inputText: fixture.userMessage,
			});

			console.log(
				`[pack=${pack.skillId}] fixture=${fixture.id} judging (${args.judgeRepeats}x)...`,
			);
			const judgeRuns = await judgePair({
				model,
				beforeText: beforeResult.text,
				afterText: afterResult.text,
				repeats: args.judgeRepeats,
			});

			fixtureReports.push({
				fixtureId: fixture.id,
				userMessage: fixture.userMessage,
				before: { text: beforeResult.text, signals: beforeSignals },
				after: { text: afterResult.text, signals: afterSignals },
				scoreDelta: scoreDelta(beforeSignals, afterSignals),
				judgeRuns,
			});
		}

		const allBeforeSignals = fixtureReports.flatMap((f) => f.before.signals);
		const allAfterSignals = fixtureReports.flatMap((f) => f.after.signals);
		const allJudgeRuns = fixtureReports.flatMap((f) => f.judgeRuns);
		const { afterWins, decided } = judgeAfterWinCount(allJudgeRuns);

		packReports.push({
			skillId: pack.skillId,
			displayName: pack.displayName,
			fixtures: fixtureReports,
			structuralHitRateBefore: hitRate(allBeforeSignals),
			structuralHitRateAfter: hitRate(allAfterSignals),
			judgeAfterWinRate: decided > 0 ? afterWins / decided : null,
		});
	}

	const report: FullReport = {
		generatedAt: new Date().toISOString(),
		model: {
			displayName: slot.displayName,
			modelName: slot.modelName,
			baseUrl: slot.baseURL,
		},
		fixturesPerPack: args.fixturesPerPack,
		judgeRepeats: args.judgeRepeats,
		packs: packReports,
	};

	const outDir = dirname(args.outPath);
	await mkdir(outDir, { recursive: true });
	const markdown = renderMarkdownReport(report);
	await writeFile(args.outPath, markdown, "utf8");
	const jsonPath = args.outPath.replace(/\.md$/, ".json");
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log(`Report written to ${args.outPath}`);
	console.log(`Report JSON written to ${jsonPath}`);
}

async function main(argv = process.argv.slice(2)) {
	const args = parseCliArgs(argv);
	if (args.help) {
		printUsage();
		return;
	}

	if (args.smoke) {
		const slot = await resolveDeepSeekModelSlot();
		const model = createDeepSeekModel(slot);
		await runSmoke(model, slot);
		return;
	}

	await runFullEvaluation(args);
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
	buildSystemPrompt,
	buildUserMessage,
	hitRate,
	judgeAfterWinCount,
	minimalContext,
	parseCliArgs,
	renderMarkdownReport,
	resolveDeepSeekModelSlot,
};
