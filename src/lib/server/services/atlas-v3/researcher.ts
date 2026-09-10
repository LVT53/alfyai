// Atlas v3 stage 3a: one isolated researcher (ADR 0063).
//
// A researcher owns ONE sub-question in ONE context that nothing else sees. It
// plans its searches inside a visible budget, issues them in a single fan-out
// through the harness's `research_web` path, reads the best-tier pages FOR ITS
// GOAL, and returns a cleaned findings note: a short summary, the verbatim
// quotes it filed, the structured claims it extracted, what is still open, and
// what turned out to be a dead end.
//
// Two invariants make this the cheap-quality lever the literature says it is:
//
//   * the researcher's context never leaves this function — only the note does;
//   * page text never reaches the note prompt — only the quotes the read call
//     already extracted. The note is written from the bank, not from the web.

import type { SupportedLanguage } from "$lib/server/services/language";
import { canonicalizeGroundedWebUrl } from "$lib/server/services/web-grounding";
import { parseJsonFromText } from "../atlas/json-extract";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import {
	ATLAS_V3_READ_SYSTEM,
	type AtlasV3BankState,
	addAtlasV3Source,
	buildAtlasV3ReadPrompt,
	fileAtlasV3Read,
	parseAtlasV3Read,
} from "./evidence-bank";
import type { AtlasV3NativeSourceSet } from "./language-standard";
import {
	type AtlasV3BudgetBlock,
	type AtlasV3ModelCall,
	renderAtlasV3Budget,
} from "./model-call";
import type { AtlasV3ResearchWeb } from "./research-web-adapter";
import { selectAtlasV3PagesToRead } from "./source-tier";
import type { AtlasV3Claim, AtlasV3FindingsNote, AtlasV3Quote } from "./types";

/** Page characters one read call may see. The page itself goes no further. */
export const ATLAS_V3_MAX_PAGE_CHARS = 18_000;
/** Quotes the note prompt may carry. The note summarises, it does not copy. */
const MAX_NOTE_QUOTES = 20;

// ---------------------------------------------------------------------------
// Step 1: plan the searches, inside a visible budget
// ---------------------------------------------------------------------------

export const ATLAS_V3_SEARCH_PLAN_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You plan web searches for ONE research question. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"queries":["...","..."]}',
		"Give exactly the number of queries the budget allows. Each is SHORT keywords, not a sentence and not the question restated.",
		"Make the queries hit DIFFERENT angles: the figure itself, the publisher likely to hold it, the year or period, and the competing measurement if one exists.",
		"No site: operators. No quotes. Do not add a year unless the question is about a period.",
		"When `preferredPrimarySources` is given, spend at least one query naming one of them.",
	].join("\n"),
	hu: [
		"EGY kutatási kérdéshez tervezel webes kereséseket. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"queries":["...","..."]}',
		"Pontosan annyi keresést adj, amennyit a keret enged. Mindegyik RÖVID kulcsszavas, nem mondat és nem a kérdés újrafogalmazása.",
		"A keresések KÜLÖNBÖZŐ irányból közelítsenek: maga a szám, a valószínű közzétevő, az év vagy időszak, és a versengő mérés, ha van.",
		"Ne használj site: operátort és idézőjelet. Évszámot csak akkor, ha a kérdés időszakról szól.",
		"Ha kapsz `preferredPrimarySources` listát, legalább egy keresés nevezze meg valamelyiket.",
	].join("\n"),
};

export interface BuildAtlasV3SearchPlanPromptInput {
	subQuestion: string;
	coreQuestion: string;
	language: SupportedLanguage;
	currentDate: string;
	queryCount: number;
	budget: AtlasV3BudgetBlock;
	preferredSources?: readonly string[];
	/** Queries earlier rounds already spent on this question. */
	alreadyTried?: readonly string[];
	/** Things earlier rounds established are not findable. */
	deadEnds?: readonly string[];
}

export function buildAtlasV3SearchPlanPrompt(
	input: BuildAtlasV3SearchPlanPromptInput,
): string {
	return JSON.stringify({
		task: "plan_searches",
		question: input.subQuestion,
		coreQuestion: input.coreQuestion,
		language: input.language,
		currentDate: input.currentDate,
		queryCount: input.queryCount,
		budget: renderAtlasV3Budget(input.budget),
		...(input.preferredSources && input.preferredSources.length > 0
			? { preferredPrimarySources: [...input.preferredSources] }
			: {}),
		...(input.alreadyTried && input.alreadyTried.length > 0
			? { alreadyTried: [...input.alreadyTried] }
			: {}),
		...(input.deadEnds && input.deadEnds.length > 0
			? { deadEnds: [...input.deadEnds] }
			: {}),
	});
}

