import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { type FetchLike, requestJson, requestResponse } from "./http";

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

/**
 * Makes a deleted produced file again: the same job is queued again from the
 * request it kept (`POST /api/chat/files/jobs/[id]/regenerate`). Throws when
 * there is nothing to make again — the job still has its file, kept no
 * request, or is not the caller's.
 */
export async function regenerateFileProductionJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<FileProductionJob> {
	const payload = await requestJson<FileProductionJobResponse>(
		`/api/chat/files/jobs/${encodeURIComponent(jobId)}/regenerate`,
		{ method: "POST" },
		"Failed to regenerate the file",
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

/**
 * Whether a produced file is still there, asked before its Open: a one-byte
 * ranged read of its preview, which the server answers 404 for a file that was
 * deleted (from the panel, in another tab). Only that answer says "gone" —
 * offline or a server error gives the panel the benefit of the doubt, and it
 * shows its own state.
 */
export async function chatFileStillExists(
	previewUrl: string,
	fetchImpl: FetchLike = fetch,
): Promise<boolean> {
	try {
		const response = await requestResponse(
			previewUrl,
			{ headers: { Range: "bytes=0-0" } },
			fetchImpl,
		);
		return response.status !== 404;
	} catch {
		return true;
	}
}
