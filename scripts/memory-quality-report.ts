#!/usr/bin/env tsx
/**
 * The Memory quality report (docs/plans/hindsight-memory/migration-runbook.md,
 * "Operator tools for stuck deliveries"): how one native account's Memory came
 * out of its deliveries, with nobody reading it. Counts how many messages were
 * delivered and with how many facts, what the entries rest on, how many are
 * duplicates, how the kinds, ages and subjects came out, how the imported
 * facts' event dates sit against the day they were said, and how delivery went
 * and whether it slowed. It prints a short summary in percentages, then the
 * whole report as JSON; --out also writes the JSON (mode 0600).
 *
 * Read-only, so there is no --execute. The report holds numbers only: no text,
 * no title and no id of an entry, a fact, a message, a job or an account.
 * "Imported" is the ChatGPT import alone: the person's own chats from before
 * native Memory, which preparation records under the same event ids, are
 * counted apart as "history". --baseline adds the same numbers summed over
 * every other native account (the tester and the measured account left out),
 * without subject counts, and only when there are at least three such accounts:
 * with fewer it says how many there are and gives no number of theirs.
 *
 * --judge adds the model judge's totals (Layer 2, `quality-judge.ts`): it sends
 * the account's current entries to the Memory curation model, as the label
 * migration does, and puts only its totals in the JSON under `judge`. A run
 * takes minutes, so before every batch, and right before every call, it checks
 * that the person's consent still stands as the run found it (Memory on, the
 * account native and active, the same epoch, control revision and newest
 * history choice) and that each entry it would show is still published; the
 * ones that are not are withdrawn, never sent. When consent itself changes the
 * run stops at once, prints `memory_quality_consent_changed`, writes no judge
 * totals and exits 1. Ctrl-C aborts the judge's calls in flight. Run from this
 * release's checkout with the app's environment loaded.
 *
 *   npx tsx scripts/memory-quality-report.ts --user <id> [--baseline] [--judge] [--out <file>]
 */
import { chmodSync, writeFileSync } from "node:fs";

const USAGE =
	"usage: npx tsx scripts/memory-quality-report.ts --user <id> [--baseline] [--judge] [--out <file>]";

interface QualityReportArguments {
	user: string;
	baseline: boolean;
	judge: boolean;
	out?: string;
}

function parseArguments(args: string[]): QualityReportArguments {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--baseline" || arg === "--judge") {
			if (flags.has(arg)) throw Error("duplicate_argument");
			flags.add(arg);
			continue;
		}
		const value = args[i + 1];
		if (
			(arg !== "--user" && arg !== "--out") ||
			value === undefined ||
			value.startsWith("--")
		)
			throw Error("invalid_arguments");
		if (values.has(arg)) throw Error("duplicate_argument");
		values.set(arg, value);
		i += 1;
	}
	const user = values.get("--user");
	if (!user) throw Error("user_required");
	const out = values.get("--out");
	return {
		user,
		baseline: flags.has("--baseline"),
		judge: flags.has("--judge"),
		...(out === undefined ? {} : { out }),
	};
}

/** What an error may print: Memory's own code, else its class. Its message can hold text. */
function codeOf(error: unknown): string {
	if (error instanceof Error && /^memory_[a-z_]+$/.test(error.message))
		return error.message;
	return error instanceof Error ? error.name : typeof error;
}

