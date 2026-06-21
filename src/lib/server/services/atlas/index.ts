import type { AtlasJobIntakeResult, SubmitAtlasJobIntakeInput } from "./intake";
import type { AtlasAction, AtlasJobCard, AtlasProfile } from "./types";

type JobLedgerModule = typeof import("./job-ledger");
type ReadModelModule = typeof import("./read-model");
type WorkerRunnerModule = typeof import("./worker-runner");

export type {
	AtlasJobIntakeResult,
	SubmitAtlasJobIntakeDependencies,
	SubmitAtlasJobIntakeInput,
} from "./intake";
export type {
	ApplyAtlasGeneratedTitleInput,
	CancelAtlasJobInput,
	ClaimedAtlasJob,
	ClaimNextAtlasJobInput,
	CompleteAtlasJobInput,
	CreateOrReuseAtlasJobInput,
	CreateOrReuseAtlasJobResult,
	DeleteAtlasJobsForConversationInput,
	FailAtlasJobInput,
	HeartbeatAtlasJobInput,
	LinkAtlasJobAssistantMessageInput,
	RecoverStaleAtlasJobsInput,
} from "./job-ledger";
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

async function loadJobLedger(): Promise<JobLedgerModule> {
	return import("./job-ledger");
}

async function loadReadModel(): Promise<ReadModelModule> {
	return import("./read-model");
}

async function loadWorkerRunner(): Promise<WorkerRunnerModule> {
	return import("./worker-runner");
}

export async function createOrReuseAtlasJob(
	...args: Parameters<JobLedgerModule["createOrReuseAtlasJob"]>
): ReturnType<JobLedgerModule["createOrReuseAtlasJob"]> {
	const { createOrReuseAtlasJob } = await loadJobLedger();
	return createOrReuseAtlasJob(...args);
}

export async function linkAtlasJobAssistantMessage(
	...args: Parameters<JobLedgerModule["linkAtlasJobAssistantMessage"]>
): ReturnType<JobLedgerModule["linkAtlasJobAssistantMessage"]> {
	const { linkAtlasJobAssistantMessage } = await loadJobLedger();
	return linkAtlasJobAssistantMessage(...args);
}

export async function claimNextAtlasJob(
	...args: Parameters<JobLedgerModule["claimNextAtlasJob"]>
): ReturnType<JobLedgerModule["claimNextAtlasJob"]> {
	const { claimNextAtlasJob } = await loadJobLedger();
	return claimNextAtlasJob(...args);
}

export async function heartbeatAtlasJob(
	...args: Parameters<JobLedgerModule["heartbeatAtlasJob"]>
): ReturnType<JobLedgerModule["heartbeatAtlasJob"]> {
	const { heartbeatAtlasJob } = await loadJobLedger();
	return heartbeatAtlasJob(...args);
}

export async function applyAtlasGeneratedTitle(
	...args: Parameters<JobLedgerModule["applyAtlasGeneratedTitle"]>
): ReturnType<JobLedgerModule["applyAtlasGeneratedTitle"]> {
	const { applyAtlasGeneratedTitle } = await loadJobLedger();
	return applyAtlasGeneratedTitle(...args);
}

export async function cancelAtlasJob(
	...args: Parameters<JobLedgerModule["cancelAtlasJob"]>
): ReturnType<JobLedgerModule["cancelAtlasJob"]> {
	const { cancelAtlasJob } = await loadJobLedger();
	return cancelAtlasJob(...args);
}

export async function cancelActiveAtlasJobsForUser(
	...args: Parameters<JobLedgerModule["cancelActiveAtlasJobsForUser"]>
): ReturnType<JobLedgerModule["cancelActiveAtlasJobsForUser"]> {
	const { cancelActiveAtlasJobsForUser } = await loadJobLedger();
	return cancelActiveAtlasJobsForUser(...args);
}

export async function cancelActiveAtlasJobsForConversation(
	...args: Parameters<JobLedgerModule["cancelActiveAtlasJobsForConversation"]>
): ReturnType<JobLedgerModule["cancelActiveAtlasJobsForConversation"]> {
	const { cancelActiveAtlasJobsForConversation } = await loadJobLedger();
	return cancelActiveAtlasJobsForConversation(...args);
}

export async function deleteAtlasJobsForUser(
	...args: Parameters<JobLedgerModule["deleteAtlasJobsForUser"]>
): ReturnType<JobLedgerModule["deleteAtlasJobsForUser"]> {
	const { deleteAtlasJobsForUser } = await loadJobLedger();
	return deleteAtlasJobsForUser(...args);
}

