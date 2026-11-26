import { relative } from "node:path";

export function playwrightTimings(report) {
	const origin = Date.parse(report.stats?.startTime);
	const spans = new Map();
	const ends = new Map();
	let signInMs = 0;

	function countSteps(steps) {
		for (const step of steps ?? []) {
			if (step.title?.startsWith("sign in")) signInMs += step.duration;
			countSteps(step.steps);
		}
	}

	function walk(suite, inheritedFile) {
		const file = suite.file || inheritedFile;
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				for (const result of test.results ?? []) {
					const start = Date.parse(result.startTime);
					const end = start + result.duration;
					const slot = result.parallelIndex;
					if (slot < 0 || !Number.isFinite(end) || result.duration < 0)
						continue;
					countSteps(result.steps);
					const name = spec.file || file;
					if (name) {
						const span = spans.get(name) ?? { start, end };
						span.start = Math.min(span.start, start);
						span.end = Math.max(span.end, end);
						spans.set(name, span);
					}
					if (Number.isInteger(slot) && Number.isFinite(origin)) {
						ends.set(slot, Math.max(ends.get(slot) ?? 0, end - origin));
					}
				}
			}
		}
		for (const child of suite.suites ?? []) walk(child, file);
	}
	for (const suite of report.suites ?? []) walk(suite);

	const files = [...spans].map(([file, span]) => ({
		file,
		ms: span.end - span.start,
	}));
	files.sort((a, b) => b.ms - a.ms);
	const workers = [...ends].map(([slot, endMs]) => ({ slot, endMs }));
	workers.sort((a, b) => a.slot - b.slot);
	const times = [...ends.values()];
	return {
		files,
		workers,
		tailMs: times.length ? Math.max(...times) - Math.min(...times) : 0,
		signInMs,
	};
}

export function vitestSplit(log) {
	const line = log.match(/^\s*Duration[^\n(]*\(([^\n)]+)\)/m)?.[1];
	if (!line) return null;
	const split = {};
	for (const part of line.split(",")) {
		const match = part
			.trim()
			.match(/^(transform|setup|import|tests|environment)\s+(.+)$/);
		if (!match) continue;
		const [, name, duration] = match;
		let seconds = 0;
		for (const [, value, unit] of duration.matchAll(
			/(\d+(?:\.\d+)?)(ms|s|m)\b/g,
		)) {
			seconds += Number(value) * { ms: 0.001, s: 1, m: 60 }[unit];
		}
		split[name] = seconds;
	}
	return Object.keys(split).length ? split : null;
}

export function slowestUnitFiles(report, n = 5, root = process.cwd()) {
	return (report.testResults ?? [])
		.filter(
			({ name, startTime, endTime }) =>
				typeof name === "string" &&
				Number.isFinite(startTime) &&
				Number.isFinite(endTime) &&
				endTime >= startTime,
		)
		.map(({ name, startTime, endTime }) => ({
			file: name.startsWith("/") ? relative(root, name) : name,
			ms: endTime - startTime,
		}))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, n);
}
