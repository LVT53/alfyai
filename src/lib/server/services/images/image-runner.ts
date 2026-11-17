// The image kind's handler: one take, from the person's pictures (or none) to a
// stored PNG. It runs under the job engine's fence, so every write it makes
// goes through `ctx` and is refused once the take is cancelled or the claim is
// gone. Loaded lazily by `image-job.ts`.
//
// Shape of a run: upload the inputs, build the graph, name the prompt and write
// its id as the checkpoint, submit it under that id (`submitted`), then follow the prompt (`starting`,
// `rendering`), fetch the picture (`finishing`), guard an edit against the
// picture it started from, store the PNG and succeed. A later attempt (the
// worker was lost after submitting) finds the checkpoint and follows the same
// prompt; if ComfyUI no longer knows it (it restarted), the take is submitted
// once more.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "$lib/server/db";
import { imageJobs } from "$lib/server/db/schema";
import type { JobFailure, JobRunContext } from "$lib/server/services/jobs";
import { createConfiguredComfyClient } from "./comfy-client";
import {
	type ComfyEvent,
	type ComfyUiClient,
	ComfyUiError,
} from "./comfyui/client";
import {
	buildPromptGraph,
	GraphBuildError,
	graphFor,
} from "./comfyui/templates";
import {
	discardStoredImageFile,
	getImageFile,
	readImageFileBytes,
	storeImageFile,
} from "./files";
import { guardEdit } from "./guards/guard-edit";
import { decodeRaw, encodePng } from "./guards/raw-image";
import {
	engineLooksWarm,
	freeOtherPictureModel,
	scheduleIdleFree,
	waitForOtherEnginesIdle,
} from "./idle-free";
import { promptWithMarks } from "./marks";
import { checkFinishedPicture } from "./picture-check";
import { createTakeEta, picturePlan, type TakeEta } from "./take-eta";
import {
	IMAGE_RENDER_DEADLINE_MS,
	parseTakeRequest,
	promptIdOf,
	type StoredTakeMeasures,
	type TakeRequest,
} from "./take-request";

const PROGRESS_WRITE_EVERY_MS = 1000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A failure the runner raises itself, with the code the take will carry. */
class TakeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "TakeError";
	}
}

function failureOf(error: unknown): JobFailure {
	if (error instanceof TakeError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
		};
	}
	if (error instanceof GraphBuildError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof ComfyUiError) {
		switch (error.code) {
			case "unreachable":
				return {
					code: "image_server_unreachable",
					message: "The picture server did not answer.",
					retryable: true,
				};
			case "rejected":
				return {
					code: "image_graph_rejected",
					message: "The picture server refused the request.",
					retryable: false,
				};
			case "timeout":
				return {
					code: "image_render_timeout",
					message: "The picture took too long to render.",
					retryable: true,
				};
			case "missing_result":
				return {
					code: "image_result_missing",
					message: "The picture server finished without a picture.",
					retryable: true,
				};
			default:
				return {
					code: "image_render_failed",
					message: "The picture could not be rendered.",
					retryable: true,
				};
		}
	}
	return {
		code: "image_render_failed",
		message: error instanceof Error ? error.message : "The picture failed.",
		retryable: true,
	};
}

type Ctx = JobRunContext<typeof imageJobs>;

