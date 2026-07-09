#!/usr/bin/env tsx
//
// Option-A (local-distill) fidelity eval harness. Compares live LOCAL-DISTILLED
// vs RAW-data answers on a representative set of connector questions, and has
// a judge model score how well the distilled answer preserves the raw
// answer's correctness/completeness. Produces the quality-hit % that
// backfills the `connections.locality.fidelityNote` i18n copy (Issue 7.4).
//
// This is a PRE-RELEASE harness, NOT run in CI: it needs a reachable local
// distill model and a reachable chat model, both configured the same way the
// app itself configures them (admin config / env — see config-store.ts). Off
// -box (e.g. in CI) it exits gracefully with a clear message instead of
// crashing; see `checkOptionAFidelityConfigured` in
// `option-a-fidelity-scoring.ts` for the (unit-tested) preflight check, and
// `README-option-a-fidelity.md` for how to run it on-box.
//
// Run with: npx tsx scripts/eval/option-a-fidelity.ts

// Load environment variables from .env file first (mirrors scripts/seed-user.ts
// and scripts/evaluate-skill-instructions-ab.ts).
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// Match env.ts's fallback (src/lib/server/env.ts) EXACTLY — see
// evaluate-skill-instructions-ab.ts for why this must be set before any
// config-store/db import.
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

const dbDir = dirname(process.env.DATABASE_PATH);
if (!existsSync(dbDir)) {
	mkdirSync(dbDir, { recursive: true });
}

import type { ModelId } from "$lib/types";
import { OPTION_A_FIDELITY_FIXTURES } from "./fixtures/option-a-fidelity.fixtures";
import {
	buildCompletedResult,
	buildFidelityJudgePrompt,
	buildNotConfiguredResult,
	checkOptionAFidelityConfigured,
	formatOptionAFidelitySummary,
	type OptionAFidelityCaseOutcome,
	type OptionAFidelityPreflightDeps,
	type OptionAFidelitySummaryResult,
	parseFidelityJudgeResponse,
} from "./option-a-fidelity-scoring";

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "scripts/eval/results");
const HARNESS_USER_ID = "option-a-fidelity-eval-harness";

// --- CLI arg parsing ---------------------------------------------------------

