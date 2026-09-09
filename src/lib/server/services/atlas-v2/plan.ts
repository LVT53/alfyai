// Atlas v2 stage 1: plan (ADR 0062). One control-model call produces the
// research questions and the section outline. Everything downstream is keyed
// on the question ids this stage mints, so ids are assigned HERE and never
// taken from model output.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import type { AtlasProfile } from "../atlas/types";
import {
	ATLAS_V2_MAX_QUESTIONS,
	ATLAS_V2_MAX_SECTIONS,
	ATLAS_V2_MIN_QUESTIONS,
	ATLAS_V2_MIN_SECTIONS,
} from "./config";
import type { AtlasV2Plan, AtlasV2PlanQuestion } from "./types";

export const ATLAS_V2_PLAN_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You plan a research report. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"title":"...","questions":["..."],"sections":[{"title":"...","brief":"...","questions":[1,2]}]}',
		"`title` names the report in at most 70 characters. It is a title, not the request repeated and not a sentence: no question mark, no trailing conjunction, no ellipsis.",
		"QUESTION 1 IS THE USER'S REQUEST ITSELF, restated as one direct question and nothing else. Every other question supports it.",
		"Each question must be answerable from public web sources and must ask for something checkable — a figure, a date, a named policy, a specification, a documented position.",
		"Do not ask compound questions; split them.",
		"Each section's `questions` lists the 1-based indexes of the questions it will be written from. Every question must belong to at least one section.",
		"Sections are a flat list in reading order, ORDERED BY HOW DIRECTLY THEY ANSWER THE REQUEST: the section covering question 1 comes first, background and context come last. Do not add an executive summary, a conclusion, a limitations or a sources section — those are produced automatically.",
	].join("\n"),
	hu: [
		"Kutatási jelentést tervezel. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"title":"...","questions":["..."],"sections":[{"title":"...","brief":"...","questions":[1,2]}]}',
		"A `title` legfeljebb 70 karakteres jelentéscím. Cím, nem a kérdés megismétlése és nem mondat: ne legyen benne kérdőjel, lezáratlan kötőszó vagy három pont.",
		"AZ 1. KÉRDÉS MAGA A FELHASZNÁLÓ KÉRDÉSE, egyetlen közvetlen kérdésként megfogalmazva. Minden további kérdés ezt támogatja.",
		"Minden kérdés legyen nyilvános webes forrásokból megválaszolható, és kérdezzen valami ellenőrizhetőt — számot, dátumot, megnevezett szabályozást, specifikációt, dokumentált álláspontot.",
		"Ne tegyél fel összetett kérdéseket; bontsd szét őket.",
		"Minden szakasz `questions` mezője az őt megalapozó kérdések 1-alapú indexeit tartalmazza. Minden kérdés legalább egy szakaszhoz tartozzon.",
		"A szakaszok lapos lista olvasási sorrendben, ASZERINT RENDEZVE, MENNYIRE KÖZVETLENÜL VÁLASZOLNAK a kérdésre: az 1. kérdést tárgyaló szakasz az első, a háttér és a kontextus a végére kerül. Ne adj hozzá vezetői összefoglalót, konklúziót, korlátok vagy források szakaszt — azok automatikusan készülnek.",
	].join("\n"),
};

export interface BuildAtlasV2PlanPromptInput {
	query: string;
	profile: AtlasProfile;
	questionCount: number;
	/** Section band for the profile's length budget (see budget.ts). */
	minSections?: number;
	maxSections?: number;
	language: SupportedLanguage;
	currentDate: string;
	/** Questions carried over from a Continue/Revise/Fork parent. */
	seedQuestions?: string[];
	/** Section titles the parent report used, for lineage continuity. */
	seedSections?: string[];
	/** For Revise: what the user asked to change. */
	reviseInstruction?: string | null;
}

export function buildAtlasV2PlanPrompt(
	input: BuildAtlasV2PlanPromptInput,
): string {
	const minSections = Math.max(
		ATLAS_V2_MIN_SECTIONS,
		input.minSections ?? ATLAS_V2_MIN_SECTIONS,
	);
	const maxSections = Math.min(
		ATLAS_V2_MAX_SECTIONS,
		Math.max(minSections, input.maxSections ?? ATLAS_V2_MAX_SECTIONS),
	);
	return JSON.stringify({
		task: "plan_research",
		request: input.query,
		coreQuestion: coreQuestionFromQuery(input.query, input.language),
		profile: input.profile,
		targetQuestionCount: input.questionCount,
		targetSectionCount: Math.max(
			minSections,
			Math.min(maxSections, Math.ceil(input.questionCount / 2)),
		),
		minSectionCount: minSections,
		maxSectionCount: maxSections,
		language: input.language,
		currentDate: input.currentDate,
		...(input.seedQuestions?.length
			? { parentQuestions: input.seedQuestions }
			: {}),
		...(input.seedSections?.length
			? { parentSections: input.seedSections }
			: {}),
		...(input.reviseInstruction
			? { reviseInstruction: input.reviseInstruction }
			: {}),
	});
}