export async function runImageTake(ctx: Ctx): Promise<void> {
	const { row, signal } = ctx;
	const request = parseTakeRequest(row.requestJson);
	if (!request) {
		await ctx.fail({
			code: "image_request_invalid",
			message: "The picture request could not be read.",
			retryable: false,
		});
		return;
	}
	const client = createConfiguredComfyClient(request.model);
	if (!client) {
		await ctx.fail({
			code: "image_server_not_configured",
			message: "No picture server is set up.",
			retryable: false,
		});
		return;
	}

	const startedAt = Date.now();
	let promptId = promptIdOf(row.checkpoint);
	let stopping: Promise<void> = Promise.resolve();

	// What a Stop asked for was written on the take before the engine cancelled
	// it, so this run reads it from the row (the Stop may have come from another
	// process). Nothing in here may throw or reject: it runs inside an abort
	// listener, where an error would end the process.
	const stopPrompt = async (): Promise<void> => {
		try {
			if (!promptId) return;
			const [state] = await db
				.select({ cancelInterrupt: imageJobs.cancelInterrupt })
				.from(imageJobs)
				.where(eq(imageJobs.id, row.id))
				.limit(1);
			await client.cancel(promptId, {
				interrupt: state?.cancelInterrupt !== 0,
			});
		} catch {
			// ComfyUI will finish or drop it on its own.
		}
	};
	const onAbort = () => {
		if (signal.reason === "cancelled") stopping = stopPrompt();
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		// One GPU, one engine's models: wait until the other engine's take (a
		// video, or the other picture model) is done before touching this one.
		const waited = await waitForOtherEnginesIdle(request.model, {
			signal,
			deadlineMs: IMAGE_RENDER_DEADLINE_MS - (Date.now() - startedAt),
			claim: { id: row.id, phaseAt: row.phaseAt ?? Date.now() },
		});
		if (waited === "cancelled") return;
		if (waited === "timeout") {
			await ctx.fail({
				code: "image_render_timeout",
				message: "The picture waited too long for the other engine to finish.",
				retryable: true,
			});
			return;
		}
		await renderTake(
			ctx,
			request,
			client,
			{
				getPromptId: () => promptId,
				setPromptId: (id) => {
					promptId = id;
				},
			},
			startedAt,
		);
		// A cancel that landed while the submit was in flight found no prompt to stop.
		if (signal.aborted && signal.reason === "cancelled") await stopPrompt();
	} catch (error) {
		if (signal.aborted) {
			if (signal.reason === "cancelled") await stopPrompt();
			return;
		}
		await ctx.fail(failureOf(error));
	} finally {
		signal.removeEventListener("abort", onAbort);
		await stopping;
		client.close();
		scheduleIdleFree();
	}
}

async function readInput(ctx: Ctx, fileId: string): Promise<Uint8Array> {
	const missing = new TakeError(
		"image_input_missing",
		"A picture this one is made from is gone.",
		false,
	);
	const file = await getImageFile({
		userId: ctx.row.userId,
		fileId,
		conversationId: ctx.row.conversationId,
	});
	if (!file) throw missing;
	try {
		return await readImageFileBytes(file, "full");
	} catch {
		throw missing;
	}
}

/**
 * See-through is the request's to decide, not the sampling's (Task 17): a take
 * may be see-through only when its graph was the transparent one or the picture
 * it changes really is. A plain generate that came back with a few pixels at
 * alpha 244 (ai.dev) is stored RGB.
 */
async function takeMayBeSeeThrough(
	ctx: Ctx,
	request: TakeRequest,
): Promise<boolean> {
	// H3 has no alpha path at all: its results are stored opaque, whatever the
	// pixels or the base carry.
	if (request.model === "h3") return false;
	if (
		graphFor(request.model, request.mode, request.transparent)
			?.transparentApplied
	) {
		return true;
	}
	const base = request.mode === "edit" ? request.inputs[0] : undefined;
	if (!base) return false;
	const file = await getImageFile({
		userId: ctx.row.userId,
		fileId: base.fileId,
		conversationId: ctx.row.conversationId,
	});
	return file?.hasAlpha === true;
}

/**
 * Uploads the inputs and submits the graph. Resolves with the id ComfyUI knows
 * the prompt by, or null when the take was stopped before the submit.
 *
 * The prompt is named here and its id written to the checkpoint BEFORE the
 * POST: a running take with no prompt id has then certainly not reached
 * ComfyUI, so the composer's Stop may cancel it outright, and a take with one
 * is stopped only through ComfyUI's queue (it may already be rendering).
 */
