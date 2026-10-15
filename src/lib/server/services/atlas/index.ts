// The Atlas façade: the names the routes, chat-turn code, account erasure and
// conversation cleanup call. Each function is a lazy delegate, so importing this
// file costs nothing: the kind and its engine load on the first call, and the v3
// pipeline only when a job is claimed (`research-job.ts` loads its handler then).
//
// Atlas's lifecycle (claim, lease, heartbeat, progress, completion, failure,
// recovery, scheduling) is the job engine's (services/jobs), started once from
// `hooks.server.ts` with `startJobs([atlasResearchJob])`. Nothing here claims or
// runs a job, and no caller wakes a worker: linking the reply message does.

import type {
	AtlasJobIntakeResult,
	SubmitAtlasJobIntakeInput,
} from "./research-job";

type ResearchJobModule = typeof import("./research-job");
type ReadModelModule = typeof import("./read-model");

export type {
	AtlasJobIntakeResult,
	CancelAtlasJobInput,
	CreateOrReuseAtlasJobInput,
	CreateOrReuseAtlasJobResult,
	DeleteAtlasJobsForConversationInput,
	LinkAtlasJobAssistantMessageInput,
	SubmitAtlasJobIntakeInput,
} from "./research-job";
export type {
	AtlasAction,
	AtlasJobCard,
	AtlasJobError,
	AtlasJobOutputs,
	AtlasJobProgress,
	AtlasJobSourceCounts,
	AtlasJobStatus,
	AtlasJobUsage,
	AtlasProfile,
} from "./types";

async function loadResearchJob(): Promise<ResearchJobModule> {
	return import("./research-job");
}

async function loadReadModel(): Promise<ReadModelModule> {
	return import("./read-model");
}

export async function createOrReuseAtlasJob(
	...args: Parameters<ResearchJobModule["createOrReuseAtlasJob"]>
): ReturnType<ResearchJobModule["createOrReuseAtlasJob"]> {
	const { createOrReuseAtlasJob } = await loadResearchJob();
	return createOrReuseAtlasJob(...args);
}

export async function linkAtlasJobAssistantMessage(
	...args: Parameters<ResearchJobModule["linkAtlasJobAssistantMessage"]>
): ReturnType<ResearchJobModule["linkAtlasJobAssistantMessage"]> {
	const { linkAtlasJobAssistantMessage } = await loadResearchJob();
	return linkAtlasJobAssistantMessage(...args);
}

export async function cancelAtlasJob(
	...args: Parameters<ResearchJobModule["cancelAtlasJob"]>
): ReturnType<ResearchJobModule["cancelAtlasJob"]> {
	const { cancelAtlasJob } = await loadResearchJob();
	return cancelAtlasJob(...args);
}

export async function cancelActiveAtlasJobsForUser(
	...args: Parameters<ResearchJobModule["cancelActiveAtlasJobsForUser"]>
): ReturnType<ResearchJobModule["cancelActiveAtlasJobsForUser"]> {
	const { cancelActiveAtlasJobsForUser } = await loadResearchJob();
	return cancelActiveAtlasJobsForUser(...args);
}

export async function cancelActiveAtlasJobsForConversation(
	...args: Parameters<ResearchJobModule["cancelActiveAtlasJobsForConversation"]>
): ReturnType<ResearchJobModule["cancelActiveAtlasJobsForConversation"]> {
	const { cancelActiveAtlasJobsForConversation } = await loadResearchJob();
	return cancelActiveAtlasJobsForConversation(...args);
}

export async function deleteAtlasJobsForUser(
	...args: Parameters<ResearchJobModule["deleteAtlasJobsForUser"]>
): ReturnType<ResearchJobModule["deleteAtlasJobsForUser"]> {
	const { deleteAtlasJobsForUser } = await loadResearchJob();
	return deleteAtlasJobsForUser(...args);
}

export async function deleteAtlasJobsForConversation(
	...args: Parameters<ResearchJobModule["deleteAtlasJobsForConversation"]>
): ReturnType<ResearchJobModule["deleteAtlasJobsForConversation"]> {
	const { deleteAtlasJobsForConversation } = await loadResearchJob();
	return deleteAtlasJobsForConversation(...args);
}

export async function listConversationAtlasJobs(
	...args: Parameters<ReadModelModule["listConversationAtlasJobs"]>
): ReturnType<ReadModelModule["listConversationAtlasJobs"]> {
	const { listConversationAtlasJobs } = await loadReadModel();
	return listConversationAtlasJobs(...args);
}

export async function submitAtlasJobIntake(
	input: SubmitAtlasJobIntakeInput,
): Promise<AtlasJobIntakeResult> {
	const { createOrReuseAtlasJob } = await loadResearchJob();
	return createOrReuseAtlasJob(input);
}
