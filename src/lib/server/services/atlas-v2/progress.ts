// The Atlas v2 progress-details contract (ADR 0062): what the pipeline writes
// onto `atlas_jobs.progress_details_json`, and the sanitiser that projects it
// back onto the `AtlasJobCard` the chat UI reads.
//
// The contract is versioned by `pipelineVersion`, so v1's
// `{ queries, roundKind, focus }` details keep working untouched and the
// sanitiser dispatches rather than merging the two shapes.

import type { SupportedLanguage } from "$lib/server/services/language";
import { sourceEvidenceText } from "./evidence-index";
import type {
	AtlasV2EvidenceIndex,
	AtlasV2Phase,
	AtlasV2Plan,
	AtlasV2ProgressDetails,
	AtlasV2ProgressEvidence,
	AtlasV2ProgressEvidenceSource,
	AtlasV2ProgressPlanEntry,
	AtlasV2QuestionConfidence,
	AtlasV2VerificationTotals,
} from "./types";
import { ATLAS_V2_PHASES } from "./types";

/** Caps applied when sanitising, so a job row can never grow unbounded. */
export const ATLAS_V2_MAX_PLAN_ENTRIES = 24;
export const ATLAS_V2_MAX_EVIDENCE_SOURCES = 96;
export const ATLAS_V2_MAX_QUESTION_CHARS = 240;
export const ATLAS_V2_MAX_NEXT_CHARS = 200;
export const ATLAS_V2_MAX_TITLE_CHARS = 160;
/**
 * Per-source snippet budget. Present so `scripts/atlas-eval.ts` can re-check
 * number matches offline from the job row instead of re-fetching the web.
 */
export const ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS = 500;

/** Percent shown for each phase, so the bar advances monotonically. */
export const ATLAS_V2_PHASE_PROGRESS: Record<AtlasV2Phase, number> = {
	plan: 5,
	research: 20,
	index: 55,
	write: 62,
	verify: 82,
	render: 94,
};

export interface AtlasV2NextLineInput {
	phase: AtlasV2Phase;
	language: SupportedLanguage;
	sectionCount: number;
	questionCount: number;
	round: { current: number; total: number };
}

/** One short line telling the reader what the job does next. */
export function buildAtlasV2NextLine(input: AtlasV2NextLineInput): string {
	const hu = input.language === "hu";
	switch (input.phase) {
		case "plan":
			return hu
				? `${input.questionCount} kutatási kérdés kijelölése · szakaszvázlat`
				: `set ${input.questionCount} research questions · outline the sections`;
		case "research":
			return hu
				? `${input.questionCount} kérdés kutatása (${input.round.current}/${input.round.total}. kör) · oldalak olvasása`
				: `research ${input.questionCount} questions (round ${input.round.current} of ${input.round.total}) · read the top pages`;
		case "index":
			return hu
				? "források egyesítése és számozása · szemét kiszűrése"
				: "merge and number the sources · drop junk";
		case "write":
			return hu
				? `${input.sectionCount} szakasz megírása hivatkozásokkal`
				: `write ${input.sectionCount} sections with citations`;
		case "verify":
			return hu
				? "minden hivatkozott szám ellenőrzése · bizonyosság megállapítása"
				: "verify every cited figure · settle confidence per claim";
		case "render":
			return hu
				? "HTML, PDF és Markdown előállítása"
				: "render HTML, PDF and Markdown";
	}
}

export interface BuildAtlasV2ProgressDetailsInput {
	phase: AtlasV2Phase;
	language: SupportedLanguage;
	plan: AtlasV2Plan | null;
	/** Question id -> how many indexed sources answer it. */
	sourceCountByQuestion?: Record<string, number>;
	/** Question ids currently being researched. */
	runningQuestionIds?: readonly string[];
	/** Question ids whose research finished. */
	doneQuestionIds?: readonly string[];
	confidenceByQuestion?: Record<string, AtlasV2QuestionConfidence>;
	round: { current: number; total: number };
	sourcesRead: number;
	evidence?: AtlasV2ProgressEvidence;
}

export function buildAtlasV2ProgressDetails(
	input: BuildAtlasV2ProgressDetailsInput,
): AtlasV2ProgressDetails {
	const running = new Set(input.runningQuestionIds ?? []);
	const done = new Set(input.doneQuestionIds ?? []);
	const plan: AtlasV2ProgressPlanEntry[] = (input.plan?.questions ?? []).map(
		(question) => ({
			id: question.id,
			question: question.question,
			status: done.has(question.id)
				? "done"
				: running.has(question.id)
					? "running"
					: "queued",
			sourceCount: input.sourceCountByQuestion?.[question.id] ?? 0,
			...(input.confidenceByQuestion?.[question.id]
				? { confidence: input.confidenceByQuestion[question.id] }
				: {}),
		}),
	);
	return {
		pipelineVersion: 2,
		queries: [],
		phase: input.phase,
		plan,
		round: input.round,
		sourcesRead: input.sourcesRead,
		next: buildAtlasV2NextLine({
			phase: input.phase,
			language: input.language,
			sectionCount: input.plan?.sections.length ?? 0,
			questionCount: input.plan?.questions.length ?? 0,
			round: input.round,
		}),
		...(input.evidence ? { evidence: input.evidence } : {}),
	};
}

