import type {
	DeepResearchDepth,
	DeepResearchJob,
	DeepResearchReportActionResult,
	DeepResearchReportIntent,
	DeepResearchResearchFurtherActionResult,
	ModelId,
} from "$lib/types";
import { type FetchLike, requestJson } from "./http";

interface DeepResearchJobResponse {
	job: DeepResearchJob;
}

interface DeepResearchChatSendResponse {
	conversationId: string;
	response: null;
	deepResearchJob: DeepResearchJob;
}

export interface StartDeepResearchChatJobInput {
	conversationId: string;
	message: string;
	depth: DeepResearchDepth;
	modelId?: ModelId;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	personalityProfileId?: string | null;
}

export interface DeepResearchWorkflowAdvanceResult {
	advanced: boolean;
	outcome: string;
	status: DeepResearchJob["status"];
	stage: string | null;
	job: DeepResearchJob;
}

export async function startDeepResearchChatJob(
	input: StartDeepResearchChatJobInput,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchJob> {
	const payload = await requestJson<DeepResearchChatSendResponse>(
		"/api/chat/send",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: input.conversationId,
				message: input.message,
				model: input.modelId,
				attachmentIds: input.attachmentIds ?? [],
				deepResearch: { depth: input.depth },
				activeDocumentArtifactId: input.activeDocumentArtifactId,
				personalityProfileId: input.personalityProfileId,
			}),
		},
		"Failed to start Deep Research",
		fetchImpl,
	);
	return payload.deepResearchJob;
}

export async function advanceDeepResearchWorkflow(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchWorkflowAdvanceResult> {
	return requestJson<DeepResearchWorkflowAdvanceResult>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/workflow/advance`,
		{ method: "POST" },
		"Failed to advance Deep Research workflow",
		fetchImpl,
	);
}

export async function cancelDeepResearchJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchJob> {
	const payload = await requestJson<DeepResearchJobResponse>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/cancel`,
		{ method: "POST" },
		"Failed to cancel Deep Research",
		fetchImpl,
	);
	return payload.job;
}

export async function editDeepResearchPlan(
	jobId: string,
	instructions: string,
	reportIntentOrFetch:
		| DeepResearchReportIntent
		| FetchLike
		| undefined = undefined,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchJob> {
	const reportIntent =
		typeof reportIntentOrFetch === "function" ? undefined : reportIntentOrFetch;
	const requestFetch =
		typeof reportIntentOrFetch === "function" ? reportIntentOrFetch : fetchImpl;
	const payload = await requestJson<DeepResearchJobResponse>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/plan/edit`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				editInstruction: instructions,
				...(reportIntent ? { reportIntent } : {}),
			}),
		},
		"Failed to edit Research Plan",
		requestFetch,
	);
	return payload.job;
}

export async function approveDeepResearchPlan(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchJob> {
	const payload = await requestJson<DeepResearchJobResponse>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/plan/approve`,
		{ method: "POST" },
		"Failed to approve Research Plan",
		fetchImpl,
	);
	return payload.job;
}

export async function discussDeepResearchReport(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DeepResearchReportActionResult> {
	return requestJson<DeepResearchReportActionResult>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/report-actions/discuss`,
		{ method: "POST" },
		"Failed to discuss Deep Research artifact",
		fetchImpl,
	);
}

export async function researchFurtherFromDeepResearchReport(
	jobId: string,
	optionsOrFetch:
		| FetchLike
		| { depth?: DeepResearchDepth; fetchImpl?: FetchLike } = fetch,
): Promise<DeepResearchResearchFurtherActionResult> {
	const fetchImpl =
		typeof optionsOrFetch === "function"
			? optionsOrFetch
			: (optionsOrFetch.fetchImpl ?? fetch);
	const depth =
		typeof optionsOrFetch === "function" ? undefined : optionsOrFetch.depth;
	return requestJson<DeepResearchResearchFurtherActionResult>(
		`/api/deep-research/jobs/${encodeURIComponent(jobId)}/report-actions/research-further`,
		{
			method: "POST",
			...(depth
				? {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ depth }),
					}
				: {}),
		},
		"Failed to research further from Deep Research artifact",
		fetchImpl,
	);
}
