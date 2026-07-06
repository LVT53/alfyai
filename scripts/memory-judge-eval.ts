// scripts/memory-judge-eval.ts  — run with: npx tsx scripts/memory-judge-eval.ts
import process from "node:process";
import { JUDGE_EVAL_FIXTURES } from "../src/lib/server/services/memory-judge/eval-fixtures";
import {
	buildJudgeSystemPrompt,
	buildJudgeUserMessage,
} from "../src/lib/server/services/memory-judge/prompt";
import {
	JUDGE_JSON_SCHEMA,
	parseJudgeDecisions,
} from "../src/lib/server/services/memory-judge/schema";

async function main() {
	const { sendJsonControlMessage } = await import(
		"../src/lib/server/services/normal-chat-control-model"
	);
	const { getConfig } = await import("../src/lib/server/config-store");
	let pass = 0;
	let fail = 0;
	for (const fx of JUDGE_EVAL_FIXTURES) {
		const res = await sendJsonControlMessage(
			buildJudgeUserMessage({
				segment: fx.segment,
				conversationSummary: null,
				existingFacts: [],
				projectId: null,
			}),
			getConfig().memoryJudgeModel,
			{
				systemPrompt: buildJudgeSystemPrompt(),
				temperature: 0,
				maxTokens: 1200,
				jsonSchema: JUDGE_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		const decisions = parseJudgeDecisions(res.text);
		const expected = fx.expect;
		const ok =
			expected === "reject_all"
				? decisions.length === 0
				: decisions.some(
						(d) =>
							d.statement
								.toLowerCase()
								.includes(expected.admitContaining.toLowerCase()) &&
							(!expected.category || d.category === expected.category) &&
							(!expected.expiryClass || d.expiryClass === expected.expiryClass),
					);
		console.log(
			`${ok ? "PASS" : "FAIL"}  ${fx.name}  →  ${decisions.map((d) => d.statement).join(" | ") || "(no decisions)"}`,
		);
		ok ? pass++ : fail++;
	}
	console.log(`\n${pass}/${pass + fail} fixtures passed`);
	process.exit(fail === 0 ? 0 : 1);
}
main();
