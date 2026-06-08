export interface TextComparisonSummary {
	addedLines: number;
	removedLines: number;
	changedLines: number;
	totalCurrentLines: number;
	totalComparedLines: number;
}

export type DiffOperation =
	| { type: "equal"; oldLine: string; newLine: string }
	| { type: "add"; newLine: string }
	| { type: "remove"; oldLine: string };

function splitLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
}

function computeLineDiff(
	oldLines: string[],
	newLines: string[],
): DiffOperation[] {
	const n = oldLines.length;
	const m = newLines.length;

	const dp: Int32Array[] = [];
	for (let i = 0; i <= n; i++) {
		dp.push(new Int32Array(m + 1));
	}
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const path: Array<{
		type: "equal" | "remove" | "add";
		oldIdx: number;
		newIdx: number;
	}> = [];

	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			path.push({ type: "equal", oldIdx: i - 1, newIdx: j - 1 });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			path.push({ type: "add", oldIdx: -1, newIdx: j - 1 });
			j--;
		} else {
			path.push({ type: "remove", oldIdx: i - 1, newIdx: -1 });
			i--;
		}
	}
	path.reverse();

	const diff: DiffOperation[] = [];
	for (const step of path) {
		switch (step.type) {
			case "equal":
				diff.push({
					type: "equal",
					oldLine: oldLines[step.oldIdx],
					newLine: newLines[step.newIdx],
				});
				break;
			case "remove":
				diff.push({ type: "remove", oldLine: oldLines[step.oldIdx] });
				break;
			case "add":
				diff.push({ type: "add", newLine: newLines[step.newIdx] });
				break;
		}
	}

	return diff;
}

export function summarizeTextComparison(
	currentText: string,
	comparedText: string,
): TextComparisonSummary {
	const oldLines = splitLines(comparedText);
	const newLines = splitLines(currentText);
	const diff = computeLineDiff(oldLines, newLines);

	let addedLines = 0;
	let removedLines = 0;
	let changedLines = 0;

	for (const op of diff) {
		if (op.type === "add") addedLines++;
		if (op.type === "remove") removedLines++;
	}

	let idx = 0;
	while (idx < diff.length - 1) {
		if (diff[idx].type === "remove" && diff[idx + 1].type === "add") {
			changedLines++;
			idx += 2;
		} else {
			idx++;
		}
	}

	return {
		addedLines,
		removedLines,
		changedLines,
		totalCurrentLines: newLines.length,
		totalComparedLines: oldLines.length,
	};
}

export function computeSideBySideDiff(
	currentText: string,
	comparedText: string,
): {
	leftLines: Array<{ text: string; type: "equal" | "add" | "remove" }>;
	rightLines: Array<{ text: string; type: "equal" | "add" | "remove" }>;
} {
	const oldLines = splitLines(comparedText);
	const newLines = splitLines(currentText);
	const diff = computeLineDiff(oldLines, newLines);

	const leftLines: Array<{
		text: string;
		type: "equal" | "add" | "remove";
	}> = [];
	const rightLines: Array<{
		text: string;
		type: "equal" | "add" | "remove";
	}> = [];

	for (const op of diff) {
		switch (op.type) {
			case "equal":
				leftLines.push({ text: op.newLine, type: "equal" });
				rightLines.push({ text: op.oldLine, type: "equal" });
				break;
			case "remove":
				leftLines.push({ text: "", type: "remove" });
				rightLines.push({ text: op.oldLine, type: "remove" });
				break;
			case "add":
				leftLines.push({ text: op.newLine, type: "add" });
				rightLines.push({ text: "", type: "add" });
				break;
		}
	}

	const aligned: {
		leftLines: Array<{ text: string; type: "equal" | "add" | "remove" }>;
		rightLines: Array<{ text: string; type: "equal" | "add" | "remove" }>;
	} = { leftLines: [], rightLines: [] };

	let li = 0;
	while (li < leftLines.length) {
		if (
			li + 1 < leftLines.length &&
			leftLines[li].type === "remove" &&
			leftLines[li + 1].type === "add"
		) {
			aligned.leftLines.push(leftLines[li + 1]);
			aligned.rightLines.push(rightLines[li]);
			li += 2;
		} else {
			aligned.leftLines.push(leftLines[li]);
			aligned.rightLines.push(rightLines[li]);
			li++;
		}
	}

	return aligned;
}
