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
	type AtlasV3Citations,
	assignAtlasV3CitationNumbers,
	atlasV3PublishersFor,
} from "./evidence-bank";
import {
	ATLAS_V3_PHASES,
	type AtlasV3EvidenceBank,
	type AtlasV3Outline,
	type AtlasV3Phase,
	type AtlasV3ProgressDetails,
	type AtlasV3ProgressEvidence,
	type AtlasV3ProgressEvidenceSource,
	type AtlasV3ProgressPlanEntry,
	type AtlasV3QualityDiagnostics,
	type AtlasV3VerificationTotals,
} from "./types";

export const ATLAS_V3_MAX_PLAN_ENTRIES = 24;
export const ATLAS_V3_MAX_EVIDENCE_SOURCES = 96;
export const ATLAS_V3_MAX_QUESTION_CHARS = 240;
export const ATLAS_V3_MAX_NEXT_CHARS = 200;
export const ATLAS_V3_MAX_TITLE_CHARS = 160;
/**
 * Per-source quote budget. Present so `scripts/atlas-eval.ts` can re-check
 * number matches offline from the job row instead of re-fetching the web.
 *
 * 1200 characters truncated eight sources on one staging job, and the
 * evaluation then flagged figures the CITED quote states — NICE's "from 123 to
 * 107-115 per 1,000" among them — as unsupported. The card must carry at least
 * the quotes the report rests on, so the cited ones are written first and the
 * budget is wide enough to hold a page's worth of them.
 */
export const ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS = 4000;

export const ATLAS_V3_PHASE_DURATION_KEYS = [
	"ask",
	"research",
	"memo",
	"outline",
	"answer",
	"write",
	"verdict",
	"critic",
	"verify",
	"render",
] as const;

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
}): string {
	const hu = input.language === "hu";
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
				host: source.host,
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

// ---------------------------------------------------------------------------
// Sanitising (read path)
// ---------------------------------------------------------------------------

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function nonNegativeInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function planStatus(value: unknown): AtlasV3ProgressPlanEntry["status"] {
	return value === "running" || value === "done" ? value : "queued";
}

function questionConfidence(
	value: unknown,
): AtlasV3ProgressPlanEntry["confidence"] {
	return value === "corroborated" ||
		value === "single" ||
		value === "mixed" ||
		value === "thin"
		? value
		: undefined;
}

function phase(value: unknown): AtlasV3Phase {
	return (ATLAS_V3_PHASES as readonly string[]).includes(value as string)
		? (value as AtlasV3Phase)
		: "ask";
}

/** True when a stored progress-details blob is the v3 shape. */
export function isAtlasV3ProgressDetails(value: unknown): boolean {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { pipelineVersion?: unknown }).pipelineVersion === 3
	);
}

export function sanitizeAtlasV3ProgressDetails(
	value: unknown,
): AtlasV3ProgressDetails {
	const record = (value ?? {}) as Record<string, unknown>;
	const planEntries = Array.isArray(record.plan) ? record.plan : [];
	const plan: AtlasV3ProgressPlanEntry[] = planEntries
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const planRecord = entry as Record<string, unknown>;
			const id = cleanText(planRecord.id, 32);
			const question = cleanText(
				planRecord.question,
				ATLAS_V3_MAX_QUESTION_CHARS,
			);
			if (!id || !question) return null;
			const confidence = questionConfidence(planRecord.confidence);
			return {
				id,
				question,
				status: planStatus(planRecord.status),
				sourceCount: nonNegativeInteger(planRecord.sourceCount),
				...(confidence ? { confidence } : {}),
			};
		})
		.filter((entry): entry is AtlasV3ProgressPlanEntry => Boolean(entry))
		.slice(0, ATLAS_V3_MAX_PLAN_ENTRIES);

	const roundRecord = (record.round ?? {}) as Record<string, unknown>;
	const total = Math.max(1, nonNegativeInteger(roundRecord.total) || 1);
	const details: AtlasV3ProgressDetails = {
		pipelineVersion: 3,
		queries: [],
		phase: phase(record.phase),
		plan,
		round: {
			current: Math.min(
				total,
				Math.max(1, nonNegativeInteger(roundRecord.current) || 1),
			),
			total,
		},
		sourcesRead: nonNegativeInteger(record.sourcesRead),
		next: cleanText(record.next, ATLAS_V3_MAX_NEXT_CHARS),
	};

	const durations = sanitizePhaseDurations(record.phaseDurationsMs);
	const sections = sanitizeSectionCounts(record.sections);
	const diagnostics = sanitizeDiagnostics(record.qualityDiagnostics);
	const evidence = sanitizeEvidence(record.evidence);
	return {
		...details,
		...(durations ? { phaseDurationsMs: durations } : {}),
		...(sections ? { sections } : {}),
		...(diagnostics ? { qualityDiagnostics: diagnostics } : {}),
		...(evidence ? { evidence } : {}),
	};
}

