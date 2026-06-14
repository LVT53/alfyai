import { clamp } from "$lib/utils/math";
export type TableOverflowMode = "fit" | "scroll";

const DEFAULT_TABLE_PRESETS: Record<number, number[]> = {
	2: [44, 56],
	3: [34, 33, 33],
	4: [28, 24, 24, 24],
};

const MIN_WEIGHT_BY_COLUMN_COUNT: Record<number, number> = {
	2: 0.34,
	3: 0.22,
	4: 0.18,
};

const MAX_WEIGHT_BY_COLUMN_COUNT: Record<number, number> = {
	2: 0.66,
	3: 0.46,
	4: 0.38,
};

function formatWidths(weights: number[]): string[] {
	const percentages = weights.map((weight) => weight * 100);
	const rounded = percentages.map((value) => Number(value.toFixed(2)));
	const total = rounded.reduce((sum, value) => sum + value, 0);
	const delta = Number((100 - total).toFixed(2));
	if (rounded.length > 0 && Math.abs(delta) > 0.001) {
		rounded[rounded.length - 1] = Number(
			(rounded[rounded.length - 1] + delta).toFixed(2),
		);
	}
	return rounded.map((value) => `${value}%`);
}

function normalizeWithBounds(
	rawValues: number[],
	minWeight: number,
	maxWeight: number,
): number[] {
	if (rawValues.length === 0) return [];

	const weights = rawValues.map(
		(value) => value / rawValues.reduce((sum, item) => sum + item, 0),
	);

	for (let iteration = 0; iteration < 6; iteration += 1) {
		const locked = new Set<number>();
		let lockedTotal = 0;

		for (const [index, weight] of weights.entries()) {
			if (weight < minWeight) {
				weights[index] = minWeight;
				locked.add(index);
				lockedTotal += minWeight;
			} else if (weight > maxWeight) {
				weights[index] = maxWeight;
				locked.add(index);
				lockedTotal += maxWeight;
			}
		}

		if (locked.size === 0) {
			break;
		}

		const remainingIndexes = weights
			.map((_, index) => index)
			.filter((index) => !locked.has(index));
		if (remainingIndexes.length === 0) {
			break;
		}

		const remainingBudget = Math.max(0, 1 - lockedTotal);
		const remainingRaw = remainingIndexes.reduce(
			(sum, index) => sum + rawValues[index],
			0,
		);
		const evenShare = remainingBudget / remainingIndexes.length;

		for (const index of remainingIndexes) {
			weights[index] =
				remainingRaw > 0
					? (rawValues[index] / remainingRaw) * remainingBudget
					: evenShare;
		}
	}

	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) {
		return new Array(rawValues.length).fill(1 / rawValues.length);
	}

	return weights.map((weight) => weight / total);
}

function getSimpleRows(table: HTMLTableElement): HTMLTableRowElement[] {
	return Array.from(table.querySelectorAll("tr")).slice(0, 8);
}

export function getTableColumnCount(table: HTMLTableElement): number {
	const headerRow = table.tHead?.rows?.[0];
	const firstBodyRow = table.tBodies?.[0]?.rows?.[0];
	const firstRow = headerRow ?? firstBodyRow ?? table.rows?.[0];
	return firstRow
		? Array.from(firstRow.cells).reduce(
				(sum, cell) => sum + (cell.colSpan || 1),
				0,
			)
		: 0;
}

export function hasExtremeUnbreakableContent(table: HTMLTableElement): boolean {
	return Array.from(table.querySelectorAll("th, td")).some((cell) => {
		const tokens = (cell.textContent ?? "").split(/\s+/).filter(Boolean);
		return tokens.some((token) => token.length >= 52);
	});
}

export function deriveBalancedColumnWidths(
	table: HTMLTableElement,
	columnCount: number,
): string[] | null {
	const preset = DEFAULT_TABLE_PRESETS[columnCount];
	if (!preset) {
		return null;
	}

	const rows = getSimpleRows(table);
	if (rows.length === 0) {
		return preset.map((value) => `${value}%`);
	}

	const rawValues = new Array(columnCount).fill(12);
	for (const row of rows) {
		const totalColumns = Array.from(row.cells).reduce(
			(sum, cell) => sum + (cell.colSpan || 1),
			0,
		);
		if (totalColumns !== columnCount) {
			return preset.map((value) => `${value}%`);
		}

		let columnIndex = 0;
		for (const cell of Array.from(row.cells)) {
			const span = cell.colSpan || 1;
			const normalizedLength = clamp(
				(cell.textContent ?? "").replace(/\s+/g, " ").trim().length,
				6,
				34,
			);
			const valuePerColumn =
				(normalizedLength + (cell.tagName === "TH" ? 4 : 0)) / span;
			for (let offset = 0; offset < span; offset += 1) {
				rawValues[columnIndex + offset] = Math.max(
					rawValues[columnIndex + offset],
					valuePerColumn,
				);
			}
			columnIndex += span;
		}
	}

	const minWeight = MIN_WEIGHT_BY_COLUMN_COUNT[columnCount] ?? 1 / columnCount;
	const maxWeight = MAX_WEIGHT_BY_COLUMN_COUNT[columnCount] ?? 1;
	const weights = normalizeWithBounds(rawValues, minWeight, maxWeight);
	return formatWidths(weights);
}

export function resolveTableOverflowMode(params: {
	columnCount: number;
	forceScroll?: boolean;
	wrapperWidth: number;
	tableWidth: number;
}): TableOverflowMode {
	if (params.forceScroll || params.columnCount > 4) {
		return "scroll";
	}

	if (params.wrapperWidth <= 0 || params.tableWidth <= 0) {
		return "fit";
	}

	return params.tableWidth - params.wrapperWidth > 1 ? "scroll" : "fit";
}
