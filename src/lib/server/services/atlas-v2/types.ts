// Atlas v2 content-pipeline types (ADR 0062). Deliberately separate from
// `atlas/types.ts`: v2 shares the job ledger, checkpoints, lifecycle and
// rendering with v1 but shares no content types with it. The one place the
// two meet is the progress-details projection in `atlas/read-model.ts`,
// which dispatches on `pipelineVersion`.

export const ATLAS_PIPELINE_VERSIONS = [1, 2] as const;
export type AtlasPipelineVersion = (typeof ATLAS_PIPELINE_VERSIONS)[number];

export const ATLAS_V2_PHASES = [
	"plan",
	"research",
	"index",
	"write",
	"verify",
	"render",
] as const;
export type AtlasV2Phase = (typeof ATLAS_V2_PHASES)[number];

export const ATLAS_V2_CONFIDENCE_LEVELS = [
	"corroborated",
	"single",
	"inferred",
] as const;
/** Per-claim confidence. `inferred` means no direct source. */
export type AtlasV2Confidence = (typeof ATLAS_V2_CONFIDENCE_LEVELS)[number];

export const ATLAS_V2_PLAN_STATUSES = ["queued", "running", "done"] as const;
export type AtlasV2PlanStatus = (typeof ATLAS_V2_PLAN_STATUSES)[number];

export const ATLAS_V2_QUESTION_CONFIDENCES = [
	"corroborated",
	"single",
	"mixed",
	"thin",
] as const;
export type AtlasV2QuestionConfidence =
	(typeof ATLAS_V2_QUESTION_CONFIDENCES)[number];

export const ATLAS_V2_CHECKPOINT_SCHEMA_VERSION = "atlas.v2.checkpoint.v1";

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface AtlasV2PlanQuestion {
	id: string;
	question: string;
}

export interface AtlasV2PlanSection {
	id: string;
	title: string;
	/** One sentence telling the writer what this section must answer. */
	brief: string;
	/** Question ids whose evidence this section is written from. */
	questionIds: string[];
}

