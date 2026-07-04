import type {
	FileProductionIntakeResult,
	SubmitFileProductionIntakeInput,
} from "./intake";

type JobLedgerModule = typeof import("./job-ledger");
type ReadModelModule = typeof import("./read-model");
type WorkerRunnerModule = typeof import("./worker-runner");

export type {
	FileProductionIntakeConversationIdResult,
	FileProductionIntakeResult,
	SubmitFileProductionIntakeInput,
} from "./intake";
export { getFileProductionIntakeConversationId } from "./intake";
export type {
	CancelFileProductionJobInput,
	ClaimedFileProductionJob,
	ClaimFileProductionJobInput,
	CreateFailedFileProductionJobInput,
	CreateFileProductionJobInput,
	CreateOrReuseFileProductionJobInput,
	CreateOrReuseFileProductionJobResult,
	DismissFileProductionJobInput,
	FailFileProductionAttemptInput,
	FileProductionJobAttempt,
	OwnedFileProductionAttemptInput,
	ReconcileStaleFileProductionJobsInput,
	RecoverStaleFileProductionAttemptsInput,
	RetryFileProductionJobInput,
} from "./job-ledger";
export type {
	DrainFileProductionWorkerInput,
	ExecuteNextFileProductionJobInput,
	ExecuteNextFileProductionJobResult,
} from "./worker-runner";

async function loadJobLedger(): Promise<JobLedgerModule> {
	return import("./job-ledger");
}

async function loadReadModel(): Promise<ReadModelModule> {
	return import("./read-model");
}

async function loadWorkerRunner(): Promise<WorkerRunnerModule> {
	return import("./worker-runner");
}

export async function createFileProductionJob(
	...args: Parameters<JobLedgerModule["createFileProductionJob"]>
): ReturnType<JobLedgerModule["createFileProductionJob"]> {
	const { createFileProductionJob } = await loadJobLedger();
	return createFileProductionJob(...args);
}

export async function createOrReuseFileProductionJob(
	...args: Parameters<JobLedgerModule["createOrReuseFileProductionJob"]>
): ReturnType<JobLedgerModule["createOrReuseFileProductionJob"]> {
	const { createOrReuseFileProductionJob } = await loadJobLedger();
	return createOrReuseFileProductionJob(...args);
}

export async function createFailedFileProductionJob(
	...args: Parameters<JobLedgerModule["createFailedFileProductionJob"]>
): ReturnType<JobLedgerModule["createFailedFileProductionJob"]> {
	const { createFailedFileProductionJob } = await loadJobLedger();
	return createFailedFileProductionJob(...args);
}

export async function assignFileProductionJobsToAssistantMessage(
	...args: Parameters<
		JobLedgerModule["assignFileProductionJobsToAssistantMessage"]
	>
): ReturnType<JobLedgerModule["assignFileProductionJobsToAssistantMessage"]> {
	const { assignFileProductionJobsToAssistantMessage } = await loadJobLedger();
	return assignFileProductionJobsToAssistantMessage(...args);
}

export async function cancelFileProductionJob(
	...args: Parameters<JobLedgerModule["cancelFileProductionJob"]>
): ReturnType<JobLedgerModule["cancelFileProductionJob"]> {
	const { cancelFileProductionJob } = await loadJobLedger();
	return cancelFileProductionJob(...args);
}

export async function dismissFileProductionJob(
	...args: Parameters<JobLedgerModule["dismissFileProductionJob"]>
): ReturnType<JobLedgerModule["dismissFileProductionJob"]> {
	const { dismissFileProductionJob } = await loadJobLedger();
	return dismissFileProductionJob(...args);
}

export async function claimNextFileProductionJob(
	...args: Parameters<JobLedgerModule["claimNextFileProductionJob"]>
): ReturnType<JobLedgerModule["claimNextFileProductionJob"]> {
	const { claimNextFileProductionJob } = await loadJobLedger();
	return claimNextFileProductionJob(...args);
}