function cleanLine(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	return normalized.slice(0, maxLength);
}

function questionIndexes(value: unknown, questionCount: number): number[] {
	if (!Array.isArray(value)) return [];
	const indexes: number[] = [];
	for (const entry of value) {
		const parsed =
			typeof entry === "number"
				? entry
				: typeof entry === "string"
					? Number.parseInt(entry, 10)
					: Number.NaN;
		if (!Number.isFinite(parsed)) continue;
		const zeroBased = parsed - 1;
		if (zeroBased >= 0 && zeroBased < questionCount) {
			if (!indexes.includes(zeroBased)) indexes.push(zeroBased);
		}
	}
	return indexes;
}

/**
 * The user's request as a single question, for use as plan question 1. The
 * first live evaluation opened an EU-solar report with Germany as the leading
 * member state and never stated the additions figure the user asked for; the
 * core question exists so the research and the summary are both anchored to
 * what was actually asked.
 */
export function coreQuestionFromQuery(
	query: string,
	language: SupportedLanguage,
): string {
	const normalized = query.replace(/\s+/g, " ").trim().slice(0, 240);
	if (!normalized) return normalized;
	if (/[?？]$/.test(normalized)) return normalized;
	// An imperative request ("Give a timeline of ...") is already one question's
	// worth of instruction; adding a question mark would misread it.
	return INTERROGATIVE_PREFIX[language].test(normalized)
		? `${normalized}?`
		: normalized;
}

/** Words that make a request a question, per report language. */
const INTERROGATIVE_PREFIX: Record<SupportedLanguage, RegExp> = {
	en: /^(what|which|who|when|where|why|how|is|are|does|do|did|can|should)\b/i,
	hu: /^(mi|mik|milyen|mennyi|mekkora|kik|mikor|hol|miért|hogyan|hogy)\b/i,
};

/** True when two question texts say the same thing, modulo punctuation. */
function sameQuestion(left: string, right: string): boolean {
	const key = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	return key(left) === key(right);
}

/**
 * Parses the plan stage's output. Returns null when the model produced
 * nothing usable, which the pipeline turns into a deterministic fallback plan
 * rather than a failed job.
 *
 * Question 1 is ALWAYS the core question, whatever the model returned: the
 * pipeline keys the "does the summary answer the question" check on it.
 */
export function parseAtlasV2Plan(
	text: string,
	options: {
		questionCount: number;
		/** The request itself; becomes question 1. */
		coreQuestion?: string;
		minSections?: number;
		maxSections?: number;
	},
): AtlasV2Plan | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as {
		questions?: unknown;
		sections?: unknown;
		title?: unknown;
	};
	const maxSections = Math.min(
		ATLAS_V2_MAX_SECTIONS,
		Math.max(
			ATLAS_V2_MIN_SECTIONS,
			options.maxSections ?? ATLAS_V2_MAX_SECTIONS,
		),
	);

	const questionTexts = Array.isArray(record.questions)
		? record.questions
				.map((entry) =>
					typeof entry === "string"
						? cleanLine(entry, 240)
						: cleanLine((entry as { question?: unknown })?.question, 240),
				)
				.filter((entry): entry is string => Boolean(entry))
		: [];
	const core = options.coreQuestion
		? cleanLine(options.coreQuestion, 240)
		: null;
	const ordered = core
		? [core, ...questionTexts.filter((entry) => !sameQuestion(entry, core))]
		: questionTexts;
	const uniqueQuestions = [...new Set(ordered)].slice(
		0,
		Math.max(
			ATLAS_V2_MIN_QUESTIONS,
			Math.min(ATLAS_V2_MAX_QUESTIONS, options.questionCount),
		),
	);
	if (uniqueQuestions.length < ATLAS_V2_MIN_QUESTIONS) return null;

	const questions: AtlasV2PlanQuestion[] = uniqueQuestions.map(
		(question, index) => ({ id: `q${index + 1}`, question }),
	);

	const rawSections = Array.isArray(record.sections) ? record.sections : [];
	const sections = rawSections
		.map((entry, index) => {
			if (!entry || typeof entry !== "object") return null;
			const sectionRecord = entry as {
				title?: unknown;
				brief?: unknown;
				questions?: unknown;
			};
			const title = cleanLine(sectionRecord.title, 120);
			if (!title) return null;
			const indexes = questionIndexes(
				sectionRecord.questions,
				questions.length,
			);
			return {
				id: `s${index + 1}`,
				title,
				brief: cleanLine(sectionRecord.brief, 400) ?? title,
				questionIds: indexes.map(
					(questionIndex) => questions[questionIndex].id,
				),
			};
		})
		.filter((section): section is NonNullable<typeof section> =>
			Boolean(section),
		)
		.slice(0, maxSections);

	if (sections.length < ATLAS_V2_MIN_SECTIONS) return null;

	// Every question must be written about somewhere, or its research is wasted.
	const covered = new Set(sections.flatMap((section) => section.questionIds));
	for (const question of questions) {
		if (covered.has(question.id)) continue;
		const smallest = sections.reduce((least, section) =>
			section.questionIds.length < least.questionIds.length ? section : least,
		);
		smallest.questionIds.push(question.id);
	}
	// A section with no questions has no evidence and would be written blind.
	const usableSections = sections.filter(
		(section) => section.questionIds.length > 0,
	);
	if (usableSections.length < ATLAS_V2_MIN_SECTIONS) return null;

	return {
		questions,
		sections: orderSectionsByRelevance(usableSections, questions),
		title: normalizeAtlasV2PlanTitle(record.title),
	};
}

