// The Atlas v3 progress-details contract (ADR 0063).
//
// Deliberately v2's SHAPE with `pipelineVersion: 3`. The chat card is being
// redesigned in another workstream, and a v3 job must render on the card that
// exists today rather than wait for it: `plan` carries the outline's nodes as
// the questions the v2 card already draws, `round` carries the research rounds,
// `evidence` carries the published sources. A client that dispatches on
// `pipelineVersion === 2` degrades to the v1 branch, which reads `queries` —
// empty here, exactly as on v2 — instead of crashing.

import type { SupportedLanguage } from "$lib/server/services/language";
import {
	ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS,
	ATLAS_V3_MAX_EVIDENCE_SOURCES,
	ATLAS_V3_MAX_PLAN_ENTRIES,
} from "../atlas/progress-details";
import {
	type AtlasV3Citations,
	assignAtlasV3CitationNumbers,
	atlasV3PublishersFor,
} from "./evidence-bank";
import type {
	AtlasV3EvidenceBank,
	AtlasV3Outline,
	AtlasV3Phase,
	AtlasV3ProgressDetails,
	AtlasV3ProgressEvidence,
	AtlasV3ProgressEvidenceSource,
	AtlasV3ProgressPlanEntry,
	AtlasV3QualityDiagnostics,
	AtlasV3VerificationTotals,
} from "./types";

/** Percent shown for each phase, so the bar advances monotonically. */
export const ATLAS_V3_PHASE_PROGRESS: Record<AtlasV3Phase, number> = {
	ask: 4,
	research: 20,
	outline: 52,
	answer: 60,
	write: 68,
	critic: 82,
	verify: 90,
	render: 95,
};

export function buildAtlasV3NextLine(input: {
	phase: AtlasV3Phase;
	language: SupportedLanguage;
	sectionCount: number;
	questionCount: number;
	round: { current: number; total: number };
	/** Sources from the parent report being re-read live (seeding, Phase D). */
	seedRecheck?: number;
}): string {
	const hu = input.language === "hu";
	if (input.phase === "research" && input.seedRecheck) {
		return hu
			? `${input.seedRecheck} forrás újraellenőrzése az előző jelentésből`
			: `Re-checking ${input.seedRecheck} source${input.seedRecheck === 1 ? "" : "s"} from the previous report`;
	}
	switch (input.phase) {
		case "ask":
			return hu
				? "a kérdés döntéssé fogalmazása · kutatási kérdések kijelölése"
				: "restate the question as a decision · set the research questions";
		case "research":
			return hu
				? `${input.questionCount} kérdés kutatása (${input.round.current}/${input.round.total}. kör) · elsődleges források olvasása`
				: `research ${input.questionCount} questions (round ${input.round.current} of ${input.round.total}) · read the top-tier pages`;
		case "outline":
			return hu
				? "a vázlat újraírása a bizonyítékok alapján · hiányok megnevezése"
				: "revise the outline against the evidence · name the gaps";
		case "answer":
			return hu
				? "a válasz táblázatának összeállítása · a különbségek kiszámítása"
				: "assemble the answer table · compute the deltas";
		case "write":
			return hu
				? `${input.sectionCount} szakasz megírása egyetlen írótól`
				: `write ${input.sectionCount} sections with one writer`;
		case "critic":
			return hu
				? "a jelentés átvizsgálása hibalista alapján · hiányzó bizonyíték pótlása"
				: "review the whole report against the failure list · fetch missing evidence";
		case "verify":
			return hu
				? "minden hivatkozott szám összevetése az idézetével"
				: "match every cited figure against the quote it rests on";
		case "render":
			return hu
				? "HTML, PDF és Markdown előállítása"
				: "render HTML, PDF and Markdown";
	}
}

export interface BuildAtlasV3ProgressDetailsInput {
	phase: AtlasV3Phase;
	language: SupportedLanguage;
	/** The living outline; its nodes are what the card draws as `plan`. */
	outline: AtlasV3Outline | null;
	/** Research questions, before the outline exists. */
	subQuestions?: readonly string[];
	runningQuestions?: readonly string[];
	doneQuestions?: readonly string[];
	round: { current: number; total: number };
	sourcesRead: number;
	evidence?: AtlasV3ProgressEvidence;
	phaseDurationsMs?: Record<string, number>;
	sections?: { written: number; planned: number };
	qualityDiagnostics?: AtlasV3QualityDiagnostics;
	/** Sources from the parent report being re-read live right now. */
	seedRecheck?: number;
}