async function submitTake(
	ctx: Ctx,
	request: TakeRequest,
	client: ComfyUiClient,
	prompt: { setPromptId(id: string): void },
): Promise<string | null> {
	const graphChoice = graphFor(
		request.model,
		request.mode,
		request.transparent,
	);
	if (!graphChoice) {
		throw new TakeError(
			"image_graph_missing",
			"This kind of picture is not set up on the picture server.",
			false,
		);
	}
	const names: string[] = [];
	// A take queued before the picture model stopped being shown boxes still
	// holds a `marked` input: it is left out here, or the boxes come back drawn.
	const sent = request.inputs.filter((input) => input.role !== "marked");
	for (const [index, input] of sent.entries()) {
		const bytes = await readInput(ctx, input.fileId);
		const ref = await client.uploadImage(
			bytes,
			`${ctx.row.id}-${index + 1}.png`,
		);
		names.push(ref.filename);
	}
	const graph = buildPromptGraph(graphChoice.template, {
		prompt: request.marks
			? promptWithMarks(request.prompt, request.marks)
			: request.prompt,
		seed: ctx.row.seed,
		width: request.canvas.width,
		height: request.canvas.height,
		images: names,
	});
	// H3 12 MP peaks at the card's edge: free the other model's resident models
	// BEFORE this take submits, so the selected service loads into free memory.
	await freeOtherPictureModel(request.model);
	if (ctx.signal.aborted) return null;
	const promptId = randomUUID();
	// Refused once the take is stopped: then nothing is posted.
	const recorded = await ctx.progress({ checkpoint: { promptId } });
	if (!recorded || ctx.signal.aborted) return null;
	prompt.setPromptId(promptId);
	const answer = await client.submit(graph, { promptId });
	if (answer.promptId !== promptId) {
		// A ComfyUI that predates caller-supplied ids picks its own: follow that one.
		console.warn("[IMAGES] ComfyUI answered with another prompt id", {
			takeId: ctx.row.id,
			sent: promptId,
			answered: answer.promptId,
		});
		prompt.setPromptId(answer.promptId);
		await ctx.progress({ checkpoint: { promptId: answer.promptId } });
	}
	return answer.promptId;
}

/**
 * Moves the phase and stamps when (ms), for the card's "how long has it been
 * here", with the estimate's finish time when the phase moves it.
 */
async function enterPhase(
	ctx: Ctx,
	phase: string,
	etaAt?: number,
): Promise<void> {
	await ctx.progress({ phase });
	await ctx.write((tx) => {
		tx.update(imageJobs)
			.set({
				phaseAt: Date.now(),
				...(etaAt === undefined ? {} : { etaAt }),
			})
			.where(eq(imageJobs.id, ctx.row.id))
			.run();
	});
}

