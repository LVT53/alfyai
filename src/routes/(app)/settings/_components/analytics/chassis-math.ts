// The shared analytics chassis: the arithmetic behind the hero number, its
// split bar, and the gridded column chart (everyday-screens redesign,
// Analytics board).
//
// Personal analytics and system analytics used to be two files that disagreed
// about almost everything they share: five equal stat tiles against six, a
// line chart against a bar chart, a comparison line reading "↑ 12% vs June
// 2026" in one and "LLM $96.31 · Parallel $32.43" in the other. Both now sit
// on the same grammar — hero number, split bar, tiles, chart, table — and this
// module is the half of it that can be checked without rendering anything.

export interface CostSegmentInput {
	label: string;
	value: number;
	/** A CSS colour (token or literal) for the bar segment and its swatch. */
	color: string;
}

export interface CostSegment extends CostSegmentInput {
	/** Share of the total, 0–100. Segments sum to 100 (or to 0 for an empty split). */
	percent: number;
	/** "Chat · $1.98" — the legend entry. */
	legend: string;
}

export interface CostSplit {
	total: number;
	segments: CostSegment[];
}

/**
 * Estimated cost is the number both audiences came for, and in both views it
 * is the sum of two or more things. Two decimals, always: this is money, and
 * `$2.4231` reads as a bug.
 */
export function formatCurrencyUsd(value: number | null | undefined): string {
	const amount = Number(value ?? 0);
	const safe = Number.isFinite(amount) ? amount : 0;
	return `$${safe.toFixed(2)}`;
}

/**
 * The split bar under the hero. Percentages are derived from the real amounts
 * and the last segment absorbs the rounding remainder, so the bar always fills
 * exactly and the legend always adds up to the hero number above it.
 *
 * Segments worth nothing are dropped — a zero-width sliver with a legend entry
 * claims a breakdown that is not there.
 */
export function buildCostSplit(
	segments: readonly CostSegmentInput[],
): CostSplit {
	const present = segments.filter(
		(segment) => Number.isFinite(segment.value) && segment.value > 0,
	);
	const total = present.reduce((sum, segment) => sum + segment.value, 0);

	if (total <= 0) {
		return { total: 0, segments: [] };
	}

	const computed = present.map((segment) => ({
		...segment,
		percent: Math.round((segment.value / total) * 10_000) / 100,
		legend: `${segment.label} · ${formatCurrencyUsd(segment.value)}`,
	}));

	// Absorb the rounding remainder into the last segment so the bar fills.
	const drift =
		100 - computed.reduce((sum, segment) => sum + segment.percent, 0);
	const last = computed[computed.length - 1];
	last.percent = Math.round((last.percent + drift) * 100) / 100;

	return { total, segments: computed };
}

export interface ComparisonDelta {
	direction: "up" | "down" | "flat";
	/** Whole-percent magnitude of the change. */
	percent: number;
}

/**
 * "↓ 8% vs August 2026". Returns null when there is nothing honest to compare
 * against — no previous period, or a previous period of zero, where a
 * percentage change is undefined rather than infinite.
 */
export function buildComparisonDelta(
	current: number,
	previous: number,
): ComparisonDelta | null {
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
	if (previous <= 0) return null;
	const change = ((current - previous) / previous) * 100;
	const percent = Math.round(Math.abs(change));
	if (percent === 0) return { direction: "flat", percent: 0 };
	return { direction: change > 0 ? "up" : "down", percent };
}

export interface ChartPoint {
	label: string;
	value: number;
}

export interface ChartColumn extends ChartPoint {
	/** Bar height as a percentage of the tallest column, 0–100. */
	heightPct: number;
	/**
	 * True for the period still running. It is drawn solid because it is the
	 * one reading guaranteed to be incomplete and the one users read as a crash.
	 */
	current: boolean;
	/** Whether this column's label is printed on the x-axis. */
	labelled: boolean;
}

export interface ColumnChart {
	columns: ChartColumn[];
	/** Gridline positions as percentages of the plot height, bottom-up. */
	gridlines: number[];
	/** The scale mark printed at the top right. */
	peak: number;
	empty: boolean;
}

/** A minimum drawn height, so a tiny-but-real period is still visible. */
const MIN_BAR_PCT = 3;

/**
 * Both views draw columns on gridlines every quarter with the scale marked at
 * the top right, and in both the final column is the period still running.
 *
 * `labelEvery` thins the x-axis: the first, the last and every nth label in
 * between, so a 52-week series does not print 52 overlapping ticks.
 */
export function buildColumnChart(
	points: readonly ChartPoint[],
	options: { labelEvery?: number; currentIndex?: number } = {},
): ColumnChart {
	const gridlines = [0, 25, 50, 75, 100];
	if (points.length === 0) {
		return { columns: [], gridlines, peak: 0, empty: true };
	}

	const peak = Math.max(...points.map((point) => point.value), 0);
	const currentIndex = options.currentIndex ?? points.length - 1;
	const labelEvery = Math.max(1, options.labelEvery ?? 1);

	const columns = points.map((point, index) => ({
		...point,
		heightPct:
			peak > 0
				? Math.max(MIN_BAR_PCT, Math.round((point.value / peak) * 100))
				: 0,
		current: index === currentIndex,
		labelled:
			index === 0 || index === points.length - 1 || index % labelEvery === 0,
	}));

	return { columns, gridlines, peak, empty: peak <= 0 };
}

/** Compact axis/tile figures: 18_400_000 → "18.4M". */
export function formatCompactNumber(value: number | null | undefined): string {
	const amount = Number(value ?? 0);
	if (!Number.isFinite(amount) || amount === 0) return "0";
	const abs = Math.abs(amount);
	if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
	if (abs >= 10_000) return `${Math.round(amount / 1_000)}K`;
	return amount.toLocaleString("en-US");
}
