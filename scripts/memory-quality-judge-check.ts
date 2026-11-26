#!/usr/bin/env tsx
/**
 * How far to trust the Memory quality judge (Layer 2 of the Memory quality
 * report) before it rates a person's entries. It runs `judgeMemoryEntries`
 * over the synthetic set (`quality-judge.eval-fixtures.ts`: made-up entries
 * with known answers, half of them Hungarian) through the real memory model,
 * the one behind Hindsight's admission gateway, and prints per question the
 * share answered as expected, over every entry and over the clear ones (those
 * not marked lenient for it), by language too, then the useful/junk confusion,
 * each miss by fixture name, the failed batches with their error codes, and
 * the totals the report would print for the set.
 *
 * Synthetic data only: it reads no person's data. It builds the model as the
 * report's --judge does (`scripts/memory-quality-report.ts`) and the label
 * migration does, from the environment's config, so the model it measures is
 * the one that judges, and prints that model's name; when
 * HINDSIGHT_CURATION_MODEL names a model or a provider, building it reads that
 * provider's settings rows, and nothing else. The call carries no tenant
 * (`BACKGROUND_MEMORY_ADMISSION`: background priority, the app's shared
 * lane). Run it from the release checkout with the app's environment loaded;
 * Ctrl-C stops it between batches. Exits 1 when no batch was answered.
 *
 *   npx tsx scripts/memory-quality-judge-check.ts
 */
import { getConfig } from "../src/lib/server/config-store";
import { BACKGROUND_MEMORY_ADMISSION } from "../src/lib/server/services/memory-profile/admission";
import {
	type CurationModel,
	createCurationModel,
} from "../src/lib/server/services/memory-profile/curation";
import {
	JUDGE_QUESTIONS,
	type JudgeQuestion,
	type JudgeShare,
	judgeAgreement,
	judgeMemoryEntries,
	judgeTotals,
} from "../src/lib/server/services/memory-profile/quality-judge";
import { QUALITY_JUDGE_FIXTURES } from "../src/lib/server/services/memory-profile/quality-judge.eval-fixtures";

const LABELS: Record<JudgeQuestion, string> = {
	useful: "useful",
	junkReason: "junk reason",
	kind: "kind",
	date: "date",
	duplicateOf: "duplicate",
};

function cell({ matched, of, share }: JudgeShare): string {
	return of && share !== null ? `${matched}/${of} ${share.toFixed(3)}` : "-";
}

/** An error's code, or its class: never its message. */
function codeOf(error: unknown): string {
	const code =
		error && typeof error === "object" && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) return code;
	return error instanceof Error ? error.name : typeof error;
}

// The environment's config, as the report's --judge reads it: the check must
// measure the model that judges.
const config = getConfig();
const controller = new AbortController();
process.once("SIGINT", () => {
	console.log("stopping: no further batch starts");
	controller.abort();
});
const thrown = new Map<string, number>();
const memoryModel = createCurationModel(
	controller.signal,
	undefined,
	BACKGROUND_MEMORY_ADMISSION,
);
const model: CurationModel = async (...args) => {
	try {
		return await memoryModel(...args);
	} catch (error) {
		const code = codeOf(error);
		thrown.set(code, (thrown.get(code) ?? 0) + 1);
		throw error;
	}
};

const fixtures = QUALITY_JUDGE_FIXTURES;
const started = Date.now();
const run = await judgeMemoryEntries(
	fixtures.map(({ entry }) => entry),
	model,
	{ signal: controller.signal },
);
const seconds = Math.round((Date.now() - started) / 1000);
const overall = judgeAgreement(fixtures, run);
const english = judgeAgreement(
	fixtures.filter(({ language }) => language === "en"),
	run,
);
const hungarian = judgeAgreement(
	fixtures.filter(({ language }) => language === "hu"),
	run,
);

const column = (text: string, width: number) => text.padEnd(width);
const failedCalls = [...thrown.values()].reduce((sum, n) => sum + n, 0);
const lines = [
	"Memory quality judge check: the synthetic set, no person's data",
	`model: ${config.hindsightCurationModel ?? (config.hindsightCurationGatewayModel || "(not set)")}, background priority, no tenant`,
	`fixtures ${fixtures.length} (en ${english.fixtures}, hu ${hungarian.fixtures}), judged ${overall.judged}, not judged ${overall.fixtures - overall.judged}, ${seconds} s`,
	`batches ${run.batches}, failed ${run.failedBatches}${
		run.failedBatches
			? ` (${[...thrown].map(([code, n]) => `${code} ${n}`).join(", ") || "no error"}; answers with no usable verdict ${Math.max(0, run.failedBatches - failedCalls)})`
			: ""
	}${controller.signal.aborted ? ", stopped early" : ""}`,
	"",
	`${column("question", 14)}${column("all", 14)}${column("clear", 14)}${column("en clear", 14)}hu clear`,
	...JUDGE_QUESTIONS.map(
		(question) =>
			`${column(LABELS[question], 14)}${column(cell(overall.questions[question].all), 14)}${column(cell(overall.questions[question].clear), 14)}${column(cell(english.questions[question].clear), 14)}${cell(hungarian.questions[question].clear)}`,
	),
	"",
	`useful/junk, expected as judged: useful as useful ${overall.useful.usefulAsUseful}, useful as junk ${overall.useful.usefulAsJunk}, junk as useful ${overall.useful.junkAsUseful}, junk as junk ${overall.useful.junkAsJunk}`,
	`dated entries given no date verdict: ${overall.dateUnanswered} (each counted as a date miss)`,
	"",
	overall.misses.length
		? "misses (~ marks a question the fixture is lenient on):"
		: "misses: none",
	...[...overall.misses]
		.sort(
			(a, b) =>
				JUDGE_QUESTIONS.indexOf(a.question) -
					JUDGE_QUESTIONS.indexOf(b.question) || a.name.localeCompare(b.name),
		)
		.map(
			(miss) =>
				`${miss.lenient ? "~" : " "} ${column(LABELS[miss.question], 12)}${column(miss.name, 30)}expected ${miss.expected}, judged ${miss.judged}`,
		),
	"",
	"totals over the set, as the report prints them (counts only):",
	JSON.stringify(
		judgeTotals(
			fixtures.map(({ entry }) => entry),
			run,
		),
	),
];
console.log(lines.join("\n"));
process.exitCode = run.verdicts.size ? 0 : 1;