export function parseAtlasV3SearchPlan(
	text: string,
	limit: number,
): string[] | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const raw = (parsed as { queries?: unknown }).queries;
	if (!Array.isArray(raw)) return null;
	const queries: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const cleaned = entry.replace(/\s+/g, " ").trim().slice(0, 160);
		if (!cleaned) continue;
		if (
			queries.some((query) => query.toLowerCase() === cleaned.toLowerCase())
		) {
			continue;
		}
		queries.push(cleaned);
		if (queries.length >= limit) break;
	}
	return queries.length > 0 ? queries : null;
}

/**
 * The queries when the plan call gives nothing usable: the question with its
 * interrogative stripped, plus one query per preferred primary source.
 */
export function deterministicAtlasV3Queries(input: {
	subQuestion: string;
	preferredSources?: readonly string[];
	limit: number;
}): string[] {
	const base = input.subQuestion
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\?+$/u, "")
		.replace(
			/^(what|which|who|when|where|why|how|is|are|does|do|did|mi|mik|milyen|kik|mikor|hol|miért|hogyan)\s+(is|are|was|were|the|a|an)?\s*/iu,
			"",
		)
		.trim();
	const candidates = [
		base || input.subQuestion,
		...(input.preferredSources ?? []).map((source) => `${base} ${source}`),
	];
	const queries: string[] = [];
	for (const candidate of candidates) {
		const cleaned = candidate.replace(/\s+/g, " ").trim().slice(0, 160);
		if (!cleaned) continue;
		if (
			queries.some((query) => query.toLowerCase() === cleaned.toLowerCase())
		) {
			continue;
		}
		queries.push(cleaned);
		if (queries.length >= input.limit) break;
	}
	return queries;
}

// ---------------------------------------------------------------------------
// Step 3: the findings note, written from the bank
// ---------------------------------------------------------------------------

export const ATLAS_V3_NOTE_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You write a short research note from evidence that has ALREADY been extracted. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"summary":"...","openQuestions":["..."],"deadEnds":["..."]}',
		"`summary` answers the question in at most four sentences, using only the quotes and claims shown. Name the figure and the publisher. If the quotes disagree, say which measurement each one is, do not average them.",
		"If the evidence does not answer the question, say exactly that in `summary`. Never guess, never fill the gap from your own knowledge.",
		"`openQuestions` are what is still missing to answer the question, as searchable questions. 0 to 3 items.",
		"`deadEnds` are things this question CANNOT be answered from, with the reason — no published series, paywalled, only vendor marketing. 0 to 2 items. Never list something you did not try.",
	].join("\n"),
	hu: [
		"Rövid kutatási jegyzetet írsz MÁR KIVONATOLT bizonyítékból. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"summary":"...","openQuestions":["..."],"deadEnds":["..."]}',
		"A `summary` legfeljebb négy mondatban válaszol a kérdésre, kizárólag a bemutatott idézetek és állítások alapján. Nevezd meg a számot és a közzétevőt. Ha az idézetek eltérnek, mondd meg, melyik milyen mérés — ne átlagolj.",
		"Ha a bizonyíték nem válaszolja meg a kérdést, pontosan ezt írd a `summary`-be. Ne találgass, és ne pótold saját tudásból.",
		"Az `openQuestions` az, ami még hiányzik, kereshető kérdés formájában. 0-3 elem.",
		"A `deadEnds` az, amiből ez a kérdés NEM válaszolható meg, az okkal — nincs közzétett adatsor, fizetőfal, csak gyártói marketing. 0-2 elem. Ne sorolj olyat, amit nem próbáltál.",
	].join("\n"),
};

export interface BuildAtlasV3NotePromptInput {
	subQuestion: string;
	coreQuestion: string;
	language: SupportedLanguage;
	currentDate: string;
	quotes: Array<{
		id: string;
		text: string;
		publisher: string;
		tier: string;
		date: string | null;
	}>;
	claims: Array<{
		id: string;
		entity: string;
		metric: string;
		value: string;
		unit: string | null;
		period: string | null;
		series: string | null;
		status: string;
	}>;
	searchesSpent: number;
	pagesRead: number;
}

