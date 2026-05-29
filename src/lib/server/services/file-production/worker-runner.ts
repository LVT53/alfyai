import { randomUUID } from "node:crypto";
import type { FileProductionJob } from "$lib/types";
import {
	executePersistedFileProductionRequest,
	type ProgramExecutionResult,
} from "./execution-adapter";
import {
	claimNextFileProductionJob,
	completeFileProductionJobAttempt,
	DEFAULT_STALE_ATTEMPT_MS,
	failFileProductionJobAttempt,
	getCurrentOwnedRunningJob,
	recoverStaleFileProductionAttempts,
} from "./job-ledger";
import type { FileProductionLimits } from "./limits";
import {
	type StoreGeneratedFileDependency,
	type SyncGeneratedFilesToMemoryDependency,
	storeFileProductionOutputs,
	syncFileProductionOutputsToMemory,
} from "./storage-adapter";

export interface ExecuteNextFileProductionJobInput {
	workerId: string;
	now?: Date;
	executeCode?: (
		sourceCode: string,
		language: "python" | "javascript",
	) => Promise<ProgramExecutionResult>;
	storeGeneratedFile?: StoreGeneratedFileDependency;
	syncGeneratedFilesToMemory?: SyncGeneratedFilesToMemoryDependency;
	limits?: Partial<FileProductionLimits>;
}

export interface ExecuteNextFileProductionJobResult {
	job: FileProductionJob;
	files: FileProductionJob["files"];
}

export interface DrainFileProductionWorkerInput
	extends Omit<ExecuteNextFileProductionJobInput, "workerId"> {
	workerId?: string;
}

interface ExecuteNextFileProductionJobStepResult {
	processed: boolean;
	result: ExecuteNextFileProductionJobResult | null;
}

const DEFAULT_WORKER_ID = `file-production:${process.pid}:${randomUUID()}`;
let workerInitialized = false;
let drainPromise: Promise<void> | null = null;

async function executeNextFileProductionJobStep(
	input: ExecuteNextFileProductionJobInput,
): Promise<ExecuteNextFileProductionJobStepResult> {
	const now = input.now ?? new Date();
	const claimed = await claimNextFileProductionJob({
		workerId: input.workerId,
		now,
	});
	if (!claimed) {
		return { processed: false, result: null };
	}

	let currentJobRow = await getCurrentOwnedRunningJob({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
	});
	if (!currentJobRow) {
		return { processed: true, result: null };
	}

	const execution = await executePersistedFileProductionRequest({
		requestJson: currentJobRow.requestJson,
		userId: currentJobRow.userId,
		conversationId: currentJobRow.conversationId,
		assistantMessageId: currentJobRow.assistantMessageId,
		fileProductionJobId: currentJobRow.id,
		title: currentJobRow.title,
		documentIntent: currentJobRow.documentIntent,
		executeCode: input.executeCode,
	});
	if (!execution.ok) {
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: execution.errorCode,
			errorMessage: execution.errorMessage,
			retryable: execution.retryable,
			now: new Date(),
		});
		return { processed: true, result: null };
	}

	const executionResult = execution.execution;

	const latestJobRow = await getCurrentOwnedRunningJob({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
	});
	if (!latestJobRow) {
		return { processed: true, result: null };
	}
	currentJobRow = latestJobRow;

	const storedOutput = await storeFileProductionOutputs({
		job: currentJobRow,
		attemptId: claimed.attempt.id,
		request: execution.request,
		executionResult,
		sourceArtifact: execution.sourceArtifact,
		now,
		storeGeneratedFile: input.storeGeneratedFile,
		limits: input.limits,
	});
	if (!storedOutput.ok) {
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: storedOutput.errorCode,
			errorMessage: storedOutput.errorMessage,
			retryable: storedOutput.retryable,
			diagnostics: storedOutput.diagnostics,
			now: new Date(),
		});
		return { processed: true, result: null };
	}

	const { producedFiles } = storedOutput;

	const completed = await completeFileProductionJobAttempt({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
		files: producedFiles.map((file, index) => ({
			chatGeneratedFileId: file.id,
			sortOrder: index,
		})),
		now: new Date(),
	});

	if (!completed) {
		return { processed: true, result: null };
	}

	await syncFileProductionOutputsToMemory({
		job: currentJobRow,
		producedFiles,
		syncGeneratedFilesToMemory: input.syncGeneratedFilesToMemory,
	});

	return {
		processed: true,
		result: {
			job: {
				...claimed.job,
				assistantMessageId: currentJobRow.assistantMessageId,
				status: "succeeded",
				stage: null,
				updatedAt: Date.now(),
				files: producedFiles,
			},
			files: producedFiles,
		},
	};
}

export async function executeNextFileProductionJob(
	input: ExecuteNextFileProductionJobInput,
): Promise<ExecuteNextFileProductionJobResult | null> {
	const step = await executeNextFileProductionJobStep(input);
	return step.result;
}

export async function drainFileProductionWorker(
	input: DrainFileProductionWorkerInput = {},
): Promise<void> {
	for (;;) {
		const step = await executeNextFileProductionJobStep({
			...input,
			workerId: input.workerId ?? DEFAULT_WORKER_ID,
		});
		if (!step.processed) {
			return;
		}
	}
}

export function wakeFileProductionWorker(): void {
	if (drainPromise) {
		return;
	}

	drainPromise = Promise.resolve()
		.then(() => drainFileProductionWorker())
		.catch((error) => {
			console.error("[FILE_PRODUCTION] Worker drain failed", { error });
		})
		.finally(() => {
			drainPromise = null;
		});
}

export async function ensureFileProductionWorker(): Promise<void> {
	if (workerInitialized) {
		return;
	}
	workerInitialized = true;
	await recoverStaleFileProductionAttempts({
		staleBefore: new Date(Date.now() - DEFAULT_STALE_ATTEMPT_MS),
	});
	wakeFileProductionWorker();
}
