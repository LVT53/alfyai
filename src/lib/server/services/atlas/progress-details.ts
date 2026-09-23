// The stored `atlas_jobs.progress_details_json` contract (ADR 0062, ADR 0063),
// for all three Atlas pipelines, and the sanitiser that projects it back onto
// the `AtlasJobCard` the chat UI reads.
//
// The contract is versioned by `pipelineVersion`, so v1's
// `{ queries, roundKind, focus }` details keep working untouched, v2's and
// v3's sanitisers dispatch rather than merge the two shapes, and a client
// that dispatches on `pipelineVersion === 2` degrades a v3 blob to the v1
// branch — which reads `queries`, always empty on v2 and v3 — instead of
// crashing.
//
// This module is the shared home for the contract: `atlas/read-model.ts` (the
// read path) and `atlas/job-ledger.ts` (through `read-model.ts`, the write
// path) both go through it instead of importing v2 or v3 internals directly.
// The v2 types and sanitiser here are a copy of v2's own
// (`atlas-v2/progress.ts`, `atlas-v2/types.ts`), which keeps its copy so v2
// stays runnable unchanged until it is deleted; v3's copy here is the one v3
// now imports (`atlas-v3/types.ts` re-exports these names so v3's own
// importers do not change).

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

/**
 * v1's progress details. Unchanged; ADR 0062 added the v2 shape alongside it
 * rather than merging the two, and this module dispatches on
 * `pipelineVersion`.
 */
export interface AtlasV1JobProgressDetails {
	queries: string[];
	roundKind?: "initial" | "gap-fill";
	focus?: string[];
}

// ---------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------

export const ATLAS_V2_PHASES = [
	"plan",
	"research",
	"index",
	"write",
	"verify",
	"render",
] as const;
export type AtlasV2Phase = (typeof ATLAS_V2_PHASES)[number];

export const ATLAS_V2_QUESTION_CONFIDENCES = [
	"corroborated",
	"single",
	"mixed",
	"thin",
] as const;
export type AtlasV2QuestionConfidence =
	(typeof ATLAS_V2_QUESTION_CONFIDENCES)[number];

export interface AtlasV2ProgressPlanEntry {
	id: string;
	question: string;
	status: "queued" | "running" | "done";
	sourceCount: number;
	confidence?: AtlasV2QuestionConfidence;
}

export interface AtlasV2ProgressEvidenceSource {
	n: number;
	title: string;
	host: string;
	date: string | null;
	cited: boolean;
	/**
	 * Truncated source text. Present so `scripts/atlas-eval.ts` can re-check
	 * number matches offline without re-fetching the web (ADR 0062).
	 */
	snippet: string;
}

export interface AtlasV2ProgressEvidence {
	corroborated: number;
	single: number;
	inferred: number;
	cut: number;
	filteredCount: number;
	sources: AtlasV2ProgressEvidenceSource[];
}

export interface AtlasV2ProgressDetails {
	pipelineVersion: 2;
	/**
	 * Always empty on v2 — the `plan` array replaced the per-round query list.
	 * Kept in the payload so a client that reads v1's `queries` unconditionally
	 * degrades to "no queries" instead of crashing on a v2 job.
	 */
	queries: string[];
	phase: AtlasV2Phase;
	plan: AtlasV2ProgressPlanEntry[];
	round: { current: number; total: number };
	sourcesRead: number;
	next: string;
	evidence?: AtlasV2ProgressEvidence;
	/**
	 * Wall time each phase took, in milliseconds. Present from the write phase
	 * onwards so `scripts/atlas-eval.ts` can report where a slow run went.
	 */
	phaseDurationsMs?: Record<string, number>;
	/**
	 * Sections the writer produced against the number the plan promised, present
	 * from the verify phase onwards. `written < planned` is a defect, and it is
	 * reported here so the evaluation sees it without reading the server log.
	 */
	sections?: { written: number; planned: number };
	/**
	 * Writer calls that ended at their output cap, and what the pipeline did
	 * about them. Present from the write phase onwards. A non-zero `length` is
	 * a defect the wall time alone reads as "the model was slow", so it is
	 * reported where `scripts/atlas-eval.ts` can see it.
	 */
	writerRunaways?: {
		length: number;
		salvaged: number;
		retried: number;
		fallback: number;
	};
}

/** Caps applied when sanitising, so a job row can never grow unbounded. */
export const ATLAS_V2_MAX_PLAN_ENTRIES = 24;
export const ATLAS_V2_MAX_EVIDENCE_SOURCES = 96;
export const ATLAS_V2_MAX_QUESTION_CHARS = 240;
export const ATLAS_V2_MAX_NEXT_CHARS = 200;
export const ATLAS_V2_MAX_TITLE_CHARS = 160;
/**
 * Per-source snippet budget. Present so `scripts/atlas-eval.ts` can re-check
 * number matches offline from the job row instead of re-fetching the web, and
 * sized so the text carries the PAGE EXCERPT as well as the search snippets:
 * at 500 chars the harness was checking figures against the snippet alone and
 * reporting mismatches the page it read plainly contained.
 */