export function buildAtlasV3NotePrompt(
	input: BuildAtlasV3NotePromptInput,
): string {
	return JSON.stringify({
		task: "write_findings_note",
		question: input.subQuestion,
		coreQuestion: input.coreQuestion,
		language: input.language,
		currentDate: input.currentDate,
		spent: { searches: input.searchesSpent, pagesRead: input.pagesRead },
		quotes: input.quotes.slice(0, MAX_NOTE_QUOTES),
		claims: input.claims.slice(0, MAX_NOTE_QUOTES),
	});
}

export interface AtlasV3ParsedNote {
	summary: string;
	openQuestions: string[];
	deadEnds: string[];
}

export function parseAtlasV3Note(text: string): AtlasV3ParsedNote | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const summary =
		typeof record.summary === "string"
			? record.summary.replace(/\s+/g, " ").trim().slice(0, 900)
			: "";
	if (!summary) return null;
	return {
		summary,
		openQuestions: stringList(record.openQuestions, 3),
		deadEnds: stringList(record.deadEnds, 2),
	};
}

function stringList(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const cleaned = entry.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!cleaned) continue;
		if (items.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
			continue;
		}
		items.push(cleaned);
		if (items.length >= limit) break;
	}
	return items;
}

// ---------------------------------------------------------------------------
// The researcher itself
// ---------------------------------------------------------------------------

export interface RunAtlasV3ResearcherInput {
	subQuestion: string;
	coreQuestion: string;
	language: SupportedLanguage;
	currentDate: string;
	/** The shared bank. Quotes and claims are filed straight into it. */
	state: AtlasV3BankState;
	researchWeb: AtlasV3ResearchWeb;
	/** The researcher model: the search plan and the findings note. */
	runModel: AtlasV3ModelCall;
	/** The read-for-goal call; defaults to the researcher model. */
	runReadModel?: AtlasV3ModelCall;
	searchesPerStep: number;
	pagesToRead: number;
	budget: AtlasV3BudgetBlock;
	nativeSources?: readonly AtlasV3NativeSourceSet[];
	preferredSources?: readonly string[];
	manufacturerHosts?: readonly string[];
	alreadyTried?: readonly string[];
	deadEnds?: readonly string[];
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	}) => void;
	/** Called after each page read, for heartbeats. */
	onPageRead?: () => void | Promise<void>;
}

