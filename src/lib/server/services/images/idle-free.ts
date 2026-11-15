// GPU memory ownership across the picture and video services. After a quiet
// spell (one unref'd timer on `globalThis`, so a double import or an HMR
// re-evaluation finds the same one) every configured service is freed. Before a
// take is submitted, every OTHER engine's service is freed as well: the card
// holds one engine at a time (H3 12 MP peaks at its edge; LTX peaks at the same
// edge), so the take's own service must load into memory the others no longer
// hold. The take's own service is never freed — a list, not a pair, because a
// third engine makes "the other one" wrong.

import { inArray } from "drizzle-orm";
import {
	getComfyuiLtxUrl,
	getComfyuiUrlForModel,
	type ImageModel,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobs, videoJobs } from "$lib/server/db/schema";
import { createConfiguredComfyClient } from "./comfy-client";
import { type ComfyUiClient, createComfyUiClient } from "./comfyui/client";

import { IMAGE_IDLE_FREE_MS } from "./take-request";

export { IMAGE_IDLE_FREE_MS };

/** Every engine the box can hold at once: the two picture models and LTX. */
export type PictureEngine = ImageModel | "ltx";

const TIMER_KEY = Symbol.for("alfyai.images.idleFreeTimer");
type Holder = { [TIMER_KEY]?: ReturnType<typeof setTimeout> };

/** Every engine the app can talk to, in a stable free order. */
const PICTURE_ENGINES: readonly PictureEngine[] = ["qwen", "h3", "ltx"];

/** Whether a take (picture or video) is queued or running in the app's ledger. */
async function anyLiveTake(): Promise<boolean> {
	const pictures = await db
		.select({ id: imageJobs.id })
		.from(imageJobs)
		.where(inArray(imageJobs.status, ["queued", "running"]))
		.limit(1);
	if (pictures.length > 0) return true;
	const videos = await db
		.select({ id: videoJobs.id })
		.from(videoJobs)
		.where(inArray(videoJobs.status, ["queued", "running"]))
		.limit(1);
	return videos.length > 0;
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

/** The address an engine listens on; empty means it is not configured. */
function engineComfyUrl(engine: PictureEngine): string {
	return engine === "ltx" ? getComfyuiLtxUrl() : getComfyuiUrlForModel(engine);
}

/**
 * Every engine except the take's own, in the stable order. One engine is
 * skipped, never the list of the others: with three engines on one card, "the
 * other picture model" frees the wrong server.
 */
export function otherPictureModels(engine: PictureEngine): PictureEngine[] {
	return PICTURE_ENGINES.filter((candidate) => candidate !== engine);
}

function createEngineClient(engine: PictureEngine): ComfyUiClient | null {
	if (engine === "ltx") {
		const url = getComfyuiLtxUrl();
		return url === "" ? null : createComfyUiClient({ baseUrl: url });
	}
	return createConfiguredComfyClient(engine);
}

/**
 * Frees every OTHER engine's service before a take is submitted. An engine
 * that is not configured (or shares the take's own address) is skipped, and an
 * unreachable one is ignored: the free is a memory optimisation, never a
 * reason for a take to fail.
 */
export async function freeOtherPictureModels(
	engine: PictureEngine,
): Promise<void> {
	const own = engineComfyUrl(engine);
	const freed: string[] = [];
	for (const other of otherPictureModels(engine)) {
		const url = engineComfyUrl(other);
		if (url === "") continue;
		if (own !== "" && sameAddress(url, own)) continue;
		if (freed.some((seen) => sameAddress(seen, url))) continue;
		freed.push(url);
		const client = createEngineClient(other);
		if (!client) continue;
		try {
			await client.free();
		} catch {
			// The other server is down or refusing; the take goes on.
		} finally {
			client.close();
		}
	}
}

/**
 * The image runner's call: free every engine except the picture model it
 * renders on, LTX included. Kept as the picture path's name so the image
 * handler is unchanged; the video runner asks `freeOtherPictureModels("ltx")`.
 */
export async function freeOtherPictureModel(model: ImageModel): Promise<void> {
	await freeOtherPictureModels(model);
}

/**
 * The idle timer's work: free every configured service, the selected one
 * included. A server that is down has nothing to free.
 */
export async function freeConfiguredServices(): Promise<void> {
	const freed: string[] = [];
	for (const engine of PICTURE_ENGINES) {
		const url = engineComfyUrl(engine);
		if (url === "" || freed.some((seen) => sameAddress(seen, url))) continue;
		freed.push(url);
		const client = createEngineClient(engine);
		if (!client) continue;
		try {
			await freeIfIdle(client);
		} catch (error) {
			console.warn("[IMAGES] Could not free a picture server", {
				engine,
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
