import { expect, it } from "vitest";
import type { OperatorReport } from "../src/lib/server/services/memory-profile/operator-tools";
import {
	parseOperatorArguments,
	printOperatorReport,
} from "./memory-operator-cli";

it("reads a dry run by default and --execute only when given", () => {
	expect(
		parseOperatorArguments(["--user", "u1", "--job", "j1"], "job"),
	).toEqual({ user: "u1", job: "j1", execute: false });
	expect(
		parseOperatorArguments(["--execute", "--user", "u1", "--job", "j1"], "job"),
	).toEqual({ user: "u1", job: "j1", execute: true });
	expect(
		parseOperatorArguments(["--user", "u1", "--bank", "b1"], "bank"),
	).toEqual({ user: "u1", bank: "b1", execute: false });
	expect(
		parseOperatorArguments(["--user", "u1", "--max-minutes", "90"], "drain"),
	).toEqual({ user: "u1", maxMinutes: 90, execute: false });
});

it.each([
	[[], "job", "user_required"],
	[["--user", "u1"], "job", "job_required"],
	[["--user", "u1"], "bank", "bank_required"],
	[["--user", "u1", "--job", "j1", "--bank", "b1"], "job", "invalid_arguments"],
	[["--user", "u1", "--user", "u2", "--job", "j"], "job", "duplicate_argument"],
	[["--user"], "drain", "invalid_arguments"],
	[["--user", "u1", "--max-minutes", "0"], "drain", "invalid_max_minutes"],
	[["--user", "u1", "--max-minutes", "2.5"], "drain", "invalid_max_minutes"],
	[["--user", "u1", "--max-minutes", "5"], "job", "invalid_arguments"],
	[
		["--user", "u1", "--job", "j", "--execute", "yes"],
		"job",
		"invalid_arguments",
	],
] as const)("refuses %j for a %s tool with %s", (args, needs, code) => {
	expect(() => parseOperatorArguments([...args], needs)).toThrow(code);
});

it("prints one line per step, the skipped jobs, then the report, and says how it ended", () => {
	const lines: string[] = [];
	const report: OperatorReport = {
		tool: "drain",
		userId: "u1",
		execute: true,
		outcome: "done",
		steps: [
			{ step: "guard", ok: true },
			{ step: "drain", ok: true, counts: { rounds: 3 } },
			{
				step: "summary",
				ok: true,
				counts: { succeeded: 4, failed: 1 },
				skipped: [
					{
						id: "j9",
						kind: "source",
						status: "failed",
						code: "native_retain_left_facts",
					},
				],
			},
		],
	};
	expect(printOperatorReport(report, (line) => lines.push(line))).toBe(0);
	expect(lines.slice(0, -1)).toEqual([
		"step guard: ok",
		"step drain: ok rounds=3",
		"step summary: ok succeeded=4 failed=1",
		"  skipped j9 source failed native_retain_left_facts",
		"outcome: done",
	]);
	expect(JSON.parse(lines.at(-1) ?? "")).toEqual(report);
	const refused: OperatorReport = {
		...report,
		outcome: "refused",
		steps: [{ step: "guard", ok: false, code: "memory_migration_excluded" }],
	};
	const more: string[] = [];
	expect(printOperatorReport(refused, (line) => more.push(line))).toBe(1);
	expect(more[0]).toBe("step guard: FAILED memory_migration_excluded");
});
