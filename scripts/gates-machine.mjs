import { spawnSync } from "node:child_process";
import { freemem } from "node:os";

export function parseSwapUsedMb(text) {
	const match = text.match(/\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT])/i);
	return match
		? Number(match[1]) *
				{ K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[match[2].toUpperCase()]
		: null;
}

export function otherTestRuns(psText, ownPid) {
	const processes = new Map();
	for (const line of psText.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		if (!match) continue;
		const [, pid, ppid, command] = match;
		processes.set(Number(pid), {
			pid: Number(pid),
			ppid: Number(ppid),
			command,
		});
	}
	return [...processes.values()]
		.filter(({ pid, command }) => {
			if (/@playwright\/mcp|playwright-mcp/.test(command)) return false;
			const argv = command.replace(
				/^(?:\S+\/)?(?:node|bun|npm exec|npx)\s+/,
				"",
			);
			const vitest =
				/^(?:\(?vitest(?:\s|\)|$)|\S*\/vitest(?:\/|\.m?js(?:\s|$)|\s|$))/;
			const playwright = /^(?:\S*\/)?playwright(?:\.js)?\s+test(?:\s|$)/;
			if (!(vitest.test(argv) || playwright.test(argv))) return false;
			const seen = new Set();
			for (
				let parent = pid;
				parent && !seen.has(parent);
				parent = processes.get(parent)?.ppid
			) {
				if (parent === ownPid) return false;
				seen.add(parent);
			}
			return true;
		})
		.map(({ pid, command }) => ({ pid, command }));
}

function output(cmd, args) {
	const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000 });
	return result.status === 0 ? result.stdout.trim() : null;
}

function probeMachine(pid) {
	const priority = output("ps", ["-o", "pri=", "-p", String(pid)]);
	const processes = output("ps", ["-axo", "pid=,ppid=,command="]);
	return {
		swapMb: parseSwapUsedMb(output("sysctl", ["-n", "vm.swapusage"]) ?? ""),
		freeMb: freemem() / 1048576,
		priority: priority && /^\d+$/.test(priority) ? Number(priority) : null,
		others: processes === null ? null : otherTestRuns(processes, pid),
	};
}

export function startMachineSampler({
	pid = process.pid,
	intervalMs = 5000,
	probe = probeMachine,
	now = Date.now,
} = {}) {
	let previous = now();
	const report = {
		samples: 0,
		swapStartMb: null,
		swapPeakMb: null,
		freeLowMb: null,
		priorityStart: null,
		priorityLowest: null,
		clampedMs: 0,
		others: [],
		incomplete: false,
	};
	const others = new Set();
	function sample() {
		const at = now();
		const data = probe(pid);
		if (!report.samples) {
			report.swapStartMb = data.swapMb;
			report.priorityStart = data.priority;
		}
		report.samples++;
		report.incomplete ||=
			data.swapMb === null || data.priority === null || data.others === null;
		if (data.swapMb !== null)
			report.swapPeakMb = Math.max(report.swapPeakMb ?? 0, data.swapMb);
		if (data.freeMb !== null)
			report.freeLowMb = Math.min(report.freeLowMb ?? Infinity, data.freeMb);
		if (data.priority !== null) {
			report.priorityLowest = Math.min(
				report.priorityLowest ?? Infinity,
				data.priority,
			);
			if (data.priority < 31) report.clampedMs += at - previous;
		}
		for (const other of data.others ?? [])
			others.add(other.command.slice(0, 60));
		previous = at;
	}
	sample();
	const timer = setInterval(sample, intervalMs);
	timer.unref();
	let stopped = false;
	return {
		stop() {
			if (!stopped) {
				clearInterval(timer);
				sample();
				report.others = [...others];
				stopped = true;
			}
			return report;
		},
	};
}

function duration(ms) {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function measuredVerdict(machine, queue) {
	const why = [];
	if (!queue.held) why.push("the queue was not held");
	if (machine.incomplete) why.push("a machine measurement was unavailable");
	if (machine.others.length)
		why.push(`another test run was going: ${machine.others[0]}`);
	if (machine.priorityLowest !== null && machine.priorityLowest < 31)
		why.push(`clamped for ${duration(machine.clampedMs)}`);
	if (machine.swapStartMb > 0)
		why.push(`${machine.swapStartMb} MB of swap in use at the start`);
	return { counts: why.length === 0, why };
}

export function machineLines(machine, measured) {
	const priority =
		machine.priorityLowest === null
			? "priority unavailable"
			: machine.priorityLowest < 31
				? `CLAMPED to priority ${machine.priorityLowest} for ${duration(machine.clampedMs)}`
				: `priority ${machine.priorityLowest} or higher throughout`;
	const mb = (value) => (value === null ? "unknown" : `${value} MB`);
	const free =
		machine.freeLowMb === null
			? "unknown"
			: `${(machine.freeLowMb / 1024).toFixed(1)} GB`;
	return [
		`mac: ${priority}; swap ${mb(machine.swapStartMb)} at start, ${mb(machine.swapPeakMb)} at peak; free memory down to ${free}`,
		measured.counts
			? "measured: yes"
			: `measured: no (${measured.why.join("; ")})`,
	];
}
