<script lang="ts">
import type { Snippet } from "svelte";
import { untrack } from "svelte";
import {
	type ColumnType,
	filterRows,
	type SortDir,
	sortRows,
	type TableColumn,
	type TableRow,
} from "./table-sort";

interface SortableTableProps {
	columns: TableColumn[];
	rows: TableRow[];
	/** Initial sort column + direction. */
	initialSort?: { key: string; dir: SortDir };
	/** Show a filter input above the table. */
	filterable?: boolean;
	/** Restrict filtering to these keys (defaults to all columns). */
	filterKeys?: string[];
	/** Placeholder text for the filter input (pass a localized string). */
	filterPlaceholder?: string;
	/** Optional pinned summary row (rendered last, not sorted/filtered). */
	totalRow?: TableRow;
	/**
	 * Optional custom cell renderers keyed by column key. When a column has a
	 * matching snippet, its body cells render the snippet — receiving
	 * `(row, value)` — instead of the default formatted text. Sorting and
	 * filtering still operate on the underlying `row[key]` value, so custom
	 * rendering (e.g. a leading icon) stays decoupled from the data. Kept
	 * generic: the caller decides which column opts in and what it renders.
	 * The pinned `totalRow` always uses the default text (never a custom cell).
	 */
	cells?: Record<string, Snippet<[TableRow, unknown]>>;
	/**
	 * Cap the body to this many rows (from the current sort/filter) until
	 * expanded. Omit for the previous unbounded behaviour. Pairs with
	 * `showAllLabel`/`showFewerLabel` for the footer line — both are plain,
	 * pre-localized strings so this component stays i18n-agnostic.
	 */
	maxRows?: number;
	/** Footer link text shown while collapsed, e.g. "Showing 10 of 34 · View all 34 →". */
	showAllLabel?: string;
	/** Footer link text shown while expanded, e.g. "Show fewer". */
	showFewerLabel?: string;
}

let {
	columns,
	rows,
	initialSort,
	filterable = false,
	filterKeys,
	filterPlaceholder = "Filter…",
	totalRow,
	cells,
	maxRows,
	showAllLabel = "View all",
	showFewerLabel = "Show fewer",
}: SortableTableProps = $props();

// Capture the initial sort once; the input props are not meant to be reactive
// after mount (the header buttons drive sortKey/sortDir thereafter).
let sortKey = $state(untrack(() => initialSort?.key ?? columns[0]?.key ?? ""));
let sortDir = $state<SortDir>(untrack(() => initialSort?.dir ?? "desc"));
let query = $state("");
let expanded = $state(false);

let columnType = $derived(
	new Map(columns.map((c) => [c.key, c.type] as const)),
);

let visibleRows = $derived.by(() => {
	const filtered = filterable
		? filterRows(rows, query, filterKeys ?? columns.map((c) => c.key))
		: rows;
	const type = columnType.get(sortKey) ?? "text";
	return sortRows(filtered, sortKey, sortDir, type);
});

// Reset to collapsed whenever the underlying row set shrinks below the cap
// (e.g. a filter change) so a stale "expanded" state doesn't hide a footer
// that would otherwise be useful again.
let isCappable = $derived(
	Boolean(maxRows) && visibleRows.length > (maxRows ?? 0),
);
let displayRows = $derived(
	isCappable && !expanded ? visibleRows.slice(0, maxRows) : visibleRows,
);

function toggleSort(key: string) {
	if (sortKey === key) {
		sortDir = sortDir === "asc" ? "desc" : "asc";
	} else {
		sortKey = key;
		sortDir = "desc";
	}
}

function alignClass(align: TableColumn["align"]): string {
	if (align === "right") return "text-right";
	if (align === "center") return "text-center";
	return "text-left";
}

// Pin the locale: cost figures are USD everywhere else in the app (rendered as
// "$0.0042"), and a host-locale formatter would print "US$1.23" on en-GB/en-AU
// machines, which makes the output (and tests) machine-dependent.
const numberFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

function formatCell(value: unknown, type: ColumnType): string {
	if (value == null) return "";
	if (type === "usd") {
		const n =
			typeof value === "number" ? value : Number.parseFloat(String(value));
		return Number.isFinite(n) ? usdFmt.format(n) : String(value);
	}
	if (type === "tokens" || type === "number") {
		const n =
			typeof value === "number" ? value : Number.parseFloat(String(value));
		return Number.isFinite(n) ? numberFmt.format(n) : String(value);
	}
	return String(value);
}

function isNumeric(type: ColumnType): boolean {
	return type !== "text";
}
</script>

{#if filterable}
	<input
		type="text"
		bind:value={query}
		placeholder={filterPlaceholder}
		class="mb-3 w-full rounded-md border border-border bg-surface-page px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
	/>
{/if}

<div class="overflow-x-auto">
	<table class="analytics-table w-full text-sm">
		<thead>
			<tr>
				{#each columns as col (col.key)}
					<th
						class="border-b border-border py-2 pr-3 text-xs font-medium text-text-muted {alignClass(
							col.align ?? (isNumeric(col.type) ? 'right' : 'left'),
						)}"
					>
						<button
							type="button"
							class="inline-flex items-center gap-1 hover:text-accent"
							onclick={() => toggleSort(col.key)}
						>
							<span>{col.label}</span>
							{#if sortKey === col.key}
								<span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>
							{/if}
						</button>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each displayRows as row (row)}
				<tr>
					{#each columns as col (col.key)}
						<td
							class="border-b border-border py-2 pr-3 text-text-secondary {alignClass(
								col.align ?? (isNumeric(col.type) ? 'right' : 'left'),
							)} {isNumeric(col.type) ? 'tabular-nums' : ''}"
						>
							{#if cells?.[col.key]}
								{@render cells[col.key](row, row[col.key])}
							{:else}
								{formatCell(row[col.key], col.type)}
							{/if}
						</td>
					{/each}
				</tr>
			{/each}
			{#if totalRow}
				<tr class="font-medium text-text-primary">
					{#each columns as col (col.key)}
						<td
							class="py-2 pr-3 {alignClass(
								col.align ?? (isNumeric(col.type) ? 'right' : 'left'),
							)} {isNumeric(col.type) ? 'tabular-nums' : ''}"
						>
							{formatCell(totalRow[col.key], col.type)}
						</td>
					{/each}
				</tr>
			{/if}
		</tbody>
	</table>
</div>
{#if isCappable}
	<div class="mt-2 text-xs">
		{#if expanded}
			<button
				type="button"
				class="text-text-muted underline-offset-2 hover:text-accent hover:underline"
				onclick={() => (expanded = false)}
			>
				{showFewerLabel}
			</button>
		{:else}
			<button
				type="button"
				class="text-text-muted underline-offset-2 hover:text-accent hover:underline"
				onclick={() => (expanded = true)}
			>
				{showAllLabel}
			</button>
		{/if}
	</div>
{/if}
