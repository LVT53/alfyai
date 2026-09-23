// Number and date matching for the Atlas v2 verifier (ADR 0062).
//
// The rule the verifier enforces is "every number or date in a cited sentence
// appears in the cited source's text". Enforcing that on raw substrings fails
// constantly, because a source that says "8,000 MW" and a writer that says
// "8 GW" are the same fact, and a source that says "3,5%" (Hungarian decimal
// comma) and a writer that says "3.5%" are the same fact. So a figure is
// expanded into every equivalent surface form before the source text is
// searched.
//
// This module is deterministic and has no model dependency: it is the part of
// verification that must never be a judgement call.

/**
 * What a run of digits actually is. Only `number` is a quantity the verifier
 * can meaningfully hunt for in a source: the first live evaluation reported
 * "2025", "January 21, 2026", "13 9343" (a Dell model number) and "GPT-5.6" as
 * figures the source did not carry, which is a false positive every time —
 * a source states a date or a model name in whatever form it likes.
 */
export type ExtractedFigureKind =
	| "number"
	| "year"
	| "date"
	| "version"
	| "ordinal";

/** A figure lifted out of a sentence, with the unit that qualifies it. */
export interface ExtractedFigure {
	/** Exactly as written in the sentence, e.g. "8,000" or "3.5". */
	raw: string;
	/** Parsed magnitude in the unit named by `unit`, or null when unparsable. */
	value: number | null;
	/** Normalised unit token ("gw", "%", "eur", "") — "" when unitless. */
	unit: string;
	/** True for a 4-digit year or an ISO/spelled date. Kept for readability. */
	isDate: boolean;
	/** What kind of digit run this is; see ExtractedFigureKind. */
	kind: ExtractedFigureKind;
	/** The full matched text including any unit, for error messages. */
	text: string;
}

/**
 * True when the figure is a quantity worth checking against a source. Years,
 * dates, model/version tokens and ordinals are not.
 */
export function isCheckableFigure(figure: ExtractedFigure): boolean {
	return figure.kind === "number";
}

const UNIT_ALIASES: Record<string, string> = {
	"%": "%",
	percent: "%",
	"per cent": "%",
	pct: "%",
	százalék: "%",
	procent: "%",
	gw: "gw",
	gigawatt: "gw",
	gigawatts: "gw",
	mw: "mw",
	megawatt: "mw",
	megawatts: "mw",
	kw: "kw",
	kilowatt: "kw",
	kilowatts: "kw",
	tw: "tw",
	terawatt: "tw",
	terawatts: "tw",
	wh: "wh",
	kwh: "kwh",
	mwh: "mwh",
	gwh: "gwh",
	twh: "twh",
	t: "t",
	tonne: "t",
	tonnes: "t",
	ton: "t",
	tons: "t",
	kt: "kt",
	mt: "mt",
	kg: "kg",
	g: "g",
	lb: "lb",
	lbs: "lb",
	km: "km",
	m: "m_len",
	mi: "mi",
	mile: "mi",
	miles: "mi",
	usd: "usd",
	$: "usd",
	dollar: "usd",
	dollars: "usd",
	eur: "eur",
	"€": "eur",
	euro: "eur",
	euros: "eur",
	gbp: "gbp",
	"£": "gbp",
	pound: "gbp",
	pounds: "gbp",
	huf: "huf",
	ft: "huf",
	forint: "huf",
};

/** Scale words, resolved into a multiplier applied to the parsed magnitude. */
const SCALE_WORDS: Record<string, number> = {
	k: 1e3,
	thousand: 1e3,
	ezer: 1e3,
	duizend: 1e3,
	m: 1e6,
	mn: 1e6,
	million: 1e6,
	millions: 1e6,
	millió: 1e6,
	miljoen: 1e6,
	bn: 1e9,
	b: 1e9,
	billion: 1e9,
	billions: 1e9,
	milliárd: 1e9,
	miljard: 1e9,
	tn: 1e12,
	trillion: 1e12,
};

/** Unit families whose members convert by a fixed factor. */
const UNIT_LADDERS: ReadonlyArray<Record<string, number>> = [
	{ kw: 1, mw: 1e3, gw: 1e6, tw: 1e9 },
	{ wh: 1, kwh: 1e3, mwh: 1e6, gwh: 1e9, twh: 1e12 },
	{ g: 1, kg: 1e3, t: 1e6, kt: 1e9, mt: 1e12 },
];

/** Reverse index from a normalised unit to every surface form it can take. */
const UNIT_SURFACE_FORMS = new Map<string, string[]>();
for (const [surface, normalized] of Object.entries(UNIT_ALIASES)) {
	const forms = UNIT_SURFACE_FORMS.get(normalized) ?? [];
	forms.push(surface);
	UNIT_SURFACE_FORMS.set(normalized, forms);
}

