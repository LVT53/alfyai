import type { FileProductionJob } from "$lib/types";
import { type FetchLike, requestJson } from "./http";

interface FileProductionJobResponse {
	job: FileProductionJob;
}

export async function retryFileProductionJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<FileProductionJob> {
	const payload = await requestJson<FileProductionJobResponse>(
		`/api/chat/files/jobs/${encodeURIComponent(jobId)}/retry`,
		{ method: "POST" },
		"Failed to retry file production",
		fetchImpl,
	);
	return payload.job;
}

export async function cancelFileProductionJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<FileProductionJob> {
	const payload = await requestJson<FileProductionJobResponse>(
		`/api/chat/files/jobs/${encodeURIComponent(jobId)}/cancel`,
		{ method: "POST" },
		"Failed to cancel file production",
		fetchImpl,
	);
	return payload.job;
}

export async function dismissFileProductionJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<FileProductionJob> {
	const payload = await requestJson<FileProductionJobResponse>(
		`/api/chat/files/jobs/${encodeURIComponent(jobId)}/dismiss`,
		{ method: "POST" },
		"Failed to dismiss file production",
		fetchImpl,
	);
	return payload.job;
}
