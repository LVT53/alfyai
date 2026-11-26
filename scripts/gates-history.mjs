import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gateStateDir } from "./gates-queue.mjs";

export function historyEntry({ startedAt, endedAt, results, ...details }) {
	const steps = Object.fromEntries(
		Object.entries(results).map(([name, result]) => [
			name,
			"code" in result ? { ms: result.ms, ok: result.ok } : result,
		]),
	);
	return {
		v: 1,
		at: new Date(startedAt).toISOString(),
		...details,
		totalMs: endedAt - startedAt,
		steps,
		counts: {
			e2e: results.playwright?.counts,
			unitFiles: results.vitest?.counts?.files,
			unitTests: results.vitest?.counts?.tests,
		},
	};
}

export function appendHistory(dir, entry) {
	if (!dir) return "history: not written (shared git directory unavailable)";
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "history.jsonl"), `${JSON.stringify(entry)}\n`);
		return null;
	} catch (error) {
		return `history: not written (${error.code ?? error.message})`;
	}
}

export function readHistory(dir) {
	if (!dir) return [];
	let data;
	try {
		data = readFileSync(join(dir, "history.jsonl"), "utf8");
	} catch {
		return [];
	}
	return data.split("\n").flatMap((line) => {
		try {
			const entry = JSON.parse(line);
			return entry?.v === 1 ? [entry] : [];
		} catch {
			return [];
		}
	});
}

export function previousRelease(entries, beforeAt) {
	const cutoff = Date.parse(beforeAt);
	let previous;
	for (const entry of entries) {
		const at = Date.parse(entry.at);
		if (
			entry.mode === "release" &&
			at < cutoff &&
			(!previous || at > Date.parse(previous.at))
		)
			previous = entry;
	}
	return previous;
}

function duration(ms) {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function delta(n, format) {
	return `(${n < 0 ? "-" : "+"}${format(Math.abs(n))})`;
}

const count = (n) => n.toLocaleString("en-US");
const localTime = (at) =>
	new Intl.DateTimeFormat("sv-SE", {
		dateStyle: "short",
		timeStyle: "short",
	}).format(new Date(at));

function e2eTotal(entry) {
	const e2e = entry.counts?.e2e;
	return e2e ? e2e.passed + e2e.failed + e2e.flaky : null;
}

export function comparisonLines(entry, previous) {
	if (
		!previous ||
		typeof previous.head !== "string" ||
		!Number.isFinite(previous.totalMs)
	) {
		return ["before: no earlier release gate in the history"];
	}
	const lines = [
		`before: release gate at ${previous.head.slice(0, 7)} on ${localTime(previous.at)} took ${duration(previous.totalMs)} (${previous.passed ? "passed" : "failed"}); this one ${duration(entry.totalMs)} ${delta(entry.totalMs - previous.totalMs, duration)}`,
	];
	const counts = [
		["e2e tests", e2eTotal(previous), e2eTotal(entry)],
		["unit tests", previous.counts?.unitTests, entry.counts?.unitTests],
	].filter(([, from, to]) => Number.isFinite(from) && Number.isFinite(to));
	if (counts.length)
		lines.push(
			counts
				.map(
					([name, from, to]) =>
						`${name} ${count(from)} -> ${count(to)} ${delta(to - from, count)}`,
				)
				.join("; "),
		);
	const steps = ["playwright", "vitest"].flatMap((step) => {
		const before = previous.steps?.[step]?.ms;
		const after = entry.steps?.[step]?.ms;
		return Number.isFinite(before) && Number.isFinite(after)
			? [`${step} ${duration(before)} -> ${duration(after)}`]
			: [];
	});
	if (steps.length) lines.push(`steps: ${steps.join(", ")}`);
	return lines;
}

function median(entries) {
	const times = entries
		.map(({ totalMs }) => totalMs)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const mid = Math.floor(times.length / 2);
	if (!times.length) return "unknown";
	return duration(
		times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2,
	);
}

export function historyReport(entries, { days = 7, now = Date.now() } = {}) {
	const cutoff = now - days * 86400000;
	const fraction = (amount, total) =>
		total ? Math.round((100 * amount) / total) : 0;
	const failures = (rows) => rows.filter(({ passed }) => !passed).length;
	return ["agent", "release"].flatMap((mode) => {
		const rows = entries.filter(
			(entry) =>
				entry.mode === mode &&
				Date.parse(entry.at) >= cutoff &&
				Date.parse(entry.at) <= now,
		);
		const clamped = rows.filter(
			({ machine }) =>
				Number.isFinite(machine?.priorityLowest) && machine.priorityLowest < 31,
		);
		const unclamped = rows.filter(
			({ machine }) =>
				Number.isFinite(machine?.priorityLowest) &&
				machine.priorityLowest >= 31 &&
				!machine.incomplete,
		);
		const measured = rows.filter((entry) => entry.measured?.counts).length;
		return [
			`${mode}: ${rows.length} runs, ${fraction(rows.length - failures(rows), rows.length)}% passed, median ${median(rows)}, ${measured} measured`,
			`  clamped: ${clamped.length} of ${rows.length} runs (${fraction(clamped.length, rows.length)}%), median ${median(clamped)}, ${failures(clamped)} of ${clamped.length} failed; unclamped: median ${median(unclamped)}, ${failures(unclamped)} of ${unclamped.length} failed`,
		];
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [command, option, value, ...extra] = process.argv.slice(2);
	const days = option === undefined ? 7 : Number(value);
	if (
		command !== "report" ||
		(option !== undefined && option !== "--days") ||
		!Number.isInteger(days) ||
		days < 1 ||
		extra.length
	) {
		console.error("usage: node scripts/gates-history.mjs report [--days N]");
		process.exitCode = 2;
	} else {
		const dir = gateStateDir(dirname(dirname(fileURLToPath(import.meta.url))));
		console.log(historyReport(readHistory(dir), { days }).join("\n"));
	}
}
