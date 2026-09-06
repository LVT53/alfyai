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
// "one block = €20", "Scale: each █ ≈ €2.5", "1 bar = 10 kg".
const LEGEND_LINE =
	/(?:one|1|each|every)\s+(?:block|bar|[█▓▒░■□▪▫])\s*(?:=|≈|~|:)\s*(?<unit>\S+)/i;
// "Riverstone  €24.25 █████": the value printed BEFORE the bar, so it ends up
// at the tail of the label group instead of in the tail group.
const TRAILING_NUMBER =
	/^(?<label>.+?)\s+(?<prefix>[~≈]?\s*[€$£¥]?)\s*(?<num>-?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)\s*(?<suffix>%|[A-Za-z€$£¥]{0,6})$/u;

function parseNumber(raw: string): number | null {
	const cleaned = raw.replace(/\s/g, "");
	// "24,25" (decimal comma) vs "1,200" (thousands separator).
	const normalized = /^-?\d+,\d{1,2}$/.test(cleaned)
		? cleaned.replace(",", ".")
		: cleaned.replace(/,/g, "");
	const value = Number(normalized);
	return Number.isFinite(value) ? value : null;
}

// A table/CSV cell that holds one number with an optional currency or unit:
// "€24.25", "24,5 kg", "1,200", "13%", "~€13". Returns the number and the
// unit token (prefix or suffix) when present.
export function parseNumericCell(
	value: unknown,
): { value: number; units?: string } | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? { value } : null;
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match =
		/^(?<prefix>[~≈]?\s*[€$£¥]?)\s*(?<num>-?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)\s*(?<suffix>%|[A-Za-z€$£¥]{0,6})$/u.exec(
			trimmed,
		);
	if (!match?.groups?.num) return null;
	const parsed = parseNumber(match.groups.num);
	if (parsed === null) return null;
	const prefix = match.groups.prefix?.replace(/[~≈\s]/g, "") ?? "";
	const suffix = match.groups.suffix?.trim() ?? "";
	const units = prefix || suffix || undefined;
	return units ? { value: parsed, units } : { value: parsed };
}

// Block-character "bars" only (optionally wrapped in backticks/quotes): the
// decorative "Relative Scale" column models add next to a numeric column.
const BAR_ONLY_CELL_RE = /^[\s`'"]*[█▓▒░■□▪▫]+[\s`'"]*$/u;
const BAR_CHARS_RE = /[█▓▒░■□▪▫]/u;

export function isBarOnlyCell(value: unknown): boolean {
	return typeof value === "string" && BAR_ONLY_CELL_RE.test(value);
}

export function hasBarChars(value: unknown): boolean {
	return typeof value === "string" && BAR_CHARS_RE.test(value);
}

// Filled bar length of a cell: "████░░" → 4.
export function barFillLength(value: unknown): number {
	return typeof value === "string"
		? (value.match(/[█▓▒■▪]/gu) ?? []).length
		: 0;
}

// "Scale (1 █ ≈ €20)", "each block = 2.5", "1 bar ≈ €2": the value one
// filled block stands for, read from a legend or a column header.
export function legendPerBlock(text: unknown): number | null {
	if (typeof text !== "string") return null;
	const match =
		/(?:one|1|each|every)?\s*(?:block|bar|[█▓▒░■□▪▫])\s*(?:=|≈|~|:)\s*(?<value>[~≈]?\s*[€$£¥]?\s*-?\d[\d ,.]*\s*(?:%|[A-Za-z€$£¥]{0,6}))/iu.exec(
			text,
		);
	const parsed = match?.groups?.value
		? parseNumericCell(match.groups.value.replace(/[)\]]+$/, ""))
		: null;
	return parsed && parsed.value > 0 ? parsed.value : null;
}

// Which numeric column were the bars drawn from? With a legend ("1 █ ≈ €20")
// it is the column whose value-per-block matches. Otherwise it is the column
// whose values are (nearly) proportional to the bar lengths; exact ties (an
// "Annual" column that is 12× "Monthly") go to the first candidate, so
// callers list candidates nearest to the bar column first.
export function pickBarMatchedColumn<T>(
	barLengths: number[],
	candidates: Array<{ id: T; values: number[] }>,
	perBlock: number | null = null,
): T | null {
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0].id;
	const scored = candidates.flatMap((candidate) => {
		const ratios: number[] = [];
		barLengths.forEach((length, index) => {
			const value = candidate.values[index];
			if (length > 0 && typeof value === "number" && value > 0) {
				ratios.push(value / length);
			}
		});
		if (ratios.length < 2) return [];
		const sorted = [...ratios].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)];
		const spread = sorted[sorted.length - 1] / sorted[0];
		return [{ id: candidate.id, median, spread }];
	});
	if (scored.length === 0) return candidates[0].id;
	if (perBlock) {
		const closest = scored.reduce((best, entry) =>
			Math.abs(entry.median - perBlock) < Math.abs(best.median - perBlock)
				? entry
				: best,
		);
		if (Math.abs(closest.median - perBlock) / perBlock <= 0.5) {
			return closest.id;
		}
	}
	const best = scored.reduce((current, entry) =>
		entry.spread < current.spread * 0.98 ? entry : current,
	);
	return best.spread <= 1.6 ? best.id : candidates[0].id;
}

// "10/day, low" and "10/day, low band" are the same category written twice.
export function sameChartCategories(a: unknown[], b: unknown[]): boolean {
	if (a.length < 2 || a.length !== b.length) return false;
	const key = (value: unknown) =>
		String(value)
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "");
	return a.every((label, index) => {
		const x = key(label);
		const y = key(b[index]);
		return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
	});
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
				// "€20" → "€", "kg" → "kg"; a bare number carries no unit.
				const unit = legend.groups.unit.replace(/[\d.,\s()]/g, "");
				if (unit && !units) units = unit;
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
		let label = match.groups.label.trim().replace(/[:：]\s*$/, "");
		let numberMatch: RegExpExecArray | null = NUMBER.exec(
			match.groups.tail ?? "",
		);
		if (!numberMatch?.groups?.num) {
			// Value before the bar: "10/day, low    €121 ██████".
			const leading = TRAILING_NUMBER.exec(label);
			if (leading?.groups?.num && leading.groups.label.trim()) {
				numberMatch = leading;
				label = leading.groups.label.trim().replace(/[:：]\s*$/, "");
			}
		}
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
