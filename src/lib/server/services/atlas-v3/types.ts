// Atlas v3 content-pipeline types (ADR 0063).
//
// Deliberately separate from `atlas-v2/types.ts`. v3 shares the job ledger,
// checkpoints, lifecycle, rendering and the `research_web` adapter with v2, and
// shares no content types with it: the unit of work is a CLAIM, not a section,
// and a citation is an evidence id, not a source number. Numbers are minted
// mechanically at render time (see render.ts), which is why nothing below
// carries one.

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

export const ATLAS_V3_CHECKPOINT_SCHEMA_VERSION = "atlas.v3.checkpoint.v1";

// ---------------------------------------------------------------------------
// 1. The ask
// ---------------------------------------------------------------------------

export const ATLAS_V3_SHAPES = [
	"comparison",
	"explanation",
	"forecast",
	"timeline",
	"mixed",
] as const;
export type AtlasV3Shape = (typeof ATLAS_V3_SHAPES)[number];

export interface AtlasV3Ask {
	/** The request restated as the decision the reader faces. */
	decision: string;
	/** Requirements the user did not spell out but expects to be met. */
	implicitRequirements: string[];
	/** Stakeholder viewpoints the report must not collapse into one. */
	perspectives: string[];
	shape: AtlasV3Shape;
	/** The one question the verdict must answer. */
	coreQuestion: string;
	/** At most 70 characters; the report and job title. */
	title: string;
	/** Sub-questions the first research round fans out to. */
	subQuestions: string[];
}

// ---------------------------------------------------------------------------
// 2. Evidence bank
// ---------------------------------------------------------------------------

/**
 * Source tiers, best first. Reading budget is spent top-down and a claim
 * resting only on `weak` is never `verified`.
 *
 *  - `primary`     regulators, statistics offices, standards bodies,
 *                  ministries, central banks, manufacturers' own documentation,
 *                  peer-reviewed papers, filings.
 *  - `press`       major newsrooms and trade press with their own reporting.
 *  - `aggregator`  syndicators, mirrors, press-release wires, comparison sites.
 *  - `weak`        forums, marketplaces, menus, vendor marketing, blogspam.
 */
export const ATLAS_V3_SOURCE_TIERS = [
	"primary",
	"press",
	"aggregator",
	"weak",
] as const;
export type AtlasV3SourceTier = (typeof ATLAS_V3_SOURCE_TIERS)[number];

export interface AtlasV3Source {
	/** `s1`. Stable for the life of the job. */
	id: string;
	canonicalUrl: string;
	host: string;
	/** Publisher organisation id (atlas-v2/publishers.ts). Independence key. */
	publisher: string;
	title: string;
	date: string | null;
	tier: AtlasV3SourceTier;
	/** True once a page read produced text for this source. */
	read: boolean;
}

/** One verbatim span the writer may cite. Nothing else leaves the bank. */
export interface AtlasV3Quote {
	/** `e12`. */
	id: string;
	sourceId: string;
	/** Verbatim, whitespace-normalised, capped. Never paraphrased. */
	text: string;
	/** The sub-question the read was performed for. */
	goal: string;
}

export const ATLAS_V3_CLAIM_STATUSES = [
	"verified",
	"single",
	"contested",
	"open",
] as const;
/**
 * `verified` — the same value from ≥2 independent publishers.
 * `single`    — one publisher.
 * `contested` — independent publishers disagree on the value.
 * `open`      — asserted by the research note but no quote carries the value.
 */
export type AtlasV3ClaimStatus = (typeof ATLAS_V3_CLAIM_STATUSES)[number];

export interface AtlasV3Claim {
	/** `c3`. */
	id: string;
	entity: string;
	metric: string;
	value: string;
	unit: string | null;
	/** The period the value covers, e.g. `2025` or `Q1 2026`. */
	period: string | null;
	/** When the value was published or last revised. */
	asOf: string | null;
	/**
	 * The measurement identity: `grid-connected EU-27 additions`, `AC`, `list
	 * price`. Two claims with different series do NOT contradict each other.
	 */
	series: string | null;
	/** Quote ids that state this value verbatim. */
	evidenceIds: string[];
	status: AtlasV3ClaimStatus;
}

export interface AtlasV3EvidenceBank {
	sources: AtlasV3Source[];
	quotes: AtlasV3Quote[];
	claims: AtlasV3Claim[];
	/** Raw hits the deterministic filters removed or merged away. */
	filteredCount: number;
}