const SCALE_PATTERN = Object.keys(SCALE_WORDS)
	.sort((a, b) => b.length - a.length)
	.map(escapeRegExp)
	.join("|");
const UNIT_PATTERN = Object.keys(UNIT_ALIASES)
	.sort((a, b) => b.length - a.length)
	.map(escapeRegExp)
	.join("|");

// A number, optionally preceded by a currency symbol, optionally followed by a
// scale word and/or a unit. Thousands separators may be "," "." or any of the
// space characters publishers actually use; the decimal separator may be "."
// or ",". Neither a scale word nor a unit may be followed by another letter, so
// "8 mint" never parses as eight million and "2024 the" never parses as 2024
// tonnes — the latter used to hide a bare year behind a bogus unit.
const GROUP_SEPARATORS = "[\\u0020\\u00a0\\u202f,.]";
const FIGURE_PATTERN = new RegExp(
	`([$\\u20ac\\u00a3])?\\s?(\\d{1,3}(?:${GROUP_SEPARATORS}\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)\\s*(?:(${SCALE_PATTERN})(?![\\p{L}]))?\\s*(?:(${UNIT_PATTERN})(?![\\p{L}]))?`,
	"giu",
);

const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const YEAR_PATTERN = /\b(1[89]\d{2}|20\d{2}|21\d{2})\b/g;

/** Month names the report languages actually use (en, hu, nl). */
const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
	"jan",
	"feb",
	"mar",
	"apr",
	"jun",
	"jul",
	"aug",
	"sep",
	"sept",
	"oct",
	"nov",
	"dec",
	"január",
	"február",
	"március",
	"április",
	"május",
	"június",
	"július",
	"augusztus",
	"szeptember",
	"október",
	"november",
	"december",
	"januari",
	"februari",
	"maart",
	"mei",
	"juni",
	"juli",
	"augustus",
	"oktober",
];
const MONTH_PATTERN = MONTH_NAMES.sort((a, b) => b.length - a.length).join("|");

/**
 * Full dates, in the forms publishers write them. Matched BEFORE plain figures
 * so "January 21, 2026" is one date rather than the numbers 21 and 2026 — the
 * "21, 2026" false positive from the first live evaluation.
 */
const DATE_PATTERNS: RegExp[] = [
	// 2026. március 14. / 2026. 03. 14.
	new RegExp(
		`\\b\\d{4}\\.\\s?(?:${MONTH_PATTERN})\\s?\\d{1,2}\\.?(?:-[\\p{L}]+)?`,
		"giu",
	),
	/\b\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?/giu,
	// 14 March 2026 / 14. March 2026
	new RegExp(`\\b\\d{1,2}\\.?\\s(?:${MONTH_PATTERN})\\.?,?\\s\\d{4}\\b`, "giu"),
	// March 14, 2026 / March 2026
	new RegExp(
		`\\b(?:${MONTH_PATTERN})\\.?\\s\\d{1,2}(?:st|nd|rd|th)?,?\\s\\d{4}\\b`,
		"giu",
	),
	new RegExp(`\\b(?:${MONTH_PATTERN})\\.?\\s\\d{4}\\b`, "giu"),
	// 14 March / March 14 (day and month, no year)
	new RegExp(`\\b\\d{1,2}\\.?\\s(?:${MONTH_PATTERN})\\b`, "giu"),
	new RegExp(
		`\\b(?:${MONTH_PATTERN})\\.?\\s\\d{1,2}(?:st|nd|rd|th)?\\b`,
		"giu",
	),
	// 14/03/2026, 14.03.2026, 3/14/26
	/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
];

/** "1st", "2nd", "3rd", "21st" — a position, not a quantity. */
const ORDINAL_PATTERN = /\b\d{1,3}(?:st|nd|rd|th)\b/gi;

/**
 * Model, version and part numbers: "GPT-5.6", "H100", "v2.1", "Llama3", and a
 * bare model-number run like "13 9343" (Dell XPS 13 9343). None of these is a
 * quantity, and a source that names the same product may write it differently.
 */
const VERSION_PATTERNS: RegExp[] = [
	/\b[\p{L}][\p{L}]*-\d+(?:\.\d+)*\b/giu,
	/\b[\p{L}][\p{L}]*\d+(?:\.\d+)*\b/giu,
];
const MODEL_NUMBER_RUN_PATTERN = /\b(\d{1,4})\s(\d{4,})\b/g;

