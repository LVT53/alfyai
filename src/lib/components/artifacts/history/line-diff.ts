/**
 * What History's Code view draws of an App's source (ruling 76, versioning.md
 * §5.4): the lines one version added and removed against another, the unchanged
 * runs folded, each change a stop for the stepper. The server only counts lines
 * ("42 lines changed", `moments/line-diff.ts`); the lines themselves are drawn
 * here, in the browser, from the two stored sources.
 *
 * A common head and tail are trimmed first, which is nearly all of a real change;
 * what is left is aligned by the longest common subsequence, and past a bounded
 * table the middle is said as "all of the first, then all of the second" rather
 * than aligned, so two sources too different to compare cost a bounded amount.
 */

export type LineOp = { op: "same" | "add" | "del"; text: string };

/** A comparison table of at most this many cells (n × m lines) is built; past it the middle is not aligned. */
const MAX_CELLS = 2_000_000;

function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.replace(/\r\n?/g, "\n").split("\n");
}

function aligned(a: readonly string[], b: readonly string[]): LineOp[] {
	const n = a.length;
	const m = b.length;
	const width = m + 1;
	// lcs[i * width + j]: the longest common subsequence of a[i..] and b[j..].
	const lcs = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			lcs[i * width + j] =
				a[i] === b[j]
					? lcs[(i + 1) * width + j + 1] + 1
					: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}
	const out: LineOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ op: "same", text: a[i] });
			i += 1;
			j += 1;
		} else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
			out.push({ op: "del", text: a[i] });
			i += 1;
		} else {
			out.push({ op: "add", text: b[j] });
			j += 1;
		}
	}
	for (; i < n; i += 1) out.push({ op: "del", text: a[i] });
	for (; j < m; j += 1) out.push({ op: "add", text: b[j] });
	return out;
}

function middle(a: readonly string[], b: readonly string[]): LineOp[] {
	if (a.length === 0) return b.map((text) => ({ op: "add", text }));
	if (b.length === 0) return a.map((text) => ({ op: "del", text }));
	if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
		return [
			...a.map((text): LineOp => ({ op: "del", text })),
			...b.map((text): LineOp => ({ op: "add", text })),
		];
	}
	return aligned(a, b);
}

/** The lines of `after` against `before`: `del` for a line only `before` has, `add` for one only `after` has. A removed line comes before the line that replaced it. */
export function diffLines(before: string, after: string): LineOp[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail += 1;
	}
	return [
		...a.slice(0, head).map((text): LineOp => ({ op: "same", text })),
		...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
		...a.slice(a.length - tail).map((text): LineOp => ({ op: "same", text })),
	];
}

export type CodeRow =
	| {
			type: "line";
			op: LineOp["op"];
			text: string;
			/** The stepper's stop this line belongs to, or `null` for an unchanged one. */
			change: number | null;
	  }
	| { type: "fold"; count: number; lines: LineOp[] };

/** Lines of context kept round a change. */
const CONTEXT = 3;
/** An unchanged run of at most this many lines is not worth a fold. */
const MIN_FOLD = 4;

/**
 * The rows to draw: every changed line, three lines of context round it, and the
 * rest of a long unchanged run as one fold (which keeps its lines, to open).
 * A changed run (removed lines and what replaced them) is one change. A source
 * with nothing changed is listed whole: there is nothing to fold round.
 */
export function foldUnchanged(ops: readonly LineOp[]): {
	rows: CodeRow[];
	changes: number;
} {
	const changeOf: Array<number | null> = new Array(ops.length).fill(null);
	let changes = 0;
	let inChange = false;
	ops.forEach((line, index) => {
		if (line.op === "same") {
			inChange = false;
			return;
		}
		if (!inChange) {
			changes += 1;
			inChange = true;
		}
		changeOf[index] = changes - 1;
	});
	if (changes === 0) {
		return {
			rows: ops.map((line) => ({ type: "line", ...line, change: null })),
			changes: 0,
		};
	}

	const keep = new Array<boolean>(ops.length).fill(false);
	ops.forEach((line, index) => {
		if (line.op === "same") return;
		for (
			let near = Math.max(0, index - CONTEXT);
			near <= Math.min(ops.length - 1, index + CONTEXT);
			near += 1
		) {
			keep[near] = true;
		}
	});

	const rows: CodeRow[] = [];
	let index = 0;
	while (index < ops.length) {
		if (keep[index]) {
			rows.push({
				type: "line",
				op: ops[index].op,
				text: ops[index].text,
				change: changeOf[index],
			});
			index += 1;
			continue;
		}
		let end = index;
		while (end < ops.length && !keep[end]) end += 1;
		const run = ops.slice(index, end);
		if (run.length <= MIN_FOLD) {
			for (const line of run) {
				rows.push({ type: "line", op: line.op, text: line.text, change: null });
			}
		} else {
			rows.push({ type: "fold", count: run.length, lines: run });
		}
		index = end;
	}
	return { rows, changes };
}
