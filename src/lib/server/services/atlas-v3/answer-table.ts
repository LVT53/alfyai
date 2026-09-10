// Atlas v3 stage 6: the answer table (ADR 0063).
//
// Before any prose, the structured answer the question's SHAPE implies is
// assembled from the memo's claims, with an evidence id per cell — a comparison
// matrix whose rows are the reader's options, a timeline whose rows are dated
// events, or a plain figure table. Every delta, ratio and growth rate is
// computed through `run_python` from cited inputs; the model never does
// arithmetic.
//
// This inverts v2, where the writer was asked for prose and, in thirteen runs,
// produced four tables and zero computed figures — while announcing "the
// following sentences summarize model context sizes and prices in a compact
// table-like format".

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { extractFigures, isCheckableFigure } from "../atlas-v2/number-match";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import type { AtlasV3ModelCall } from "./model-call";
import type {
	AtlasV3AnswerCell,
	AtlasV3AnswerTable,
	AtlasV3Ask,
	AtlasV3Derived,
	AtlasV3EvidenceBank,
	AtlasV3Memo,
	AtlasV3Shape,
	AtlasV3Usage,
} from "./types";

export const ATLAS_V3_MAX_TABLE_ROWS = 12;
export const ATLAS_V3_MAX_TABLE_COLUMNS = 6;
export const ATLAS_V3_MAX_DERIVED = 6;

/** A Python expression may only be arithmetic over literals. */
const SAFE_EXPRESSION = /^[\d\s.,+\-*/()%eE]+$/;

export type AtlasV3CalculationRunner = (input: {
	expression: string;
}) => Promise<{ ok: boolean; value: string | null }>;

/** The table kind a report shape implies. */
export function atlasV3TableKindForShape(
	shape: AtlasV3Shape,
): AtlasV3AnswerTable["kind"] {
	if (shape === "comparison") return "comparison";
	if (shape === "timeline") return "timeline";
	return "figures";
}

export const ATLAS_V3_ANSWER_TABLE_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You assemble the structured answer to a research question from claims that are already verified. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"title":"...","columns":[{"key":"option","label":"Option"}],"rows":[{"option":{"text":"...","evidenceIds":["e1"]}}],"derived":[{"id":"k1","label":"Change 2024-2025","expression":"(65.1-65.6)/65.6*100","inputs":["e1","e4"]}]}',
		"For a COMPARISON the rows are the reader's OPTIONS and the columns are the criteria that separate them. For a TIMELINE the rows are dated events, earliest first, with a `date` column. Otherwise the rows are figures with their period and series.",
		'Every cell is {"text":"...","evidenceIds":[...]}. `text` is the value as its source states it. `evidenceIds` are quote ids that state it. A label cell — an option name, a row heading — may have an empty list; a cell carrying a FIGURE may not.',
		'Never invent a cell. If a criterion is unknown for one row, write "not published" with an empty evidence list rather than guessing.',
		"`derived` are the deltas, ratios, per-unit costs and growth rates the answer needs. `expression` is ONE arithmetic expression over NUMBERS ONLY — no names, no functions, no units. `inputs` are the quote ids the numbers came from. At most 6.",
		"Include a `series` or `asOf` column whenever two rows measure different things or come from different vintages.",
	].join("\n"),
	hu: [
		"Egy kutatási kérdés strukturált válaszát állítod össze már ellenőrzött állításokból. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"title":"...","columns":[{"key":"option","label":"Lehetőség"}],"rows":[{"option":{"text":"...","evidenceIds":["e1"]}}],"derived":[{"id":"k1","label":"Változás 2024-2025","expression":"(65.1-65.6)/65.6*100","inputs":["e1","e4"]}]}',
		"ÖSSZEHASONLÍTÁSNÁL a sorok az olvasó LEHETŐSÉGEI, az oszlopok a köztük döntő szempontok. IDŐVONALNÁL a sorok dátumozott események a legkorábbitól, `date` oszloppal. Egyébként a sorok számok az időszakukkal és adatsorukkal.",
		'Minden cella {"text":"...","evidenceIds":[...]}. A `text` az érték úgy, ahogy a forrás írja. Az `evidenceIds` az azt kimondó idézetazonosítók. Címkecella lehet üres listával; SZÁMOT hordozó cella nem.',
		"Ne találj ki cellát. Ha egy szempont egy sorra ismeretlen, írd azt, hogy „nincs közzétéve”, üres bizonyítéklistával.",
		"A `derived` a szükséges különbségek, arányok, egységárak és növekedési ütemek. Az `expression` EGYETLEN aritmetikai kifejezés CSAK SZÁMOKKAL — név, függvény és mértékegység nélkül. Az `inputs` azok az idézetazonosítók, ahonnan a számok jönnek. Legfeljebb 6.",
		"Tegyél `series` vagy `asOf` oszlopot, ha két sor mást mér vagy más évjáratú.",
	].join("\n"),
};

