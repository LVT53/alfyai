// The façade.
//
// Ledger reads and ledger writes are re-exported directly; anything that can
// reach an extractor is loaded through a lazy `import()`. That split is the
// whole point of this file: a poll endpoint that only reads rows must not pull
// `node:fs` and a backend HTTP client into its bundle, and a static re-export
// of the worker would do exactly that. Mirrors `file-production/index.ts`.

type IntakeModule = typeof import("./intake");
type WorkerRunnerModule = typeof import("./worker-runner");

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
	StartGeneratedFileReadbackParams,
	StartUploadExtractionParams,
} from "./intake";
export type {
	CancelExtractionJobInput,
	ClaimExtractionJobInput,
	ClaimedExtractionJob,
	CompleteExtractionAttemptInput,
	DocumentExtractionAttemptRow,
	DocumentExtractionJobRow,
	EnqueueExtractionJobInput,
	EnqueueExtractionJobResult,
	FailExtractionAttemptInput,
	MaterializeLegacyExtractionJobInput,
	OwnedAttemptInput,
	RecoverStaleExtractionAttemptsInput,
	RetryExtractionJobInput,
} from "./job-ledger";
export {
	cancelExtractionJob,
	enqueueExtractionJob,
	getExtractionJobRow,
	isCancelRequested,
	listExtractionJobAttempts,
	materializeLegacyExtractionJob,
	retryExtractionJob,
} from "./job-ledger";
export type {
	ExtractionJobLookup,
	ExtractionJobVerdict,
	WaitForExtractionJobVerdictInput,
} from "./job-wait";
export { waitForExtractionJobVerdict } from "./job-wait";
export {
	getExtractionJobById,
	getExtractionJobForArtifact,
	getExtractionJobsForArtifacts,
	LEGACY_EXTRACTION_GRACE_MS,
	mapExtractionJobRow,
} from "./read-model";
export type {
	DocumentExtractionIntakeRoute,
	DocumentExtractionOrigin,
} from "./types";
export {
	EXTRACTION_PRIORITY_READBACK,
	EXTRACTION_PRIORITY_UPLOAD,
} from "./types";
export type {
	ExecuteNextExtractionJobInput,
	ExecuteNextExtractionJobResult,
	ReadbackExtractionSink,
} from "./worker-runner";

async function loadIntake(): Promise<IntakeModule> {
	return import("./intake");
}

async function loadWorkerRunner(): Promise<WorkerRunnerModule> {
	return import("./worker-runner");
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

export async function drainExtractionWorker(
	...args: Parameters<WorkerRunnerModule["drainExtractionWorker"]>
): ReturnType<WorkerRunnerModule["drainExtractionWorker"]> {
	const { drainExtractionWorker } = await loadWorkerRunner();
	return drainExtractionWorker(...args);
}

export async function executeNextExtractionJob(
	...args: Parameters<WorkerRunnerModule["executeNextExtractionJob"]>
): ReturnType<WorkerRunnerModule["executeNextExtractionJob"]> {
	const { executeNextExtractionJob } = await loadWorkerRunner();
	return executeNextExtractionJob(...args);
}

export async function runDirectTextExtractionInline(
	...args: Parameters<WorkerRunnerModule["runDirectTextExtractionInline"]>
): ReturnType<WorkerRunnerModule["runDirectTextExtractionInline"]> {
	const { runDirectTextExtractionInline } = await loadWorkerRunner();
	return runDirectTextExtractionInline(...args);
}

export async function setGeneratedFileReadbackSink(
	...args: Parameters<WorkerRunnerModule["setGeneratedFileReadbackSink"]>
): Promise<void> {
	const { setGeneratedFileReadbackSink } = await loadWorkerRunner();
	setGeneratedFileReadbackSink(...args);
}

export function wakeExtractionWorker(): void {
	void loadWorkerRunner()
		.then(({ wakeExtractionWorker }) => wakeExtractionWorker())
		.catch((error) => {
			console.error("[EXTRACTION] Failed to wake worker", { error });
		});
}

export async function ensureExtractionWorker(): Promise<void> {
	const { ensureExtractionWorker } = await loadWorkerRunner();
	return ensureExtractionWorker();
}