// ---------------------------------------------------------------------------
// 3. Research rounds and the rebuilt workspace
// ---------------------------------------------------------------------------

export interface AtlasV3BudgetUsed {
	searches: number;
	pagesRead: number;
	rounds: number;
}

/**
 * The workspace. REWRITTEN from the round's notes every round, never appended
 * to: an accumulating transcript is the failure mode this pipeline exists to
 * avoid.
 */
export interface AtlasV3Memo {
	answerSoFar: string;
	/** Claim ids in the bank, best-supported first. */
	claimIds: string[];
	openQuestions: string[];
	/** Questions the evidence says are not answerable; never re-asked. */
	deadEnds: string[];
	budgetUsed: AtlasV3BudgetUsed;
}

/** One isolated researcher's cleaned answer for one sub-question. */
export interface AtlasV3FindingsNote {
	subQuestion: string;
	/** What the researcher concluded, in at most a short paragraph. */
	summary: string;
	quotes: AtlasV3Quote[];
	claims: AtlasV3Claim[];
	openQuestions: string[];
	deadEnds: string[];
	searches: number;
	pagesRead: number;
	error: string | null;
}

// ---------------------------------------------------------------------------
// 4. Living outline
// ---------------------------------------------------------------------------

export const ATLAS_V3_NODE_STATUSES = [
	"planned",
	"ready",
	"thin",
	"cut",
] as const;
export type AtlasV3NodeStatus = (typeof ATLAS_V3_NODE_STATUSES)[number];

export interface AtlasV3OutlineNode {
	/** `n1`. */
	id: string;
	title: string;
	/** The claim this section exists to defend. Not a topic. */
	claim: string;
	/** What this node still needs, in the researcher's words. */
	needs: string[];
	/** Quote ids bound to this node. Two nodes may not share a set. */
	evidenceIds: string[];
	status: AtlasV3NodeStatus;
}

