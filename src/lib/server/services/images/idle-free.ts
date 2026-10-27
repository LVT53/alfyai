// Gives the picture server's GPU memory back after a quiet spell. One unref'd
// timer on `globalThis` (so a double import or an HMR re-evaluation finds the
// same one); every take that ends re-arms it. When it fires with no take
// queued or running in this app and nothing in ComfyUI's queue, the models are
// unloaded with POST /free.

import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { imageJobs } from "$lib/server/db/schema";
import { createConfiguredComfyClient } from "./comfy-client";
import type { ComfyUiClient } from "./comfyui/client";

/** Measured in plan 2c Task 4. */
export const IMAGE_IDLE_FREE_MS = 15 * 60_000;

const TIMER_KEY = Symbol.for("alfyai.images.idleFreeTimer");
type Holder = { [TIMER_KEY]?: ReturnType<typeof setTimeout> };

/** Whether a take is queued or running in the app's ledger. */
async function anyLiveTake(): Promise<boolean> {
	const rows = await db
		.select({ id: imageJobs.id })
		.from(imageJobs)
		.where(inArray(imageJobs.status, ["queued", "running"]))
		.limit(1);
	return rows.length > 0;
}

/** Frees ComfyUI when the app has no live take and ComfyUI's queue is empty. True when /free was sent. */
export async function freeIfIdle(client: ComfyUiClient): Promise<boolean> {
	if (await anyLiveTake()) return false;
	if ((await client.queueSize()) > 0) return false;
	await client.free();
	return true;
}

export function scheduleIdleFree(options?: { delayMs?: number }): void {
	const holder = globalThis as Holder;
	const existing = holder[TIMER_KEY];
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		holder[TIMER_KEY] = undefined;
		void fire();
	}, options?.delayMs ?? IMAGE_IDLE_FREE_MS);
	timer.unref();
	holder[TIMER_KEY] = timer;
}

/** The timer's work. Never rejects: a picture server that is down has nothing to free. */
async function fire(): Promise<void> {
	const client = createConfiguredComfyClient();
	if (!client) return;
	try {
		await freeIfIdle(client);
	} catch (error) {
		console.warn("[IMAGES] Could not free the picture server", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		client.close();
	}
}