function isYearLike(value: string): boolean {
	const parsed = Number.parseInt(value, 10);
	return value.length === 4 && parsed >= 1800 && parsed <= 2199;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses a written number into a magnitude. Handles both separator
 * conventions: "8,000" and "8.000" are eight thousand, "3.5" and "3,5" are
 * three and a half.
 */
export function parseWrittenNumber(raw: string): number | null {
	const cleaned = raw.replace(/[\u0020\u00a0\u202f]/g, "");
	const hasComma = cleaned.includes(",");
	const hasDot = cleaned.includes(".");
	let normalized = cleaned;
	if (hasComma && hasDot) {
		// The rightmost separator is the decimal one.
		normalized =
			cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
				? cleaned.replace(/\./g, "").replace(",", ".")
				: cleaned.replace(/,/g, "");
	} else if (hasComma) {
		normalized = /,\d{3}(?:\D|$)/.test(cleaned)
			? cleaned.replace(/,/g, "")
			: cleaned.replace(",", ".");
	} else if (hasDot) {
		normalized = /\.\d{3}(?:\D|$)/.test(cleaned)
			? cleaned.replace(/\./g, "")
			: cleaned;
	}
	const parsed = Number.parseFloat(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every figure and date a sentence asserts. Citation markers (`[3]`) and the
 * confidence key are stripped first so they are never treated as figures.
 */
export function extractFigures(sentence: string): ExtractedFigure[] {
	const text = sentence
		.replace(/\[(?:\d{1,3}|calc:[A-Za-z0-9_-]+|inferred)\]/g, " ")
		.replace(/[ᶜˢⁱ]/g, " ");
	const figures: ExtractedFigure[] = [];
	const claimedRanges: Array<[number, number]> = [];
	const dateRanges: Array<[number, number]> = [];
	// Overlap is tested across the WHOLE match, not just its first character:
	// the figure pattern may start one character early on an optional leading
	// space, which would otherwise let it re-extract digits inside a claimed
	// date or model number ("13 934" out of "XPS 13 9343").
	const overlaps = (
		start: number,
		length: number,
		ranges: ReadonlyArray<[number, number]> = claimedRanges,
	): boolean =>
		ranges.some(([from, to]) => start < to && start + length > from);

	const claim = (
		start: number,
		matched: string,
		kind: ExtractedFigureKind,
	): void => {
		claimedRanges.push([start, start + matched.length]);
		if (kind === "date") dateRanges.push([start, start + matched.length]);
		figures.push({
			raw: matched,
			value: null,
			unit: "",
			isDate: kind === "date",
			kind,
			text: matched,
		});
	};

	for (const match of text.matchAll(ISO_DATE_PATTERN)) {
		claim(match.index ?? 0, match[0], "date");
	}
	for (const pattern of DATE_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const start = match.index ?? 0;
			if (overlaps(start, match[0].length)) continue;
			claim(start, match[0], "date");
		}
	}
	for (const pattern of VERSION_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const start = match.index ?? 0;
			if (overlaps(start, match[0].length)) continue;
			// A unit written against its number ("8GW", "3.5%") is a quantity, not
			// a version, and the scale words are handled by the figure pattern.
			const digitsAt = match[0].search(/\d/);
			const prefix = match[0].slice(0, digitsAt).toLowerCase();
			if (prefix in UNIT_ALIASES || prefix in SCALE_WORDS) continue;
			claim(start, match[0], "version");
		}
	}
	for (const match of text.matchAll(MODEL_NUMBER_RUN_PATTERN)) {
		const start = match.index ?? 0;
		if (overlaps(start, match[0].length)) continue;
		// "in 2024 1500 MW" is a year and a quantity, not a part number.
		if (isYearLike(match[1]) || isYearLike(match[2])) continue;
		const after = text.slice(
			start + match[0].length,
			start + match[0].length + 12,
		);
		if (new RegExp(`^\\s*(?:${UNIT_PATTERN})\\b`, "iu").test(after)) continue;
		claim(start, match[0], "version");
	}
	for (const match of text.matchAll(ORDINAL_PATTERN)) {
		const start = match.index ?? 0;
		if (overlaps(start, match[0].length)) continue;
		claim(start, match[0], "ordinal");
	}

	for (const match of text.matchAll(FIGURE_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (overlaps(start, match[0].length)) continue;
		const [, currency, digits, scaleWord, unitWord] = match;
		if (!digits) continue;
		const magnitude = parseWrittenNumber(digits);
		const scale = scaleWord ? SCALE_WORDS[scaleWord.toLowerCase()] : 1;
		const unit = unitWord
			? (UNIT_ALIASES[unitWord.toLowerCase()] ?? "")
			: currency
				? (UNIT_ALIASES[currency] ?? "")
				: "";
		claimedRanges.push([start, end]);
		const bareYear = !unit && !scaleWord && !currency && isYearLike(digits);
		figures.push({
			raw: digits,
			value: magnitude === null ? null : magnitude * (scale ?? 1),
			unit,
			isDate: bareYear,
			kind: bareYear ? "year" : "number",
			text: match[0].trim(),
		});
	}

	// A year the figure pattern never reached (inside punctuation it does not
	// span) still has to be recognised rather than left out entirely.
	for (const match of text.matchAll(YEAR_PATTERN)) {
		const year = match[0];
		const start = match.index ?? 0;
		if (overlaps(start, year.length, dateRanges)) continue;
		if (figures.some((figure) => figure.raw === year)) continue;
		if (overlaps(start, year.length)) continue;
		figures.push({
			raw: year,
			value: Number.parseInt(year, 10),
			unit: "",
			isDate: true,
			kind: "year",
			text: year,
		});
	}

	return figures;
}

function digitGroupVariants(value: number): string[] {
	const rounded = Number.isInteger(value) ? value.toString() : trimFloat(value);
	const variants = new Set<string>([rounded]);
	if (Number.isInteger(value) && Math.abs(value) >= 1000) {
		const grouped = Math.trunc(value)
			.toString()
			.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		variants.add(grouped);
		variants.add(grouped.replace(/,/g, "."));
		variants.add(grouped.replace(/,/g, " "));
		variants.add(grouped.replace(/,/g, "\u00a0"));
		variants.add(grouped.replace(/,/g, "\u202f"));
	}
	if (!Number.isInteger(value)) {
		const decimal = trimFloat(value);
		variants.add(decimal.replace(".", ","));
	}
	return [...variants];
}

function trimFloat(value: number): string {
	// Keep at most 6 significant decimals, then drop trailing zeros.
	return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Values expressed in every unit of the same ladder, e.g. GW -> MW, kW. */
function ladderEquivalents(
	value: number,
	unit: string,
): Array<{ value: number; unit: string }> {
	const ladder = UNIT_LADDERS.find((entry) => unit in entry);
	if (!ladder) return [{ value, unit }];
	const base = value * ladder[unit];
	return Object.entries(ladder)
		.map(([otherUnit, factor]) => ({ value: base / factor, unit: otherUnit }))
		.filter((entry) => Math.abs(entry.value) >= 0.001 && entry.value < 1e15);
}

/** Scale-word renderings, e.g. 8_000_000_000 -> "8 bn", "8 billion". */
function scaleRenderings(value: number): string[] {
	const renderings: string[] = [];
	for (const [word, multiplier] of Object.entries(SCALE_WORDS)) {
		if (multiplier < 1e3) continue;
		const scaled = value / multiplier;
		if (scaled < 0.1 || scaled >= 1000) continue;
		for (const digits of digitGroupVariants(roundTo(scaled, 3))) {
			renderings.push(`${digits} ${word}`);
			renderings.push(`${digits}${word}`);
		}
	}
	return renderings;
}

function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/**
 * Every surface form the figure could take in a source, as lowercase strings.
 * Exported for the unit tests, which assert the variant table directly.
 */
export function figureSurfaceForms(figure: ExtractedFigure): string[] {
	const forms = new Set<string>();
	const addWithUnits = (digits: string, unit: string): void => {
		forms.add(digits.toLowerCase());
		if (!unit) return;
		for (const surface of UNIT_SURFACE_FORMS.get(unit) ?? []) {
			forms.add(`${digits}${surface}`.toLowerCase());
			forms.add(`${digits} ${surface}`.toLowerCase());
			forms.add(`${surface}${digits}`.toLowerCase());
			forms.add(`${surface} ${digits}`.toLowerCase());
		}
	};

	forms.add(figure.raw.toLowerCase());
	if (figure.value === null) return [...forms];

	if (figure.isDate) {
		forms.add(String(figure.value));
		return [...forms];
	}

	for (const equivalent of ladderEquivalents(figure.value, figure.unit)) {
		for (const digits of digitGroupVariants(roundTo(equivalent.value, 6))) {
			addWithUnits(digits, equivalent.unit);
		}
	}
	for (const rendering of scaleRenderings(figure.value)) {
		forms.add(rendering.toLowerCase());
		for (const surface of UNIT_SURFACE_FORMS.get(figure.unit) ?? []) {
			forms.add(`${rendering} ${surface}`.toLowerCase());
		}
	}
	return [...forms];
}

function normalizeHaystack(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\u00a0\u202f]/g, " ")
		.replace(/\s+/g, " ");
}

/**
 * True when `sourceText` states the figure, in any equivalent surface form.
 *
 * Matching is substring-based on a whitespace-normalised haystack, with digit
 * boundaries enforced so "8 GW" does not match "18 GW" and "3.5" does not
 * match "13.55".
 */
export function figureAppearsInText(
	figure: ExtractedFigure,
	sourceText: string,
): boolean {
	const haystack = normalizeHaystack(sourceText);
	if (!haystack) return false;
	for (const form of figureSurfaceForms(figure)) {
		const needle = normalizeHaystack(form);
		if (!needle) continue;
		if (containsWithDigitBoundaries(haystack, needle)) return true;
	}
	return false;
}

function containsWithDigitBoundaries(
	haystack: string,
	needle: string,
): boolean {
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) return false;
		const before = index > 0 ? haystack[index - 1] : "";
		const after = haystack[index + needle.length] ?? "";
		const startsWithDigit = /\d/.test(needle[0] ?? "");
		const endsWithDigit = /\d/.test(needle[needle.length - 1] ?? "");
		const leftOk = !startsWithDigit || !/[\d.,]/.test(before);
		const rightOk = !endsWithDigit || !/[\d]/.test(after);
		if (leftOk && rightOk) return true;
		from = index + 1;
	}
}