/**
 * Reading order by how directly a section answers the request: a section is
 * ranked by the LOWEST question index it is written from, and question 1 is
 * the core question. Ties keep the model's own order, so this only ever moves
 * a section that buried the answer behind context.
 */
export function orderSectionsByRelevance<
	TSection extends { questionIds: string[] },
>(sections: TSection[], questions: AtlasV2PlanQuestion[]): TSection[] {
	const rankById = new Map(
		questions.map((question, index) => [question.id, index]),
	);
	return sections
		.map((section, position) => ({
			section,
			position,
			rank: Math.min(
				...section.questionIds.map(
					(questionId) => rankById.get(questionId) ?? questions.length,
				),
			),
		}))
		.sort((left, right) =>
			left.rank === right.rank
				? left.position - right.position
				: left.rank - right.rank,
		)
		.map((entry) => entry.section);
}

export const ATLAS_V2_MAX_TITLE_CHARS = 70;

/** Words a truncated title must not end on; see `deterministicAtlasV2Title`. */
const TITLE_TRAILING_WORDS = new Set([
	"and",
	"or",
	"but",
	"with",
	"without",
	"for",
	"from",
	"to",
	"of",
	"in",
	"on",
	"at",
	"by",
	"as",
	"the",
	"a",
	"an",
	"how",
	"what",
	"which",
	"that",
	"does",
	"do",
	"is",
	"are",
	"than",
	"then",
	"és",
	"vagy",
	"de",
	"a",
	"az",
	"hogy",
	"hogyan",
	"mint",
	"en",
	"of",
	"met",
	"voor",
	"van",
	"het",
	"de",
]);

