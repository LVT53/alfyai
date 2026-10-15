// The façade.
//
// Job writes and the job kind are re-exported directly; the intake, the read model
// and the source persistence are loaded through a lazy `import()`, so a caller that
// only reads a report or a card never loads their graphs. What runs a job is the job
// engine (`services/jobs`), started once from `hooks.server.ts` with the kind this
// folder defines (`production-job.ts`); there is no worker to ensure, wake or drain
// from here, and the renderers, the sandbox client and the chat-file store are
// loaded by the engine on the first claim (`production-runner.ts`), never from here.

import type {
	FileProductionIntakeResult,
	SubmitFileProductionIntakeInput,
} from "./intake";
import {
	createFailedFileProductionJob,
	createOrReuseFileProductionJob,
} from "./production-job";

type SourcePersistenceModule = typeof import("./source-persistence");
type ReadModelModule = typeof import("./read-model");

export type {
	FileProductionIntakeConversationIdResult,
	FileProductionIntakeResult,
	SubmitFileProductionIntakeInput,
} from "./intake";
export { getFileProductionIntakeConversationId } from "./intake";
export { assignFileProductionJobsToAssistantMessage } from "./job-links";
export type {
	CancelFileProductionJobInput,
	CreateFailedFileProductionJobInput,
	CreateFileProductionJobInput,
	CreateOrReuseFileProductionJobInput,
	CreateOrReuseFileProductionJobResult,
	DismissFileProductionJobInput,
	FileProductionJobVerdict,
	ReconcileStaleFileProductionJobsInput,
	RegenerateFileProductionJobInput,
	RetryFileProductionJobInput,
	WaitForFileProductionJobVerdictInput,
} from "./production-job";
export {
	cancelActiveFileProductionForUser,
	cancelFileProductionJob,
	createFailedFileProductionJob,
	createFileProductionJob,
	createOrReuseFileProductionJob,
	dismissFileProductionJob,
	reconcileStaleFileProductionJobs,
	regenerateFileProductionJob,
	retryFileProductionJob,
	waitForFileProductionJobVerdict,
} from "./production-job";
export type { FileProductionJobState } from "./read-model";
export { ARTIFACT_EXPORT_JOB_ORIGIN } from "./types";

async function loadReadModel(): Promise<ReadModelModule> {
	return import("./read-model");
}

/**
 * A job's persisted report source, user- and conversation-scoped. Lazy, so a
 * caller that only reads a report never loads the renderer graph.
 */
export async function getGeneratedDocumentSourceForFileProductionJob(
	...args: Parameters<
		SourcePersistenceModule["getGeneratedDocumentSourceForFileProductionJob"]
	>
): ReturnType<
	SourcePersistenceModule["getGeneratedDocumentSourceForFileProductionJob"]
> {
	const { getGeneratedDocumentSourceForFileProductionJob } = await import(
		"./source-persistence"
	);
	return getGeneratedDocumentSourceForFileProductionJob(...args);
}

export async function listConversationFileProductionJobs(
	...args: Parameters<ReadModelModule["listConversationFileProductionJobs"]>
): ReturnType<ReadModelModule["listConversationFileProductionJobs"]> {
	const { listConversationFileProductionJobs } = await loadReadModel();
	return listConversationFileProductionJobs(...args);
}

export async function getConversationFileProductionJob(
	...args: Parameters<ReadModelModule["getConversationFileProductionJob"]>
): ReturnType<ReadModelModule["getConversationFileProductionJob"]> {
	const { getConversationFileProductionJob } = await loadReadModel();
	return getConversationFileProductionJob(...args);
}

export async function getFileProductionJobForUser(
	...args: Parameters<ReadModelModule["getFileProductionJobForUser"]>
): ReturnType<ReadModelModule["getFileProductionJobForUser"]> {
	const { getFileProductionJobForUser } = await loadReadModel();
	return getFileProductionJobForUser(...args);
}

export async function listConversationFileProductionJobStates(
	...args: Parameters<
		ReadModelModule["listConversationFileProductionJobStates"]
	>
): ReturnType<ReadModelModule["listConversationFileProductionJobStates"]> {
	const { listConversationFileProductionJobStates } = await loadReadModel();
	return listConversationFileProductionJobStates(...args);
}

/**
 * Validates and normalises a request, then makes the job (or hands back the one
 * the request's key already made). The engine wakes the kind after the commit that
 * made a queued job, so there is nothing to wake from here.
 */
export async function submitFileProductionIntake(
	input: SubmitFileProductionIntakeInput,
): Promise<FileProductionIntakeResult> {
	const { submitFileProductionIntakeWithDependencies } = await import(
		"./intake"
	);
	return submitFileProductionIntakeWithDependencies(input, {
		createOrReuseFileProductionJob,
		createFailedFileProductionJob,
	});
}
