// GPU memory ownership across the picture and video services. After a quiet
// spell (one unref'd timer on `globalThis`, so a double import or an HMR
// re-evaluation finds the same one) every configured service is freed. Before a
// take is submitted, every OTHER engine's service is freed as well: the card
// holds one engine at a time (H3 12 MP peaks at its edge; LTX peaks at the same
// edge), so the take's own service must load into memory the others no longer
// hold. The take's own service is never freed — a list, not a pair, because a
// third engine makes "the other one" wrong.

import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import {
	getComfyuiLtxUrl,
	getComfyuiUrlForModel,
	type ImageModel,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobs, videoJobs } from "$lib/server/db/schema";
import { createConfiguredComfyClient } from "./comfy-client";
import { type ComfyUiClient, createComfyUiClient } from "./comfyui/client";

import { IMAGE_IDLE_FREE_MS, parseTakeRequest } from "./take-request";

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

/** The phases of a take that reached the GPU: its engine's models were loaded for it. */
const ON_THE_GPU = ["starting", "rendering", "finishing"];

/**
 * Whether `engine` most likely still holds its models, for the estimate's load
 * time (`take-eta.ts`): another take of it is on the GPU now, or the take that
 * last reached the GPU (on any engine) was on it and ended within
 * IMAGE_IDLE_FREE_MS. A take on another engine frees this one before it
 * submits, and the idle timer frees every engine after that long. A guess: a
 * wrong one only makes the countdown run faster or run over, nothing else.
 */
