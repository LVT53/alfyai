import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { type FetchLike, requestJson, requestResponse } from "./http";

interface FileProductionJobResponse {
	job: FileProductionJob;
}

/**
 * One of the caller's own jobs by its id (`GET /api/chat/files/jobs/[id]`), with
 * the files it has made so far. `null` when the server says there is no such job
 * for this user (404: gone, or not theirs) or the session ended (401): nothing
 * will ever show up, so a caller that waits stops. Any other failure (the network,
 * a 5xx) throws, and `waitForFileProductionJob` takes that for "not known yet".
 */
export async function fetchFileProductionJob(
	jobId: string,
	fetchImpl: FetchLike = fetch,
): Promise<FileProductionJob | null> {
	const response = await requestResponse(
		`/api/chat/files/jobs/${encodeURIComponent(jobId)}`,
		undefined,
		fetchImpl,
	);
	if (response.status === 401 || response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`Could not read the file job (${response.status})`);
	}
	const payload = (await response.json()) as FileProductionJobResponse;
	return payload.job;
}

/** How a wait on a job ended: it made its file, it did not, the wait ran out, or the job is not there to wait on. */
export type FileProductionJobWaitResult =
	| { state: "succeeded"; job: FileProductionJob }
	| { state: "failed"; job: FileProductionJob }
	| { state: "timeout"; job: FileProductionJob }
	| { state: "gone" };

export interface FileProductionJobWaitOptions {
	/** The whole wait. A job that is still running then is not waited for any longer. */
	timeoutMs?: number;
	/** The pause before the next read, by how many reads were made: quick at first, since a document export takes well under a second. */
	pollDelayMs?: (readsSoFar: number) => number;
	signal?: AbortSignal;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export const FILE_PRODUCTION_JOB_WAIT_TIMEOUT_MS = 60_000;

function defaultPollDelayMs(readsSoFar: number): number {
	if (readsSoFar < 3) return 250;
	if (readsSoFar < 8) return 500;
	return 1000;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Follows a job the caller started until it has finished: succeeded, failed or
 * cancelled, no longer there, or the wait ran out (the job then keeps the status
 * it last had). The first read is made at once. A read that fails is not a
 * verdict (the job is still running on the server): the next read tries again.
 */
export async function waitForFileProductionJob(
	job: FileProductionJob,
	options: FileProductionJobWaitOptions = {},
): Promise<FileProductionJobWaitResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const pollDelayMs = options.pollDelayMs ?? defaultPollDelayMs;
	const deadline =
		now() +
		Math.max(0, options.timeoutMs ?? FILE_PRODUCTION_JOB_WAIT_TIMEOUT_MS);
	let latest = job;

	for (let reads = 0; ; reads++) {
		if (latest.status === "succeeded")
			return { state: "succeeded", job: latest };
		if (latest.status === "failed" || latest.status === "cancelled") {
			return { state: "failed", job: latest };
		}
		if (options.signal?.aborted) return { state: "timeout", job: latest };

		try {
			const read = await fetchFileProductionJob(latest.id, options.fetchImpl);
			if (!read) return { state: "gone" };
			latest = read;
			// A finished job is answered at the top of the loop, with no pause.
			if (
				latest.status === "succeeded" ||
				latest.status === "failed" ||
				latest.status === "cancelled"
			) {
				continue;
			}
		} catch {
			// The network or a 5xx: say nothing about the job, read it again.
		}

		const remainingMs = deadline - now();
		if (remainingMs <= 0) return { state: "timeout", job: latest };
		await sleep(Math.min(pollDelayMs(reads), remainingMs));
	}
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