export async function failFileProductionJobAttempt(
	...args: Parameters<JobLedgerModule["failFileProductionJobAttempt"]>
): ReturnType<JobLedgerModule["failFileProductionJobAttempt"]> {
	const { failFileProductionJobAttempt } = await loadJobLedger();
	return failFileProductionJobAttempt(...args);
}

export async function heartbeatFileProductionJobAttempt(
	...args: Parameters<JobLedgerModule["heartbeatFileProductionJobAttempt"]>
): ReturnType<JobLedgerModule["heartbeatFileProductionJobAttempt"]> {
	const { heartbeatFileProductionJobAttempt } = await loadJobLedger();
	return heartbeatFileProductionJobAttempt(...args);
}

export async function listConversationFileProductionJobs(
	...args: Parameters<ReadModelModule["listConversationFileProductionJobs"]>
): ReturnType<ReadModelModule["listConversationFileProductionJobs"]> {
	const { listConversationFileProductionJobs } = await loadReadModel();
	return listConversationFileProductionJobs(...args);
}

export async function reconcileStaleFileProductionJobs(
	...args: Parameters<JobLedgerModule["reconcileStaleFileProductionJobs"]>
): ReturnType<JobLedgerModule["reconcileStaleFileProductionJobs"]> {
	const { reconcileStaleFileProductionJobs } = await loadJobLedger();
	return reconcileStaleFileProductionJobs(...args);
}

export async function recoverStaleFileProductionAttempts(
	...args: Parameters<JobLedgerModule["recoverStaleFileProductionAttempts"]>
): ReturnType<JobLedgerModule["recoverStaleFileProductionAttempts"]> {
	const { recoverStaleFileProductionAttempts } = await loadJobLedger();
	return recoverStaleFileProductionAttempts(...args);
}

export async function retryFileProductionJob(
	...args: Parameters<JobLedgerModule["retryFileProductionJob"]>
): ReturnType<JobLedgerModule["retryFileProductionJob"]> {
	const { retryFileProductionJob } = await loadJobLedger();
	return retryFileProductionJob(...args);
}

export async function drainFileProductionWorker(
	...args: Parameters<WorkerRunnerModule["drainFileProductionWorker"]>
): ReturnType<WorkerRunnerModule["drainFileProductionWorker"]> {
	const { drainFileProductionWorker } = await loadWorkerRunner();
	return drainFileProductionWorker(...args);
}

export async function executeNextFileProductionJob(
	...args: Parameters<WorkerRunnerModule["executeNextFileProductionJob"]>
): ReturnType<WorkerRunnerModule["executeNextFileProductionJob"]> {
	const { executeNextFileProductionJob } = await loadWorkerRunner();
	return executeNextFileProductionJob(...args);
}

export function wakeFileProductionWorker(): void {
	void loadWorkerRunner()
		.then(({ wakeFileProductionWorker }) => wakeFileProductionWorker())
		.catch((error) => {
			console.error("[FILE_PRODUCTION] Failed to wake worker", { error });
		});
}

export async function ensureFileProductionWorker(
	...args: Parameters<WorkerRunnerModule["ensureFileProductionWorker"]>
): ReturnType<WorkerRunnerModule["ensureFileProductionWorker"]> {
	const { ensureFileProductionWorker } = await loadWorkerRunner();
	return ensureFileProductionWorker(...args);
}

export async function submitFileProductionIntake(
	input: SubmitFileProductionIntakeInput,
): Promise<FileProductionIntakeResult> {
	const [{ submitFileProductionIntakeWithDependencies }, jobLedger] =
		await Promise.all([import("./intake"), loadJobLedger()]);
	const wakeFileProductionWorker =
		input.wakeWorker ??
		(async () => {
			const { wakeFileProductionWorker } = await loadWorkerRunner();
			return wakeFileProductionWorker();
		});

	return submitFileProductionIntakeWithDependencies(input, {
		createOrReuseFileProductionJob: jobLedger.createOrReuseFileProductionJob,
		createFailedFileProductionJob: jobLedger.createFailedFileProductionJob,
		wakeFileProductionWorker,
	});
}
