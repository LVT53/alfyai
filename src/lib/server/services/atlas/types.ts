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

export interface AtlasJobProgress {
	percent: number;
	stage: string;
	details: AtlasJobProgressDetails;
}

export interface AtlasJobProgressDetails {
	queries: string[];
}

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

export const ATLAS_PIPELINE_STAGES = [
	"decompose",
	"search",
	"curate",
	"synthesize",
	"integrate",
	"assemble",
	"audit",
	"render",
] as const;

export type AtlasPipelineStage = (typeof ATLAS_PIPELINE_STAGES)[number];

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
}

export interface AtlasHonestyMarker {
	code: string;
	message: string;
	severity: "info" | "warning" | "critical";
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