/** Follows the prompt, writing what the card shows. Resolves with the pictures ComfyUI made. */
async function followTake(
	ctx: Ctx,
	client: ComfyUiClient,
	promptId: string,
	deadlineMs: number,
	eta: TakeEta,
) {
	let chain: Promise<unknown> = Promise.resolve();
	// Writes go one after another, never overlapping, and never reject.
	const queue = (work: () => Promise<unknown>) => {
		chain = chain.then(work).catch(() => undefined);
	};
	let started = false;
	let rendering = false;
	let lastWriteAt = 0;

	const onEvent = (event: ComfyEvent) => {
		if (event.type === "queued") {
			queue(() =>
				ctx.write((tx) => {
					tx.update(imageJobs)
						.set({ queueAhead: event.ahead })
						.where(eq(imageJobs.id, ctx.row.id))
						.run();
				}),
			);
		} else if (event.type === "started") {
			if (started) return;
			started = true;
			// The prompt is on the GPU: the countdown starts with the whole plan.
			const etaAt = eta.start(Date.now());
			queue(() => enterPhase(ctx, "starting", etaAt));
		} else if (event.type === "progress") {
			const now = Date.now();
			// The estimate sees every step (its rate needs them all); the row is
			// written at most once a second, and on the last step.
			const etaAt = eta.progress({ value: event.value, max: event.max }, now);
			if (!rendering) {
				rendering = true;
				queue(() => enterPhase(ctx, "rendering"));
			}
			const lastStep = event.max > 0 && event.value >= event.max;
			if (
				!lastStep &&
				lastWriteAt !== 0 &&
				now - lastWriteAt < PROGRESS_WRITE_EVERY_MS
			) {
				return;
			}
			lastWriteAt = now;
			const percent = Math.min(
				100,
				Math.round((event.value / Math.max(1, event.max)) * 100),
			);
			queue(() =>
				ctx.write((tx) => {
					tx.update(imageJobs)
						.set({ progressPercent: percent, etaAt })
						.where(eq(imageJobs.id, ctx.row.id))
						.run();
				}),
			);
		}
	};

	try {
		return await client.follow(promptId, {
			signal: ctx.signal,
			deadlineMs,
			onEvent,
		});
	} finally {
		await chain;
	}
}

/** How long a picture server may be unreachable mid-render before the take gives up; a real reload takes ~26 s. */
export const FOLLOW_GRACE_MS = 60_000;
const FOLLOW_RETRY_MS = 1000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * Follows a submitted prompt. A picture server that stops answering (or
 * answers with an error) after the checkpoint is written is most likely
 * reloading, so the follow is retried for a grace window before the take
 * fails; what ComfyUI says when it is back (it forgot the prompt) is the
 * caller's to act on.
 */
async function followWithGrace(
	ctx: Ctx,
	client: ComfyUiClient,
	promptId: string,
	startedAt: number,
	eta: TakeEta,
) {
	let downSince = 0;
	for (;;) {
		const left = IMAGE_RENDER_DEADLINE_MS - (Date.now() - startedAt);
		if (left <= 0) {
			throw new ComfyUiError("timeout", "ComfyUI took too long");
		}
		try {
			return await followTake(ctx, client, promptId, left, eta);
		} catch (error) {
			const transient =
				error instanceof ComfyUiError &&
				(error.code === "unreachable" || error.code === "bad_response");
			if (!transient || ctx.signal.aborted) throw error;
			downSince ||= Date.now();
			if (Date.now() - downSince >= FOLLOW_GRACE_MS) throw error;
			await pause(FOLLOW_RETRY_MS, ctx.signal);
		}
	}
}