type CliArgs = {
	chatModelId: string;
	outPath: string;
	help: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
	let chatModelId = "model1";
	let outPath = path.join(
		DEFAULT_OUTPUT_DIR,
		`option-a-fidelity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	let help = false;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg.startsWith("--chat-model=")) {
			chatModelId = arg.slice("--chat-model=".length).trim();
		} else if (arg.startsWith("--out=")) {
			outPath = arg.slice("--out=".length);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return { chatModelId, outPath, help };
}

function printUsage() {
	console.log(
		[
			"Usage: npx tsx scripts/eval/option-a-fidelity.ts [options]",
			"",
			"Options:",
			"  --chat-model=<id>   Chat model id to answer questions with (default: model1)",
			"  --out=<path>        Result JSON output path (default: scripts/eval/results/option-a-fidelity-<timestamp>.json)",
			"  --help              Show this message",
			"",
			"Requires a reachable local-distill model (memoryConsolidationModel, must",
			"resolve to a local/non-cloud host) and a reachable chat model. Off-box or",
			"unconfigured, this exits gracefully with a skip message instead of failing.",
			"See scripts/eval/README-option-a-fidelity.md.",
		].join("\n"),
	);
}

// --- JSON schemas for the control-model calls --------------------------------

const ANSWER_JSON_SCHEMA = {
	name: "option_a_fidelity_answer",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["answer"],
		properties: {
			answer: { type: "string" },
		},
	},
};

const FIDELITY_JUDGE_JSON_SCHEMA = {
	name: "option_a_fidelity_judge",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["fidelity", "rationale"],
		properties: {
			fidelity: { type: "integer", minimum: 0, maximum: 100 },
			rationale: { type: "string" },
		},
	},
};

function extractAnswerText(rawText: string): string {
	try {
		const parsed = JSON.parse(rawText) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as Record<string, unknown>).answer === "string"
		) {
			return (parsed as Record<string, unknown>).answer as string;
		}
	} catch {
		// Not JSON (or missing the field) — fall back to the raw text below.
	}
	return rawText.trim();
}

// --- Preflight wiring ---------------------------------------------------------

async function buildRealPreflightDeps(): Promise<OptionAFidelityPreflightDeps> {
	const { getConfig } = await import("$lib/server/config-store");
	const { resolveNormalChatModelRunProvider } = await import(
		"$lib/server/services/normal-chat-model"
	);
	const { isCloudModel } = await import(
		"$lib/server/services/connections/locality"
	);

	return {
		resolveChatProvider: async (chatModelId: string) => {
			const config = getConfig();
			const provider = await resolveNormalChatModelRunProvider(
				chatModelId,
				config,
			);
			return {
				baseUrl: provider.baseUrl,
				modelName: provider.modelName,
				displayName: provider.displayName,
			};
		},
		resolveDistillModelId: () => getConfig().memoryConsolidationModel,
		isCloudModel,
	};
}

// --- Running one fixture case -------------------------------------------------

type CaseDetail = {
	caseId: string;
	capability: string;
	question: string;
	outcome: "scored" | "withheld" | "error";
	rawAnswer?: string;
	distilledAnswer?: string;
	fidelity?: number;
	rationale?: string;
	error?: string;
};

async function answerQuestion(params: {
	sendJsonControlMessage: typeof import("$lib/server/services/normal-chat-control-model").sendJsonControlMessage;
	chatModelId: string;
	capability: string;
	question: string;
	dataText: string;
}): Promise<string> {
	const message = [
		`User question: ${params.question}`,
		"",
		"Data:",
		params.dataText,
	].join("\n");
	const res = await params.sendJsonControlMessage(
		message,
		params.chatModelId as ModelId,
		{
			systemPrompt: `Answer the user's question using ONLY the following ${params.capability} data. Be concise and factual; do not invent details that are not present in the data.`,
			thinkingMode: "off",
			jsonSchema: ANSWER_JSON_SCHEMA,
			allowReasoningFallback: true,
		},
	);
	return extractAnswerText(res.text);
}