export function buildAtlasV3ProgressDetails(
	input: BuildAtlasV3ProgressDetailsInput,
): AtlasV3ProgressDetails {
	const running = new Set(input.runningQuestions ?? []);
	const done = new Set(input.doneQuestions ?? []);
	// Before the outline exists the card shows the research questions; after it,
	// the sections. Both are "what the job is working through", which is what the
	// existing card's `plan` list means.
	const plan: AtlasV3ProgressPlanEntry[] = input.outline
		? input.outline.nodes.map((node) => ({
				id: node.id,
				question: node.title,
				status:
					node.status === "ready"
						? "done"
						: node.status === "cut"
							? "done"
							: "queued",
				sourceCount: node.evidenceIds.length,
				confidence:
					node.status === "ready"
						? "corroborated"
						: node.status === "thin"
							? "single"
							: "thin",
			}))
		: (input.subQuestions ?? []).map((question, index) => ({
				id: `q${index + 1}`,
				question,
				status: done.has(question)
					? "done"
					: running.has(question)
						? "running"
						: "queued",
				sourceCount: 0,
			}));
	return {
		pipelineVersion: 3,
		queries: [],
		phase: input.phase,
		plan: plan.slice(0, ATLAS_V3_MAX_PLAN_ENTRIES),
		round: input.round,
		sourcesRead: input.sourcesRead,
		next: buildAtlasV3NextLine({
			phase: input.phase,
			language: input.language,
			sectionCount: input.outline?.nodes.length ?? 0,
			questionCount: input.outline
				? input.outline.nodes.length
				: (input.subQuestions?.length ?? 0),
			round: input.round,
			...(input.seedRecheck ? { seedRecheck: input.seedRecheck } : {}),
		}),
		...(input.evidence ? { evidence: input.evidence } : {}),
		...(input.phaseDurationsMs && Object.keys(input.phaseDurationsMs).length > 0
			? { phaseDurationsMs: { ...input.phaseDurationsMs } }
			: {}),
		...(input.sections ? { sections: { ...input.sections } } : {}),
		...(input.qualityDiagnostics
			? { qualityDiagnostics: { ...input.qualityDiagnostics } }
			: {}),
	};
}

/**
 * The evidence card, numbered EXACTLY as the rendered report numbers it.
 *
 * The caller passes the citation map the renderer minted rather than a list of
 * ids, because the harness cross-checks the report's `[n]` markers against this
 * card's `sources[].n`: two independent orderings would make every number look
 * like a mismatch.
 */
export function buildAtlasV3ProgressEvidence(input: {
	bank: AtlasV3EvidenceBank;
	totals: AtlasV3VerificationTotals;
	/** From `buildAtlasV3DocumentSource`. Cited sources first, in report order. */
	citations: AtlasV3Citations;
}): AtlasV3ProgressEvidence {
	// Uncited sources are appended AFTER the cited ones, so a cited source keeps
	// the number the report gave it. The report's OWN source order comes first,
	// because a report may number a source no sentence cites — an abstaining
	// report lists the pages it read that way — and rebuilding the order from
	// quotes alone would give the card a different `[n]` for it.
	const reportOrder = [...input.citations.numberBySourceId.entries()]
		.sort((left, right) => left[1] - right[1])
		.map(([sourceId]) => sourceId);
	const citations = assignAtlasV3CitationNumbers({
		bank: input.bank,
		citedEvidenceIds: [...input.citations.numberByEvidenceId.keys()].sort(
			(left, right) =>
				(input.citations.numberByEvidenceId.get(left) ?? 0) -
				(input.citations.numberByEvidenceId.get(right) ?? 0),
		),
		extraSourceIds: [
			...reportOrder,
			...input.bank.sources.map((source) => source.id),
		],
	});
	const citedSourceIds = new Set(input.citations.numberBySourceId.keys());
	const citedEvidenceIds = new Set(input.citations.numberByEvidenceId.keys());
	const sources: AtlasV3ProgressEvidenceSource[] = citations.sources.map(
		(source, index) => {
			// The QUOTES, not the page: the harness re-checks number matches against
			// exactly what the writer was allowed to see. The ones a sentence
			// actually CITES come first, because the cap falls on the tail and a
			// truncated cited quote reads to the harness as an invented figure.
			const quotes = input.bank.quotes.filter(
				(quote) => quote.sourceId === source.id,
			);
			const ordered = [
				...quotes.filter((quote) => citedEvidenceIds.has(quote.id)),
				...quotes.filter((quote) => !citedEvidenceIds.has(quote.id)),
			];
			return {
				n: index + 1,
				title: source.title,
				// A user document has no host; the card draws a library glyph for it.
				host: source.kind === "local" ? "" : source.host,
				kind: source.kind === "local" ? "local" : "web",
				date: source.date,
				cited: citedSourceIds.has(source.id),
				snippet: ordered
					.map((quote) => quote.text)
					.join(" ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS),
			};
		},
	);
	return {
		corroborated: input.totals.corroborated,
		single: input.totals.single,
		inferred: input.totals.inferred,
		cut: input.totals.cut,
		filteredCount: input.bank.filteredCount,
		sources: sources.slice(0, ATLAS_V3_MAX_EVIDENCE_SOURCES),
	};
}

/** Claims by status, for the diagnostics. */
export function atlasV3ClaimCounts(bank: AtlasV3EvidenceBank): {
	total: number;
	verified: number;
	contested: number;
} {
	return {
		total: bank.claims.length,
		verified: bank.claims.filter((claim) => claim.status === "verified").length,
		contested: bank.claims.filter((claim) => claim.status === "contested")
			.length,
	};
}

/** Independent publishers behind a claim. Re-exported for the diagnostics. */
export { atlasV3PublishersFor };
