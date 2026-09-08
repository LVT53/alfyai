// Atlas v2 stage 2: bounded research rounds (ADR 0062, keeping ADR 0037's
// bounded-rounds decision). One research_web call per question, fanned out at
// the existing Atlas search concurrency, then a coverage check between rounds.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import type { AtlasV2ResearchWebRunner } from "./research-web-adapter";
import type {
	AtlasV2CoverageReview,
	AtlasV2Plan,
	AtlasV2PlanQuestion,
	AtlasV2RawSource,
	AtlasV2ResearchQuestionOutcome,
	AtlasV2ResearchRoundResult,
} from "./types";

const MAX_SEARCH_QUERIES_PER_QUESTION = 5;

/**
 * Short keyword queries for one question. Parallel takes the question itself
 * as the objective, so these are angles rather than restatements: the bare
 * question minus its interrogative, plus the follow-ups the coverage check
 * proposed for it.
 */
export function buildQuestionSearchQueries(input: {
	question: string;
	extraQueries?: string[];
	limit: number;
}): string[] {
	const base = input.question
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\?+$/u, "")
		.replace(
			/^(what|which|who|when|where|why|how|is|are|does|do|did|mi|mik|milyen|kik|mikor|hol|miért|hogyan|wat|welke|wie|wanneer|waar|waarom|hoe)\s+(is|are|was|were|the|a|an)?\s*/iu,
			"",
		)
		.trim();
	const candidates = [
		base || input.question,
		...(input.extraQueries ?? []),
	].map((query) => query.replace(/\s+/g, " ").trim());
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate.toLowerCase();
		if (unique.some((entry) => entry.toLowerCase() === key)) continue;
		unique.push(candidate);
		if (
			unique.length >= Math.min(input.limit, MAX_SEARCH_QUERIES_PER_QUESTION)
		) {
			break;
		}
	}
	return unique;
}

/**
 * The extra query appended on the exhaustive profile's last round: it asks the
 * index for figures that DISAGREE with what earlier rounds found, so the
 * verifier's contradiction check has something to compare against.
 */
export function contradictionHuntQuery(
	question: string,
	language: SupportedLanguage,
): string {
	const subject = question.replace(/\?+$/u, "").trim();
	return language === "hu"
		? `${subject} eltérő adatok vitatott számok kritika`
		: `${subject} conflicting figures disputed revised estimate`;
}

/** Runs `tasks` with at most `limit` in flight, preserving input order. */
export async function mapWithConcurrency<TInput, TOutput>(
	items: readonly TInput[],
	limit: number,
	run: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
	const results = new Array<TOutput>(items.length);
	let cursor = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) return;
				results[index] = await run(items[index], index);
			}
		}),
	);
	return results;
}

export interface RunAtlasV2ResearchRoundInput {
	round: number;
	questions: AtlasV2PlanQuestion[];
	researchWeb: AtlasV2ResearchWebRunner;
	readPages: number;
	queriesPerQuestion: number;
	concurrency: number;
	language: SupportedLanguage;
	/** Follow-up queries the coverage check proposed, keyed by question id. */
	followUpQueries?: Record<string, string[]>;
	/** Adds the contradiction-hunting query to every question this round. */
	huntContradictions?: boolean;
	/** Called after each question finishes, for progress heartbeats. */
	onQuestionDone?: (input: {
		questionId: string;
		rawSourceCount: number;
	}) => Promise<void> | void;
}

export async function runAtlasV2ResearchRound(
	input: RunAtlasV2ResearchRoundInput,
): Promise<AtlasV2ResearchRoundResult> {
	const perQuestion = await mapWithConcurrency(
		input.questions,
		input.concurrency,
		async (question) => {
			const extraQueries = [
				...(input.followUpQueries?.[question.id] ?? []),
				...(input.huntContradictions
					? [contradictionHuntQuery(question.question, input.language)]
					: []),
			];
			const searchQueries = buildQuestionSearchQueries({
				question: question.question,
				extraQueries,
				limit: input.queriesPerQuestion + extraQueries.length,
			});
			let rawSources: AtlasV2RawSource[] = [];
			let pagesRead = 0;
			let error: string | null = null;
			try {
				const result = await input.researchWeb({
					question: question.question,
					searchQueries,
					readPages: input.readPages,
				});
				pagesRead = result.pagesRead;
				rawSources = result.sources.map((source) => ({
					questionId: question.id,
					round: input.round,
					url: source.url,
					title: source.title,
					snippets: source.snippets,
					publishedAt: source.publishedAt,
					pageExcerpt: source.pageExcerpt,
				}));
			} catch (thrown) {
				// One question's search failing must not lose the whole round; the
				// coverage check will see the question as thin and retry it.
				error =
					thrown instanceof Error ? thrown.message : "research_web failed";
			}
			await input.onQuestionDone?.({
				questionId: question.id,
				rawSourceCount: rawSources.length,
			});
			const outcome: AtlasV2ResearchQuestionOutcome = {
				questionId: question.id,
				queries: searchQueries,
				rawSourceCount: rawSources.length,
				pagesRead,
				error,
			};
			return { rawSources, outcome };
		},
	);

	return {
		round: input.round,
		rawSources: perQuestion.flatMap((entry) => entry.rawSources),
		outcomes: perQuestion.map((entry) => entry.outcome),
	};
}

