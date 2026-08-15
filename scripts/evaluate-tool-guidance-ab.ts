#!/usr/bin/env tsx
//
// G0 (prompt eval baseline) harness for the architecture-deepening
// programme's Normal Chat guidance-pack removal (G1). G1 will DELETE the
// Normal Chat guidance packs (src/lib/server/services/normal-chat-context.ts,
// `planNormalChatGuidancePacks` / `NORMAL_CHAT_GUIDANCE_PACKS`) and move each
// tool's usage rules into its own tool `description`
// (src/lib/server/services/normal-chat-tools/index.ts). A probe already
// proved pack SELECTION varies (English-only regexes keyed on the latest
// message only; different packs for an EN vs HU phrasing of the identical
// request; follow-up turns can lose packs a first turn would have gotten) —
// this harness exists to prove whether that variation actually degrades
// TOOL SELECTION, which is the falsifiable claim G1 needs before it can
// delete the packs.
//
// For each corpus turn (scripts/eval/tool-guidance-fixtures.ts) this script:
//   1. Assembles the REAL outbound system prompt via the REAL
//      `buildOutboundSystemPrompt` (current code = guidance packs = the
//      BEFORE arm; G1 will re-run this SAME script, unmodified, against ITS
//      code to produce the AFTER arm — see `--label` below).
//   2. Calls `generateText({ model, system, messages, tools })` where
//      `tools` are DEFINITION-ONLY (name + description + zod input schema,
//      NO `execute`) so the model's tool-SELECTION is observed without any
//      real Parallel/Brave/sandbox side effect or cost. AI SDK v6 tools
//      without `execute` are "client-side tools": `generateText`'s default
//      `stopWhen` is `stepCountIs(1)`, so this is naturally single-step —
//      the model either emits a tool call (captured in `result.toolCalls`,
//      never run) or answers directly in `result.text`. Confirmed against
//      the Vercel AI SDK docs via Context7 (see the "Define a client-side
//      tool" example and `isStepCount`'s default-of-1 behavior).
//   3. Scores the result with the deterministic, unit-tested functions in
//      `scripts/tool-guidance-scoring.ts` (NOT re-implemented here).
//   4. Writes a JSON + markdown report to `scripts/eval/results/`.
//
// This script performs LIVE API calls when run normally (not --smoke or
// --dry-run). It is NOT run as part of this repo's `npm test`/`npm run
// check` gate — see the header comment on evaluate-skill-instructions-ab.ts
// for the identical convention this file clones.
//
// SECURITY: this script must never print, log, or persist the resolved
// model slot's apiKey, nor the full RuntimeConfig object. Only displayName,
// modelName, and baseUrl are ever logged — mirrors
// evaluate-skill-instructions-ab.ts exactly.

// Load environment variables from .env file first (mirrors scripts/seed-user.ts
// and scripts/evaluate-skill-instructions-ab.ts).
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// Match env.ts's fallback (src/lib/server/env.ts:264) EXACTLY, for the same
// reason evaluate-skill-instructions-ab.ts does: the app runs without a
// .env in dev, so provider API keys were encrypted with this default
// SESSION_SECRET; this harness must use the same value or decryptApiKey()
// fails. Must be set before any config-store/db import.
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET = "mock-session-secret-for-dev-testing-only";
}
if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

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
import { generateText, stepCountIs, tool } from "ai";
// Import our application modules (now safe - env vars are already set and directory exists).
import { ALFYAI_NEMOTRON_PROMPT, getSystemPrompt } from "$lib/server/prompts";
// READ-ONLY import of the real prompt-assembly + pack-planning code under
// test — G1 owns normal-chat-context.ts; this harness only calls its
// exported functions, never modifies them.
import {
	buildOutboundSystemPrompt,
	planNormalChatGuidancePacks,
} from "$lib/server/services/normal-chat-context";
// READ-ONLY imports of each tool's own zod input schema. These are exported
// from each tool's OWN module (research-web.ts, fetch-url.ts, etc.), not
// from normal-chat-tools/index.ts itself, so importing them does not touch
// the file G1 owns.
import { fetchUrlInputSchema } from "$lib/server/services/normal-chat-tools/fetch-url";
import { imageSearchInputSchema } from "$lib/server/services/normal-chat-tools/image-search";
import { memoryContextInputSchema } from "$lib/server/services/normal-chat-tools/memory-context";
import { produceFileInputSchema } from "$lib/server/services/normal-chat-tools/produce-file";
import { researchWebInputSchema } from "$lib/server/services/normal-chat-tools/research-web";
import { listEnabledProviderModels } from "$lib/server/services/provider-models";
import {
	decryptApiKey,
	getProvider,
	getProviderWithSecrets,
} from "$lib/server/services/providers";
import {
	type ExpectedTool,
	summarizeToolGuidanceCorpus,
	type ToolGuidanceFixture,
	toolGuidanceFixtures,
} from "./eval/tool-guidance-fixtures";
import {
	citationPresent,
	correctToolSelected,
	fileProduced,
	imagesEmbedded,
	summarizeHitRate,
	type ToolCallLike,
} from "./tool-guidance-scoring";

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "scripts/eval/results");
const GENERATION_TEMPERATURE = 0.2;
const GENERATION_MAX_OUTPUT_TOKENS = 900;

