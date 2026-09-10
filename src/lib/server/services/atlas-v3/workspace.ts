// Atlas v3 stage 3b: the rebuilt workspace (ADR 0063).
//
// The memo is the ONLY thing that survives a round. It is REWRITTEN from the
// round's findings notes, never appended to, and it is small on purpose: a
// growing transcript is what the WebResearcher and ARC results say costs ten to
// fifteen points at a fixed model, and our 262k window is precisely the trap
// that makes the losing approach easy to fall into.
//
// A memo names its claims by id. The values live in the bank; the memo carries
// the argument, the open questions and the dead ends.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import type { AtlasV3ModelCall } from "./model-call";
import type {
	AtlasV3BudgetUsed,
	AtlasV3EvidenceBank,
	AtlasV3FindingsNote,
	AtlasV3Memo,
} from "./types";

/** Claims one memo may name. Past this the memo is a transcript again. */
export const ATLAS_V3_MAX_MEMO_CLAIMS = 40;
const MAX_OPEN_QUESTIONS = 8;
const MAX_DEAD_ENDS = 6;

export const ATLAS_V3_MEMO_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You REWRITE a research memo from this round's notes. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"answerSoFar":"...","claimIds":["c1","c4"],"openQuestions":["..."],"deadEnds":["..."]}',
		"You are rewriting, not appending. The previous memo is shown so you can keep what still holds and DROP what this round settled or disproved.",
		"`answerSoFar` answers the core question in at most six sentences, from the claims shown. Name the figure, the publisher and the period. Where two claims measure different things, say so — never average them, never call two series a disagreement.",
		"If the claims do not yet answer the core question, say what is established and what is not. Never guess.",
		"`claimIds` are the claims the answer rests on, best-supported first, at most 40. Only ids that appear in the input.",
		"`openQuestions` are what is still needed, as searchable questions, at most 8. Drop anything this round answered.",
		"`deadEnds` are what has been established as unanswerable, with the reason, at most 6. Never drop a dead end that is still true — re-searching it is wasted budget.",
	].join("\n"),
	hu: [
		"ÚJRAÍROD a kutatási feljegyzést a kör jegyzeteiből. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"answerSoFar":"...","claimIds":["c1","c4"],"openQuestions":["..."],"deadEnds":["..."]}',
		"Újraírsz, nem hozzáfűzöl. Az előző feljegyzést azért látod, hogy megtartsd, ami még áll, és ELHAGYD, amit ez a kör eldöntött vagy cáfolt.",
		"Az `answerSoFar` legfeljebb hat mondatban válaszol a fő kérdésre, a bemutatott állításokból. Nevezd meg a számot, a közzétevőt és az időszakot. Ha két állítás mást mér, mondd ki — ne átlagolj, és ne nevezz két adatsort ellentmondásnak.",
		"Ha az állítások még nem válaszolják meg a fő kérdést, írd le, mi áll és mi nem. Ne találgass.",
		"A `claimIds` azok az állítások, amelyeken a válasz nyugszik, a legjobban alátámasztottal kezdve, legfeljebb 40. Csak a bemenetben szereplő azonosítók.",
		"Az `openQuestions` az, ami még hiányzik, kereshető kérdésként, legfeljebb 8. Hagyd el, amit ez a kör megválaszolt.",
		"A `deadEnds` az, amiről kiderült, hogy nem válaszolható meg, az okkal, legfeljebb 6. Ne hagyj el olyan zsákutcát, ami még igaz — az újrakeresése elpazarolt keret.",
	].join("\n"),
};

export interface BuildAtlasV3MemoPromptInput {
	coreQuestion: string;
	decision: string;
	language: SupportedLanguage;
	currentDate: string;
	round: number;
	roundsLeft: number;
	previous: AtlasV3Memo | null;
	notes: AtlasV3FindingsNote[];
	/** The claims the round produced, flattened for the prompt. */
	claims: Array<{
		id: string;
		entity: string;
		metric: string;
		value: string;
		unit: string | null;
		period: string | null;
		asOf: string | null;
		series: string | null;
		status: string;
		publishers: string[];
	}>;
}

