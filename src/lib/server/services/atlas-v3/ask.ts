// Atlas v3 stage 1: understand the ask (ADR 0063).
//
// One control-model call, thinking off, tight cap, flat JSON. It restates the
// request as the DECISION the reader faces, names the requirements the user did
// not spell out, enumerates the perspectives the report must not collapse, and
// picks the report's shape — which is what later decides whether the answer
// table is a comparison matrix, a timeline or a figure table.
//
// Implicit reasoning and unstated requirements cause roughly half of the rubric
// failures measured in commercial deep-research products, and v2 had no stage
// that even represented them.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { ATLAS_V3_SHAPES, type AtlasV3Ask, type AtlasV3Shape } from "./types";

export const ATLAS_V3_MAX_TITLE_CHARS = 70;
const MAX_LIST_ITEMS = 6;
const MAX_ITEM_CHARS = 200;
const MAX_SUB_QUESTIONS = 8;

export const ATLAS_V3_ASK_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You restate a research request as a decision. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"decision":"...","coreQuestion":"...","title":"...","shape":"comparison|explanation|forecast|timeline|mixed","implicitRequirements":["..."],"perspectives":["..."],"subQuestions":["..."]}',
		"`decision` is what the reader will DO with the answer, in one sentence.",
		"`coreQuestion` is the single question the report's first paragraph must answer. Keep the user's own numbers, names and dates.",
		"`title` is at most 70 characters and names the subject, not the task. No colon-and-subtitle.",
		"`shape`: comparison when options are ranked; timeline when the answer is a sequence of dated events; forecast when it is about a future value; explanation when it is about a mechanism or cause; mixed only when two of those genuinely apply.",
		"`implicitRequirements` are things the user expects but did not say — a currency, a jurisdiction, a date range, a budget, an availability constraint. 2 to 5 items. Never restate the question.",
		"`perspectives` are the stakeholders whose view of the answer differs — buyer and manufacturer, regulator and operator, patient and payer. 2 to 4 items.",
		"`subQuestions` are 3 to 6 research questions that, answered, answer the core question. Each must be answerable from a published source. No question about opinion or preference.",
	].join("\n"),
	hu: [
		"Egy kutatási kérést fogalmazol újra döntésként. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"decision":"...","coreQuestion":"...","title":"...","shape":"comparison|explanation|forecast|timeline|mixed","implicitRequirements":["..."],"perspectives":["..."],"subQuestions":["..."]}',
		"A `decision` egy mondatban mondja meg, mit fog KEZDENI az olvasó a válasszal.",
		"A `coreQuestion` az az egyetlen kérdés, amelyre a jelentés első bekezdésének válaszolnia kell. Tartsd meg a felhasználó saját számait, neveit és dátumait.",
		"A `title` legfeljebb 70 karakter, a tárgyat nevezi meg, nem a feladatot. Ne legyen kettőspontos alcím.",
		"A `shape`: comparison, ha lehetőségeket rangsorol; timeline, ha dátumozott események sora a válasz; forecast, ha jövőbeli értékről szól; explanation, ha mechanizmusról vagy okról; mixed csak akkor, ha kettő valóban érvényes.",
		"Az `implicitRequirements` olyan elvárások, amelyeket a felhasználó nem mondott ki — pénznem, joghatóság, időszak, keret, elérhetőség. 2-5 elem. Ne ismételd meg a kérdést.",
		"A `perspectives` azok az érintettek, akiknek más a nézőpontja — vevő és gyártó, szabályozó és üzemeltető, beteg és finanszírozó. 2-4 elem.",
		"A `subQuestions` 3-6 kutatási kérdés, amelyek megválaszolva megválaszolják a fő kérdést. Mindegyik publikált forrásból megválaszolható legyen. Vélemény vagy ízlés nem kérdés.",
	].join("\n"),
};

export interface BuildAtlasV3AskPromptInput {
	query: string;
	profile: string;
	language: SupportedLanguage;
	currentDate: string;
	/** A Revise action's instruction, carried so the ask reflects it. */
	reviseInstruction?: string | null;
	/** Native primary sources for the jurisdictions the request mentions. */
	preferredSources?: readonly string[];
}

export function buildAtlasV3AskPrompt(
	input: BuildAtlasV3AskPromptInput,
): string {
	return JSON.stringify({
		task: "understand_the_ask",
		request: input.query,
		profile: input.profile,
		language: input.language,
		currentDate: input.currentDate,
		...(input.reviseInstruction
			? { reviseInstruction: input.reviseInstruction }
			: {}),
		...(input.preferredSources && input.preferredSources.length > 0
			? { preferredPrimarySources: [...input.preferredSources] }
			: {}),
	});
}

function cleanItem(value: unknown, maxChars = MAX_ITEM_CHARS): string {
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, maxChars)
		: "";
}

function cleanList(value: unknown, limit = MAX_LIST_ITEMS): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		const cleaned = cleanItem(entry);
		if (!cleaned) continue;
		if (items.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
			continue;
		}
		items.push(cleaned);
		if (items.length >= limit) break;
	}
	return items;
}

