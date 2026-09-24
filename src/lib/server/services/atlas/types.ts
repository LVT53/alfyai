import type {
	AtlasJobProgressDetails,
	AtlasV1JobProgressDetails,
} from "./progress-details";

export type { AtlasJobProgressDetails, AtlasV1JobProgressDetails };

export const ATLAS_PROFILES = ["overview", "in-depth", "exhaustive"] as const;
export const ATLAS_ACTIONS = ["create", "continue", "fork", "revise"] as const;
export const ATLAS_JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;

export type AtlasProfile = (typeof ATLAS_PROFILES)[number];
export type AtlasAction = (typeof ATLAS_ACTIONS)[number];
export type AtlasJobStatus = (typeof ATLAS_JOB_STATUSES)[number];

/**
 * Atlas runs pipeline v3 exclusively (ADR 0063; the v1/v2 pipelines and the
 * `ATLAS_PIPELINE` switch were removed in Phase B of the v3-only
 * consolidation, see ADR 0062's amendment). Every NEW job is stamped this
 * version at kickoff and again at claim, whatever a queued row already
 * carries — `pipeline_version` on old rows stays a historical record of
 * which pipeline produced them, not a live routing switch.
 */
export const ATLAS_CURRENT_PIPELINE_VERSION = 3;
export type AtlasStoredPipelineVersion = 1 | 2 | 3;

export interface AtlasJobProgress {
	percent: number;
	stage: string;
	details: AtlasJobProgressDetails;
}

// `AtlasV1JobProgressDetails` and `AtlasJobProgressDetails` (v1/v2/v3 union)
// live in `./progress-details`, imported and re-exported above, so the read
// model and job ledger can keep importing them from either module.

export interface AtlasJobSourceCounts {
	local: number;
	web: number;
	accepted: number;
	rejected: number;
}

export interface AtlasJobUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasJobOutputs {
	fileProductionJobId: string | null;
	htmlChatGeneratedFileId: string | null;
	pdfChatGeneratedFileId: string | null;
	markdownChatGeneratedFileId: string | null;
}

export interface AtlasEvidenceAppendixSummary {
	status: "checkpoint_only";
	acceptedWebSourceCount: number;
	acceptedLocalSourceCount: number;
	rejectedWebSourceCount: number;
	rawExcerptPresent: boolean;
	rawExcerptLabelCount: number;
	maxSnippetChars: number;
	rejectedReasonCounts: Record<string, number>;
	publishedReportIncludesRawExcerpts: false;
}

export interface AtlasJobError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface AtlasJobCard {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	action: AtlasAction;
	parentAtlasJobId: string | null;
	profile: AtlasProfile;
	/**
	 * Which content pipeline produced (or is producing) this job. 1 and 2 are
	 * ADR 0062's, now historical; 3 is ADR 0063's, and every new job runs on
	 * it (`ATLAS_CURRENT_PIPELINE_VERSION`).
	 */
	pipelineVersion: AtlasStoredPipelineVersion;
	title: string;
	status: AtlasJobStatus;
	stage: string;
	progress: AtlasJobProgress;
	sourceCounts: AtlasJobSourceCounts;
	usage: AtlasJobUsage;
	outputs: AtlasJobOutputs;
	error: AtlasJobError | null;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
}

export interface AtlasPipelineJobContext {
	id: string;
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
	action: AtlasAction;
	parentAtlasJobId: string | null;
	profile: AtlasProfile;
	title: string;
	query: string;
	lifecycle: AtlasLifecycleContext;
	/**
	 * The kickoff user message this job was resolved from (D2/D3 read local
	 * sources and the parent's evidence bank off it); `null` when the query
	 * could not be traced back to a specific user message.
	 */
	kickoffUserMessageId: string | null;
}

export type AtlasDocumentFamilyMode = "new_family" | "same_family";

export interface AtlasDocumentFamilyMetadata {
	familyId: string;
	mode: AtlasDocumentFamilyMode;
	action: AtlasAction;
	rootAtlasJobId: string;
	currentAtlasJobId: string;
	parentAtlasJobId: string | null;
	forkedFromAtlasJobId: string | null;
}

export interface AtlasLifecycleContext {
	family: AtlasDocumentFamilyMetadata;
	seed: AtlasLifecycleSeed | null;
}

export interface AtlasLifecycleSeed {
	parentAtlasJobId: string;
	compressedFindings: unknown;
	curatedSourcePool: unknown | null;
	checkpoint: unknown;
	documentSourceSummary: unknown;
}