export function buildAtlasV3MemoPrompt(
	input: BuildAtlasV3MemoPromptInput,
): string {
	return JSON.stringify({
		task: "rewrite_memo",
		coreQuestion: input.coreQuestion,
		decision: input.decision,
		language: input.language,
		currentDate: input.currentDate,
		round: input.round,
		roundsLeft: input.roundsLeft,
		previousMemo: input.previous
			? {
					answerSoFar: input.previous.answerSoFar,
					claimIds: input.previous.claimIds,
					openQuestions: input.previous.openQuestions,
					deadEnds: input.previous.deadEnds,
				}
			: null,
		notes: input.notes.map((note) => ({
			question: note.subQuestion,
			summary: note.summary,
			openQuestions: note.openQuestions,
			deadEnds: note.deadEnds,
		})),
		claims: input.claims.slice(0, ATLAS_V3_MAX_MEMO_CLAIMS),
	});
}

export function parseAtlasV3Memo(
	text: string,
	input: { knownClaimIds: readonly string[]; budgetUsed: AtlasV3BudgetUsed },
): AtlasV3Memo | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const answerSoFar =
		typeof record.answerSoFar === "string"
			? record.answerSoFar.replace(/\s+/g, " ").trim().slice(0, 1400)
			: "";
	if (!answerSoFar) return null;
	const known = new Set(input.knownClaimIds);
	const claimIds: string[] = [];
	if (Array.isArray(record.claimIds)) {
		for (const entry of record.claimIds) {
			if (typeof entry !== "string") continue;
			const id = entry.trim();
			// A memo may not invent a claim: an id the bank does not hold would
			// become a citation with no evidence behind it.
			if (!known.has(id) || claimIds.includes(id)) continue;
			claimIds.push(id);
			if (claimIds.length >= ATLAS_V3_MAX_MEMO_CLAIMS) break;
		}
	}
	return {
		answerSoFar,
		claimIds,
		openQuestions: stringList(record.openQuestions, MAX_OPEN_QUESTIONS),
		deadEnds: stringList(record.deadEnds, MAX_DEAD_ENDS),
		budgetUsed: input.budgetUsed,
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

/**
 * The memo when the model answer does not parse: the round's note summaries,
 * joined, over the claims the bank actually holds. Worse prose than the model's
 * answer and exactly as truthful, which is the property that matters — a lost
 * memo would otherwise cost the round's whole research.
 */
export function deterministicAtlasV3Memo(input: {
	previous: AtlasV3Memo | null;
	notes: readonly AtlasV3FindingsNote[];
	bank: AtlasV3EvidenceBank;
	budgetUsed: AtlasV3BudgetUsed;
}): AtlasV3Memo {
	const summaries = input.notes
		.map((note) => note.summary.trim())
		.filter(Boolean);
	const answerSoFar =
		(summaries.length > 0
			? summaries.join(" ")
			: (input.previous?.answerSoFar ?? "")
		).slice(0, 1400) ||
		"No evidence has been established for the core question yet.";
	// Best-supported first, so a truncated memo keeps the claims that matter.
	const rank = { verified: 0, contested: 1, single: 2, open: 3 } as const;
	const claimIds = [...input.bank.claims]
		.sort((left, right) => rank[left.status] - rank[right.status])
		.slice(0, ATLAS_V3_MAX_MEMO_CLAIMS)
		.map((claim) => claim.id);
	return {
		answerSoFar,
		claimIds,
		openQuestions: dedupe(
			[
				...input.notes.flatMap((note) => note.openQuestions),
				...(input.previous?.openQuestions ?? []),
			],
			MAX_OPEN_QUESTIONS,
		),
		deadEnds: dedupe(
			[
				...(input.previous?.deadEnds ?? []),
				...input.notes.flatMap((note) => note.deadEnds),
			],
			MAX_DEAD_ENDS,
		),
		budgetUsed: input.budgetUsed,
	};
}

function dedupe(items: readonly string[], limit: number): string[] {
	const unique: string[] = [];
	for (const item of items) {
		const cleaned = item.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!cleaned) continue;
		if (unique.some((entry) => entry.toLowerCase() === cleaned.toLowerCase())) {
			continue;
		}
		unique.push(cleaned);
		if (unique.length >= limit) break;
	}
	return unique;
}