// ── Tool descriptions (hand-copied, READ-ONLY provenance) ───────────────
//
// `TOOL_I18N` in src/lib/server/services/normal-chat-tools/index.ts (~line
// 173) is NOT exported, and this harness must not modify that file (G1 owns
// it). The five descriptions below are copied by hand from `TOOL_I18N.en` /
// `TOOL_I18N.hu` for the five tools this harness evaluates, exactly the same
// convention scripts/skill-eval-fixtures.ts already uses for the guidance
// pack "before" text. If TOOL_I18N's wording changes, this block must be
// re-synced by hand — there is no automatic drift detection.
type ToolGuidanceToolName =
	| "research_web"
	| "fetch_url"
	| "image_search"
	| "produce_file"
	| "memory_context";

const TOOL_DESCRIPTIONS: Record<
	"en" | "hu",
	Record<ToolGuidanceToolName, string>
> = {
	en: {
		research_web:
			"Search and fetch current web sources, returning compact citation-ready evidence.",
		fetch_url:
			"Fetch and read specific web pages by URL, returning citation-ready page content. Use when the user gives a link or you need full details/specs from a page beyond search snippets.",
		image_search: "Search the web for image results for the current request.",
		produce_file:
			"Queue generation of downloadable files for the current conversation.",
		memory_context:
			"Retrieve bounded durable memory, named project-folder context, project continuity, persona memory, or account history for this conversation.",
	},
	hu: {
		research_web:
			"Keresés az interneten aktuális források után, tömör, hivatkozásra kész bizonyítékokkal.",
		fetch_url:
			"Konkrét weboldalak letöltése és elolvasása URL alapján, hivatkozásra kész oldaltartalommal. Akkor használd, ha a felhasználó megad egy linket, vagy ha a keresési részleteken túl egy oldal teljes tartalmára/adataira van szükséged.",
		image_search: "Képkeresés az interneten az aktuális kéréshez.",
		produce_file:
			"Letölthető fájlok generálásának ütemezése az aktuális beszélgetéshez.",
		memory_context:
			"Tartós memória, projektmappa-kontextus, folytonosság, személyre szabott memória vagy fiókelőzmények lekérése ehhez a beszélgetéshez.",
	},
};

/**
 * Builds the definition-only tool set for one fixture's language: name +
 * description (matching the app's real per-language tool description) +
 * zod input schema, and deliberately NO `execute`. Mirrors the real app's 5
 * Parallel/file/memory tools; deliberately excludes connection tools,
 * `read_generated_file`, and the `done` tool the tool-termination guidance
 * pack references (see the report's "Limitations" section for why that's
 * fine for a tool-SELECTION signal).
 */
function buildToolDefinitions(language: "en" | "hu") {
	const descriptions = TOOL_DESCRIPTIONS[language];
	return {
		research_web: tool({
			description: descriptions.research_web,
			inputSchema: researchWebInputSchema,
		}),
		fetch_url: tool({
			description: descriptions.fetch_url,
			inputSchema: fetchUrlInputSchema,
		}),
		image_search: tool({
			description: descriptions.image_search,
			inputSchema: imageSearchInputSchema,
		}),
		produce_file: tool({
			description: descriptions.produce_file,
			// produce_file's real schema is a `.passthrough()` object; zod
			// object schemas are valid AI SDK v6 `inputSchema` values as-is.
			inputSchema: produceFileInputSchema,
		}),
		memory_context: tool({
			description: descriptions.memory_context,
			inputSchema: memoryContextInputSchema,
		}),
	};
}

// ── CLI arg parsing ──────────────────────────────────────────────────────

type EvalLabel = "before" | "after";

