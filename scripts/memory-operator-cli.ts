/**
 * The shared command line of the Memory operator tools (`memory-resend.ts`,
 * `memory-reattach.ts`, `memory-recover-consolidation.ts`, `memory-drain.ts`):
 * the arguments, one printed line per step, the report as JSON last, and the
 * exit code. Imports nothing of the app, so it loads before the app's
 * environment is checked.
 */
import type { OperatorReport } from "../src/lib/server/services/memory-profile/operator-tools";

export interface OperatorArguments {
	user: string;
	job?: string;
	bank?: string;
	maxMinutes?: number;
	execute: boolean;
}

/** What a tool names besides the account: a job, a bank, or (the drain) a time limit. */
export type OperatorNeeds = "job" | "bank" | "drain";

export function parseOperatorArguments(
	args: string[],
	needs: OperatorNeeds,
): OperatorArguments {
	const valued = new Set([
		"--user",
		needs === "job" ? "--job" : needs === "bank" ? "--bank" : "--max-minutes",
	]);
	const values = new Map<string, string>();
	let execute = false;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--execute") {
			if (execute) throw Error("duplicate_argument");
			execute = true;
			continue;
		}
		const value = args[i + 1];
		if (!valued.has(flag) || value === undefined || value.startsWith("--"))
			throw Error("invalid_arguments");
		if (values.has(flag)) throw Error("duplicate_argument");
		values.set(flag, value);
		i += 1;
	}
	const user = values.get("--user");
	if (!user) throw Error("user_required");
	const parsed: OperatorArguments = { user, execute };
	if (needs === "job") {
		const job = values.get("--job");
		if (!job) throw Error("job_required");
		parsed.job = job;
	}
	if (needs === "bank") {
		const bank = values.get("--bank");
		if (!bank) throw Error("bank_required");
		parsed.bank = bank;
	}
	const minutes = values.get("--max-minutes");
	if (minutes !== undefined) {
		if (!/^\d{1,4}$/.test(minutes) || +minutes < 1 || +minutes > 1440)
			throw Error("invalid_max_minutes");
		parsed.maxMinutes = Number(minutes);
	}
	return parsed;
}

/** Prints the steps, the skipped jobs and the report; returns the exit code. */
export function printOperatorReport(
	report: OperatorReport,
	write: (line: string) => void = console.log,
): number {
	for (const step of report.steps) {
		const parts = [
			`step ${step.step}:`,
			step.ok ? "ok" : `FAILED ${step.code ?? "unknown"}`,
			...(step.detail && step.ok ? [step.detail] : []),
			...Object.entries(step.counts ?? {}).map(([k, v]) => `${k}=${v}`),
			...(step.ids?.length ? [`ids=${step.ids.join(",")}`] : []),
		];
		write(parts.join(" "));
		for (const job of step.skipped ?? [])
			write(
				`  skipped ${job.id} ${job.kind} ${job.status} ${job.code ?? "no_code"}`,
			);
	}
	write(`outcome: ${report.outcome}`);
	write(JSON.stringify(report));
	return report.outcome === "done" || report.outcome === "dry_run" ? 0 : 1;
}

/** Parses, runs the tool, prints, and sets the exit code: 2 for bad arguments. */
export async function runOperatorCli(
	needs: OperatorNeeds,
	usage: string,
	run: (args: OperatorArguments) => Promise<OperatorReport>,
): Promise<void> {
	let args: OperatorArguments;
	try {
		args = parseOperatorArguments(process.argv.slice(2), needs);
	} catch (error) {
		console.error(
			`${error instanceof Error ? error.message : error}\n${usage}`,
		);
		process.exitCode = 2;
		return;
	}
	process.exitCode = printOperatorReport(await run(args));
}