export async function deleteAtlasJobsForConversation(
	...args: Parameters<JobLedgerModule["deleteAtlasJobsForConversation"]>
): ReturnType<JobLedgerModule["deleteAtlasJobsForConversation"]> {
	const { deleteAtlasJobsForConversation } = await loadJobLedger();
	return deleteAtlasJobsForConversation(...args);
}

export async function recoverStaleAtlasJobs(
	...args: Parameters<JobLedgerModule["recoverStaleAtlasJobs"]>
): ReturnType<JobLedgerModule["recoverStaleAtlasJobs"]> {
	const { recoverStaleAtlasJobs } = await loadJobLedger();
	return recoverStaleAtlasJobs(...args);
}

export async function completeAtlasJob(
	...args: Parameters<JobLedgerModule["completeAtlasJob"]>
): ReturnType<JobLedgerModule["completeAtlasJob"]> {
	const { completeAtlasJob } = await loadJobLedger();
	return completeAtlasJob(...args);
}

export async function failAtlasJob(
	...args: Parameters<JobLedgerModule["failAtlasJob"]>
): ReturnType<JobLedgerModule["failAtlasJob"]> {
	const { failAtlasJob } = await loadJobLedger();
	return failAtlasJob(...args);
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
	const [{ submitAtlasJobIntakeWithDependencies }, jobLedger] =
		await Promise.all([import("./intake"), loadJobLedger()]);
	return submitAtlasJobIntakeWithDependencies(input, {
		createOrReuseAtlasJob: jobLedger.createOrReuseAtlasJob,
	});
}

export function wakeAtlasWorker(): void {
	void loadWorkerRunner()
		.then(({ wakeAtlasWorker }) => wakeAtlasWorker())
		.catch((error) => {
			console.error("[ATLAS] Failed to wake worker", { error });
		});
}

export async function ensureAtlasWorker(
	...args: Parameters<WorkerRunnerModule["ensureAtlasWorker"]>
): ReturnType<WorkerRunnerModule["ensureAtlasWorker"]> {
	const { ensureAtlasWorker } = await loadWorkerRunner();
	return ensureAtlasWorker(...args);
}

export interface KickoffAtlasTurnInput {
	userId: string;
	conversationId: string;
	message: string;
	profile: AtlasProfile;
	action?: AtlasAction;
	parentAtlasId?: string | null;
	clientAtlasTurnId?: string | null;
}

export type KickoffAtlasTurnResult =
	| {
			ok: true;
			value: {
				assistantResponse: string;
				assistantMetadata: {
					evidenceStatus: "not_applicable";
					atlas: {
						jobId: string;
						status: string;
						stage: string;
						profile: AtlasProfile;
						action: AtlasAction;
						reused: boolean;
					};
				};
				atlasJob: AtlasJobCard;
				reused: boolean;
			};
	  }
	| {
			ok: false;
			error: {
				status: number;
				error: string;
				code: string;
			};
	  };

export async function kickoffAtlasTurn(
	input: KickoffAtlasTurnInput,
): Promise<KickoffAtlasTurnResult> {
	const action = normalizeAtlasAction(input.action);
	const clientAtlasTurnId = input.clientAtlasTurnId?.trim();
	if (!clientAtlasTurnId) {
		return {
			ok: false,
			error: {
				status: 400,
				error: "clientAtlasTurnId is required for Atlas turns.",
				code: "ATLAS_CLIENT_TURN_ID_REQUIRED",
			},
		};
	}

	const result = await submitAtlasJobIntake({
		userId: input.userId,
		conversationId: input.conversationId,
		action,
		parentAtlasJobId: input.parentAtlasId ?? null,
		profile: input.profile,
		query: input.message,
		clientAtlasTurnId,
	});

	return {
		ok: true,
		value: {
			assistantResponse: buildAtlasKickoffAssistantMessage(result.job.profile),
			assistantMetadata: {
				evidenceStatus: "not_applicable",
				atlas: {
					jobId: result.job.id,
					status: result.job.status,
					stage: result.job.stage,
					profile: result.job.profile,
					action,
					reused: result.reused,
				},
			},
			atlasJob: result.job,
			reused: result.reused,
		},
	};
}

function buildAtlasKickoffAssistantMessage(profile: AtlasProfile): string {
	return `Atlas is queued with the ${profile} profile. You can close this page and return for progress.`;
}

function normalizeAtlasAction(action: AtlasAction | undefined): AtlasAction {
	return action === "continue" || action === "fork" || action === "revise"
		? action
		: "create";
}