type CliArgs = {
	label: EvalLabel;
	limit: number | null;
	smoke: boolean;
	outPath: string | null;
	help: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
	let label: EvalLabel = "before";
	let limit: number | null = null;
	let smoke = false;
	let outPath: string | null = null;
	let help = false;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--smoke") {
			smoke = true;
		} else if (arg.startsWith("--label=")) {
			const value = arg.slice("--label=".length).trim();
			if (value !== "before" && value !== "after") {
				throw new Error(`--label must be "before" or "after", got: ${value}`);
			}
			label = value;
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

	return { label, limit, smoke, outPath, help };
}

function printUsage() {
	console.log(
		[
			"Usage: npx tsx scripts/evaluate-tool-guidance-ab.ts [options]",
			"",
			"Options:",
			"  --label=before|after   Names the output file only — the harness always runs",
			"                         CURRENT code; BEFORE/AFTER is a code-version distinction,",
			"                         not a harness flag (default: before)",
			"  --limit=<n>            Evaluate only the first n corpus fixtures (default: all 68)",
			"  --smoke                Run ONE fixture and exit — cheap connectivity check",
			"  --out=<path>           Report output path (.md); a sibling .json is also written",
			"  --help                 Show this message",
			"",
			"Model resolution: set EVAL_MODEL_DISPLAY_NAME to pick a specific enabled",
			"provider model by displayName; otherwise the first enabled provider model",
			"(by sortOrder) is used. Requires a reachable DB with at least one enabled",
			"provider model — see resolveEvalModelSlot().",
		].join("\n"),
	);
}

// ── Model resolution ─────────────────────────────────────────────────────

type ResolvedModelSlot = {
	baseURL: string;
	apiKey: string;
	modelName: string;
	displayName: string;
};

/**
 * Resolves the model to evaluate against. Model-agnostic by design (this
 * harness must also run on the staging box, which configures a self-hosted
 * qwen model, not DeepSeek):
 *
 *  1. If `EVAL_MODEL_DISPLAY_NAME` is set, use the enabled provider model
 *     whose displayName matches it exactly (case-insensitive).
 *  2. Otherwise, use the first enabled provider model (`listEnabledProviderModels()`
 *     is already ordered by `sortOrder`).
 *  3. Look up its provider for the baseUrl, and decrypt its stored API key
 *     via `decryptApiKey` (which derives its key from SESSION_SECRET
 *     internally) — exactly the same DB-decryption path
 *     evaluate-skill-instructions-ab.ts uses, with no provider-specific env
 *     var special-casing (that harness's DEEPSEEK_API_KEY fallback doesn't
 *     generalize to an unknown provider name).
 *
 * SECURITY: the returned object's apiKey must never be logged or persisted,
 * and neither must the provider secrets or SESSION_SECRET. Only
 * displayName/modelName/baseURL may ever be logged.
 */
async function resolveEvalModelSlot(): Promise<ResolvedModelSlot> {
	const models = await listEnabledProviderModels();
	if (models.length === 0) {
		throw new Error(
			"No enabled provider models found in the DB. Configure at least one " +
				"provider + model via the admin UI (or on staging, the box's own " +
				"qwen config) before running this harness.",
		);
	}

	const overrideName = process.env.EVAL_MODEL_DISPLAY_NAME?.trim();
	let model: (typeof models)[number] | undefined;
	if (overrideName) {
		model = models.find(
			(m) => m.displayName.trim().toLowerCase() === overrideName.toLowerCase(),
		);
		if (!model) {
			const available = models.map((m) => m.displayName).join(", ") || "(none)";
			throw new Error(
				`No enabled provider model found with displayName "${overrideName}" ` +
					`(from EVAL_MODEL_DISPLAY_NAME). Available model displayNames: ${available}.`,
			);
		}
	} else {
		model = models[0];
	}

	const provider = await getProvider(model.providerId);
	if (!provider) {
		throw new Error(
			`Provider "${model.providerId}" for model "${model.displayName}" was not found.`,
		);
	}
	const baseURL = provider.baseUrl;

	const secrets = await getProviderWithSecrets(model.providerId);
	if (!secrets) {
		throw new Error(
			`Provider secrets for "${model.providerId}" (model "${model.displayName}") were not found.`,
		);
	}
	// Prefer an explicit env key (mirrors the existing harness's DEEPSEEK_API_KEY
	// path). The app resolves the provider key from MODEL_*_API_KEY in .env via
	// config-store at runtime, so the stored DB blob may be encrypted under a
	// different SESSION_SECRET than this process sees; the env key is the
	// authoritative one the app actually uses. Fall back to DB decryption.
	let apiKey: string;
	const envKey = process.env.EVAL_MODEL_API_KEY?.trim();
	if (envKey) {
		apiKey = envKey;
	} else {
		try {
			apiKey = decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv);
		} catch {
			throw new Error(
				"Could not decrypt the stored provider key. Set EVAL_MODEL_API_KEY " +
					"in the environment, or ensure SESSION_SECRET matches the app " +
					"instance that added this model.",
			);
		}
	}

	return {
		baseURL,
		apiKey,
		modelName: model.name,
		displayName: model.displayName,
	};
}