export interface BuildAtlasV3AnswerTablePromptInput {
	ask: AtlasV3Ask;
	memo: AtlasV3Memo;
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	currentDate: string;
}

export function buildAtlasV3AnswerTablePrompt(
	input: BuildAtlasV3AnswerTablePromptInput,
): string {
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);
	const claims = input.memo.claimIds
		.map((id) => claimsById.get(id))
		.filter((claim): claim is NonNullable<typeof claim> => Boolean(claim));
	const evidenceIds = new Set(claims.flatMap((claim) => claim.evidenceIds));
	return JSON.stringify({
		task: "assemble_answer_table",
		coreQuestion: input.ask.coreQuestion,
		decision: input.ask.decision,
		shape: input.ask.shape,
		kind: atlasV3TableKindForShape(input.ask.shape),
		language: input.language,
		currentDate: input.currentDate,
		answerSoFar: input.memo.answerSoFar,
		maxRows: ATLAS_V3_MAX_TABLE_ROWS,
		maxColumns: ATLAS_V3_MAX_TABLE_COLUMNS,
		claims: claims.map((claim) => ({
			id: claim.id,
			entity: claim.entity,
			metric: claim.metric,
			value: claim.value,
			unit: claim.unit,
			period: claim.period,
			asOf: claim.asOf,
			series: claim.series,
			status: claim.status,
			evidenceIds: claim.evidenceIds,
		})),
		quotes: input.bank.quotes
			.filter((quote) => evidenceIds.has(quote.id))
			.map((quote) => ({ id: quote.id, text: quote.text })),
	});
}

export function parseAtlasV3AnswerTable(
	text: string,
	input: {
		kind: AtlasV3AnswerTable["kind"];
		knownEvidenceIds: readonly string[];
	},
): AtlasV3AnswerTable | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.columns) || !Array.isArray(record.rows))
		return null;
	const known = new Set(input.knownEvidenceIds);

	const columns: AtlasV3AnswerTable["columns"] = [];
	for (const entry of record.columns) {
		if (!entry || typeof entry !== "object") continue;
		const column = entry as Record<string, unknown>;
		const key = clean(column.key, 40).replace(/\s+/g, "_");
		if (!key || columns.some((existing) => existing.key === key)) continue;
		columns.push({ key, label: clean(column.label, 60) || key });
		if (columns.length >= ATLAS_V3_MAX_TABLE_COLUMNS) break;
	}
	if (columns.length === 0) return null;

	const rows: AtlasV3AnswerTable["rows"] = [];
	for (const entry of record.rows) {
		if (!entry || typeof entry !== "object") continue;
		const source = entry as Record<string, unknown>;
		const row: Record<string, AtlasV3AnswerCell> = {};
		let hasText = false;
		for (const column of columns) {
			const cell = parseCell(source[column.key], known);
			row[column.key] = cell;
			if (cell.text) hasText = true;
		}
		if (!hasText) continue;
		rows.push(row);
		if (rows.length >= ATLAS_V3_MAX_TABLE_ROWS) break;
	}
	if (rows.length === 0) return null;

	const derived: AtlasV3Derived[] = [];
	if (Array.isArray(record.derived)) {
		for (const entry of record.derived) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			const expression = clean(item.expression, 200);
			// Arithmetic over literals ONLY. An expression naming a variable, a
			// function or a unit is not a calculation the sandbox can check, and an
			// unchecked figure is the thing this stage exists to prevent.
			if (!expression || !SAFE_EXPRESSION.test(expression)) continue;
			derived.push({
				id: clean(item.id, 12) || `k${derived.length + 1}`,
				label: clean(item.label, 120) || "derived figure",
				expression,
				inputs: Array.isArray(item.inputs)
					? item.inputs
							.filter(
								(id): id is string =>
									typeof id === "string" && known.has(id.trim()),
							)
							.map((id) => id.trim())
					: [],
				value: null,
			});
			if (derived.length >= ATLAS_V3_MAX_DERIVED) break;
		}
	}

	return {
		kind: input.kind,
		title: clean(record.title, 120) || "Answer",
		columns,
		rows,
		derived,
	};
}

