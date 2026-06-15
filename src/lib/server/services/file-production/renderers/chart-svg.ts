import type { GeneratedDocumentChartBlock } from "../source-schema";

const CHART_THEME = {
	text: "#1B1815",
	secondaryText: "#6F6860",
	accent: "#B65F3D",
	rule: "#DED6CB",
	panel: "#FAF8F4",
} as const;
const SERIES_PALETTE = [
	"#B65F3D",
	"#4D7188",
	"#7A7F42",
	"#C29A3D",
	"#6F6860",
	"#8E6A86",
];

export interface RenderedChartSvg {
	svg: string;
	width: number;
	height: number;
	dataPointCount: number;
	chartType: GeneratedDocumentChartBlock["chartType"];
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function labelValue(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function isCartesianChart(chart: GeneratedDocumentChartBlock): boolean {
	return ["bar", "stackedBar", "line", "area", "scatter"].includes(
		chart.chartType,
	);
}

function niceTicks(min: number, max: number): number[] {
	if (min === max) {
		return [min - 1, min, min + 1];
	}
	const span = max - min;
	const rawStep = span / 4;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const normalized = rawStep / magnitude;
	const step =
		(normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
		magnitude;
	const start = Math.floor(min / step) * step;
	const end = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let value = start; value <= end + step / 2; value += step) {
		ticks.push(Number(value.toFixed(6)));
	}
	return ticks;
}

function baseSvg(params: {
	chart: GeneratedDocumentChartBlock;
	width: number;
	height: number;
	body: string[];
	dataPointCount: number;
}): RenderedChartSvg {
	return {
		width: params.width,
		height: params.height,
		dataPointCount: params.dataPointCount,
		chartType: params.chart.chartType,
		svg: [
			`<svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" role="img" aria-labelledby="chart-title chart-desc" data-chart-type="${escapeXml(params.chart.chartType)}">`,
			`<title id="chart-title">${escapeXml(params.chart.title ?? "Chart")}</title>`,
			`<desc id="chart-desc">${escapeXml(params.chart.altText ?? params.chart.caption ?? params.chart.title ?? "Chart")}</desc>`,
			`<rect x="0" y="0" width="${params.width}" height="${params.height}" rx="0" fill="${CHART_THEME.panel}"/>`,
			`<text x="68" y="28" font-size="16" font-weight="700" fill="${CHART_THEME.text}">${escapeXml(params.chart.title ?? "Chart")}</text>`,
			params.chart.caption
				? `<text x="68" y="46" font-size="11" fill="${CHART_THEME.secondaryText}">${escapeXml(params.chart.caption)}</text>`
				: "",
			...params.body,
			"</svg>",
		]
			.filter(Boolean)
			.join(""),
	};
}

interface CartesianChartRow {
	label: string;
	value: number;
	series: string;
	xValue: number;
}

interface CartesianChartState {
	chart: GeneratedDocumentChartBlock;
	width: number;
	height: number;
	margin: { top: number; right: number; bottom: number; left: number };
	plotWidth: number;
	plotHeight: number;
	rawRows: CartesianChartRow[];
	labels: string[];
	series: string[];
	ticks: number[];
	isBarChart: boolean;
	groupWidth: number;
	pointInset: number;
	drawablePlotWidth: number;
	unitLabel: string;
	scaleY: (value: number) => number;
	scaleX: (index: number) => number;
	xScale: (index: number) => number;
}

function renderCartesianChart(
	chart: GeneratedDocumentChartBlock,
	width: number,
	height: number,
): RenderedChartSvg {
	const state = buildCartesianChartState(chart, width, height);
	const { points, areaPoints } = buildCartesianLineAndAreaGeometry(state);
	const xLabels = buildCartesianXAxisLabels(state);
	const yGrid = buildCartesianYAxisGrid(state);
	const markers = buildCartesianLineMarkers(state);
	const bars = buildCartesianBars(state);
	const scatterMarkers = buildCartesianScatter(state);

	return baseSvg({
		chart,
		width,
		height,
		dataPointCount: state.rawRows.length,
		body: [
			`<text x="${state.margin.left - 44}" y="${state.margin.top - 18}" font-size="10" fill="${CHART_THEME.secondaryText}">${escapeXml(chart.units ?? "")}</text>`,
			...yGrid,
			`<line x1="${state.margin.left}" y1="${state.margin.top + state.plotHeight}" x2="${state.margin.left + state.plotWidth}" y2="${state.margin.top + state.plotHeight}" stroke="${CHART_THEME.secondaryText}" stroke-width="1"/>`,
			`<line x1="${state.margin.left}" y1="${state.margin.top}" x2="${state.margin.left}" y2="${state.margin.top + state.plotHeight}" stroke="${CHART_THEME.secondaryText}" stroke-width="1"/>`,
			...bars,
			...(chart.chartType === "area" && areaPoints
				? [
						`<polygon points="${areaPoints}" fill="${CHART_THEME.accent}" opacity="0.16"/>`,
					]
				: []),
			...(chart.chartType === "line" || chart.chartType === "area"
				? [
						`<polyline points="${points}" fill="none" stroke="${CHART_THEME.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
						...markers,
					]
				: []),
			...scatterMarkers,
			...xLabels,
		],
	});
}

function buildCartesianChartState(
	chart: GeneratedDocumentChartBlock,
	width: number,
	height: number,
): CartesianChartState {
	if (!chart.xKey || !chart.yKey) {
		throw new Error("Cartesian charts require xKey and yKey.");
	}
	if (chart.chartType === "stackedBar" && !chart.seriesKey) {
		throw new Error("Stacked bar charts require seriesKey.");
	}

	const rows: CartesianChartRow[] = chartRowsFromData(chart);
	const labels = Array.from(new Set(rows.map((row) => row.label)));
	const series = Array.from(new Set(rows.map((row) => row.series)));
	const isBarChart =
		chart.chartType === "bar" || chart.chartType === "stackedBar";
	const margin = { top: 54, right: 28, bottom: 54, left: 68 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;

	const stackedTotals = labels.map((label) =>
		rows
			.filter((row) => row.label === label)
			.reduce((sum, row) => sum + Math.max(row.value, 0), 0),
	);
	const values =
		isBarChart && chart.chartType === "stackedBar"
			? stackedTotals
			: rows.map((row) => row.value);
	const minValue = Math.min(0, ...values);
	const maxValue = Math.max(...values);
	const ticks = niceTicks(minValue, maxValue);

	const groupWidth = isBarChart
		? Math.max(18, (plotWidth / Math.max(labels.length, 1)) * 0.66)
		: 0;
	const pointInset = isBarChart
		? groupWidth / 2 + 4
		: chart.chartType === "scatter"
			? 6
			: 5;
	const drawablePlotWidth = Math.max(1, plotWidth - pointInset * 2);
	const scaleY = (value: number) => {
		const tickMin = ticks[0];
		const tickMax = ticks[ticks.length - 1];
		return (
			margin.top +
			plotHeight -
			((value - tickMin) / (tickMax - tickMin || 1)) * plotHeight
		);
	};
	const scaleIndex = (index: number, count: number) =>
		margin.left +
		pointInset +
		(count === 1
			? drawablePlotWidth / 2
			: (index / (count - 1)) * drawablePlotWidth);

	return {
		chart,
		width,
		height,
		margin,
		plotWidth,
		plotHeight,
		rawRows: rows,
		labels,
		series,
		ticks,
		isBarChart,
		groupWidth,
		pointInset,
		drawablePlotWidth,
		unitLabel: chart.units ? ` (${chart.units})` : "",
		scaleY,
		scaleX: (index: number) => scaleIndex(index, rows.length),
		xScale: (index: number) => scaleIndex(index, labels.length),
	};
}

function chartRowsFromData(
	chart: GeneratedDocumentChartBlock,
): CartesianChartRow[] {
	if (!chart.xKey || !chart.yKey) {
		throw new Error("Cartesian charts require xKey and yKey.");
	}
	const xKey = chart.xKey;
	const yKey = chart.yKey;

	const rows = chart.data
		.map((row, sourceIndex) => ({
			label: labelValue(row[xKey]),
			value: numberValue(row[yKey]),
			series: chart.seriesKey ? labelValue(row[chart.seriesKey]) : "Value",
			xValue: numberValue(row[xKey]) ?? sourceIndex,
		}))
		.filter((row): row is CartesianChartRow => row.value !== null);

	if (rows.length === 0) {
		throw new Error("Chart data has no numeric values.");
	}

	return rows;
}

function buildCartesianXAxisLabels(state: CartesianChartState): string[] {
	return state.labels.map((label, index) => {
		const x = state.xScale(index);
		return `<text x="${x.toFixed(1)}" y="${state.height - 22}" text-anchor="middle" font-size="10" fill="${CHART_THEME.secondaryText}">${escapeXml(label)}</text>`;
	});
}

function buildCartesianYAxisGrid(state: CartesianChartState): string[] {
	return state.ticks.map((tick) => {
		const y = state.scaleY(tick);
		return [
			`<line x1="${state.margin.left}" y1="${y.toFixed(1)}" x2="${state.margin.left + state.plotWidth}" y2="${y.toFixed(1)}" stroke="${CHART_THEME.rule}" stroke-width="1"/>`,
			`<text x="${state.margin.left - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${CHART_THEME.secondaryText}">${escapeXml(new Intl.NumberFormat("en-US").format(tick))}</text>`,
		].join("");
	});
}

function buildCartesianLineAndAreaGeometry(state: CartesianChartState): {
	points: string;
	areaPoints: string | null;
} {
	const points = state.rawRows
		.map(
			(row, index) =>
				`${state.scaleX(index).toFixed(1)},${state.scaleY(row.value).toFixed(1)}`,
		)
		.join(" ");
	const areaPoints =
		state.chart.chartType === "area"
			? `${state.scaleX(0).toFixed(1)},${(state.margin.top + state.plotHeight).toFixed(1)} ${points} ${state.scaleX(state.rawRows.length - 1).toFixed(1)},${(state.margin.top + state.plotHeight).toFixed(1)}`
			: null;
	return { points, areaPoints };
}

function buildCartesianLineMarkers(state: CartesianChartState): string[] {
	return state.rawRows.map((row, index) => {
		const x = state.scaleX(index);
		const y = state.scaleY(row.value);
		return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${CHART_THEME.accent}"><title>${escapeXml(`${row.label}: ${row.value}${state.unitLabel}`)}</title></circle>`;
	});
}

function buildCartesianBars(state: CartesianChartState): string[] {
	if (!state.isBarChart) return [];

	const bars: string[] = [];
	for (const [labelIndex, label] of state.labels.entries()) {
		const groupX = state.xScale(labelIndex) - state.groupWidth / 2;
		if (state.chart.chartType === "stackedBar") {
			let stackedY = state.margin.top + state.plotHeight;
			for (const [seriesIndex, seriesName] of state.series.entries()) {
				const value =
					state.rawRows.find(
						(row) => row.label === label && row.series === seriesName,
					)?.value ?? 0;
				const barHeight =
					((Math.max(value, 0) - 0) /
						(state.ticks[state.ticks.length - 1] || 1)) *
					state.plotHeight;
				stackedY -= barHeight;
				bars.push(
					`<rect x="${groupX.toFixed(1)}" y="${stackedY.toFixed(1)}" width="${state.groupWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${SERIES_PALETTE[seriesIndex % SERIES_PALETTE.length]}"><title>${escapeXml(`${label} ${seriesName}: ${value}${state.unitLabel}`)}</title></rect>`,
				);
			}
		} else {
			const value =
				state.rawRows.find((row) => row.label === label)?.value ?? 0;
			const y = state.scaleY(value);
			const zero = state.scaleY(0);
			bars.push(
				`<rect x="${groupX.toFixed(1)}" y="${Math.min(y, zero).toFixed(1)}" width="${state.groupWidth.toFixed(1)}" height="${Math.abs(zero - y).toFixed(1)}" fill="${CHART_THEME.accent}"><title>${escapeXml(`${label}: ${value}${state.unitLabel}`)}</title></rect>`,
			);
		}
	}
	return bars;
}

function buildCartesianScatter(state: CartesianChartState): string[] {
	if (state.chart.chartType !== "scatter") return [];

	const xMin = Math.min(...state.rawRows.map((row) => row.xValue));
	const xMax = Math.max(...state.rawRows.map((row) => row.xValue));

	return state.rawRows.map((row) => {
		const x =
			state.margin.left +
			state.pointInset +
			((row.xValue - xMin) / (xMax - xMin || 1)) * state.drawablePlotWidth;
		const y = state.scaleY(row.value);
		return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${CHART_THEME.accent}"><title>${escapeXml(`${row.xValue}: ${row.value}${state.unitLabel}`)}</title></circle>`;
	});
}

function arcPath(
	cx: number,
	cy: number,
	radius: number,
	startAngle: number,
	endAngle: number,
): string {
	const startX = cx + radius * Math.cos(startAngle);
	const startY = cy + radius * Math.sin(startAngle);
	const endX = cx + radius * Math.cos(endAngle);
	const endY = cy + radius * Math.sin(endAngle);
	const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
	return `M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${startX.toFixed(1)} ${startY.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 ${largeArc} 1 ${endX.toFixed(1)} ${endY.toFixed(1)} Z`;
}

function renderPieChart(
	chart: GeneratedDocumentChartBlock,
	width: number,
	height: number,
): RenderedChartSvg {
	if (!chart.labelKey || !chart.valueKey)
		throw new Error("Pie charts require labelKey and valueKey.");
	const labelKey = chart.labelKey;
	const valueKey = chart.valueKey;
	const rows = chart.data
		.map((row) => ({
			label: labelValue(row[labelKey]),
			value: numberValue(row[valueKey]),
		}))
		.filter(
			(row): row is { label: string; value: number } =>
				row.value !== null && row.value > 0,
		);
	if (rows.length === 0)
		throw new Error("Pie chart data has no positive numeric values.");
	const total = rows.reduce((sum, row) => sum + row.value, 0);
	const cx = 250;
	const cy = 194;
	const radius = 96;
	let angle = -Math.PI / 2;
	const slices: string[] = [];
	const legend: string[] = [];
	for (const [index, row] of rows.entries()) {
		const nextAngle = angle + (row.value / total) * Math.PI * 2;
		const color = SERIES_PALETTE[index % SERIES_PALETTE.length];
		slices.push(
			`<path d="${arcPath(cx, cy, radius, angle, nextAngle)}" fill="${color}"><title>${escapeXml(`${row.label}: ${row.value}`)}</title></path>`,
		);
		legend.push(
			`<rect x="390" y="${132 + index * 24}" width="12" height="12" fill="${color}"/><text x="410" y="${142 + index * 24}" font-size="11" fill="${CHART_THEME.text}">${escapeXml(row.label)}</text>`,
		);
		angle = nextAngle;
	}
	if (chart.chartType === "donut") {
		slices.push(
			`<circle cx="${cx}" cy="${cy}" r="48" fill="${CHART_THEME.panel}"/>`,
		);
	}
	return baseSvg({
		chart,
		width,
		height,
		dataPointCount: rows.length,
		body: [...slices, ...legend],
	});
}

export function renderChartSvg(
	chart: GeneratedDocumentChartBlock,
	options: { width?: number; height?: number } = {},
): RenderedChartSvg {
	const width = options.width ?? 640;
	const height = options.height ?? 360;
	if (isCartesianChart(chart)) {
		return renderCartesianChart(chart, width, height);
	}
	if (chart.chartType === "pie" || chart.chartType === "donut") {
		return renderPieChart(chart, width, height);
	}
	throw new Error(
		`Chart SVG renderer does not support ${chart.chartType} charts.`,
	);
}
