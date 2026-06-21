export const ATLAS_PROFILES = ["overview", "in-depth", "exhaustive"] as const;
export const ATLAS_ACTIONS = ["create", "continue", "fork", "revise"] as const;
export const ATLAS_JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export const ATLAS_EVIDENCE_PACK_SCHEMA_VERSION = "atlas.evidence-pack.v1";
export const ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION = "atlas.coverage-review.v1";
export const ATLAS_ASSEMBLY_SCHEMA_VERSION = "atlas.assembly.v1";
export const ATLAS_CLAIM_BASIS_SCHEMA_VERSION = "atlas.claim-basis.v1";
export const ATLAS_CLAIM_SUPPORT_LEVELS = [
	"supported",
	"partial",
	"unsupported",
] as const;
export const ATLAS_GAP_PROPOSAL_PRIORITIES = [
	"critical",
	"high",
	"medium",
	"low",
] as const;

export type AtlasProfile = (typeof ATLAS_PROFILES)[number];
export type AtlasAction = (typeof ATLAS_ACTIONS)[number];
export type AtlasJobStatus = (typeof ATLAS_JOB_STATUSES)[number];
export type AtlasGapProposalPriority =
	(typeof ATLAS_GAP_PROPOSAL_PRIORITIES)[number];
export type AtlasClaimSupportLevel =
	(typeof ATLAS_CLAIM_SUPPORT_LEVELS)[number];

export type AtlasEvidencePackSourceKind = "web" | "local";
export type AtlasEvidencePackAuthority =
	| "explicit_local"
	| "working_document"
	| "automatic_local"
	| "accepted_web"
	| "parent_seed";

export interface AtlasEvidencePackSourceRef {
	id: string;
	kind: AtlasEvidencePackSourceKind;
	title: string;
	url: string | null;
	authority: AtlasEvidencePackAuthority;
}

export interface AtlasEvidencePackFreshness {
	asOfDate: string | null;
	retrievedAt: string | null;
	isCurrentEvidence: boolean;
	parentAtlasJobId: string | null;
	note: string | null;
}

export interface AtlasEvidencePack {
	version: typeof ATLAS_EVIDENCE_PACK_SCHEMA_VERSION;
	id: string;
	sourceRefs: AtlasEvidencePackSourceRef[];
	sourceKind: AtlasEvidencePackSourceKind;
	authority: AtlasEvidencePackAuthority;
	supportedFacets: string[];
	supportedQuestions: string[];
	evidence: {
		summary: string;
		excerpt: string;
	};
	conflicts: string[];
	limitations: string[];
	freshness: AtlasEvidencePackFreshness;
	affectedSectionHint: string | null;
	versionNote: string;
}

export interface AtlasEvidencePackDiagnostic {
	code: string;
	severity: "info" | "warning";
	message: string;
}

export interface AtlasGapProposal {
	missingQuestion: string;
	whyCurrentEvidenceIsWeak: string;
	targetSearchQuery: string;
	desiredEvidenceType: string;
	affectedSection: string;
	priority: AtlasGapProposalPriority;
}

export interface AtlasCoverageReviewDiagnostic {
	code: string;
	severity: "info" | "warning";
	message: string;
	proposal?: AtlasGapProposal;
}

export interface AtlasCoverageReviewLimitation {
	code: string;
	message: string;
}

export interface AtlasCoverageReview {
	version: typeof ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION;
	sufficient: boolean;
	proposals: AtlasGapProposal[];
	approvedGapCandidates: AtlasGapProposal[];
	diagnostics: AtlasCoverageReviewDiagnostic[];
	limitations: AtlasCoverageReviewLimitation[];
}

export interface AtlasSectionBriefSourceAssociation {
	sourceId: string;
	sourceKind: AtlasEvidencePackSourceKind | null;
	sourceTitle: string | null;
	url: string | null;
	evidencePackId: string | null;
	relevance: string | null;
}

export interface AtlasSectionBrief {
	sectionTitle: string;
	brief: string;
	evidencePackIds: string[];
	sourceAssociations: AtlasSectionBriefSourceAssociation[];
	limitations: string[];
}

export interface AtlasAssemblyMetadata {
	version: typeof ATLAS_ASSEMBLY_SCHEMA_VERSION;
	generatedTitle: string | null;
	sectionBriefs: AtlasSectionBrief[];
	limitations: string[];
	structured: boolean;
}

export interface AtlasClaimLocator {
	sectionTitle: string | null;
	paragraphIndex: number | null;
	claimIndex: number | null;
	claimText: string;
	quote: string | null;
	startOffset: number | null;
	endOffset: number | null;
}

export interface AtlasClaimBasis {
	version: typeof ATLAS_CLAIM_BASIS_SCHEMA_VERSION;
	id: string;
	locator: AtlasClaimLocator;
	supportLevel: AtlasClaimSupportLevel;
	evidencePackIds: string[];
	sourceRefs: AtlasEvidencePackSourceRef[];
	supportRationale: string;
	auditConcernCode: string | null;
}

export interface AtlasClaimBasisDiagnostic {
	code: string;
	severity: "info" | "warning";
	message: string;
	sectionTitle?: string | null;
	basisId?: string;
}

export interface AtlasClaimBasisLimitation {
	code: string;
	message: string;
	basisIds: string[];
	sectionTitle: string | null;
}

export interface AtlasClaimBasisSectionCoverage {
	sectionTitle: string;
	factualClaimCount: number;
	basisCount: number;
	supportedCount: number;
	partialCount: number;
	unsupportedCount: number;
	density: number;
}

export interface AtlasClaimBasisResult {
	version: typeof ATLAS_CLAIM_BASIS_SCHEMA_VERSION;
	claimBasis: AtlasClaimBasis[];
	limitations: AtlasClaimBasisLimitation[];
	diagnostics: AtlasClaimBasisDiagnostic[];
	coverageBySection: AtlasClaimBasisSectionCoverage[];
	status: "succeeded" | "failed";
	failureReason: string | null;
	retryRequested: boolean;
}

export interface AtlasJobProgress {
	percent: number;
	stage: string;
	details: AtlasJobProgressDetails;
}

export interface AtlasJobProgressDetails {
	queries: string[];
	roundKind?: "initial" | "gap-fill";
	focus?: string[];
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
	"coverage-review",
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

export interface AtlasImageCandidate {
	id: string;
	query: string;
	title: string;
	imageUrl: string;
	sourcePageUrl: string | null;
	sourceTitle: string | null;
	thumbnailUrl: string | null;
	width: number | null;
	height: number | null;
	caption: string;
	selectionReason: string;
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