export interface RewriteAtlasV3MemoInput extends BuildAtlasV3MemoPromptInput {
	bank: AtlasV3EvidenceBank;
	budgetUsed: AtlasV3BudgetUsed;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	}) => void;
}

/** One model call, one rewritten memo, with the deterministic memo beneath. */
export async function rewriteAtlasV3Memo(
	input: RewriteAtlasV3MemoInput,
): Promise<AtlasV3Memo> {
	const fallback = () =>
		deterministicAtlasV3Memo({
			previous: input.previous,
			notes: input.notes,
			bank: input.bank,
			budgetUsed: input.budgetUsed,
		});
	try {
		const call = await input.runModel({
			stage: `v3:memo:${input.round}`,
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.memo,
			system: ATLAS_V3_MEMO_SYSTEM[input.language],
			prompt: buildAtlasV3MemoPrompt(input),
		});
		input.onUsage?.(call.usage);
		const parsed = parseAtlasV3Memo(call.text, {
			knownClaimIds: input.bank.claims.map((claim) => claim.id),
			budgetUsed: input.budgetUsed,
		});
		if (!parsed) return fallback();
		// A memo that named no claim cannot be defended; the deterministic ranking
		// is better than an argument with no evidence behind it.
		return parsed.claimIds.length > 0
			? parsed
			: { ...parsed, claimIds: fallback().claimIds };
	} catch {
		return fallback();
	}
}

/**
 * Merges the memos of independent research passes (exhaustive mode).
 *
 * Merging at MEMO level rather than at note level is the cheap quality lever:
 * three passes disagree about what matters, and the union of their claims with
 * the intersection of their dead ends is a better starting point than any one
 * of them. The answers are concatenated rather than re-summarised, because the
 * outline stage rewrites from this anyway.
 */
export function mergeAtlasV3Memos(memos: readonly AtlasV3Memo[]): AtlasV3Memo {
	if (memos.length === 0) {
		return {
			answerSoFar: "",
			claimIds: [],
			openQuestions: [],
			deadEnds: [],
			budgetUsed: { searches: 0, pagesRead: 0, rounds: 0 },
		};
	}
	if (memos.length === 1) return memos[0];
	const claimIds: string[] = [];
	for (const memo of memos) {
		for (const id of memo.claimIds) {
			if (!claimIds.includes(id)) claimIds.push(id);
			if (claimIds.length >= ATLAS_V3_MAX_MEMO_CLAIMS) break;
		}
	}
	// A dead end only counts when EVERY pass hit it: one pass failing to find a
	// series is not evidence that the series does not exist.
	const deadEnds = memos[0].deadEnds.filter((entry) =>
		memos.every((memo) =>
			memo.deadEnds.some(
				(candidate) => candidate.toLowerCase() === entry.toLowerCase(),
			),
		),
	);
	return {
		answerSoFar: memos
			.map((memo) => memo.answerSoFar.trim())
			.filter(Boolean)
			.join(" ")
			.slice(0, 1400),
		claimIds,
		openQuestions: dedupe(
			memos.flatMap((memo) => memo.openQuestions),
			MAX_OPEN_QUESTIONS,
		),
		deadEnds: dedupe(deadEnds, MAX_DEAD_ENDS),
		budgetUsed: memos.reduce(
			(total, memo) => ({
				searches: total.searches + memo.budgetUsed.searches,
				pagesRead: total.pagesRead + memo.budgetUsed.pagesRead,
				rounds: Math.max(total.rounds, memo.budgetUsed.rounds),
			}),
			{ searches: 0, pagesRead: 0, rounds: 0 },
		),
	};
}
