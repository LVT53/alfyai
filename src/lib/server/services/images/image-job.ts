// A take on the job engine: the KIND (its definition) and the functions the app
// calls to queue, stop, retry and cancel takes. The engine owns every lifecycle
// transition; this file writes only the take's own columns. The handler
// (`image-runner.ts`) loads on the first claim, so a route that only queues or
// cancels never pulls in the pixel guards or sharp.
//
// Up to six takes may be running at once install-wide so their prompts reach
// ComfyUI together and its own queue orders them (plan's call); a person may
// have four.

import { eq } from "drizzle-orm";
import { getConfig, isImageMakingConfigured } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobAttempts, imageJobs } from "$lib/server/db/schema";
import {
	cancel,
	cancelAll,
	defineJobKind,
	enqueue,
	retry,
} from "$lib/server/services/jobs";
import { createConfiguredComfyClient } from "./comfy-client";
import { freshSeed } from "./seeds";
import { promptIdOf, type TakeRequest } from "./take-request";

export { IMAGE_RENDER_DEADLINE_MS } from "./take-request";

const WORKER_LOST_LIMIT = 3;

export const imageJob = defineJobKind({
	name: "image",
	logPrefix: "[IMAGES]",
	tables: { jobs: imageJobs, attempts: imageJobAttempts },
	enabled: () => isImageMakingConfigured(getConfig()),
	limits: () => ({ global: 6, perUser: 4 }),
	lease: () => ({ heartbeatMs: 10_000, staleAfterMs: 90_000 }),
	phases: ["submitted", "starting", "rendering", "finishing"],
	lostAttempt: () => ({
		code: "image_worker_lost",
		message: "The picture worker stopped before finishing.",
	}),
	onFailure: (failure, { attempts }) =>
		failure.code === "image_worker_lost" && attempts < WORKER_LOST_LIMIT
			? { requeue: true, delayMs: 2_000 }
			: { requeue: false, retryable: failure.retryable },
	userRetry: { from: ["failed", "cancelled"] },
	// A take that goes (back) to the queue starts its display columns afresh and
	// forgets which kind of Stop an earlier run was given.
	onTransition: (tx, row, to) => {
		if (to !== "queued") return;
		tx.update(imageJobs)
			.set({
				queueAhead: null,
				progressPercent: null,
				etaSeconds: null,
				phaseAt: null,
				cancelInterrupt: 1,
			})
			.where(eq(imageJobs.id, row.id))
			.run();
	},
	handler: () => import("./image-runner").then((m) => m.runImageTake),
});

export async function enqueueTake(input: {
	userId: string;
	conversationId: string;
	cardId: string;
	toolCallId: string | null;
	origin: "turn" | "retry" | "auto_retry" | "another";
	retryOf: string | null;
	request: TakeRequest;
	seed: number;
	heldUntil: number | null;
}): Promise<{ takeId: string }> {
	// Never the seed that made an input (global constraint): a caller's seed that
	// is on the avoid list is redrawn, so the rule holds whoever queues the take.
	const seed = input.request.avoidSeeds.includes(input.seed)
		? freshSeed(input.request.avoidSeeds)
		: input.seed;
	const { row } = await enqueue(imageJob, {
		values: {
			userId: input.userId,
			conversationId: input.conversationId,
			cardId: input.cardId,
			toolCallId: input.toolCallId,
			origin: input.origin,
			retryOf: input.retryOf,
			requestJson: JSON.stringify(input.request),
			seed,
			heldUntil: input.heldUntil,
		},
	});
	return { takeId: row.id };
}

/**
 * Stops a take. `interrupt: true` (the card's own Stop, the default) may stop
 * a prompt ComfyUI is already rendering. `interrupt: false` (the composer's
 * Stop) only deletes a prompt still waiting in ComfyUI's queue: a take that has
 * started finishes onto its card, so nothing is cancelled and false comes back.
 * The kind of Stop is written on the take before the engine cancels it, so the
 * run that gets the abort (in this process or another) acts on the right one.
 */
export async function cancelTake(
	userId: string,
	takeId: string,
	options: { interrupt?: boolean } = {},
): Promise<boolean> {
	const interrupt = options.interrupt ?? true;
	const [row] = await db
		.select({
			userId: imageJobs.userId,
			status: imageJobs.status,
			checkpoint: imageJobs.checkpoint,
		})
		.from(imageJobs)
		.where(eq(imageJobs.id, takeId))
		.limit(1);
	if (!row || row.userId !== userId) return false;
	if (row.status !== "queued" && row.status !== "running") return false;

	if (!interrupt && row.status === "running") {
		const promptId = promptIdOf(row.checkpoint);
		if (promptId) {
			// Submitted: take it out of ComfyUI's queue if it is still waiting there.
			// Anything else (rendering, gone, ComfyUI unreachable) leaves the take alone.
			const client = createConfiguredComfyClient();
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
	}

	await db
		.update(imageJobs)
		.set({ cancelInterrupt: interrupt ? 1 : 0 })
		.where(eq(imageJobs.id, takeId));
	return (await cancel(imageJob, takeId, { userId })) !== null;
}

/** The person's Retry of a failed or cancelled take. */
export async function retryTake(
	userId: string,
	takeId: string,
): Promise<boolean> {
	return (await retry(imageJob, takeId, { userId })) !== null;
}

/** Account erasure and Clear Workspace: every queued or running take of the person's stops at once. */
export async function cancelImageTakesForUser(
	userId: string,
): Promise<{ cancelled: number }> {
	return { cancelled: await cancelAll(imageJob, { userId }) };
}

/** A chat's delete: its takes stop before its picture files are removed, so none stores a file into a chat that is going. */
export async function cancelImageTakesForConversation(
	userId: string,
	conversationId: string,
): Promise<{ cancelled: number }> {
	return {
		cancelled: await cancelAll(imageJob, {
			userId,
			where: (jobs) => eq(jobs.conversationId, conversationId),
		}),
	};
}
