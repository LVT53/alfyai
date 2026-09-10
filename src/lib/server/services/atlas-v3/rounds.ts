// Atlas v3 stage 3c: research rounds (ADR 0063).
//
// A round fans its sub-questions out to isolated researchers, files everything
// they find into the shared bank, and rewrites the memo from their notes. It
// does NOT decide whether to run another round — the goal test does (goal.ts),
// which is the difference between stopping when the answer is in hand and
// stopping when a counter runs out.

import type { SupportedLanguage } from "$lib/server/services/language";
import { mapWithConcurrency } from "../atlas-v2/research";
import type { AtlasV3BankState } from "./evidence-bank";
import {
	atlasV3PublishersFor,
	freezeAtlasV3Bank,
	rescoreAtlasV3Claims,
} from "./evidence-bank";
import type { AtlasV3NativeSourceSet } from "./language-standard";
import type { AtlasV3ModelCall } from "./model-call";
import type { AtlasV3ResearchWeb } from "./research-web-adapter";
import { runAtlasV3Researcher } from "./researcher";
import type {
	AtlasV3BudgetUsed,
	AtlasV3FindingsNote,
	AtlasV3Memo,
	AtlasV3Usage,
} from "./types";
import { rewriteAtlasV3Memo } from "./workspace";

export interface RunAtlasV3RoundInput {
	round: number;
	roundsTotal: number;
	subQuestions: string[];
	coreQuestion: string;
	decision: string;
	language: SupportedLanguage;
	currentDate: string;
	state: AtlasV3BankState;
	researchWeb: AtlasV3ResearchWeb;
	runResearcherModel: AtlasV3ModelCall;
	/** The memo rewrite; the outline model by default. */
	runMemoModel: AtlasV3ModelCall;
	searchesPerStep: number;
	pagesPerQuestion: number;
	concurrency: number;
	previousMemo: AtlasV3Memo | null;
	nativeSources?: readonly AtlasV3NativeSourceSet[];
	preferredSources?: readonly string[];
	manufacturerHosts?: readonly string[];
	/** Queries earlier rounds already spent, so a round does not repeat them. */
	alreadyTried?: readonly string[];
	onUsage?: (usage: AtlasV3Usage) => void;
	onQuestionStart?: (subQuestion: string) => void | Promise<void>;
	onQuestionDone?: (input: {
		subQuestion: string;
		quotes: number;
		claims: number;
	}) => void | Promise<void>;
	onPageRead?: () => void | Promise<void>;
}

export interface AtlasV3RoundResult {
	round: number;
	notes: AtlasV3FindingsNote[];
	memo: AtlasV3Memo;
	budgetUsed: AtlasV3BudgetUsed;
	/** Every query this round issued, for the next round's `alreadyTried`. */
	queries: string[];
}

export async function runAtlasV3Round(
	input: RunAtlasV3RoundInput,
): Promise<AtlasV3RoundResult> {
	const roundsLeft = Math.max(0, input.roundsTotal - input.round);
	const budgetBlock = {
		searchesLeft:
			input.searchesPerStep * input.subQuestions.length * (roundsLeft + 1),
		pageReadsLeft:
			input.pagesPerQuestion * input.subQuestions.length * (roundsLeft + 1),
		roundsLeft,
	};

	const notes = await mapWithConcurrency(
		input.subQuestions,
		Math.max(1, input.concurrency),
		async (subQuestion) => {
			await input.onQuestionStart?.(subQuestion);
			// One researcher failing must not lose the round: the memo will carry
			// the question as still open and the goal test will ask for it again.
			try {
				const note = await runAtlasV3Researcher({
					subQuestion,
					coreQuestion: input.coreQuestion,
					language: input.language,
					currentDate: input.currentDate,
					state: input.state,
					researchWeb: input.researchWeb,
					runModel: input.runResearcherModel,
					searchesPerStep: input.searchesPerStep,
					pagesToRead: input.pagesPerQuestion,
					budget: budgetBlock,
					nativeSources: input.nativeSources,
					preferredSources: input.preferredSources,
					manufacturerHosts: input.manufacturerHosts,
					alreadyTried: input.alreadyTried,
					deadEnds: input.previousMemo?.deadEnds,
					onUsage: input.onUsage,
					onPageRead: input.onPageRead,
				});
				await input.onQuestionDone?.({
					subQuestion,
					quotes: note.quotes.length,
					claims: note.claims.length,
				});
				return note;
			} catch (thrown) {
				await input.onQuestionDone?.({ subQuestion, quotes: 0, claims: 0 });
				return {
					subQuestion,
					summary: "",
					quotes: [],
					claims: [],
					openQuestions: [subQuestion],
					deadEnds: [],
					searches: 0,
					pagesRead: 0,
					error: thrown instanceof Error ? thrown.message : "researcher failed",
				} satisfies AtlasV3FindingsNote;
			}
		},
	);

	// Claim status depends on how many independent publishers ended up behind a
	// value, and this round may have supplied the second one for a claim an
	// earlier round filed as `single`.
	rescoreAtlasV3Claims(input.state);

	const budgetUsed: AtlasV3BudgetUsed = {
		searches:
			(input.previousMemo?.budgetUsed.searches ?? 0) +
			notes.reduce((total, note) => total + note.searches, 0),
		pagesRead:
			(input.previousMemo?.budgetUsed.pagesRead ?? 0) +
			notes.reduce((total, note) => total + note.pagesRead, 0),
		rounds: input.round,
	};

	const bank = freezeAtlasV3Bank(input.state);
	const memo = await rewriteAtlasV3Memo({
		coreQuestion: input.coreQuestion,
		decision: input.decision,
		language: input.language,
		currentDate: input.currentDate,
		round: input.round,
		roundsLeft,
		previous: input.previousMemo,
		notes,
		claims: bank.claims.map((claim) => ({
			id: claim.id,
			entity: claim.entity,
			metric: claim.metric,
			value: claim.value,
			unit: claim.unit,
			period: claim.period,
			asOf: claim.asOf,
			series: claim.series,
			status: claim.status,
			publishers: atlasV3PublishersFor(bank, claim.evidenceIds),
		})),
		bank,
		budgetUsed,
		runModel: input.runMemoModel,
		onUsage: input.onUsage,
	});

	return {
		round: input.round,
		notes,
		memo,
		budgetUsed,
		queries: [...new Set(notes.map((note) => note.subQuestion))],
	};
}

/**
 * The sub-questions the next round should research: the goal test's named gaps
 * first, then the memo's open questions, minus anything already established as
 * a dead end and anything already asked.
 */
export function nextAtlasV3SubQuestions(input: {
	gaps: readonly string[];
	memo: AtlasV3Memo | null;
	asked: readonly string[];
	limit: number;
}): string[] {
	const seen = new Set(input.asked.map((entry) => entry.toLowerCase()));
	const deadEnds = new Set(
		(input.memo?.deadEnds ?? []).map((entry) => entry.toLowerCase()),
	);
	const next: string[] = [];
	for (const candidate of [
		...input.gaps,
		...(input.memo?.openQuestions ?? []),
	]) {
		const cleaned = candidate.replace(/\s+/g, " ").trim().slice(0, 240);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key) || deadEnds.has(key)) continue;
		seen.add(key);
		next.push(cleaned);
		if (next.length >= input.limit) break;
	}
	return next;
}
