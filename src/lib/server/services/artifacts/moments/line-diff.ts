/**
 * How many lines a change added and removed, for an App's History line ("42
 * lines changed"). Counts only: the Code tab draws the lines themselves in the
 * browser. Myers' O(ND) shortest edit script gives the edit distance D; with
 * the longest common subsequence L = (n + m − D) / 2 the counts follow
 * (removed = n − L, added = m − L). A common head and tail are trimmed first,
 * which is nearly all of a real change, and past `maxEdits` the answer is the
 * difference of the two texts' lines taken as bags, so a pathological pair of
 * texts costs a bounded amount and never throws.
 */

function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.replace(/\r\n?/g, "\n").split("\n");
}

function bagDifference(
	before: readonly string[],
	after: readonly string[],
): { added: number; removed: number } {
	const counts = new Map<string, number>();
	for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of after) {
		const left = counts.get(line) ?? 0;
		if (left > 0) counts.set(line, left - 1);
		else added += 1;
	}
	let removed = 0;
	for (const left of counts.values()) removed += left;
	return { added, removed };
}

/** The edit distance between two line lists, or `null` once it passes `maxEdits`. */
function editDistance(
	a: readonly string[],
	b: readonly string[],
	maxEdits: number,
): number | null {
	const n = a.length;
	const m = b.length;
	if (n === 0) return m <= maxEdits ? m : null;
	if (m === 0) return n <= maxEdits ? n : null;
	const limit = Math.min(maxEdits, n + m);
	const offset = limit + 1;
	// furthest[k + offset] = the furthest x reached on diagonal k.
	const furthest = new Int32Array(2 * limit + 3);
	for (let d = 0; d <= limit; d += 1) {
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (
				k === -d ||
				(k !== d && furthest[k - 1 + offset] < furthest[k + 1 + offset])
			) {
				x = furthest[k + 1 + offset];
			} else {
				x = furthest[k - 1 + offset] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			furthest[k + offset] = x;
			if (x >= n && y >= m) return d;
		}
	}
	return null;
}

export function diffLineCounts(
	before: string,
	after: string,
	maxEdits = 2000,
): { added: number; removed: number } {
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
	const middleA = a.slice(head, a.length - tail);
	const middleB = b.slice(head, b.length - tail);
	const distance = editDistance(middleA, middleB, maxEdits);
	if (distance === null) return bagDifference(middleA, middleB);
	const common = (middleA.length + middleB.length - distance) / 2;
	return { added: middleB.length - common, removed: middleA.length - common };
}
