/**
 * Reusable analytics UI components (Phase B, wave B2).
 *
 * These are theme-aware (light/dark via the `.dark` class) and styled entirely
 * with the app's own design tokens — the accent is TERRACOTTA (`var(--accent)`),
 * NOT indigo. Shared class definitions live in `./analytics.css`; the Chart.js
 * palette lives in `./chart-palette.ts`.
 *
 * TABS: do NOT build a bespoke tab strip here. Reuse the existing
 * `$lib/components/ui/PageSwitcher.svelte` (role="tablist") wherever tabbed
 * analytics navigation is needed.
 */

export { default as AnalyticsCard } from "./AnalyticsCard.svelte";
export { default as AnalyticsChart } from "./AnalyticsChart.svelte";
export {
	ACCENT_FALLBACK,
	CATEGORICAL,
	categoricalColor,
	GRID_COLOR,
	getAccent,
	SERIES,
	TICK_COLOR,
} from "./chart-palette";
export { default as MonthNav } from "./MonthNav.svelte";
export {
	formatMonthLabel,
	isNextDisabled,
	isPrevDisabled,
	stepMonth,
} from "./month-nav-logic";
export { default as SortableTable } from "./SortableTable.svelte";
export { default as StatCard } from "./StatCard.svelte";
export { default as StatGrid } from "./StatGrid.svelte";
export {
	type ColumnType,
	filterRows,
	type SortDir,
	sortRows,
	type TableColumn,
	type TableRow,
} from "./table-sort";