function createEvalModel(slot: ResolvedModelSlot) {
	const provider = createOpenAICompatible({
		name: "tool-guidance-eval",
		apiKey: slot.apiKey,
		baseURL: slot.baseURL,
	});
	return provider.languageModel(slot.modelName);
}

// ── System prompt assembly (calls the REAL production function) ─────────

function buildSystemPromptForFixture(fixture: ToolGuidanceFixture): string {
	const basePrompt =
		getSystemPrompt("alfyai-nemotron") || ALFYAI_NEMOTRON_PROMPT;
	const latestMessage = fixture.messages[fixture.messages.length - 1];
	// Pack selection (inside buildOutboundSystemPrompt, when no
	// `guidancePackSelection` override is passed) runs its regexes against
	// `inputValue` ONLY — never the full `messages` history. Passing the
	// latest message's raw text here mirrors the real runtime exactly (see
	// normal-chat-context.ts `buildPreparationSystemPromptFromInput`, which
	// also plans packs from `params.message`, the current turn only) and is
	// precisely the mechanism this corpus's `isFollowUp` fixtures probe.
	return buildOutboundSystemPrompt({
		basePrompt,
		inputValue: latestMessage.content,
		responseLanguage: fixture.language,
		fileProductionToolsAvailable: true,
	});
}

// ── Generation ────────────────────────────────────────────────────────────

type GenerationResult = {
	text: string;
	toolCalls: ToolCallLike[];
};

async function generateForFixture(params: {
	model: ReturnType<typeof createEvalModel>;
	fixture: ToolGuidanceFixture;
}): Promise<GenerationResult> {
	const { model, fixture } = params;
	const system = buildSystemPromptForFixture(fixture);
	const tools = buildToolDefinitions(fixture.language);

	const result = await generateText({
		model,
		system,
		messages: fixture.messages,
		tools,
		// Explicit for clarity — this is already generateText's default, and
		// is what makes tool calls observed-but-never-executed: with no
		// `execute` on any tool, the SDK cannot auto-run a tool call, so a
		// step boundary is unavoidable either way. Kept explicit so a future
		// AI SDK major version change to the default doesn't silently turn
		// this into a multi-step loop.
		stopWhen: stepCountIs(1),
		temperature: GENERATION_TEMPERATURE,
		maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
	});

	return {
		text: result.text,
		toolCalls: result.toolCalls.map((call) => ({ toolName: call.toolName })),
	};
}

// ── Report data model ────────────────────────────────────────────────────

type FixtureResult = {
	fixtureId: string;
	language: "en" | "hu";
	category: string;
	isFollowUp: boolean;
	expectedTool: ExpectedTool;
	calledTools: string[];
	text: string;
	toolSelectionCorrect: boolean;
	citationHit: boolean | null;
	imageHit: boolean | null;
	fileHit: boolean | null;
	guidancePackMode: "compact" | "full" | "disabled";
	guidancePackIds: string[];
};

type DimensionReport = {
	hits: number;
	applicable: number;
	hitRate: number | null;
};

type FullReport = {
	generatedAt: string;
	label: EvalLabel;
	model: { displayName: string; modelName: string; baseUrl: string };
	corpus: ReturnType<typeof summarizeToolGuidanceCorpus>;
	dimensions: {
		toolSelection: DimensionReport;
		citation: DimensionReport;
		image: DimensionReport;
		file: DimensionReport;
	};
	limitations: string[];
	results: FixtureResult[];
};