/** Reads a model-proposed title, or null when it is not usable as one. */
export function normalizeAtlasV2PlanTitle(value: unknown): string | null {
	const cleaned = cleanLine(value, 200);
	if (!cleaned) return null;
	const stripped = cleaned
		.replace(/^#{1,6}\s+/, "")
		.replace(/^["'“”„]|["'“”„]$/g, "")
		.replace(/[?!]+$/, "")
		.replace(/\.{2,}$|…$/, "")
		.trim();
	if (stripped.length < 4) return null;
	if (/^(untitled|title|report|atlas report|jelentés)$/i.test(stripped)) {
		return null;
	}
	return stripped.length > ATLAS_V2_MAX_TITLE_CHARS
		? truncateTitleAtWordBoundary(stripped, ATLAS_V2_MAX_TITLE_CHARS)
		: stripped;
}

/**
 * The title when the model gave none. The first live evaluation titled reports
 * with the request truncated mid-clause ("... and how does that"), so this cuts
 * at a word boundary, drops a dangling function word, and adds NO ellipsis.
 */
export function deterministicAtlasV2Title(
	query: string,
	maxChars = ATLAS_V2_MAX_TITLE_CHARS,
): string {
	const normalized = query
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?!]+$/, "")
		.replace(/\.$/, "")
		.trim();
	if (normalized.length <= maxChars) return normalized;
	// Prefer cutting at the first clause boundary inside the budget: a request
	// with a comma usually states its subject before it.
	const clause = normalized.slice(0, maxChars + 1);
	const separator = Math.max(
		clause.lastIndexOf(", "),
		clause.lastIndexOf("; "),
		clause.lastIndexOf(" — "),
	);
	const candidate =
		separator > Math.floor(maxChars / 3)
			? clause.slice(0, separator)
			: truncateTitleAtWordBoundary(normalized, maxChars);
	return trimTrailingFunctionWords(candidate);
}

function truncateTitleAtWordBoundary(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const window = value.slice(0, maxChars + 1);
	const lastSpace = window.lastIndexOf(" ");
	const cut =
		lastSpace > 0 ? window.slice(0, lastSpace) : window.slice(0, maxChars);
	return trimTrailingFunctionWords(cut);
}

/**
 * A truncated title must not end mid-phrase. Two shapes are trimmed: a
 * trailing run of function words ("... add in 2025 and how does that"), and a
 * dangling determiner phrase, where a preposition and an article are followed
 * by a single word ("... prices of the leading"). A preposition with no article
 * after it is left alone, because "... XPS 13 for repairability" reads fine.
 */
function trimTrailingFunctionWords(value: string): string {
	let result = value.replace(/[\s,;:—–-]+$/, "");
	const danglingPhrase =
		/\s(?:of|in|for|with|from|to|on|at|by|about|between|across)\s+(?:the|a|an|its|their)\s+\S+$/i;
	const dangling = danglingPhrase.exec(result);
	if (dangling) result = result.slice(0, dangling.index);
	for (;;) {
		const match = /\s([\p{L}]+)$/u.exec(result);
		if (!match) break;
		if (!TITLE_TRAILING_WORDS.has(match[1].toLowerCase())) break;
		result = result.slice(0, match.index).replace(/[\s,;:—–-]+$/, "");
	}
	return result.replace(/[\s,;:—–-]+$/, "");
}

/**
 * The plan used when the model's output is unusable. Deterministic and
 * derived from the request itself, so a job never fails at stage 1.
 */
export function fallbackAtlasV2Plan(input: {
	query: string;
	questionCount: number;
	language: SupportedLanguage;
}): AtlasV2Plan {
	const subject = input.query.replace(/\s+/g, " ").trim().slice(0, 120);
	const angles =
		input.language === "hu"
			? [
					`Mi a jelenlegi helyzet: ${subject}?`,
					`Milyen számok és dátumok írják le: ${subject}?`,
					`Kik a fő szereplők és mi az álláspontjuk: ${subject}?`,
					`Milyen szabályozás vagy szabvány érinti: ${subject}?`,
					`Mik a fő kockázatok és ellentmondások: ${subject}?`,
					`Mi változott a legutóbbi 12 hónapban: ${subject}?`,
					`Milyen alternatívák vagy összehasonlítások léteznek: ${subject}?`,
					`Mi a következő 12 hónap várható alakulása: ${subject}?`,
				]
			: [
					`What is the current state of ${subject}?`,
					`Which figures and dates describe ${subject}?`,
					`Who are the main actors in ${subject} and what is their position?`,
					`Which rules, standards or policies govern ${subject}?`,
					`What are the main risks and disagreements about ${subject}?`,
					`What changed about ${subject} in the last 12 months?`,
					`What alternatives or comparisons exist for ${subject}?`,
					`What is expected of ${subject} over the next 12 months?`,
				];
	const count = Math.max(
		ATLAS_V2_MIN_QUESTIONS,
		Math.min(angles.length + 1, input.questionCount),
	);
	// The core question leads even in the fallback plan.
	const questions = [
		coreQuestionFromQuery(input.query, input.language),
		...angles,
	]
		.slice(0, count)
		.map((question, index) => ({
			id: `q${index + 1}`,
			question,
		}));
	const sectionTitles =
		input.language === "hu"
			? [
					"Jelenlegi helyzet",
					"Szereplők és szabályozás",
					"Kockázatok és kilátások",
				]
			: ["Current state", "Actors and rules", "Risks and outlook"];
	const perSection = Math.ceil(questions.length / sectionTitles.length);
	return {
		questions,
		sections: sectionTitles
			.map((title, index) => ({
				id: `s${index + 1}`,
				title,
				brief: title,
				questionIds: questions
					.slice(index * perSection, (index + 1) * perSection)
					.map((question) => question.id),
			}))
			.filter((section) => section.questionIds.length > 0),
		title: deterministicAtlasV2Title(input.query),
	};
}
