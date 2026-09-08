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
		'Shape: {"questions":["..."],"sections":[{"title":"...","brief":"...","questions":[1,2]}]}',
		"Each question must be answerable from public web sources and must ask for something checkable — a figure, a date, a named policy, a specification, a documented position.",
		"Do not ask compound questions; split them.",
		"Each section's `questions` lists the 1-based indexes of the questions it will be written from. Every question must belong to at least one section.",
		"Sections are a flat list, in reading order. Do not add an executive summary, a conclusion, a limitations or a sources section — those are produced automatically.",
	].join("\n"),
	hu: [
		"Kutatási jelentést tervezel. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"questions":["..."],"sections":[{"title":"...","brief":"...","questions":[1,2]}]}',
		"Minden kérdés legyen nyilvános webes forrásokból megválaszolható, és kérdezzen valami ellenőrizhetőt — számot, dátumot, megnevezett szabályozást, specifikációt, dokumentált álláspontot.",
		"Ne tegyél fel összetett kérdéseket; bontsd szét őket.",
		"Minden szakasz `questions` mezője az őt megalapozó kérdések 1-alapú indexeit tartalmazza. Minden kérdés legalább egy szakaszhoz tartozzon.",
		"A szakaszok lapos lista, olvasási sorrendben. Ne adj hozzá vezetői összefoglalót, konklúziót, korlátok vagy források szakaszt — azok automatikusan készülnek.",
	].join("\n"),
};

export interface BuildAtlasV2PlanPromptInput {
	query: string;
	profile: AtlasProfile;
	questionCount: number;
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
	return JSON.stringify({
		task: "plan_research",
		request: input.query,
		profile: input.profile,
		targetQuestionCount: input.questionCount,
		targetSectionCount: Math.max(
			ATLAS_V2_MIN_SECTIONS,
			Math.min(ATLAS_V2_MAX_SECTIONS, Math.ceil(input.questionCount / 2)),
		),
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
 * Parses the plan stage's output. Returns null when the model produced
 * nothing usable, which the pipeline turns into a deterministic fallback plan
 * rather than a failed job.
 */
export function parseAtlasV2Plan(
	text: string,
	options: { questionCount: number },
): AtlasV2Plan | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as { questions?: unknown; sections?: unknown };

	const questionTexts = Array.isArray(record.questions)
		? record.questions
				.map((entry) =>
					typeof entry === "string"
						? cleanLine(entry, 240)
						: cleanLine((entry as { question?: unknown })?.question, 240),
				)
				.filter((entry): entry is string => Boolean(entry))
		: [];
	const uniqueQuestions = [...new Set(questionTexts)].slice(
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
		.slice(0, ATLAS_V2_MAX_SECTIONS);

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

	return { questions, sections: usableSections };
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
		Math.min(angles.length, input.questionCount),
	);
	const questions = angles.slice(0, count).map((question, index) => ({
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
	};
}
