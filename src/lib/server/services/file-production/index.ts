import {
	type FileProductionIntakeResult,
	type SubmitFileProductionIntakeInput,
	submitFileProductionIntakeWithDependencies,
} from "./intake";
import {
	createFailedFileProductionJob,
	createOrReuseFileProductionJob,
} from "./job-ledger";
import { wakeFileProductionWorker } from "./worker-runner";

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
	FailFileProductionAttemptInput,
	FileProductionJobAttempt,
	OwnedFileProductionAttemptInput,
	ReconcileStaleFileProductionJobsInput,
	RecoverStaleFileProductionAttemptsInput,
	RetryFileProductionJobInput,
} from "./job-ledger";
export {
	assignFileProductionJobsToAssistantMessage,
	cancelFileProductionJob,
	claimNextFileProductionJob,
	createFailedFileProductionJob,
	createFileProductionJob,
	createOrReuseFileProductionJob,
	failFileProductionJobAttempt,
	heartbeatFileProductionJobAttempt,
	listConversationFileProductionJobs,
	reconcileStaleFileProductionJobs,
	recoverStaleFileProductionAttempts,
	retryFileProductionJob,
} from "./job-ledger";
export type {
	DrainFileProductionWorkerInput,
	ExecuteNextFileProductionJobInput,
	ExecuteNextFileProductionJobResult,
} from "./worker-runner";
export {
	drainFileProductionWorker,
	ensureFileProductionWorker,
	executeNextFileProductionJob,
	wakeFileProductionWorker,
} from "./worker-runner";

export async function submitFileProductionIntake(
	input: SubmitFileProductionIntakeInput,
): Promise<FileProductionIntakeResult> {
	return submitFileProductionIntakeWithDependencies(input, {
		createOrReuseFileProductionJob,
		createFailedFileProductionJob,
		wakeFileProductionWorker: input.wakeWorker ?? wakeFileProductionWorker,
	});
}
