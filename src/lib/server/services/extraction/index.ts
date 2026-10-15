// The façade.
//
// Job reads and job writes are re-exported directly; anything that can reach an
// extractor is loaded through a lazy `import()` (the intake) or by the job engine
// on the first claim (the handler). That split is the whole point of this file: a
// poll endpoint that only reads rows must not pull `node:fs` and a backend HTTP
// client into its bundle, and a static re-export of the handler would do exactly
// that. Mirrors `file-production/index.ts`.
//
// What runs a job is the job engine (`services/jobs`), started once from
// `hooks.server.ts` with the kind this folder defines (`extraction-job.ts`); there
// is no worker to ensure, wake or drain from here.

type IntakeModule = typeof import("./intake");

export type { ExtractionConfig } from "./config";
export { getExtractionConfig } from "./config";
export type {
	DocumentExtractionError,
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
	ExtractionHandle,
	ExtractionProgress,
} from "./contracts";
export type {
	CancelExtractionJobInput,
	DocumentExtractionAttemptRow,
	DocumentExtractionJobRow,
	EnqueueExtractionJobInput,
	EnqueueExtractionJobResult,
	ExtractionJobVerdict,
	MaterializeLegacyExtractionJobInput,
	RetryExtractionJobInput,
	WaitForExtractionJobVerdictInput,
} from "./extraction-job";
export {
	cancelActiveDocumentExtractionForUser,
	cancelExtractionJob,
	enqueueExtractionJob,
	getExtractionJobRow,
	listExtractionJobAttempts,
	materializeLegacyExtractionJob,
	retryExtractionJob,
	waitForExtractionJobVerdict,
} from "./extraction-job";
export type {
	StartGeneratedFileReadbackParams,
	StartUploadExtractionParams,
} from "./intake";
export {
	getExtractionJobById,
	getExtractionJobForArtifact,
	getExtractionJobsForArtifacts,
	LEGACY_EXTRACTION_GRACE_MS,
	mapExtractionJobRow,
} from "./read-model";
export type { ReadbackExtractionSink } from "./readback-sink";
export { setGeneratedFileReadbackSink } from "./readback-sink";
export type {
	DocumentExtractionIntakeRoute,
	DocumentExtractionOrigin,
} from "./types";
export {
	EXTRACTION_PRIORITY_READBACK,
	EXTRACTION_PRIORITY_UPLOAD,
} from "./types";

async function loadIntake(): Promise<IntakeModule> {
	return import("./intake");
}

export async function startUploadExtraction(
	...args: Parameters<IntakeModule["startUploadExtraction"]>
): ReturnType<IntakeModule["startUploadExtraction"]> {
	const { startUploadExtraction } = await loadIntake();
	return startUploadExtraction(...args);
}

export async function startGeneratedFileReadback(
	...args: Parameters<IntakeModule["startGeneratedFileReadback"]>
): ReturnType<IntakeModule["startGeneratedFileReadback"]> {
	const { startGeneratedFileReadback } = await loadIntake();
	return startGeneratedFileReadback(...args);
}
