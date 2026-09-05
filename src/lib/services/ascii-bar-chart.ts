// Recognise "ASCII bar charts" — the block-character bars models like to draw
// in a code fence — and turn them into real chart data.
//
//   Riverstone       ████████████████████░░░░░░░  €24.25
//   Cutters Choice   █████████████████████░░░░░░  €25.75
//
// Both the chat renderer (bare fence → chart block) and the document
// converter (paragraph/code → chart block) use this, so it lives in a
// client-safe module with no server imports.

export type AsciiBarChartPoint = { label: string; value: number };

export type AsciiBarChart = {
	title?: string;
	units?: string;
	points: AsciiBarChartPoint[];
};

const BAR_CHARS = "█▓▒░■□▪▫#=*|";
const BAR_LINE = new RegExp(
	`^(?<label>.+?)\\s+(?<bar>[${BAR_CHARS}]{2,})\\s*(?<tail>.*)$`,
);
// A number with optional currency/unit prefix or suffix: "€24.25", "24,5 kg",
// "$1,200", "~€13", "13%". The first number in the tail wins.
const NUMBER =
	/(?<prefix>[~≈]?\s*[€$£¥]?)\s*(?<num>-?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)\s*(?<suffix>%|[A-Za-z€$£¥]{0,6})/u;
const LEGEND_LINE =
	/(?:one|1)\s+(?:block|bar|█|■)\s*(?:=|≈)\s*(?<unit>[^\s]+)/i;

function parseNumber(raw: string): number | null {
	const cleaned = raw.replace(/\s/g, "");
	// "24,25" (decimal comma) vs "1,200" (thousands separator).
	const normalized = /^-?\d+,\d{1,2}$/.test(cleaned)
		? cleaned.replace(",", ".")
		: cleaned.replace(/,/g, "");
	const value = Number(normalized);
	return Number.isFinite(value) ? value : null;
}

export function parseAsciiBarChart(text: string): AsciiBarChart | null {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.trim().length > 0);
	if (lines.length < 2) return null;

	let title: string | undefined;
	let units: string | undefined;
	const points: AsciiBarChartPoint[] = [];
	let nonBarLines = 0;

	for (const line of lines) {
		const match = BAR_LINE.exec(line.trim());
		if (!match?.groups) {
			const legend = LEGEND_LINE.exec(line);
			if (legend?.groups?.unit) {
				units = legend.groups.unit;
				continue;
			}
			// A leading caption line is allowed; anything else counts against it.
			if (points.length === 0 && !title && !/[█▓▒░]/.test(line)) {
				title = line.trim().replace(/[:：]\s*$/, "");
				continue;
			}
			nonBarLines += 1;
			continue;
		}
		const label = match.groups.label.trim().replace(/[:：]\s*$/, "");
		const numberMatch = NUMBER.exec(match.groups.tail ?? "");
		const value = numberMatch?.groups?.num
			? parseNumber(numberMatch.groups.num)
			: null;
		if (!label || value === null) {
			nonBarLines += 1;
			continue;
		}
		if (!units) {
			const prefix = numberMatch?.groups?.prefix?.replace(/[~≈\s]/g, "");
			const suffix = numberMatch?.groups?.suffix?.trim();
			if (prefix) units = prefix;
			else if (suffix && /^(?:%|[A-Za-z€$£¥]+)$/.test(suffix)) units = suffix;
		}
		points.push({ label, value });
	}

	// At least two bars and bars must dominate the block.
	if (points.length < 2 || nonBarLines > points.length) return null;
	return { ...(title ? { title } : {}), ...(units ? { units } : {}), points };
}

// Chart.js config for the chat renderer's ```chart block.
export function asciiBarChartToChartJs(
	chart: AsciiBarChart,
): Record<string, unknown> {
	const label = chart.units ? `Value (${chart.units})` : "Value";
	return {
		type: "bar",
		data: {
			labels: chart.points.map((point) => point.label),
			datasets: [{ label, data: chart.points.map((point) => point.value) }],
		},
		...(chart.title
			? {
					options: { plugins: { title: { display: true, text: chart.title } } },
				}
			: {}),
	};
}
