/**
 * Pure sort + filter logic for `SortableTable.svelte` (Phase B, wave B2).
 *
 * Extracted into a standalone module so it can be unit-tested without
 * mounting a component. Both functions are pure and return NEW arrays; they
 * never mutate their inputs.
 */

export type ColumnType = "text" | "number" | "usd" | "tokens";

export type SortDir = "asc" | "desc";

export type TableRow = Record<string, unknown>;

/** Column descriptor for `SortableTable.svelte`. */
export interface TableColumn {
	key: string;
	label: string;
	type: ColumnType;
	align?: "left" | "right" | "center";
}

/**
 * Coerce a cell value to a number for numeric-family sorting
 * (`number` | `usd` | `tokens`). Null/undefined/non-numeric values sort as
 * `-Infinity` so they consistently land at the bottom of a descending sort.
 */
function toNumber(value: unknown): number {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
	}
	if (typeof value === "string" && value.trim() !== "") {
		// Strip currency symbols, thousands separators and whitespace.
		const cleaned = value.replace(/[^0-9.eE+-]/g, "");
		const parsed = Number.parseFloat(cleaned);
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}
	return Number.NEGATIVE_INFINITY;
}

/** Coerce a cell value to a lowercased string for text sorting/filtering. */
function toText(value: unknown): string {
	if (value == null) return "";
	return String(value).toLowerCase();
}

/**
 * Sort `rows` by `key`, returning a new array. `type` selects the comparator:
 * `text` uses locale-aware string compare; `number`/`usd`/`tokens` compare
 * numerically. `dir` toggles ascending/descending.
 */
export function sortRows<T extends TableRow>(
	rows: readonly T[],
	key: string,
	dir: SortDir,
	type: ColumnType,
): T[] {
	const factor = dir === "asc" ? 1 : -1;
	const copy = [...rows];

	copy.sort((a, b) => {
		let cmp: number;
		if (type === "text") {
			cmp = toText(a[key]).localeCompare(toText(b[key]));
		} else {
			cmp = toNumber(a[key]) - toNumber(b[key]);
		}
		return cmp * factor;
	});

	return copy;
}

/**
 * Filter `rows` to those where ANY of `keys` (or every column when `keys` is
 * omitted/empty) contains `query` (case-insensitive substring). An empty or
 * whitespace-only query returns all rows (a fresh copy).
 */
export function filterRows<T extends TableRow>(
	rows: readonly T[],
	query: string,
	keys?: readonly string[],
): T[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...rows];

	return rows.filter((row) => {
		const searchKeys =
			keys && keys.length > 0 ? keys : (Object.keys(row) as string[]);
		return searchKeys.some((k) => toText(row[k]).includes(needle));
	});
}