export const ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS = 1200;

/**
 * Phase names `phaseDurationsMs` may carry. Fixed rather than free-form so the
 * job row cannot be grown by an unexpected key, and named separately from the
 * phases because verification splits into work worth timing on its own.
 */
export const ATLAS_V2_PHASE_DURATION_KEYS = [
	"plan",
	"research",
	"coverage",
	"index",
	"write",
	"verify",
	"summary",
	"render",
] as const;

/**
 * True when a stored progress-details blob is the v2 shape. Used to dispatch
 * between the three contracts.
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
			const confidence = questionConfidenceV2(planRecord.confidence);
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
		phase: phaseV2(record.phase),
		plan,
		round,
		sourcesRead: nonNegativeInteger(record.sourcesRead),
		next: cleanText(record.next, ATLAS_V2_MAX_NEXT_CHARS),
	};

	const durations = sanitizePhaseDurations(
		record.phaseDurationsMs,
		ATLAS_V2_PHASE_DURATION_KEYS,
	);
	const withDurations = durations
		? { ...details, phaseDurationsMs: durations }
		: details;
	const sections = sanitizeSectionCounts(record.sections);
	const withSections = sections
		? { ...withDurations, sections }
		: withDurations;
	const writerRunaways = sanitizeWriterRunaways(record.writerRunaways);
	const withRunaways = writerRunaways
		? { ...withSections, writerRunaways }
		: withSections;
	const evidence = sanitizeV2Evidence(record.evidence);
	return evidence ? { ...withRunaways, evidence } : withRunaways;
}

function phaseV2(value: unknown): AtlasV2Phase {
	return (ATLAS_V2_PHASES as readonly string[]).includes(value as string)
		? (value as AtlasV2Phase)
		: "plan";
}

function questionConfidenceV2(
	value: unknown,
): AtlasV2QuestionConfidence | undefined {
	return value === "corroborated" ||
		value === "single" ||
		value === "mixed" ||
		value === "thin"
		? value
		: undefined;
}

/** Writer runaway counters, or null when the job reported none. */
function sanitizeWriterRunaways(
	value: unknown,
): AtlasV2ProgressDetails["writerRunaways"] | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const keys = ["length", "salvaged", "retried", "fallback"] as const;
	if (keys.every((key) => record[key] === undefined)) return null;
	return {
		length: nonNegativeInteger(record.length),
		salvaged: nonNegativeInteger(record.salvaged),
		retried: nonNegativeInteger(record.retried),
		fallback: nonNegativeInteger(record.fallback),
	};
}

function sanitizeV2Evidence(value: unknown): AtlasV2ProgressEvidence | null {
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

// ---------------------------------------------------------------------------
// v3
// ---------------------------------------------------------------------------

export const ATLAS_V3_PHASES = [
	"ask",
	"research",
	"outline",
	"answer",
	"write",
	"critic",
	"verify",
	"render",
] as const;
export type AtlasV3Phase = (typeof ATLAS_V3_PHASES)[number];

export interface AtlasV3ProgressPlanEntry {
	id: string;
	question: string;
	status: "queued" | "running" | "done";
	sourceCount: number;
	confidence?: "corroborated" | "single" | "mixed" | "thin";
}

export interface AtlasV3ProgressEvidenceSource {
	n: number;
	title: string;
	host: string;
	date: string | null;
	cited: boolean;
	snippet: string;
}

export interface AtlasV3ProgressEvidence {
	corroborated: number;
	single: number;
	inferred: number;
	cut: number;
	filteredCount: number;
	sources: AtlasV3ProgressEvidenceSource[];
}

export interface AtlasV3QualityDiagnostics {
	/** True when the goal test failed and the report says so. */
	abstained: boolean;
	verdictPresent: boolean;
	/** True when the verdict was assembled from the sections, not written. */
	verdictFallback: boolean;
	/** Sentences the final pass cut as restatement or over-quota inference. */
	repeatedSentences: number;
	claimCount: number;
	verifiedClaimCount: number;
	contestedClaimCount: number;
	/** Readings joined by the loose identity match, not by the strict key. */
	claimsMerged: number;
	answerTableCells: number;
	derivedFigures: number;
	criticRounds: number;
	criticFindings: number;
	needsEvidenceResolved: number;
	roundsRun: number;
	searches: number;
	pagesRead: number;
	sectionsPlanned: number;
	sectionsWritten: number;
	/** Sections appended because the outline model fell below `minSections`. */
	sectionsSupplemented: number;
	wordCount: number;
	writerRunaways: {
		length: number;
		salvaged: number;
		retried: number;
		fallback: number;
	};
}

export interface AtlasV3ProgressDetails {
	pipelineVersion: 3;
	/** Always empty; kept so a v1-shaped client degrades instead of crashing. */
	queries: string[];
	phase: AtlasV3Phase;
	/** Outline nodes, projected as the questions the v2 card already renders. */
	plan: AtlasV3ProgressPlanEntry[];
	round: { current: number; total: number };
	sourcesRead: number;
	next: string;
	evidence?: AtlasV3ProgressEvidence;
	phaseDurationsMs?: Record<string, number>;
	sections?: { written: number; planned: number };
	qualityDiagnostics?: AtlasV3QualityDiagnostics;
}

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
			const confidence = questionConfidenceV3(planRecord.confidence);
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
		phase: phaseV3(record.phase),
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

	const durations = sanitizePhaseDurations(
		record.phaseDurationsMs,
		ATLAS_V3_PHASE_DURATION_KEYS,
	);
	const sections = sanitizeSectionCounts(record.sections);
	const diagnostics = sanitizeDiagnostics(record.qualityDiagnostics);
	const evidence = sanitizeV3Evidence(record.evidence);
	return {
		...details,
		...(durations ? { phaseDurationsMs: durations } : {}),
		...(sections ? { sections } : {}),
		...(diagnostics ? { qualityDiagnostics: diagnostics } : {}),
		...(evidence ? { evidence } : {}),
	};
}

