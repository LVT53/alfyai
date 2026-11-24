// A video take on the job engine: the KIND (its definition) and the functions
// the app calls to queue, stop and retry takes. The engine owns every lifecycle
// transition; this file writes only the take's own columns. The handler
// (`runner.ts`) loads on the first claim, so a route that only queues or
// cancels never pulls in ffmpeg, sharp or the LTX graph.
//
// One take at a time install-wide and one per person: LTX and H3 cannot be
// resident on the card together, so a second video would only wait behind a
// model swap. The picture kind's six-at-once shape does not apply here.

import { and, eq, isNull, type SQL } from "drizzle-orm";
import { isVideoMakingConfigured } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { videoJobAttempts, videoJobs } from "$lib/server/db/schema";
import {
	cancel,
	cancelAll,
	defineJobKind,
	enqueue,
	retry,
} from "$lib/server/services/jobs";
import { promptIdOf } from "../take-request";
import { createVideoComfyClient } from "./comfy-client";
import { parseVideoTakeRequest, type VideoTakeRequest } from "./request";

const WORKER_LOST_LIMIT = 3;

export const videoJob = defineJobKind({
	name: "video",
	logPrefix: "[VIDEO]",
	tables: { jobs: videoJobs, attempts: videoJobAttempts },
	enabled: () => isVideoMakingConfigured(),
	limits: () => ({ global: 1, perUser: 1 }),
	lease: () => ({ heartbeatMs: 15_000, staleAfterMs: 120_000 }),
	phases: ["submitted", "starting", "rendering", "finishing"],
	lostAttempt: () => ({
		code: "video_worker_lost",
		message: "The video worker stopped before finishing.",
	}),
	onFailure: (failure, { attempts }) =>
		failure.code === "video_worker_lost" && attempts < WORKER_LOST_LIMIT
			? { requeue: true, delayMs: 2_000 }
			: { requeue: false, retryable: failure.retryable },
	userRetry: { from: ["failed", "cancelled"] },
	// A take that goes (back) to the queue starts its display columns afresh and
	// forgets which kind of Stop an earlier run was given. The checkpoint is the
	// engine's and survives on purpose: that is what resumes a render. A claim
	// stamps `phase_at` in its own transaction: from that moment the take holds
	// the GPU for the cross-engine gate (`idle-free.ts`).
	onTransition: (tx, row, to) => {
		if (to === "running") {
			tx.update(videoJobs)
				.set({ phaseAt: Date.now() })
				.where(eq(videoJobs.id, row.id))
				.run();
			return;
		}
		if (to !== "queued") return;
		tx.update(videoJobs)
			.set({
				queueAhead: null,
				progressPercent: null,
				etaAt: null,
				phaseAt: null,
				cancelInterrupt: 1,
			})
			.where(eq(videoJobs.id, row.id))
			.run();
	},
	handler: () => import("./runner").then((module) => module.runVideoTake),
});

/** Queues one take. The tool slice builds the request and the seed. */
export async function enqueueVideoTake(input: {
	userId: string;
	conversationId: string;
	artifactId: string | null;
	toolCallId: string | null;
	origin: "turn" | "retry" | "another";
	retryOf: string | null;
	request: VideoTakeRequest;
	seed: number;
}): Promise<{ takeId: string }> {
	const { row } = await enqueue(videoJob, {
		values: {
			userId: input.userId,
			conversationId: input.conversationId,
			artifactId: input.artifactId,
			toolCallId: input.toolCallId,
			origin: input.origin,
			retryOf: input.retryOf,
			requestJson: JSON.stringify(input.request),
			seed: input.seed,
		},
	});
	return { takeId: row.id };
}

/**
 * Stops a take. `interrupt: true` (the card's own Stop, the default) may stop
 * the prompt ComfyUI is already rendering. `interrupt: false` (the composer's
 * Stop) cancels a take that has not reached ComfyUI (no prompt id recorded) and
 * otherwise only deletes a prompt still waiting in ComfyUI's queue: a render
 * that has started finishes and then the take stops at its next boundary, so
 * nothing is cancelled and false comes back.
 *
 * The kind of Stop is written on the take before the engine cancels it, so the
 * run that gets the abort (in this process or another) acts on the right one.
 */
export async function cancelVideoTake(
	userId: string,
	takeId: string,
	options: { interrupt?: boolean } = {},
): Promise<boolean> {
	const interrupt = options.interrupt ?? true;
	const [row] = await db
		.select({
			userId: videoJobs.userId,
			status: videoJobs.status,
			checkpoint: videoJobs.checkpoint,
			requestJson: videoJobs.requestJson,
		})
		.from(videoJobs)
		.where(eq(videoJobs.id, takeId))
		.limit(1);
	if (!row || row.userId !== userId) return false;
	if (row.status !== "queued" && row.status !== "running") return false;

	if (!interrupt && row.status === "running") {
		const promptId = promptIdOf(row.checkpoint);
		if (!promptId) {
			// The runner writes the prompt id it will submit under BEFORE it posts,
			// so a running take with none is still preparing its inputs and has not
			// reached ComfyUI: it is cancelled outright. The check and the cancel
			// are one transaction, so a checkpoint written meanwhile wins (the take
			// is then left to the queue's rule on the next Stop).
			const cancelled = await cancelAll(videoJob, {
				userId,
				where: (jobs) =>
					and(eq(jobs.id, takeId), isNull(jobs.checkpoint)) as SQL,
			});
			return cancelled > 0;
		}
		const request = parseVideoTakeRequest(row.requestJson);
		if (!request) return false;
		const client = createVideoComfyClient();
		if (!client) return false;
		try {
			const found = await client.cancel(promptId, { interrupt: false });
			if (found !== "deleted") return false;
		} catch {
			return false;
		} finally {
			client.close();
		}
	}

	await db
		.update(videoJobs)
		.set({ cancelInterrupt: interrupt ? 1 : 0 })
		.where(eq(videoJobs.id, takeId));
	return (await cancel(videoJob, takeId, { userId })) !== null;
}

/** The person's Retry of a failed or cancelled take. */
export async function retryVideoTake(
	userId: string,
	takeId: string,
): Promise<boolean> {
	// A take the explicit-picture filter blocked would make the same clip again.
	const [take] = await db
		.select({ errorCode: videoJobs.errorCode })
		.from(videoJobs)
		.where(and(eq(videoJobs.id, takeId), eq(videoJobs.userId, userId)))
		.limit(1);
	if (take?.errorCode === "video_blocked") return false;
	return (await retry(videoJob, takeId, { userId })) !== null;
}

/** Account erasure and Clear Workspace: every queued or running video take stops at once. */
export async function cancelVideoTakesForUser(
	userId: string,
): Promise<{ cancelled: number }> {
	return { cancelled: await cancelAll(videoJob, { userId }) };
}

/** A chat's delete: its takes stop before its files are removed. */
export async function cancelVideoTakesForConversation(
	userId: string,
	conversationId: string,
): Promise<{ cancelled: number }> {
	return {
		cancelled: await cancelAll(videoJob, {
			userId,
			where: (jobs) => eq(jobs.conversationId, conversationId),
		}),
	};
}
