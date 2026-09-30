// The artifacts service boundary (Feature 2 · Artifacts, ADR-0066): a family
// of five kinds — Document, App, Canvas, Slides, File — on the existing
// `artifacts` backbone, with versions, comments and per-App key-value state in
// three child tables.
//
// Callers import ONLY from this facade (`$lib/server/services/artifacts`),
// never from its internals — the chat-turn facade rule. Slices 1–5 append one
// export block each; nothing outside this directory queries the artifact
// tables directly (the account data archive, which reads everything a user
// owns on purpose, is the one named exception — see its own header).

// Slice 3 (Canvas): the board's own save seam and the ops envelope every
// kind's id-addressed changes go through. Each type slice appends one block.
export { saveCanvasBoard } from "./canvas-ops";
export {
	ARTIFACT_CATALOGUE_MAX,
	ARTIFACT_CATALOGUE_TITLE_MAX_CHARS,
	type ArtifactCatalogueEntry,
	buildArtifactCatalogueBlock,
	listArtifactCatalogueEntries,
	resolveArtifactCatalogueBlock,
} from "./catalogue";
export {
	type AlfyCommentOutcome,
	type AlfyCommentReplyResult,
	createComment,
	deleteComment,
	getComment,
	listComments,
	parseArtifactAnchor,
	resolveComment,
	runAlfyCommentReply,
} from "./comments";
export {
	acknowledgeDocumentReviewBlocks,
	applyDocumentPatch,
	computePendingReviewBlocks,
	createDocumentArtifact,
	DocumentOperationError,
	type DocumentReviewMetadata,
	type DocumentReviewPendingBlock,
	documentTabsFromMetadata,
	getDocumentReviewState,
	readDocumentForAlfy,
	saveDocumentBody,
} from "./document-ops";
export {
	buildGeneratedDocumentSource,
	sanitizeDocumentFilename,
} from "./export";
export { hashArtifactBody } from "./hash";
export { keepMessageAsDocument } from "./keep-message";
export { deleteKv, getKv, listKv, setKv } from "./kv";
export {
	applyArtifactOps,
	OPS_BRANCHES,
	type OpsBranch,
	type OpsBranchOutcome,
	type OpsEnvelopeFailureReason,
	type OpsEnvelopeInput,
	type OpsEnvelopeResult,
} from "./ops";
export {
	listArtifactsForConversation,
	listMissingArtifactIds,
} from "./read-model";
export {
	artifactIdInUse,
	createArtifact,
	deleteArtifact,
	getArtifact,
	kindForArtifactRow,
	parseArtifactMetadata,
	updateArtifactBody,
} from "./record";
// The review state of an artifact of either kind that has one (a Document's,
// ruling 61; a board's, ruling 63), behind the one review route.
export {
	type ArtifactReviewResult,
	acknowledgeArtifactReview,
	getArtifactReviewState,
} from "./review";
export {
	type ArtifactSerializer,
	type FileArtifactDescriptor,
	getArtifactSerializer,
} from "./serialize";
// The one gate a board passes on its way into storage, for a writer that makes
// a board rather than saves one (the model's create handler): canonical, hashed
// as written, refused past its caps.
export {
	type CanvasBoardRefusal,
	canvasBodyHash,
	prepareCanvasBoard,
} from "./serialize/canvas";
export type {
	Anchor,
	ArtifactAuthor,
	ArtifactCardSummary,
	ArtifactComment,
	ArtifactCommentStatus,
	ArtifactDetail,
	ArtifactKind,
	ArtifactKvRow,
	ArtifactMetadata,
	ArtifactRecord,
	ArtifactScopeOptions,
	ArtifactVersionSummary,
	CreatableArtifactKind,
	CreateArtifactInput,
} from "./types";
export { getVersionBody, listVersions, restoreVersion } from "./versions";