async function runCase(
	fixture: (typeof OPTION_A_FIDELITY_FIXTURES)[number],
	chatModelId: string,
): Promise<{ outcome: OptionAFidelityCaseOutcome; detail: CaseDetail }> {
	const { sendJsonControlMessage } = await import(
		"$lib/server/services/normal-chat-control-model"
	);
	const { distillConnectorPayload } = await import(
		"$lib/server/services/connections/locality"
	);

	try {
		const rawAnswer = await answerQuestion({
			sendJsonControlMessage,
			chatModelId,
			capability: fixture.capability,
			question: fixture.question,
			dataText: fixture.rawConnectorText,
		});

		const distillResult = await distillConnectorPayload({
			userId: HARNESS_USER_ID,
			capability: fixture.capability,
			userQuestion: fixture.question,
			rawText: fixture.rawConnectorText,
		});

		if ("unavailable" in distillResult) {
			return {
				outcome: {
					kind: "withheld",
					caseId: fixture.id,
					capability: fixture.capability,
				},
				detail: {
					caseId: fixture.id,
					capability: fixture.capability,
					question: fixture.question,
					outcome: "withheld",
					rawAnswer,
				},
			};
		}

		const distilledAnswer = await answerQuestion({
			sendJsonControlMessage,
			chatModelId,
			capability: fixture.capability,
			question: fixture.question,
			dataText: distillResult.distilled,
		});

		const judgePrompt = buildFidelityJudgePrompt({
			question: fixture.question,
			rawAnswer,
			distilledAnswer,
		});
		const judgeRes = await sendJsonControlMessage(
			judgePrompt,
			chatModelId as ModelId,
			{
				systemPrompt:
					"You are a strict, impartial evaluator. Follow the user's instructions exactly and respond with strict JSON only.",
				thinkingMode: "off",
				jsonSchema: FIDELITY_JUDGE_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		const judged = parseFidelityJudgeResponse(judgeRes.text);

		if (!judged) {
			return {
				outcome: {
					kind: "error",
					caseId: fixture.id,
					capability: fixture.capability,
					error: `Judge response could not be parsed: ${judgeRes.text.slice(0, 200)}`,
				},
				detail: {
					caseId: fixture.id,
					capability: fixture.capability,
					question: fixture.question,
					outcome: "error",
					rawAnswer,
					distilledAnswer,
					error: "Judge response could not be parsed",
				},
			};
		}

		return {
			outcome: {
				kind: "scored",
				caseId: fixture.id,
				capability: fixture.capability,
				fidelity: judged.fidelity,
			},
			detail: {
				caseId: fixture.id,
				capability: fixture.capability,
				question: fixture.question,
				outcome: "scored",
				rawAnswer,
				distilledAnswer,
				fidelity: judged.fidelity,
				rationale: judged.rationale,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			outcome: {
				kind: "error",
				caseId: fixture.id,
				capability: fixture.capability,
				error: message,
			},
			detail: {
				caseId: fixture.id,
				capability: fixture.capability,
				question: fixture.question,
				outcome: "error",
				error: message,
			},
		};
	}
}

// --- Main orchestration -------------------------------------------------------

async function writeResultFile(
	outPath: string,
	summary: OptionAFidelitySummaryResult,
	cases?: CaseDetail[],
) {
	await mkdir(dirname(outPath), { recursive: true });
	const payload = cases ? { ...summary, cases } : summary;
	await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(argv = process.argv.slice(2)) {
	const args = parseCliArgs(argv);
	if (args.help) {
		printUsage();
		return;
	}

	const preflightDeps = await buildRealPreflightDeps();
	const preflight = await checkOptionAFidelityConfigured(
		preflightDeps,
		args.chatModelId,
	);

	if (!preflight.configured) {
		const reason = `Option-A fidelity eval requires the local distill model + a chat model configured; run on-box pre-release. (${preflight.reason})`;
		const result = buildNotConfiguredResult(reason);
		console.log(formatOptionAFidelitySummary(result));
		await writeResultFile(args.outPath, result);
		console.log(`Result written to ${args.outPath}`);
		return;
	}

	console.log(
		`[option-a-fidelity] chatModel=${preflight.chatModelDisplayName} (${preflight.chatModelId}) distillModel=${preflight.distillModelId}`,
	);

	const outcomes: OptionAFidelityCaseOutcome[] = [];
	const cases: CaseDetail[] = [];

	for (const fixture of OPTION_A_FIDELITY_FIXTURES) {
		console.log(
			`[case=${fixture.id}] capability=${fixture.capability} running...`,
		);
		const { outcome, detail } = await runCase(fixture, preflight.chatModelId);
		outcomes.push(outcome);
		cases.push(detail);
		console.log(`[case=${fixture.id}] outcome=${outcome.kind}`);
	}

	const result = buildCompletedResult({
		chatModelId: preflight.chatModelId,
		chatModelDisplayName: preflight.chatModelDisplayName,
		distillModelId: preflight.distillModelId,
		outcomes,
	});

	console.log("");
	console.log(formatOptionAFidelitySummary(result));

	await writeResultFile(args.outPath, result, cases);
	console.log(`Result written to ${args.outPath}`);
	console.log(
		"Backfill this overall qualityHit% into connections.locality.fidelityNote (en+hu) in src/lib/i18n/connections.ts.",
	);
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	main().catch((error) => {
		console.error(
			error instanceof Error
				? error.message
				: `Unknown error: ${String(error)}`,
		);
		process.exitCode = 1;
	});
}

export { extractAnswerText, parseCliArgs };