function phaseV3(value: unknown): AtlasV3Phase {
	return (ATLAS_V3_PHASES as readonly string[]).includes(value as string)
		? (value as AtlasV3Phase)
		: "ask";
}

function questionConfidenceV3(
	value: unknown,
): AtlasV3ProgressPlanEntry["confidence"] {
	return value === "corroborated" ||
		value === "single" ||
		value === "mixed" ||
		value === "thin"
		? value
		: undefined;
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

function sanitizeV3Evidence(value: unknown): AtlasV3ProgressEvidence | null {
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

// ---------------------------------------------------------------------------
// Shared read-path helpers
// ---------------------------------------------------------------------------

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function nonNegativeInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function planStatus(value: unknown): "queued" | "running" | "done" {
	return value === "running" || value === "done" ? value : "queued";
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

/** Per-phase wall time, bounded to the known phase names for that pipeline. */
function sanitizePhaseDurations(
	value: unknown,
	knownKeys: readonly string[],
): Record<string, number> | null {
	if (!value || typeof value !== "object") return null;
	const durations: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const name = cleanText(key, 24);
		if (!name || !knownKeys.includes(name)) continue;
		durations[name] = nonNegativeInteger(raw);
	}
	return Object.keys(durations).length > 0 ? durations : null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type AtlasJobProgressDetails =
	| AtlasV1JobProgressDetails
	| AtlasV2ProgressDetails
	| AtlasV3ProgressDetails;

const MAX_PROGRESS_ITEMS = 8;
const MAX_PROGRESS_TEXT_LENGTH = 140;

function sanitizeProgressText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	if (
		/fetched\s+page\s+excerpt\s*:/i.test(normalized) ||
		/evidence\s+pack/i.test(normalized) ||
		/source\s+excerpt/i.test(normalized)
	) {
		return null;
	}
	return normalized.slice(0, MAX_PROGRESS_TEXT_LENGTH).trim();
}

function parseProgressTextList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(sanitizeProgressText)
		.filter((item): item is string => Boolean(item))
		.slice(0, MAX_PROGRESS_ITEMS);
}

function sanitizeAtlasV1JobProgressDetails(
	value: unknown,
): AtlasV1JobProgressDetails {
	if (!value || typeof value !== "object") return { queries: [] };
	const record = value as {
		queries?: unknown;
		roundKind?: unknown;
		focus?: unknown;
		gapFillFocus?: unknown;
	};
	const queries = parseProgressTextList(record.queries);
	const focus = parseProgressTextList(record.focus ?? record.gapFillFocus);
	const roundKind =
		record.roundKind === "gap-fill" || record.roundKind === "initial"
			? record.roundKind
			: undefined;
	return {
		queries,
		...(roundKind ? { roundKind } : {}),
		...(focus.length > 0 ? { focus } : {}),
	};
}

/**
 * Projects a stored progress-details blob onto the shape the read model and
 * heartbeat use. ADR 0062 added a second contract shape and ADR 0063 a
 * third; `pipelineVersion` selects, and anything else keeps v1's
 * `{ queries, roundKind, focus }` behaviour byte for byte. v3's shape is v2's
 * with `pipelineVersion: 3`, so a client that dispatches on `=== 2` degrades
 * to the v1 branch — which reads `queries`, always empty here — instead of
 * crashing.
 */
export function sanitizeAtlasJobProgressDetails(
	value: unknown,
): AtlasJobProgressDetails {
	if (isAtlasV3ProgressDetails(value)) {
		return sanitizeAtlasV3ProgressDetails(value);
	}
	if (isAtlasV2ProgressDetails(value)) {
		return sanitizeAtlasV2ProgressDetails(value);
	}
	return sanitizeAtlasV1JobProgressDetails(value);
}