// ---------------------------------------------------------------------------
// Coverage check (one control-model call between rounds)
// ---------------------------------------------------------------------------

export const ATLAS_V2_COVERAGE_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You review research coverage. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"thin":[{"id":"q3","queries":["...","..."]}],"sufficient":false}',
		"List a question in `thin` ONLY when the evidence shown for it cannot support a cited factual claim — no figure, no date, no named position, or only vendor marketing.",
		"For each thin question give 1-2 SHORT keyword queries that would find the missing evidence. No site: operators. No years unless the question is historical.",
		'Set "sufficient" to true when nothing is thin.',
	].join("\n"),
	hu: [
		"Kutatási lefedettséget vizsgálsz. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"thin":[{"id":"q3","queries":["...","..."]}],"sufficient":false}',
		"Csak akkor sorolj egy kérdést a `thin` közé, ha a bemutatott bizonyíték nem tud alátámasztani hivatkozott tényállítást — nincs szám, dátum, megnevezett álláspont, vagy csak gyártói marketing van.",
		"Minden gyenge kérdéshez adj 1-2 RÖVID kulcsszavas keresést, ami megtalálná a hiányzó bizonyítékot. Ne használj site: operátort. Évszámot csak történeti kérdésnél.",
		'A "sufficient" akkor true, ha semmi sem gyenge.',
	].join("\n"),
};

export interface BuildAtlasV2CoveragePromptInput {
	plan: AtlasV2Plan;
	/** Per question: how many sources, and a couple of their excerpts. */
	evidenceByQuestion: Array<{
		id: string;
		question: string;
		sourceCount: number;
		excerpts: string[];
	}>;
	round: number;
	roundsRemaining: number;
	language: SupportedLanguage;
}

export function buildAtlasV2CoveragePrompt(
	input: BuildAtlasV2CoveragePromptInput,
): string {
	return JSON.stringify({
		task: "review_coverage",
		round: input.round,
		roundsRemaining: input.roundsRemaining,
		language: input.language,
		questions: input.evidenceByQuestion.map((entry) => ({
			id: entry.id,
			question: entry.question,
			sourceCount: entry.sourceCount,
			excerpts: entry.excerpts,
		})),
	});
}

export function parseAtlasV2CoverageReview(
	text: string,
	knownQuestionIds: readonly string[],
): AtlasV2CoverageReview {
	const parsed = parseJsonFromText(text);
	const empty: AtlasV2CoverageReview = {
		thinQuestionIds: [],
		followUpQueries: [],
		sufficient: true,
	};
	if (!parsed || typeof parsed !== "object") return empty;
	const record = parsed as { thin?: unknown; sufficient?: unknown };
	const thinEntries = Array.isArray(record.thin) ? record.thin : [];
	const thinQuestionIds: string[] = [];
	const followUpQueries: AtlasV2CoverageReview["followUpQueries"] = [];
	for (const entry of thinEntries) {
		if (!entry || typeof entry !== "object") continue;
		const thinRecord = entry as { id?: unknown; queries?: unknown };
		const id = typeof thinRecord.id === "string" ? thinRecord.id.trim() : "";
		if (!id || !knownQuestionIds.includes(id)) continue;
		if (thinQuestionIds.includes(id)) continue;
		thinQuestionIds.push(id);
		const queries = Array.isArray(thinRecord.queries)
			? thinRecord.queries
					.map((query) =>
						typeof query === "string"
							? query.replace(/\s+/g, " ").trim().slice(0, 160)
							: "",
					)
					.filter(Boolean)
					.slice(0, 2)
			: [];
		if (queries.length > 0) followUpQueries.push({ questionId: id, queries });
	}
	return {
		thinQuestionIds,
		followUpQueries,
		sufficient:
			thinQuestionIds.length === 0 &&
			(record.sufficient === undefined || record.sufficient === true),
	};
}

/**
 * Questions with no usable evidence at all. Deterministic, so a round is never
 * declared sufficient while a question is empty regardless of what the
 * coverage model said.
 */
export function deterministicallyThinQuestionIds(
	byQuestion: Record<string, number[]>,
	questions: readonly AtlasV2PlanQuestion[],
	minimumSources = 2,
): string[] {
	return questions
		.filter(
			(question) => (byQuestion[question.id]?.length ?? 0) < minimumSources,
		)
		.map((question) => question.id);
}