function sanitizeSectionCounts(
	value: unknown,
): { written: number; planned: number } | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.written === undefined && record.planned === undefined) return null;
	return {
		written: nonNegativeInteger(record.written),
		planned: nonNegativeInteger(record.planned),
	};
}

function sanitizePhaseDurations(value: unknown): Record<string, number> | null {
	if (!value || typeof value !== "object") return null;
	const durations: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const name = cleanText(key, 24);
		if (
			!name ||
			!(ATLAS_V3_PHASE_DURATION_KEYS as readonly string[]).includes(name)
		) {
			continue;
		}
		durations[name] = nonNegativeInteger(raw);
	}
	return Object.keys(durations).length > 0 ? durations : null;
}

function sanitizeDiagnostics(value: unknown): AtlasV3QualityDiagnostics | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const runaways = (record.writerRunaways ?? {}) as Record<string, unknown>;
	return {
		abstained: record.abstained === true,
		verdictPresent: record.verdictPresent === true,
		verdictFallback: record.verdictFallback === true,
		repeatedSentences: nonNegativeInteger(record.repeatedSentences),
		claimCount: nonNegativeInteger(record.claimCount),
		verifiedClaimCount: nonNegativeInteger(record.verifiedClaimCount),
		contestedClaimCount: nonNegativeInteger(record.contestedClaimCount),
		claimsMerged: nonNegativeInteger(record.claimsMerged),
		answerTableCells: nonNegativeInteger(record.answerTableCells),
		derivedFigures: nonNegativeInteger(record.derivedFigures),
		criticRounds: nonNegativeInteger(record.criticRounds),
		criticFindings: nonNegativeInteger(record.criticFindings),
		needsEvidenceResolved: nonNegativeInteger(record.needsEvidenceResolved),
		roundsRun: nonNegativeInteger(record.roundsRun),
		searches: nonNegativeInteger(record.searches),
		pagesRead: nonNegativeInteger(record.pagesRead),
		sectionsPlanned: nonNegativeInteger(record.sectionsPlanned),
		sectionsWritten: nonNegativeInteger(record.sectionsWritten),
		sectionsSupplemented: nonNegativeInteger(record.sectionsSupplemented),
		wordCount: nonNegativeInteger(record.wordCount),
		writerRunaways: {
			length: nonNegativeInteger(runaways.length),
			salvaged: nonNegativeInteger(runaways.salvaged),
			retried: nonNegativeInteger(runaways.retried),
			fallback: nonNegativeInteger(runaways.fallback),
		},
	};
}

function sanitizeEvidence(value: unknown): AtlasV3ProgressEvidence | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const sourceEntries = Array.isArray(record.sources) ? record.sources : [];
	const sources: AtlasV3ProgressEvidenceSource[] = sourceEntries
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const sourceRecord = entry as Record<string, unknown>;
			const n = nonNegativeInteger(sourceRecord.n);
			if (n < 1) return null;
			const host = cleanText(sourceRecord.host, 120);
			if (!host) return null;
			const date = cleanText(sourceRecord.date, 32);
			return {
				n,
				title: cleanText(sourceRecord.title, ATLAS_V3_MAX_TITLE_CHARS) || host,
				host,
				date: date || null,
				cited: sourceRecord.cited === true,
				snippet: cleanText(
					sourceRecord.snippet,
					ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS,
				),
			};
		})
		.filter((entry): entry is AtlasV3ProgressEvidenceSource => Boolean(entry))
		.slice(0, ATLAS_V3_MAX_EVIDENCE_SOURCES);
	return {
		corroborated: nonNegativeInteger(record.corroborated),
		single: nonNegativeInteger(record.single),
		inferred: nonNegativeInteger(record.inferred),
		cut: nonNegativeInteger(record.cut),
		filteredCount: nonNegativeInteger(record.filteredCount),
		sources,
	};
}