const REPORT_LIMITATIONS = [
	"Hand-written corpus: real user messages are messier than anything in scripts/eval/tool-guidance-fixtures.ts — typos, code-switching mid-sentence, run-on phrasing, mixed EN/HU within one message. This corpus demonstrates the pack-selection MECHANISM (regex/length/language sensitivity), not real-traffic prevalence; treat any hit-rate delta as a lower bound on how often it fires in production.",
	"Single-step, definition-only tools: no tool actually executes, so a model that calls a tool typically stops with empty `text` in the same step (there is no tool RESULT to answer from yet). `toolSelectionCorrect` and `fileHit` (both read `toolCalls`) are reliable under this design; `citationHit` and `imageHit` (both read `text`) will structurally under-fire and a near-zero rate there is not evidence of a guidance regression — it's the harness design. Treat them as reusable, unit-tested primitives, not as this slice's primary signal.",
	"Reduced tool surface: only the 5 Parallel/file/memory tools this corpus targets are defined (research_web, fetch_url, image_search, produce_file, memory_context) — connection tools (calendar/files/email/...), read_generated_file, and the tool-loop's `done` tool are not. The tool-termination guidance pack still references calling `done`; since it's undefined here the model may mention it in text or attempt an unrecognized tool call, which the AI SDK reports as an invalid/dynamic tool call rather than throwing. This doesn't affect scoring for the five evaluated tools.",
	"BEFORE vs AFTER is a CODE-version distinction, not a flag this script exposes: this run always assembles the system prompt via whatever `buildOutboundSystemPrompt` / `planNormalChatGuidancePacks` currently do in the checked-out code. G0 commits the BEFORE (packs) baseline; G1 re-runs this SAME script, unmodified, after deleting the packs to produce the AFTER report. `--label` only names the output file.",
];

function hitRateOf(flags: Array<boolean | null>): DimensionReport {
	return summarizeHitRate(flags);
}

// ── Report rendering ──────────────────────────────────────────────────────

function renderMarkdownReport(report: FullReport): string {
	const lines: string[] = [];
	lines.push("# Tool Guidance A/B Evaluation Report");
	lines.push("");
	lines.push(`Generated at: ${report.generatedAt}`);
	lines.push(`Label: ${report.label}`);
	lines.push(
		`Model: ${report.model.displayName} (${report.model.modelName}) @ ${report.model.baseUrl}`,
	);
	lines.push("");
	lines.push("## Corpus breakdown");
	lines.push("");
	lines.push(
		`Total: ${report.corpus.total} (en: ${report.corpus.enCount}, hu: ${report.corpus.huCount}, ${(report.corpus.huPercent * 100).toFixed(1)}% hu) — follow-up turns: ${report.corpus.followUpCount}`,
	);
	lines.push("");
	lines.push("By category:");
	for (const [category, count] of Object.entries(report.corpus.byCategory)) {
		lines.push(`- ${category}: ${count}`);
	}
	lines.push("");
	lines.push("By expected tool:");
	for (const [expectedTool, count] of Object.entries(
		report.corpus.byExpectedTool,
	)) {
		lines.push(`- ${expectedTool}: ${count}`);
	}
	lines.push("");
	lines.push("## Per-dimension hit-rates");
	lines.push("");
	lines.push("| Dimension | Hits | Applicable | Hit rate |");
	lines.push("| --- | --- | --- | --- |");
	for (const [name, dim] of Object.entries(report.dimensions)) {
		lines.push(
			`| ${name} | ${dim.hits} | ${dim.applicable} | ${dim.hitRate === null ? "n/a" : `${(dim.hitRate * 100).toFixed(1)}%`} |`,
		);
	}
	lines.push("");
	lines.push("## Limitations");
	lines.push("");
	for (const limitation of report.limitations) {
		lines.push(`- ${limitation}`);
	}
	lines.push("");
	lines.push("## Per-fixture results");
	lines.push("");
	lines.push(
		"| id | lang | category | follow-up | expected | called | correct | pack mode |",
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const r of report.results) {
		lines.push(
			`| ${r.fixtureId} | ${r.language} | ${r.category} | ${r.isFollowUp ? "yes" : "no"} | ${r.expectedTool} | ${r.calledTools.join(", ") || "(none)"} | ${r.toolSelectionCorrect ? "✅" : "❌"} | ${r.guidancePackMode} |`,
		);
	}
	lines.push("");

	return lines.join("\n");
}

// ── Main orchestration ───────────────────────────────────────────────────