function parseCell(value: unknown, known: Set<string>): AtlasV3AnswerCell {
	if (typeof value === "string" || typeof value === "number") {
		return { text: clean(value, 160), evidenceIds: [] };
	}
	if (!value || typeof value !== "object") return { text: "", evidenceIds: [] };
	const cell = value as Record<string, unknown>;
	const evidenceIds = Array.isArray(cell.evidenceIds)
		? cell.evidenceIds
				.filter(
					(id): id is string => typeof id === "string" && known.has(id.trim()),
				)
				.map((id) => id.trim())
				.slice(0, 3)
		: [];
	return { text: clean(cell.text, 160), evidenceIds };
}

function clean(value: unknown, maxChars: number): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value).slice(0, maxChars);
	}
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, maxChars)
		: "";
}

/**
 * Runs every derived expression through the sandbox. A calculation that does
 * not evaluate keeps `value: null`, and the writer may then not use it — the
 * rule that replaces v2's "an inferred sentence may not contain a figure".
 */
export async function computeAtlasV3Derived(input: {
	table: AtlasV3AnswerTable;
	runPython?: AtlasV3CalculationRunner;
}): Promise<AtlasV3AnswerTable> {
	if (!input.runPython || input.table.derived.length === 0) return input.table;
	const derived: AtlasV3Derived[] = [];
	for (const entry of input.table.derived) {
		let value: string | null = null;
		try {
			const result = await input.runPython({ expression: entry.expression });
			value = result.ok ? result.value : null;
		} catch {
			value = null;
		}
		derived.push({ ...entry, value: value ? roundForProse(value) : null });
	}
	return { ...input.table, derived };
}

/**
 * Python prints fifteen significant digits; a report quoting
 * "-0.7621951219512195%" is worse than one quoting "-0.76%". Three bands, so a
 * percentage reads as a percentage and a small ratio keeps its precision:
 * one decimal at 100 and above, two decimals down to 0.1, three significant
 * digits below that. Integers are left alone.
 */
export function roundForProse(value: string): string {
	const parsed = Number.parseFloat(value.trim());
	if (!Number.isFinite(parsed)) return value.trim().slice(0, 40);
	if (Number.isInteger(parsed)) return String(parsed);
	const magnitude = Math.abs(parsed);
	if (magnitude >= 100) return String(Number(parsed.toFixed(1)));
	if (magnitude >= 0.1) return String(Number(parsed.toFixed(2)));
	return String(Number(parsed.toPrecision(3)));
}

/**
 * The deterministic table: one row per claim the memo named, with the columns
 * the claim shape already has. Used when the model answer does not parse, so a
 * report never loses its structured answer to one bad draw.
 */
