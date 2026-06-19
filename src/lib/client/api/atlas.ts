import type {
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
	LinkedContextSource,
} from "$lib/types";
import { type FetchLike, requestJson } from "./http";

export interface SubmitAtlasTurnPayload {
	conversationId: string;
	message: string;
	attachmentIds: string[];
	linkedSources?: LinkedContextSource[];
	profile: AtlasProfile;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	clientAtlasTurnId: string;
}

export interface SubmitAtlasTurnResult {
	message: string;
	atlasJob: AtlasJobCard;
}

interface AtlasJobResponse {
	job: AtlasJobCard;
}

interface AtlasSendResponse {
	response?: {
		text?: string;
	};
	message?: string;
	atlasJob?: AtlasJobCard;
}

export async function cancelAtlasJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<AtlasJobCard> {
	const payload = await requestJson<AtlasJobResponse>(
		`/api/atlas/jobs/${encodeURIComponent(jobId)}/cancel`,
		{ method: "POST" },
		"Failed to cancel Atlas",
		fetchImpl,
	);
	return payload.job;
}

export async function submitAtlasTurn(
	payload: SubmitAtlasTurnPayload,
	fetchImpl: FetchLike = fetch,
): Promise<SubmitAtlasTurnResult> {
	const response = await requestJson<AtlasSendResponse>(
		"/api/chat/send",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				conversationId: payload.conversationId,
				message: payload.message,
				attachmentIds: payload.attachmentIds,
				linkedSources: payload.linkedSources ?? [],
				atlasMode: true,
				atlasProfile: payload.profile,
				atlasAction: payload.action,
				parentAtlasId: payload.parentAtlasJobId ?? null,
				clientAtlasTurnId: payload.clientAtlasTurnId,
			}),
		},
		"Failed to start Atlas",
		fetchImpl,
	);

	if (!response.atlasJob) {
		throw new Error("The server returned no Atlas job.");
	}

	return {
		message: response.response?.text ?? response.message ?? "",
		atlasJob: response.atlasJob,
	};
}