async function run(args: QualityReportArguments): Promise<number> {
	// One clock for the numbers and for the judge, so both read the same entries.
	const now = new Date();
	let exitCode = 0;
	try {
		// Loaded here so a failure to open the database prints a code, not a stack.
		// The report module loads the judge's for its consent code, so both come
		// or neither does.
		const quality = await import(
			"../src/lib/server/services/memory-profile/quality-report"
		);
		const judge = await import(
			"../src/lib/server/services/memory-profile/quality-judge"
		);
		const report = quality.measureMemoryQuality({ userId: args.user, now });
		const output: Record<string, unknown> = { ...report };
		for (const line of quality.summarizeMemoryQuality(report, "Account"))
			console.log(line);

		if (args.baseline) {
			const baseline = quality.measureMemoryBaseline({
				excludeUserIds: [args.user],
				now,
			});
			output.baseline = baseline;
			for (const line of quality.summarizeMemoryQuality(
				baseline,
				"Baseline, every other native account summed",
			))
				console.log(line);
		}

		if (args.judge) {
			const controller = new AbortController();
			process.once("SIGINT", () => {
				console.log("stopping: the judge's model calls in flight are aborted");
				controller.abort();
			});
			// The judge is a model call that can fail: the counts above stand without it.
			try {
				const { createCurationModel } = await import(
					"../src/lib/server/services/memory-profile/curation"
				);
				const { memoryAdmissionFor } = await import(
					"../src/lib/server/services/memory-profile/admission"
				);
				// What the person agreed to, as the run starts. A run for an account
				// that is not in force already is the same refusal.
				const found = quality.readJudgeConsent(args.user);
				if (!found) throw new Error(judge.MEMORY_QUALITY_CONSENT_CHANGED);
				let refused = false;
				const stillAllowed = () => {
					try {
						quality.assertJudgeConsent(args.user, found);
					} catch (error) {
						refused = true;
						throw error;
					}
				};
				const entries = judge.judgeEntriesFor(args.user, now);
				// The ids of every entry the run will show, candidates too: the fence
				// places them once, now, and asks about their observations after.
				const published = quality.publishedEntryFence(
					args.user,
					entries.flatMap((entry) => [
						entry.id,
						...entry.candidates.map(({ id }) => id),
					]),
				);
				// Background priority, like the label migration: it waits behind live
				// turns. `stillAllowed` is also asked right before each call is sent,
				// after the admission queue's wait.
				const model = createCurationModel(
					controller.signal,
					stillAllowed,
					memoryAdmissionFor(args.user, "background"),
				);
				const run = await judge.judgeMemoryEntries(entries, model, {
					signal: controller.signal,
					// Before each batch, with the ids of its entries and then of their
					// candidates, and all of them answered. Throwing ends the run.
					beforeBatch: (ids) => {
						stillAllowed();
						return published(ids);
					},
				});
				// A refusal the judge counted as a failed batch is a refusal all the same.
				if (refused) throw new Error(judge.MEMORY_QUALITY_CONSENT_CHANGED);
				const totals = judge.judgeTotals(entries, run);
				output.judge = totals;
				// A batch that fails does not throw, so say how much was judged.
				console.log(
					`  judge: ${totals.judged} of ${totals.entries} entries judged, ${totals.withdrawn} withdrawn, ${totals.failedBatches} of ${totals.batches} batches failed; its totals are in the JSON under \`judge\``,
				);
				if (totals.notJudged > 0) exitCode = 1;
			} catch (error) {
				// With more than one call in flight, one beside the refused call could
				// still be out: stop it.
				if (
					error instanceof Error &&
					error.message === judge.MEMORY_QUALITY_CONSENT_CHANGED
				)
					controller.abort();
				console.error(`judge: failed ${codeOf(error)}`);
				exitCode = 1;
			}
		}

		const json = JSON.stringify(output, null, 2);
		console.log(json);
		if (args.out) {
			writeFileSync(args.out, `${json}\n`, { mode: 0o600 });
			// A file that was already there keeps its mode through the write above.
			chmodSync(args.out, 0o600);
			console.log(`written: ${args.out}`);
		}
	} catch (error) {
		console.error(`error: ${codeOf(error)}`);
		return 1;
	}
	return exitCode;
}

let args: QualityReportArguments | undefined;
try {
	args = parseArguments(process.argv.slice(2));
} catch (error) {
	console.error(`${error instanceof Error ? error.message : error}\n${USAGE}`);
	process.exitCode = 2;
}
if (args) process.exitCode = await run(args);