export async function runAtlasV3Researcher(
	input: RunAtlasV3ResearcherInput,
): Promise<AtlasV3FindingsNote> {
	const runRead = input.runReadModel ?? input.runModel;
	const empty: AtlasV3FindingsNote = {
		subQuestion: input.subQuestion,
		summary: "",
		quotes: [],
		claims: [],
		openQuestions: [],
		deadEnds: [],
		searches: 0,
		pagesRead: 0,
		error: null,
	};

	// -- plan the searches ---------------------------------------------------
	let queries: string[] = [];
	try {
		const plan = await input.runModel({
			stage: "v3:searchplan",
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.ask,
			system: ATLAS_V3_SEARCH_PLAN_SYSTEM[input.language],
			prompt: buildAtlasV3SearchPlanPrompt({
				subQuestion: input.subQuestion,
				coreQuestion: input.coreQuestion,
				language: input.language,
				currentDate: input.currentDate,
				queryCount: input.searchesPerStep,
				budget: input.budget,
				preferredSources: input.preferredSources,
				alreadyTried: input.alreadyTried,
				deadEnds: input.deadEnds,
			}),
		});
		input.onUsage?.(plan.usage);
		queries = parseAtlasV3SearchPlan(plan.text, input.searchesPerStep) ?? [];
	} catch {
		queries = [];
	}
	if (queries.length === 0) {
		queries = deterministicAtlasV3Queries({
			subQuestion: input.subQuestion,
			preferredSources: input.preferredSources,
			limit: input.searchesPerStep,
		});
	}

	// -- one fan-out of searches --------------------------------------------
	let hits: Array<{
		url: string;
		title: string;
		publishedAt: string | null;
	}> = [];
	try {
		const result = await input.researchWeb.search({
			question: input.subQuestion,
			searchQueries: queries,
		});
		hits = result.hits.map((hit) => ({
			url: hit.url,
			title: hit.title,
			publishedAt: hit.publishedAt,
		}));
	} catch (thrown) {
		return {
			...empty,
			searches: queries.length,
			error: thrown instanceof Error ? thrown.message : "research_web failed",
		};
	}

	// -- choose the pages worth reading, BY TIER ------------------------------
	//
	// This is the ordering v2 did not have: the adapter's own top-distinct rule
	// spent the read budget on whatever ranked highest, which is how one page
	// per question turned out to be a marketplace listing.
	const candidates = hits
		.map((hit) => {
			const canonical = canonicalizeGroundedWebUrl(hit.url);
			return canonical
				? {
						...hit,
						canonicalUrl: canonical.canonicalUrl,
						host: canonical.host,
					}
				: null;
		})
		.filter(
			(
				hit,
			): hit is (typeof hits)[number] & {
				canonicalUrl: string;
				host: string;
			} => hit !== null,
		);
	const toRead = selectAtlasV3PagesToRead(candidates, input.pagesToRead, {
		nativeSources: input.nativeSources,
		manufacturerHosts: input.manufacturerHosts,
	});

	// -- read each page FOR THE GOAL ----------------------------------------
	const quotes: AtlasV3Quote[] = [];
	const claims: AtlasV3Claim[] = [];
	let pagesRead = 0;
	for (const hit of toRead) {
		const source = addAtlasV3Source(input.state, {
			url: hit.canonicalUrl,
			title: hit.title,
			publishedAt: hit.publishedAt,
			read: true,
			nativeSources: input.nativeSources,
			manufacturerHosts: input.manufacturerHosts,
		});
		if (!source) continue;
		const page = await input.researchWeb.read(hit.canonicalUrl);
		if (!page.text) continue;
		pagesRead += 1;
		await input.onPageRead?.();
		try {
			const call = await runRead({
				stage: `v3:read:${source.id}`,
				thinkingMode: "off",
				maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.researchNote,
				system: ATLAS_V3_READ_SYSTEM[input.language],
				prompt: buildAtlasV3ReadPrompt({
					goal: input.subQuestion,
					language: input.language,
					sourceTitle: source.title,
					sourceHost: source.host,
					sourceDate: source.date,
					tier: source.tier,
					pageText: page.text,
					maxPageChars: ATLAS_V3_MAX_PAGE_CHARS,
					currentDate: input.currentDate,
				}),
			});
			input.onUsage?.(call.usage);
			const read = parseAtlasV3Read(call.text);
			// A navigation menu, a listing or a cookie wall reports itself useless
			// and contributes nothing. This is the check v2 did not have.
			if (!read || read.useless) continue;
			const filed = fileAtlasV3Read({
				state: input.state,
				sourceId: source.id,
				goal: input.subQuestion,
				read,
			});
			quotes.push(...filed.quotes);
			claims.push(...filed.claims);
		} catch {
			// One unreadable page must not lose the question; the note will say
			// what is still open and the next round can try again.
		}
	}

	// -- write the note, from the BANK, never from the page ------------------
	if (quotes.length === 0) {
		return {
			...empty,
			searches: queries.length,
			pagesRead,
			summary: "",
			openQuestions: [input.subQuestion],
			error: null,
		};
	}
	let note: AtlasV3ParsedNote | null = null;
	try {
		const call = await input.runModel({
			stage: "v3:note",
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.researchNote,
			system: ATLAS_V3_NOTE_SYSTEM[input.language],
			prompt: buildAtlasV3NotePrompt({
				subQuestion: input.subQuestion,
				coreQuestion: input.coreQuestion,
				language: input.language,
				currentDate: input.currentDate,
				searchesSpent: queries.length,
				pagesRead,
				quotes: quotes.map((quote) => {
					const source = input.state.sources.find(
						(entry) => entry.id === quote.sourceId,
					);
					return {
						id: quote.id,
						text: quote.text,
						publisher: source?.publisher ?? "",
						tier: source?.tier ?? "press",
						date: source?.date ?? null,
					};
				}),
				claims: claims.map((claim) => ({
					id: claim.id,
					entity: claim.entity,
					metric: claim.metric,
					value: claim.value,
					unit: claim.unit,
					period: claim.period,
					series: claim.series,
					status: claim.status,
				})),
			}),
		});
		input.onUsage?.(call.usage);
		note = parseAtlasV3Note(call.text);
	} catch {
		note = null;
	}

	return {
		subQuestion: input.subQuestion,
		// A note the model could not write is not a lost question: the claims and
		// quotes are already in the bank, and the memo stage reads those.
		summary: note?.summary ?? "",
		quotes,
		claims,
		openQuestions: note?.openQuestions ?? [],
		deadEnds: note?.deadEnds ?? [],
		searches: queries.length,
		pagesRead,
		error: null,
	};
}