export interface AtlasV3Outline {
	nodes: AtlasV3OutlineNode[];
	/** Nodes the revision cut, with why, for the diagnostics. */
	cut: Array<{ id: string; title: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// 5. Goal test
// ---------------------------------------------------------------------------

export interface AtlasV3GoalVerdict {
	passed: boolean;
	/** True when the core claim table has ≥2 independent publishers. */
	coreCorroborated: boolean;
	/** Node ids that do not yet carry enough bound evidence. */
	thinNodeIds: string[];
	/** Targeted sub-questions the next round should research. */
	gaps: string[];
	/** True when the budget is spent and the goal cannot be reached. */
	exhausted: boolean;
	/** True when the report must abstain rather than pad. */
	abstain: boolean;
	reason: string;
}

// ---------------------------------------------------------------------------
// 6. Answer table
// ---------------------------------------------------------------------------

export interface AtlasV3AnswerCell {
	text: string;
	/** Quote ids supporting this cell. Empty only on a label column. */
	evidenceIds: string[];
	/** Id of a `derived` entry when the cell is computed, not quoted. */
	calcId?: string | null;
}

export interface AtlasV3Derived {
	/** `k1`. */
	id: string;
	label: string;
	/** A single Python expression over figures the cited inputs state. */
	expression: string;
	/** Quote ids the expression's inputs come from. */
	inputs: string[];
	/** Filled in by run_python; null when the sandbox could not evaluate it. */
	value: string | null;
}

export interface AtlasV3AnswerTable {
	kind: "comparison" | "timeline" | "figures";
	title: string;
	columns: Array<{ key: string; label: string }>;
	rows: Array<Record<string, AtlasV3AnswerCell>>;
	derived: AtlasV3Derived[];
}

// ---------------------------------------------------------------------------
// 7. Writer output
// ---------------------------------------------------------------------------

export const ATLAS_V3_SENTENCE_KINDS = [
	"claim",
	"synthesis",
	"adjudication",
] as const;
/**
 * `claim`        a figure or fact a quote states.
 * `synthesis`    a conclusion spanning sources. MAY carry a figure, but only a
 *                computed one (`calcId`) or one its own evidence ids state.
 * `adjudication` names two series or publishers and says which to believe.
 */
export type AtlasV3SentenceKind = (typeof ATLAS_V3_SENTENCE_KINDS)[number];

export interface AtlasV3Sentence {
	text: string;
	/** Quote ids. Numbers are minted at render; the writer never types one. */
	evidenceIds: string[];
	kind: AtlasV3SentenceKind;
	/** Id of an answer-table `derived` entry whose value this sentence uses. */
	calcId: string | null;
}

export interface AtlasV3WrittenSection {
	nodeId: string;
	title: string;
	paragraphs: AtlasV3Sentence[][];
	/** A table or timeline this section owns, rendered as its own block. */
	table: AtlasV3AnswerTable | null;
}

// ---------------------------------------------------------------------------
// 8. Critic
// ---------------------------------------------------------------------------

export const ATLAS_V3_FAILURE_CODES = [
	"no_verdict",
	"repeated_claim",
	"hollow_sentence",
	"unsupported_figure",
	"averaged_conflict",
	"thin_section",
	"missed_requirement",
	"register",
] as const;
export type AtlasV3FailureCode = (typeof ATLAS_V3_FAILURE_CODES)[number];

export const ATLAS_V3_INSTRUCTION_KINDS = [
	"rewrite",
	"cut",
	"needs_evidence",
] as const;
export type AtlasV3InstructionKind =
	(typeof ATLAS_V3_INSTRUCTION_KINDS)[number];

export interface AtlasV3Finding {
	code: AtlasV3FailureCode;
	/** Outline node id, or null for a whole-report finding. */
	nodeId: string | null;
	/** The offending sentence, verbatim, when the finding names one. */
	quote: string | null;
	detail: string;
	instruction: {
		kind: AtlasV3InstructionKind;
		/** Present on `needs_evidence`: what to research. */
		query?: string;
	};
}

// ---------------------------------------------------------------------------
// 9. Verification
// ---------------------------------------------------------------------------

export const ATLAS_V3_VERIFY_OUTCOMES = [
	"kept",
	"rewritten",
	"needs_evidence",
	"cut",
] as const;
export type AtlasV3VerifyOutcome = (typeof ATLAS_V3_VERIFY_OUTCOMES)[number];

export const ATLAS_V3_CONFIDENCE_LEVELS = [
	"corroborated",
	"single",
	"inferred",
] as const;
export type AtlasV3Confidence = (typeof ATLAS_V3_CONFIDENCE_LEVELS)[number];

export interface AtlasV3VerifiedSentence {
	text: string;
	evidenceIds: string[];
	kind: AtlasV3SentenceKind;
	confidence: AtlasV3Confidence;
	outcome: AtlasV3VerifyOutcome;
	/** Why the sentence failed, handed verbatim to the critic. */
	failures: string[];
}

export interface AtlasV3VerifiedSection {
	nodeId: string;
	title: string;
	paragraphs: AtlasV3VerifiedSentence[][];
	table: AtlasV3AnswerTable | null;
}

export interface AtlasV3VerificationTotals {
	corroborated: number;
	single: number;
	inferred: number;
	/** Sentences the final pass cut as restatement or over-quota inference. */
	repeated: number;
	cut: number;
	needsEvidence: number;
}

export interface AtlasV3VerificationResult {
	sections: AtlasV3VerifiedSection[];
	totals: AtlasV3VerificationTotals;
	/** Quote ids at least one kept sentence cites. */
	citedEvidenceIds: string[];
	/** Sentences the verifier wants better evidence for, for the critic. */
	needsEvidence: Array<{ nodeId: string; text: string; query: string }>;
	/** Source ids whose date is older than the stale window. */
	staleSourceIds: string[];
}

// ---------------------------------------------------------------------------
// 10. Limitations, honestly
// ---------------------------------------------------------------------------

/**
 * What could not be established and WHY. Never "five sentences were removed" —
 * the mechanic that produced v2's uninformative Limitations list.
 */
export interface AtlasV3Limitation {
	/** What the report could not establish. */
	subject: string;
	/** Why: no published series, conflicting definitions, paywalled, stale. */
	reason: string;
}

// ---------------------------------------------------------------------------
// UI contract (progress details on the job row)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface AtlasV3Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasV3PipelineResult {
	status: "succeeded";
	stage: "render";
	pipelineVersion: 3;
	title: string;
	/** The verdict; becomes the assistant message content. */
	executiveSummaryMarkdown: string;
	/** True when the goal test could not be met and the report says so. */
	abstained: boolean;
	outputs: {
		fileProductionJobId: string | null;
		htmlChatGeneratedFileId: string | null;
		pdfChatGeneratedFileId: string | null;
		markdownChatGeneratedFileId: string | null;
	};
	usage: AtlasV3Usage;
	sourceCounts: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	diagnostics: AtlasV3QualityDiagnostics;
}

export class AtlasV3PipelineError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AtlasV3PipelineError";
		this.code = code;
	}
}