function parseShape(value: unknown): AtlasV3Shape | null {
	return typeof value === "string" &&
		(ATLAS_V3_SHAPES as readonly string[]).includes(value)
		? (value as AtlasV3Shape)
		: null;
}

/**
 * Parses the ask. Returns null when the answer carries no core question at all;
 * the pipeline then falls back to the deterministic ask below rather than
 * spending a retry on a stage worth under a thousand tokens.
 */
export function parseAtlasV3Ask(
	text: string,
	fallback: { query: string; language: SupportedLanguage },
): AtlasV3Ask | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const coreQuestion =
		cleanItem(record.coreQuestion, 240) || cleanItem(record.decision, 240);
	if (!coreQuestion) return null;
	const subQuestions = cleanList(record.subQuestions, MAX_SUB_QUESTIONS);
	return {
		decision: cleanItem(record.decision, 240) || coreQuestion,
		coreQuestion,
		title:
			cleanItem(record.title, ATLAS_V3_MAX_TITLE_CHARS) ||
			deterministicAtlasV3Title(fallback.query),
		shape: parseShape(record.shape) ?? inferAtlasV3Shape(fallback),
		implicitRequirements: cleanList(record.implicitRequirements),
		perspectives: cleanList(record.perspectives, 4),
		subQuestions:
			subQuestions.length > 0
				? subQuestions
				: deterministicSubQuestions(fallback),
	};
}

/**
 * The deterministic ask. Used when the model answer does not parse, so a job
 * never fails at its cheapest stage; the shape is guessed from the request's
 * own wording, which is worse than the model's answer and better than nothing.
 */
export function fallbackAtlasV3Ask(input: {
	query: string;
	language: SupportedLanguage;
}): AtlasV3Ask {
	const coreQuestion = input.query.replace(/\s+/g, " ").trim().slice(0, 240);
	return {
		decision: coreQuestion,
		coreQuestion,
		title: deterministicAtlasV3Title(input.query),
		shape: inferAtlasV3Shape(input),
		implicitRequirements: [],
		perspectives: [],
		subQuestions: deterministicSubQuestions(input),
	};
}

const SHAPE_CUES: Array<{ shape: AtlasV3Shape; patterns: RegExp[] }> = [
	{
		shape: "comparison",
		patterns: [
			/\b(vs\.?|versus|compare[ds]?|comparison|which\s+(one|is\s+better)|better\s+than|rank(ed|ing)?)\b/iu,
			/\b(összehasonlít|melyik\s+(a\s+)?jobb|szemben|rangsor)/iu,
		],
	},
	{
		shape: "timeline",
		patterns: [
			/\b(timeline|chronolog|history\s+of|what\s+happened|sequence\s+of\s+events)\b/iu,
			/\b(idővonal|kronológ|története|eseménysor)/iu,
		],
	},
	{
		shape: "forecast",
		patterns: [
			/\b(forecast|outlook|projection|will\s+\w+\s+(be|reach|rise|fall)|expected\s+in\s+20\d\d|by\s+20[3-9]\d)\b/iu,
			/\b(előrejelzés|kilátás|várható|mennyi\s+lesz)/iu,
		],
	},
];

/** The report's shape from the request's own wording. Deterministic. */
export function inferAtlasV3Shape(input: {
	query: string;
	language: SupportedLanguage;
}): AtlasV3Shape {
	const matched = SHAPE_CUES.filter((entry) =>
		entry.patterns.some((pattern) => pattern.test(input.query)),
	);
	if (matched.length === 1) return matched[0].shape;
	if (matched.length > 1) return "mixed";
	return "explanation";
}

/** Sub-questions when the model gave none: the request, then its parts. */
function deterministicSubQuestions(input: {
	query: string;
	language: SupportedLanguage;
}): string[] {
	const base = input.query.replace(/\s+/g, " ").trim();
	const clauses = base
		.split(/(?:[;?]|,\s+(?:and|és)\s+)/u)
		.map((clause) => clause.trim())
		.filter((clause) => clause.length > 12);
	const questions = [base, ...clauses];
	const unique: string[] = [];
	for (const question of questions) {
		const trimmed = question.slice(0, 240);
		if (unique.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) {
			continue;
		}
		unique.push(trimmed);
		if (unique.length >= 4) break;
	}
	return unique;
}

/**
 * A title from the request, cut at a word boundary. The job row's own title is
 * the request cut at 80 characters, which is what produced v1's "…and how does
 * that" titles.
 */
export function deterministicAtlasV3Title(
	query: string,
	maxChars = ATLAS_V3_MAX_TITLE_CHARS,
): string {
	const normalized = query
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?!]+$/u, "")
		.replace(/\.$/u, "")
		.trim();
	if (normalized.length <= maxChars) return normalized;
	const clause = normalized.slice(0, maxChars + 1);
	const separator = Math.max(
		clause.lastIndexOf(", "),
		clause.lastIndexOf("; "),
		clause.lastIndexOf(" — "),
	);
	if (separator > Math.floor(maxChars / 3)) return clause.slice(0, separator);
	const boundary = clause.lastIndexOf(" ");
	return (boundary > 0 ? clause.slice(0, boundary) : clause.slice(0, maxChars))
		.replace(/[\s,;:—-]+$/u, "")
		.trim();
}