export function buildAtlasV2ProgressEvidence(input: {
	index: AtlasV2EvidenceIndex;
	totals: AtlasV2VerificationTotals;
	/** Published source numbers at least one surviving sentence cites. */
	citedSourceNumbers: readonly number[];
	/** Published-numbering view of the sources (see render.ts). */
	publishedSources: AtlasV2EvidenceIndex["sources"];
}): AtlasV2ProgressEvidence {
	const cited = new Set(input.citedSourceNumbers);
	const sources: AtlasV2ProgressEvidenceSource[] = input.publishedSources.map(
		(source) => ({
			n: source.n,
			title: source.title,
			host: source.host,
			date: source.date,
			cited: cited.has(source.n),
			snippet: sourceEvidenceText(source)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS),
		}),
	);
	return {
		corroborated: input.totals.corroborated,
		single: input.totals.single,
		inferred: input.totals.inferred,
		cut: input.totals.cut,
		filteredCount: input.index.filteredCount,
		sources,
	};
}

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

function planStatus(value: unknown): AtlasV2ProgressPlanEntry["status"] {
	return value === "running" || value === "done" ? value : "queued";
}

function questionConfidence(
	value: unknown,
): AtlasV2QuestionConfidence | undefined {
	return value === "corroborated" ||
		value === "single" ||
		value === "mixed" ||
		value === "thin"
		? value
		: undefined;
}

function phase(value: unknown): AtlasV2Phase {
	return ATLAS_V2_PHASES.includes(value as AtlasV2Phase)
		? (value as AtlasV2Phase)
		: "plan";
}

/**
 * True when a stored progress-details blob is the v2 shape. Used by
 * `atlas/read-model.ts` to dispatch between the two contracts.
 */
export function isAtlasV2ProgressDetails(value: unknown): boolean {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		(value as { pipelineVersion?: unknown }).pipelineVersion === 2
	);
}

export function sanitizeAtlasV2ProgressDetails(
	value: unknown,
): AtlasV2ProgressDetails {
	const record = (value ?? {}) as Record<string, unknown>;
	const planEntries = Array.isArray(record.plan) ? record.plan : [];
	const plan: AtlasV2ProgressPlanEntry[] = planEntries
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const planRecord = entry as Record<string, unknown>;
			const id = cleanText(planRecord.id, 32);
			const question = cleanText(
				planRecord.question,
				ATLAS_V2_MAX_QUESTION_CHARS,
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
		.filter((entry): entry is AtlasV2ProgressPlanEntry => Boolean(entry))
		.slice(0, ATLAS_V2_MAX_PLAN_ENTRIES);

	const roundRecord = (record.round ?? {}) as Record<string, unknown>;
	const total = Math.max(1, nonNegativeInteger(roundRecord.total) || 1);
	const round = {
		current: Math.min(
			total,
			Math.max(1, nonNegativeInteger(roundRecord.current) || 1),
		),
		total,
	};

	const details: AtlasV2ProgressDetails = {
		pipelineVersion: 2,
		queries: [],
		phase: phase(record.phase),
		plan,
		round,
		sourcesRead: nonNegativeInteger(record.sourcesRead),
		next: cleanText(record.next, ATLAS_V2_MAX_NEXT_CHARS),
	};

	const evidence = sanitizeEvidence(record.evidence);
	return evidence ? { ...details, evidence } : details;
}

function sanitizeEvidence(value: unknown): AtlasV2ProgressEvidence | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const sourceEntries = Array.isArray(record.sources) ? record.sources : [];
	const sources: AtlasV2ProgressEvidenceSource[] = sourceEntries
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
				title: cleanText(sourceRecord.title, ATLAS_V2_MAX_TITLE_CHARS) || host,
				host,
				date: date || null,
				cited: sourceRecord.cited === true,
				snippet: cleanText(
					sourceRecord.snippet,
					ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS,
				),
			};
		})
		.filter((entry): entry is AtlasV2ProgressEvidenceSource => Boolean(entry))
		.slice(0, ATLAS_V2_MAX_EVIDENCE_SOURCES);

	return {
		corroborated: nonNegativeInteger(record.corroborated),
		single: nonNegativeInteger(record.single),
		inferred: nonNegativeInteger(record.inferred),
		cut: nonNegativeInteger(record.cut),
		filteredCount: nonNegativeInteger(record.filteredCount),
		sources,
	};
}
