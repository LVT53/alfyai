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
export {
	ARTIFACT_CATALOGUE_MAX,
	ARTIFACT_CATALOGUE_TITLE_MAX_CHARS,
	type ArtifactCatalogueEntry,
	buildArtifactCatalogueBlock,
	listArtifactCatalogueEntries,
	resolveArtifactCatalogueBlock,
} from "./catalogue";
export {
	createComment,
	deleteComment,
	listComments,
	parseArtifactAnchor,
	resolveComment,
} from "./comments";
export { hashArtifactBody } from "./hash";
export { deleteKv, getKv, listKv, setKv } from "./kv";
export { listArtifactsForConversation } from "./read-model";
export {
	createArtifact,
	deleteArtifact,
	getArtifact,
	kindForArtifactRow,
	parseArtifactMetadata,
	updateArtifactBody,
} from "./record";
export {
	type ArtifactSerializer,
	type FileArtifactDescriptor,
	getArtifactSerializer,
} from "./serialize";
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