export async function engineLooksWarm(
	engine: PictureEngine,
	takeId: string,
	now = Date.now(),
): Promise<boolean> {
	if (engine === "ltx") {
		const [busy] = await db
			.select({ id: videoJobs.id })
			.from(videoJobs)
			.where(
				and(
					eq(videoJobs.status, "running"),
					ne(videoJobs.id, takeId),
					inArray(videoJobs.phase, ON_THE_GPU),
				),
			)
			.limit(1);
		if (busy) return true;
	} else {
		const busy = await db
			.select({ requestJson: imageJobs.requestJson })
			.from(imageJobs)
			.where(
				and(
					eq(imageJobs.status, "running"),
					ne(imageJobs.id, takeId),
					inArray(imageJobs.phase, ON_THE_GPU),
				),
			);
		if (
			busy.some((take) => parseTakeRequest(take.requestJson)?.model === engine)
		) {
			return true;
		}
	}
	const [picture] = await db
		.select({
			completedAt: imageJobs.completedAt,
			requestJson: imageJobs.requestJson,
		})
		.from(imageJobs)
		.where(
			and(
				isNotNull(imageJobs.completedAt),
				inArray(imageJobs.phase, ON_THE_GPU),
			),
		)
		.orderBy(desc(imageJobs.completedAt))
		.limit(1);
	const [video] = await db
		.select({ completedAt: videoJobs.completedAt })
		.from(videoJobs)
		.where(
			and(
				isNotNull(videoJobs.completedAt),
				inArray(videoJobs.phase, ON_THE_GPU),
			),
		)
		.orderBy(desc(videoJobs.completedAt))
		.limit(1);
	const pictureAt = picture?.completedAt?.getTime() ?? 0;
	const videoAt = video?.completedAt?.getTime() ?? 0;
	const lastAt = Math.max(pictureAt, videoAt);
	if (lastAt === 0 || now - lastAt >= IMAGE_IDLE_FREE_MS) return false;
	const lastEngine: PictureEngine | null =
		videoAt >= pictureAt
			? "ltx"
			: (parseTakeRequest(picture?.requestJson ?? "")?.model ?? null);
	return lastEngine === engine;
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

/**
 * How long a take waits for another engine's take to finish before it gives
 * up: about a second between ledger reads (a video take is tens of seconds, so
 * a finer poll only spends queries), and the take's own render deadline as the
 * end of the wait.
 */
const OTHER_ENGINE_POLL_MS = 1000;

// A test seam, like the media timeout's: a spec cannot spend 15 minutes waiting
// for a timeout, so it may shorten the poll and cap the wait.
const WAIT_TEST_KEY = Symbol.for("alfyai.images.otherEngineWaitTests");
type WaitTestOverride = { intervalMs?: number; deadlineMs?: number };
type WaitTestHolder = { [WAIT_TEST_KEY]?: WaitTestOverride };
export function setOtherEngineWaitForTests(
	next: WaitTestOverride | undefined,
): void {
	if (!process.env.VITEST) {
		throw new Error("setOtherEngineWaitForTests is for vitest only");
	}
	(globalThis as WaitTestHolder)[WAIT_TEST_KEY] = next;
}
function waitTestOverride(): WaitTestOverride {
	return (globalThis as WaitTestHolder)[WAIT_TEST_KEY] ?? {};
}

/** Whether any queued or running take is rendering on `engine`. */
async function hasLiveTakeOnEngine(engine: PictureEngine): Promise<boolean> {
	if (engine === "ltx") {
		const [video] = await db
			.select({ id: videoJobs.id })
			.from(videoJobs)
			.where(inArray(videoJobs.status, ["queued", "running"]))
			.limit(1);
		return video !== undefined;
	}
	const pictures = await db
		.select({ id: imageJobs.id, requestJson: imageJobs.requestJson })
		.from(imageJobs)
		.where(inArray(imageJobs.status, ["queued", "running"]));
	return pictures.some(
		(picture) => parseTakeRequest(picture.requestJson)?.model === engine,
	);
}

/** The take the gate is deciding for: its claim time (ms) and id (a same-ms tie-break). */
export type EngineClaim = {
	id: string;
	phaseAt: number;
	/**
	 * The take already holds a prompt it posted before (a run resumed after a
	 * restart, `promptIdOf(checkpoint)`). Its checkpoint has held the GPU all
	 * along, queued or running, so every other take is waiting for it: waiting
	 * here would only stand it against takes that wait for it (review M-1).
	 */
	onGpu?: boolean;
};

/**
 * Whether another engine holds the card:
 *  - a take that is ON the GPU (running, with a prompt or a phase past
 *    `submitted`) always blocks;
 *  - a take still waiting in its own gate blocks only when it was claimed
 *    earlier (`phase_at` is milliseconds), so two takes that start together
 *    have a deterministic order and cannot wait on each other until both
 *    deadlines.
 * A queued take does not block (it is not on the GPU, and when it claims it
 * will see this take running and wait itself), unless it carries a checkpoint:
 * a take an app restart put back in the queue, whose prompt may still be
 * rendering, holds the GPU until it resumes (review M-1). Its own engine's
 * takes never block (ComfyUI's queue orders those).
 */
async function hasLiveTakeOnOtherEngine(
	engine: PictureEngine,
	claim: EngineClaim,
): Promise<boolean> {
	const occupies = (row: {
		id: string;
		phase: string | null;
		checkpoint: string | null;
		phaseAt: number | null;
	}): boolean => {
		if (row.phase !== "submitted" || row.checkpoint !== null) return true;
		// The claim stamps `phase_at` (each kind's `onTransition`), so a running
		// take without one is one this code cannot place: it holds the GPU.
		if (row.phaseAt === null) return true;
		return (
			row.phaseAt < claim.phaseAt ||
			(row.phaseAt === claim.phaseAt && row.id < claim.id)
		);
	};
	const pictures = await db
		.select({
			id: imageJobs.id,
			phase: imageJobs.phase,
			checkpoint: imageJobs.checkpoint,
			phaseAt: imageJobs.phaseAt,
			requestJson: imageJobs.requestJson,
		})
		.from(imageJobs)
		.where(
			or(
				eq(imageJobs.status, "running"),
				and(eq(imageJobs.status, "queued"), isNotNull(imageJobs.checkpoint)),
			),
		);
	for (const picture of pictures) {
		const model = parseTakeRequest(picture.requestJson)?.model ?? null;
		// An unreadable request cannot be placed on our engine: it counts as another.
		if (model === null || model !== engine) {
			if (model === null || occupies(picture)) return true;
		}
	}
	if (engine === "ltx") return false;
	const videos = await db
		.select({
			id: videoJobs.id,
			phase: videoJobs.phase,
			checkpoint: videoJobs.checkpoint,
			phaseAt: videoJobs.phaseAt,
		})
		.from(videoJobs)
		.where(
			or(
				eq(videoJobs.status, "running"),
				and(eq(videoJobs.status, "queued"), isNotNull(videoJobs.checkpoint)),
			),
		);
	return videos.some(occupies);
}

function waitPause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export type OtherEngineWaitResult = "idle" | "cancelled" | "timeout";

/**
 * The cross-engine gate: one GPU can hold one engine's models, so a take waits
 * until no take of any OTHER engine is queued or running before it frees
 * anything or POSTs. Its own engine's takes do not block (ComfyUI's queue
 * orders those). The wait respects the take's Stop (`cancelled`) and its own
 * render deadline (`timeout`); a caller that stopped is settled by its runner
 * as cancelled, never as a timeout.
 */
export async function waitForOtherEnginesIdle(
	engine: PictureEngine,
	options: {
		signal: AbortSignal;
		deadlineMs: number;
		/** The waiting take; only takes older than it block (oldest wins). */
		claim: EngineClaim;
	},
): Promise<OtherEngineWaitResult> {
	// A take whose own prompt is already on the GPU is the one the others wait
	// for: it goes on (`EngineClaim.onGpu`).
	if (options.claim.onGpu) {
		return options.signal.aborted ? "cancelled" : "idle";
	}
	const override = waitTestOverride();
	const intervalMs = override.intervalMs ?? OTHER_ENGINE_POLL_MS;
	const startedAt = Date.now();
	const deadlineMs = Math.min(
		Math.max(0, options.deadlineMs),
		override.deadlineMs ?? Number.POSITIVE_INFINITY,
	);
	for (;;) {
		if (options.signal.aborted) return "cancelled";
		if (!(await hasLiveTakeOnOtherEngine(engine, options.claim))) return "idle";
		const elapsed = Date.now() - startedAt;
		if (elapsed >= deadlineMs) return "timeout";
		await waitPause(
			Math.max(1, Math.min(intervalMs, deadlineMs - elapsed)),
			options.signal,
		);
	}
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
		// Never unload an engine with a live take: at best it is wasted work, at
		// worst it pulls the models out from under a render (`Fault failed: 2`).
		if (await hasLiveTakeOnEngine(other)) continue;
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