export interface FigureMismatch {
	figure: ExtractedFigure;
	/** Human-readable mismatch handed back to the writer verbatim. */
	detail: string;
}

/**
 * Checks every figure in a sentence against the text of one cited source.
 * Returns the figures the source does NOT state.
 */
export function findUnsupportedFigures(input: {
	sentence: string;
	sourceText: string;
	sourceNumber: number;
}): FigureMismatch[] {
	return extractFigures(input.sentence)
		.filter(isCheckableFigure)
		.filter((figure) => !figureAppearsInText(figure, input.sourceText))
		.map((figure) => {
			const closest = closestFigureInText(figure, input.sourceText);
			return {
				figure,
				detail: closest
					? `"${figure.text}" does not appear in source [${input.sourceNumber}]; the closest figure it states is "${closest.text}"`
					: `"${figure.text}" does not appear in source [${input.sourceNumber}] in any unit or format variant`,
			};
		});
}

/**
 * The comparable figure in `sourceText` nearest to `figure`, so the rewrite
 * prompt can say what the source DOES state instead of only that the writer's
 * number is absent. Comparable means the same unit family; a bare number
 * compares only against other bare numbers.
 */
export function closestFigureInText(
	figure: ExtractedFigure,
	sourceText: string,
): ExtractedFigure | null {
	if (figure.value === null || !isCheckableFigure(figure)) return null;
	const ladder = UNIT_LADDERS.find((entry) => figure.unit in entry);
	const toBase = (value: number, unit: string): number | null => {
		if (!ladder) return unit === figure.unit ? value : null;
		const factor = ladder[unit];
		return factor === undefined ? null : value * factor;
	};
	const target = toBase(figure.value, figure.unit);
	if (target === null) return null;
	let best: { figure: ExtractedFigure; distance: number } | null = null;
	for (const candidate of extractFigures(sourceText)) {
		if (candidate.value === null || !isCheckableFigure(candidate)) continue;
		const candidateBase = toBase(candidate.value, candidate.unit);
		if (candidateBase === null) continue;
		const distance = Math.abs(candidateBase - target);
		if (!best || distance < best.distance) {
			best = { figure: candidate, distance };
		}
	}
	return best?.figure ?? null;
}

/**
 * Numbers in `sourceText` that carry the same unit as `figure` but a different
 * magnitude beyond `tolerance` (relative). Used for contradiction detection.
 */
export function competingFigures(
	figure: ExtractedFigure,
	sourceText: string,
	tolerance = 0.02,
): ExtractedFigure[] {
	if (figure.value === null || !isCheckableFigure(figure)) return [];
	const ladder = UNIT_LADDERS.find((entry) => figure.unit in entry);
	const toBase = (value: number, unit: string): number | null => {
		if (!ladder) return unit === figure.unit ? value : null;
		const factor = ladder[unit];
		return factor === undefined ? null : value * factor;
	};
	const target = toBase(figure.value, figure.unit);
	if (target === null || target === 0) return [];
	return extractFigures(sourceText).filter((candidate) => {
		if (candidate.value === null || !isCheckableFigure(candidate)) return false;
		const candidateBase = toBase(candidate.value, candidate.unit);
		if (candidateBase === null) return false;
		return Math.abs(candidateBase - target) / Math.abs(target) > tolerance;
	});
}
