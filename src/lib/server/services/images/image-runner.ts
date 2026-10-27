// The image kind's handler: one take, from the person's pictures (or none) to a
// stored PNG. It runs under the job engine's fence, so every write it makes
// goes through `ctx` and is refused once the take is cancelled or the claim is
// gone. Loaded lazily by `image-job.ts`.
//
// Shape of a run: upload the inputs, build the graph, submit, write the prompt
// id as the checkpoint (`submitted`), then follow the prompt (`starting`,
// `rendering`), fetch the picture (`finishing`), guard an edit against the
// picture it started from, store the PNG and succeed. A later attempt (the
// worker was lost after submitting) finds the checkpoint and follows the same
// prompt; if ComfyUI no longer knows it (it restarted), the take is submitted
// once more.

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
	deleteImageFilesById,
	getImageFile,
	readImageFileBytes,
	storeImageFile,
} from "./files";
import { guardEdit } from "./guards/guard-edit";
import { decodeRaw, encodePng } from "./guards/raw-image";
import { scheduleIdleFree } from "./idle-free";
import {
	IMAGE_RENDER_DEADLINE_MS,
	parseTakeRequest,
	type StoredTakeMeasures,
	type TakeRequest,
} from "./take-request";

const PROGRESS_WRITE_EVERY_MS = 1000;
/** Added to the remaining-steps estimate for decoding the result and the guard. */
const ETA_FINISH_SECONDS = 3;
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

function promptIdOf(checkpoint: string | null): string | null {
	if (!checkpoint) return null;
	try {
		const parsed: unknown = JSON.parse(checkpoint);
		if (typeof parsed === "object" && parsed !== null && "promptId" in parsed) {
			const id = (parsed as { promptId: unknown }).promptId;
			return typeof id === "string" && id !== "" ? id : null;
		}
	} catch {
		// A checkpoint we cannot read is no checkpoint.
	}
	return null;
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
	const client = createConfiguredComfyClient();
	if (!client) {
		await ctx.fail({
			code: "image_server_not_configured",
			message: "No picture server is set up.",
			retryable: false,
		});
		return;
	}

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
		await renderTake(ctx, request, client, {
			getPromptId: () => promptId,
			setPromptId: (id) => {
				promptId = id;
			},
		});
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

async function submitTake(
	ctx: Ctx,
	request: TakeRequest,
	client: ComfyUiClient,
): Promise<string> {
	const graphChoice = graphFor(request.mode, request.transparent);
	if (!graphChoice) {
		throw new TakeError(
			"image_graph_missing",
			"This kind of picture is not set up on the picture server.",
			false,
		);
	}
	const names: string[] = [];
	for (const [index, input] of request.inputs.entries()) {
		const bytes = await readInput(ctx, input.fileId);
		const ref = await client.uploadImage(
			bytes,
			`${ctx.row.id}-${index + 1}.png`,
		);
		names.push(ref.filename);
	}
	const graph = buildPromptGraph(graphChoice.template, {
		prompt: request.prompt,
		seed: ctx.row.seed,
		width: request.canvas.width,
		height: request.canvas.height,
		images: names,
	});
	const { promptId } = await client.submit(graph);
	return promptId;
}

/** Moves the phase and stamps when (ms), for the card's "how long has it been here". */
async function enterPhase(ctx: Ctx, phase: string): Promise<void> {
	await ctx.progress({ phase });
	await ctx.write((tx) => {
		tx.update(imageJobs)
			.set({ phaseAt: Date.now() })
			.where(eq(imageJobs.id, ctx.row.id))
			.run();
	});
}

/** Follows the prompt, writing what the card shows. Resolves with the pictures ComfyUI made. */
async function followTake(ctx: Ctx, client: ComfyUiClient, promptId: string) {
	let chain: Promise<unknown> = Promise.resolve();
	// Writes go one after another, never overlapping, and never reject.
	const queue = (work: () => Promise<unknown>) => {
		chain = chain.then(work).catch(() => undefined);
	};
	let started = false;
	let rendering = false;
	let firstStepAt = 0;
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
			queue(() => enterPhase(ctx, "starting"));
		} else if (event.type === "progress") {
			const now = Date.now();
			if (!rendering) {
				rendering = true;
				firstStepAt = now;
				queue(() => enterPhase(ctx, "rendering"));
			}
			if (lastWriteAt !== 0 && now - lastWriteAt < PROGRESS_WRITE_EVERY_MS) {
				return;
			}
			lastWriteAt = now;
			const done = Math.max(1, event.value);
			const left = Math.max(0, event.max - event.value);
			const percent = Math.min(
				100,
				Math.round((event.value / Math.max(1, event.max)) * 100),
			);
			const eta = Math.round(
				(((now - firstStepAt) / 1000) * left) / done + ETA_FINISH_SECONDS,
			);
			queue(() =>
				ctx.write((tx) => {
					tx.update(imageJobs)
						.set({ progressPercent: percent, etaSeconds: eta })
						.where(eq(imageJobs.id, ctx.row.id))
						.run();
				}),
			);
		}
	};

	try {
		return await client.follow(promptId, {
			signal: ctx.signal,
			deadlineMs: IMAGE_RENDER_DEADLINE_MS,
			onEvent,
		});
	} finally {
		await chain;
	}
}

async function renderTake(
	ctx: Ctx,
	request: TakeRequest,
	client: ComfyUiClient,
	prompt: { getPromptId(): string | null; setPromptId(id: string): void },
): Promise<void> {
	const { row, signal } = ctx;
	let resubmitted = false;
	let refs: Awaited<ReturnType<typeof followTake>>;

	for (;;) {
		let promptId = prompt.getPromptId();
		if (!promptId) {
			promptId = await submitTake(ctx, request, client);
			prompt.setPromptId(promptId);
			if (signal.aborted) return;
			await ctx.progress({ phase: "submitted", checkpoint: { promptId } });
			if (signal.aborted) return;
		}
		try {
			refs = await followTake(ctx, client, promptId);
			break;
		} catch (error) {
			const forgotten =
				error instanceof ComfyUiError && error.code === "missing_result";
			if (!forgotten || resubmitted || signal.aborted) throw error;
			// ComfyUI no longer knows the prompt (it restarted): once more, from the start.
			resubmitted = true;
			prompt.setPromptId("");
			await ctx.progress({ checkpoint: null });
		}
	}
	if (signal.aborted) return;

	await enterPhase(ctx, "finishing");
	const first = refs[0];
	if (!first) {
		throw new ComfyUiError(
			"missing_result",
			"ComfyUI finished without a picture",
		);
	}
	const output = await client.fetchImage(first);

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

	const file = await storeImageFile({
		userId: row.userId,
		conversationId: row.conversationId,
		role: "take",
		png,
	});
	const settled = await ctx.succeed({
		apply: (tx) => {
			tx.update(imageJobs)
				.set({
					resultFileId: file.id,
					measuresJson: measures ? JSON.stringify(measures) : null,
					progressPercent: 100,
					etaSeconds: null,
				})
				.where(eq(imageJobs.id, row.id))
				.run();
		},
	});
	if (!settled) {
		// The take was stopped (or its chat deleted) while the picture was being
		// stored: nothing points at the file, so it must not stay behind.
		await deleteImageFilesById([file.id]).catch(() => 0);
	}
}