async function scoreFixture(params: {
	model: ReturnType<typeof createEvalModel>;
	fixture: ToolGuidanceFixture;
}): Promise<FixtureResult> {
	const { model, fixture } = params;
	const generation = await generateForFixture({ model, fixture });

	const latestMessage = fixture.messages[fixture.messages.length - 1];
	const guidancePlan = planNormalChatGuidancePacks({
		message: latestMessage.content,
		responseLanguage: fixture.language,
		fileProductionToolsAvailable: true,
	});

	return {
		fixtureId: fixture.id,
		language: fixture.language,
		category: fixture.category,
		isFollowUp: fixture.isFollowUp,
		expectedTool: fixture.expectedTool,
		calledTools: generation.toolCalls.map((c) => c.toolName),
		text: generation.text,
		toolSelectionCorrect: correctToolSelected(
			generation.toolCalls,
			fixture.expectedTool,
		),
		citationHit:
			fixture.expectedSignals?.citation === true
				? citationPresent(generation.text)
				: null,
		imageHit:
			fixture.expectedSignals?.image === true
				? imagesEmbedded(generation.text)
				: null,
		fileHit:
			fixture.expectedSignals?.file === true
				? fileProduced(generation.toolCalls)
				: null,
		guidancePackMode: guidancePlan.mode,
		guidancePackIds: guidancePlan.selectedPackIds,
	};
}

async function runSmoke(model: ReturnType<typeof createEvalModel>) {
	const fixture = toolGuidanceFixtures[0];
	console.log(`[smoke] Using fixture=${fixture.id} (${fixture.language})`);
	const result = await scoreFixture({ model, fixture });
	console.log(
		`[smoke] expected=${result.expectedTool} called=[${result.calledTools.join(", ")}] correct=${result.toolSelectionCorrect}`,
	);
	console.log(`[smoke] First 200 chars of text: ${result.text.slice(0, 200)}`);
}

async function runFullEvaluation(args: CliArgs) {
	const slot = await resolveEvalModelSlot();
	const model = createEvalModel(slot);

	console.log(
		`[evaluate-tool-guidance-ab] label=${args.label} model displayName=${slot.displayName} modelName=${slot.modelName} baseUrl=${slot.baseURL}`,
	);

	const fixtures = args.limit
		? toolGuidanceFixtures.slice(0, args.limit)
		: toolGuidanceFixtures;

	const results: FixtureResult[] = [];
	for (const fixture of fixtures) {
		console.log(`[fixture=${fixture.id}] generating...`);
		const result = await scoreFixture({ model, fixture });
		results.push(result);
		console.log(
			`[fixture=${fixture.id}] expected=${result.expectedTool} called=[${result.calledTools.join(", ")}] correct=${result.toolSelectionCorrect}`,
		);
	}

	const dimensions = {
		toolSelection: hitRateOf(results.map((r) => r.toolSelectionCorrect)),
		citation: hitRateOf(results.map((r) => r.citationHit)),
		image: hitRateOf(results.map((r) => r.imageHit)),
		file: hitRateOf(results.map((r) => r.fileHit)),
	};

	const report: FullReport = {
		generatedAt: new Date().toISOString(),
		label: args.label,
		model: {
			displayName: slot.displayName,
			modelName: slot.modelName,
			baseUrl: slot.baseURL,
		},
		corpus: summarizeToolGuidanceCorpus(fixtures),
		dimensions,
		limitations: REPORT_LIMITATIONS,
		results,
	};

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath =
		args.outPath ??
		path.join(
			DEFAULT_OUTPUT_DIR,
			`tool-guidance-eval-${args.label}-${timestamp}.md`,
		);

	const outDir = dirname(outPath);
	await mkdir(outDir, { recursive: true });
	const markdown = renderMarkdownReport(report);
	await writeFile(outPath, markdown, "utf8");
	const jsonPath = outPath.replace(/\.md$/, ".json");
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

	console.log(`Report written to ${outPath}`);
	console.log(`Report JSON written to ${jsonPath}`);
	console.log(
		`Tool selection hit rate: ${dimensions.toolSelection.hitRate === null ? "n/a" : `${(dimensions.toolSelection.hitRate * 100).toFixed(1)}%`}`,
	);
}

async function main(argv = process.argv.slice(2)) {
	const args = parseCliArgs(argv);
	if (args.help) {
		printUsage();
		return;
	}

	if (args.smoke) {
		const slot = await resolveEvalModelSlot();
		const model = createEvalModel(slot);
		await runSmoke(model);
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
	buildSystemPromptForFixture,
	buildToolDefinitions,
	hitRateOf,
	parseCliArgs,
	REPORT_LIMITATIONS,
	renderMarkdownReport,
	resolveEvalModelSlot,
};