export function deterministicAtlasV3AnswerTable(input: {
	ask: AtlasV3Ask;
	memo: AtlasV3Memo;
	bank: AtlasV3EvidenceBank;
}): AtlasV3AnswerTable | null {
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);
	const claims = input.memo.claimIds
		.map((id) => claimsById.get(id))
		.filter((claim): claim is NonNullable<typeof claim> => Boolean(claim))
		.slice(0, ATLAS_V3_MAX_TABLE_ROWS);
	if (claims.length === 0) return null;
	const columns = [
		{ key: "subject", label: "Subject" },
		{ key: "value", label: "Value" },
		{ key: "period", label: "Period" },
		{ key: "series", label: "Series" },
	];
	return {
		kind: atlasV3TableKindForShape(input.ask.shape),
		title: input.ask.coreQuestion.slice(0, 120),
		columns,
		rows: claims.map((claim) => ({
			subject: {
				text: `${claim.entity} — ${claim.metric}`,
				evidenceIds: [],
			},
			value: {
				text: claim.unit ? `${claim.value} ${claim.unit}` : claim.value,
				evidenceIds: claim.evidenceIds.slice(0, 2),
			},
			period: { text: claim.period ?? "", evidenceIds: [] },
			series: { text: claim.series ?? "", evidenceIds: [] },
		})),
		derived: [],
	};
}

export interface BuildAtlasV3AnswerInput
	extends BuildAtlasV3AnswerTablePromptInput {
	runModel: AtlasV3ModelCall;
	runPython?: AtlasV3CalculationRunner;
	onUsage?: (usage: AtlasV3Usage) => void;
}

export async function buildAtlasV3Answer(
	input: BuildAtlasV3AnswerInput,
): Promise<AtlasV3AnswerTable | null> {
	const knownEvidenceIds = input.bank.quotes.map((quote) => quote.id);
	let table: AtlasV3AnswerTable | null = null;
	try {
		const call = await input.runModel({
			stage: "v3:answer",
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.answerTable,
			system: ATLAS_V3_ANSWER_TABLE_SYSTEM[input.language],
			prompt: buildAtlasV3AnswerTablePrompt(input),
		});
		input.onUsage?.(call.usage);
		table = parseAtlasV3AnswerTable(call.text, {
			kind: atlasV3TableKindForShape(input.ask.shape),
			knownEvidenceIds,
		});
	} catch {
		table = null;
	}
	const resolved =
		table ??
		deterministicAtlasV3AnswerTable({
			ask: input.ask,
			memo: input.memo,
			bank: input.bank,
		});
	if (!resolved) return null;
	return computeAtlasV3Derived({ table: resolved, runPython: input.runPython });
}

/** Every evidence id the table cites, in cell order. For the citation minting. */
export function atlasV3AnswerTableEvidenceIds(
	table: AtlasV3AnswerTable | null,
): string[] {
	if (!table) return [];
	const ids: string[] = [];
	for (const row of table.rows) {
		for (const column of table.columns) {
			for (const id of row[column.key]?.evidenceIds ?? []) {
				if (!ids.includes(id)) ids.push(id);
			}
		}
	}
	for (const entry of table.derived) {
		for (const id of entry.inputs) if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Cells carrying a FIGURE but no citation. A defect the critic must see.
 *
 * Two rules keep this off the label column, where "Framework 13" and "2025" are
 * row headings rather than measurements: the first column is a heading by
 * construction in every table kind this stage builds, and elsewhere the cell
 * must carry a figure v2's extractor calls checkable — which already knows a
 * model number, a version and a bare year from a quantity.
 */
export function atlasV3UncitedFigureCells(
	table: AtlasV3AnswerTable | null,
): Array<{ column: string; text: string }> {
	if (!table) return [];
	const uncited: Array<{ column: string; text: string }> = [];
	for (const row of table.rows) {
		for (const column of table.columns.slice(1)) {
			const cell = row[column.key];
			if (!cell?.text || cell.evidenceIds.length > 0) continue;
			const figures = extractFigures(cell.text).filter(isCheckableFigure);
			if (figures.length === 0) continue;
			uncited.push({ column: column.key, text: cell.text });
		}
	}
	return uncited;
}