export interface AtlasV2Plan {
	questions: AtlasV2PlanQuestion[];
	sections: AtlasV2PlanSection[];
	/**
	 * Report title the plan stage proposed, at most 70 characters. Null when the
	 * model gave nothing usable; the pipeline then derives one from the request.
	 */
	title?: string | null;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

/** One raw web hit, before the deterministic evidence index runs. */
export interface AtlasV2RawSource {
	questionId: string;
	round: number;
	url: string;
	title: string;
	snippets: string[];
	publishedAt: string | null;
	/** Page text from the `readPages` extraction, when this hit was read. */
	pageExcerpt: string | null;
}

export interface AtlasV2ResearchQuestionOutcome {
	questionId: string;
	queries: string[];
	rawSourceCount: number;
	pagesRead: number;
	error: string | null;
}

export interface AtlasV2ResearchRoundResult {
	round: number;
	rawSources: AtlasV2RawSource[];
	outcomes: AtlasV2ResearchQuestionOutcome[];
}

export interface AtlasV2CoverageReview {
	/** Question ids the control model judged thin. */
	thinQuestionIds: string[];
	/** Targeted follow-up queries, keyed by question id. */
	followUpQueries: Array<{ questionId: string; queries: string[] }>;
	sufficient: boolean;
}

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

export const ATLAS_V2_DROP_REASONS = [
	"unparsable_url",
	"redirect_stub",
	"status_stub",
	"social_profile",
	"boilerplate_only",
	"empty",
	"duplicate_canonical",
	"duplicate_article",
] as const;
export type AtlasV2DropReason = (typeof ATLAS_V2_DROP_REASONS)[number];

export interface AtlasV2DroppedSource {
	url: string;
	host: string | null;
	title: string;
	reason: AtlasV2DropReason;
}

export interface AtlasV2IndexedSource {
	/** 1-based citation number. Stable for the life of the job. */
	n: number;
	canonicalUrl: string;
	host: string;
	/** Publisher organisation id used for corroboration independence. */
	organisation: string;
	title: string;
	date: string | null;
	snippets: string[];
	pageExcerpt: string | null;
	questionIds: string[];
}

export interface AtlasV2EvidenceIndex {
	sources: AtlasV2IndexedSource[];
	dropped: AtlasV2DroppedSource[];
	/** How many raw hits the deterministic filters removed or merged away. */
	filteredCount: number;
	/** Question id -> the citation numbers that answer it. */
	byQuestion: Record<string, number[]>;
}

// ---------------------------------------------------------------------------
// Writer output
// ---------------------------------------------------------------------------

export interface AtlasV2WrittenSentence {
	text: string;
	citations: number[];
	/**
	 * The writer marks a hedged synthesis sentence that no single source
	 * states directly. The verifier confirms no figure sits inside it.
	 */
	inferred: boolean;
	/** Id of a `calculations` entry this sentence's figure comes from. */
	calcId: string | null;
}

export interface AtlasV2WrittenParagraph {
	sentences: AtlasV2WrittenSentence[];
}

export interface AtlasV2Calculation {
	id: string;
	/** A single Python expression over literals drawn from the sources. */
	expression: string;
	/** Citation numbers the expression's inputs come from. */
	inputs: number[];
}

export interface AtlasV2WrittenSection {
	sectionId: string;
	title: string;
	paragraphs: AtlasV2WrittenParagraph[];
	calculations: AtlasV2Calculation[];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const ATLAS_V2_FAILURE_CODES = [
	"unresolved_citation",
	"uncited_figure",
	"number_not_in_source",
	"entailment_failed",
	"inferred_with_figure",
	"contradiction_unstated",
	"calculation_unverified",
] as const;
export type AtlasV2FailureCode = (typeof ATLAS_V2_FAILURE_CODES)[number];

export interface AtlasV2Failure {
	code: AtlasV2FailureCode;
	/** Reader-facing detail: the exact mismatch handed back to the writer. */
	detail: string;
	citation: number | null;
}

export interface AtlasV2Contradiction {
	/**
	 * A short label for WHAT disagrees, lifted from the sentence around the
	 * figure, so the Limitations line names the quantity instead of only two
	 * bare numbers.
	 */
	quantity: string;
	/** Figure as the sentence states it. */
	statedValue: string;
	statedCitation: number;
	/** The independently sourced figure that disagrees. */
	competingValue: string;
	competingCitation: number;
	sentence: string;
}

export interface AtlasV2VerifiedSentence {
	sectionId: string;
	text: string;
	citations: number[];
	confidence: AtlasV2Confidence;
	failures: AtlasV2Failure[];
	/** True when the sentence survived verification (possibly rewritten). */
	kept: boolean;
	rewritten: boolean;
}

export interface AtlasV2VerifiedSection {
	sectionId: string;
	title: string;
	paragraphs: AtlasV2VerifiedSentence[][];
}

export interface AtlasV2VerificationTotals {
	corroborated: number;
	single: number;
	inferred: number;
	cut: number;
}

export interface AtlasV2VerificationResult {
	sections: AtlasV2VerifiedSection[];
	totals: AtlasV2VerificationTotals;
	contradictions: AtlasV2Contradiction[];
	/** Citation numbers whose source date is older than the stale window. */
	staleCitations: number[];
	/** Citation numbers at least one kept sentence cites. */
	citedSourceNumbers: number[];
	/** Claims sent for an entailment check. */
	entailmentCallCount: number;
	/** Model calls those claims cost, after batching. */
	entailmentBatchCount: number;
}

// ---------------------------------------------------------------------------
// UI contract (progress details on the job row)
// ---------------------------------------------------------------------------

export interface AtlasV2ProgressPlanEntry {
	id: string;
	question: string;
	status: AtlasV2PlanStatus;
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
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface AtlasV2Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasV2PipelineResult {
	status: "succeeded";
	stage: "render";
	pipelineVersion: 2;
	title: string;
	/** Executive-summary Markdown; becomes the assistant message content. */
	executiveSummaryMarkdown: string;
	outputs: {
		fileProductionJobId: string | null;
		htmlChatGeneratedFileId: string | null;
		pdfChatGeneratedFileId: string | null;
		markdownChatGeneratedFileId: string | null;
	};
	usage: AtlasV2Usage;
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	verification: AtlasV2VerificationTotals & {
		filteredCount: number;
		contradictionCount: number;
		staleCitationCount: number;
	};
}

export class AtlasV2PipelineError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AtlasV2PipelineError";
		this.code = code;
	}
}
