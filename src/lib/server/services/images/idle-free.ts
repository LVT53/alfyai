// GPU memory ownership across the two picture services. After a quiet spell
// (one unref'd timer on `globalThis`, so a double import or an HMR
// re-evaluation finds the same one) every configured service is freed. Before a
// take is submitted, the OTHER model's service is freed as well: H3 4 MP peaks at
// the card's edge, so Qwen's resident models must go before H3 loads, and the
// same is true the other way round. The take's own service is never freed.

import { inArray } from "drizzle-orm";
import {
	getComfyuiUrlForModel,
	type ImageModel,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobs } from "$lib/server/db/schema";
import { createConfiguredComfyClient } from "./comfy-client";
import type { ComfyUiClient } from "./comfyui/client";

import { IMAGE_IDLE_FREE_MS } from "./take-request";

export { IMAGE_IDLE_FREE_MS };

const TIMER_KEY = Symbol.for("alfyai.images.idleFreeTimer");
type Holder = { [TIMER_KEY]?: ReturnType<typeof setTimeout> };

/** Every picture model the app can talk to, in a stable free order. */
const PICTURE_MODELS: readonly ImageModel[] = ["qwen", "h3"];

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

/** One server is one address, whether or not a hand-typed URL ends in "/". */
function sameAddress(a: string, b: string): boolean {
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** The model a take does not use: its service's models must go before the take loads its own. */
export function otherPictureModel(model: ImageModel): ImageModel {
	return model === "h3" ? "qwen" : "h3";
}

/**
 * Frees the OTHER picture model's service before a take is submitted. A service
 * that is not configured (or shares the selected one's address) is skipped, and
 * an unreachable one is ignored: the free is a memory optimisation, never a
 * reason for a take to fail.
 */
export async function freeOtherPictureModel(model: ImageModel): Promise<void> {
	const other = otherPictureModel(model);
	const otherUrl = getComfyuiUrlForModel(other);
	if (otherUrl === "" || sameAddress(otherUrl, getComfyuiUrlForModel(model))) {
		return;
	}
	const client = createConfiguredComfyClient(other);
	if (!client) return;
	try {
		await client.free();
	} catch {
		// The other server is down or refusing; the take goes on.
	} finally {
		client.close();
	}
}

/**
 * The idle timer's work: free every configured service, the selected one
 * included. A picture server that is down has nothing to free.
 */
export async function freeConfiguredServices(): Promise<void> {
	const freed: string[] = [];
	for (const model of PICTURE_MODELS) {
		const url = getComfyuiUrlForModel(model);
		if (url === "" || freed.some((seen) => sameAddress(seen, url))) continue;
		freed.push(url);
		const client = createConfiguredComfyClient(model);
		if (!client) continue;
		try {
			await freeIfIdle(client);
		} catch (error) {
			console.warn("[IMAGES] Could not free a picture server", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			client.close();
		}
	}
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

/** The timer's work. Never rejects. */
async function fire(): Promise<void> {
	await freeConfiguredServices();
}