async function renderTake(
	ctx: Ctx,
	request: TakeRequest,
	client: ComfyUiClient,
	prompt: { getPromptId(): string | null; setPromptId(id: string): void },
	startedAt: number,
): Promise<void> {
	const { row, signal } = ctx;
	let resubmitted = false;
	let output: Uint8Array;
	// The estimate's plan: this engine's model load (next to none when its
	// models are still loaded), the sampler and the finish, for this canvas.
	let eta = createTakeEta(
		picturePlan(request, await engineLooksWarm(request.model, row.id)),
	);

	for (;;) {
		let promptId = prompt.getPromptId();
		if (!promptId) {
			const submitted = await submitTake(ctx, request, client, prompt);
			if (!submitted || signal.aborted) return;
			promptId = submitted;
			await enterPhase(ctx, "submitted");
			if (signal.aborted) return;
		}
		try {
			const refs = await followWithGrace(ctx, client, promptId, startedAt, eta);
			if (signal.aborted) return;
			await enterPhase(ctx, "finishing", eta.enter("finish"));
			const first = refs[0];
			if (!first) {
				throw new ComfyUiError(
					"missing_result",
					"ComfyUI finished without a picture",
				);
			}
			// A restart between "done" and this fetch clears the temp result: 404.
			output = await client.fetchImage(first);
			break;
		} catch (error) {
			const forgotten =
				error instanceof ComfyUiError &&
				(error.code === "missing_result" || error.code === "bad_response");
			if (!forgotten || resubmitted || signal.aborted) throw error;
			// ComfyUI no longer knows the prompt or its picture (it restarted): once
			// more, from the start, with a fresh estimate from a cold load (the one
			// real reason the time left may go up).
			resubmitted = true;
			prompt.setPromptId("");
			eta = createTakeEta(picturePlan(request, false));
			await ctx.progress({ checkpoint: null });
		}
	}
	if (signal.aborted) return;

	let png: Uint8Array;
	let measures: StoredTakeMeasures | null = null;
	if (request.mode === "edit") {
		const baseInput = request.inputs[0];
		if (!baseInput) {
			throw new TakeError(
				"image_input_missing",
				"No picture to change.",
				false,
			);
		}
		const base = await decodeRaw(
			await readInput(ctx, baseInput.fileId),
			request.canvas,
		);
		const anchor = request.anchor
			? await decodeRaw(
					await readInput(ctx, request.anchor.fileId),
					request.canvas,
				)
			: null;
		const result = await decodeRaw(output, request.canvas);
		const outcome = await guardEdit({
			base,
			anchor,
			chainSinceAnchor: request.anchor?.chainSinceAnchor ?? 0,
			result,
			marks: request.marks,
		});
		png = await encodePng(outcome.picture);
		measures = {
			...outcome.measures,
			chainSinceAnchor: outcome.chainSinceAnchor,
			anchorIsResult: outcome.anchorIsResult,
		};
	} else {
		png = PNG_SIGNATURE.every((byte, index) => output[index] === byte)
			? output
			: await sharp(output).png().toBuffer();
	}
	if (signal.aborted) return;

	// The explicit-picture filter, on the picture as it would be stored (an
	// edit's pasted result too). A blocked or unchecked picture is never
	// stored, so there is no file to serve, thumbnail or download.
	const check = await checkFinishedPicture({
		userId: row.userId,
		takeId: row.id,
		png,
	});
	if (check === "blocked") {
		throw new TakeError(
			"image_blocked",
			"The picture was blocked by the explicit-picture filter.",
			false,
		);
	}
	if (check === "unchecked") {
		throw new TakeError(
			"image_unchecked",
			"The picture could not be checked, so it was not kept.",
			true,
		);
	}
	if (signal.aborted) return;

	const file = await storeImageFile({
		userId: row.userId,
		conversationId: row.conversationId,
		role: "take",
		png,
		mayBeSeeThrough: await takeMayBeSeeThrough(ctx, request),
	});
	if (signal.aborted) {
		await discardStoredImageFile(file).catch(() => undefined);
		return;
	}
	const settled = await ctx.succeed({
		apply: (tx) => {
			tx.update(imageJobs)
				.set({
					resultFileId: file.id,
					measuresJson: measures ? JSON.stringify(measures) : null,
					progressPercent: 100,
					etaAt: null,
				})
				.where(eq(imageJobs.id, row.id))
				.run();
		},
	});
	if (!settled) {
		// The take was stopped (or its chat deleted) while the picture was being
		// stored: nothing points at the file, and its chat's cleanup may already
		// have run, so it is removed by path, row or no row.
		await discardStoredImageFile(file).catch(() => undefined);
		return;
	}
	// The take has landed. A held take stays a take to pick (settleCard skips it
	// until its hold is released or has run out); otherwise it becomes the
	// version in use when the card has none. The picture is already stored, so a
	// failure here must not fail the take: the boot sweep settles the card.
	try {
		// Loaded here, not at the top: cards.ts pulls the artifacts service, which
		// a render that never lands has no use for.
		const { settleCard } = await import("./cards");
		await settleCard(row.cardId, { preferTakeId: row.id });
	} catch (error) {
		console.error("[IMAGES] Could not settle the card:", error);
	}
}
