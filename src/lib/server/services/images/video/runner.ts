// The video kind's handler: one take, from the source still to a stored mp4
// with its poster and thumbnail, and the `video` artifact version pointing at
// them. Loaded lazily by `video-job.ts`.
//
// Shape of a run: read and fit the source still, upload it, then render each
// segment (one at 5 s, two at 10 s). A segment is submitted under a prompt id
// written to the checkpoint BEFORE the POST, followed, and its mp4 fetched;
// segment 2 is guided by the LAST DECODED FRAME of segment 1, which is what
// makes the chain a chain. The clips are concatenated, the poster and four
// more frames are sampled for the explicit-picture filter, and only then is
// anything stored. A later attempt finds the checkpointed prompt (and every
// finished segment's saved clip) and resumes instead of rendering it twice; a
// ComfyUI that forgot the prompt is resubmitted once per segment.
//
// A 10 s take whose second segment fails FAILS THE WHOLE TAKE: one segment is
// never stored and served as if it were ten seconds.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "$lib/server/db";
import { videoJobs } from "$lib/server/db/schema";
import {
	createArtifact,
	deleteLibraryArtifact,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import type { JobFailure, JobRunContext } from "$lib/server/services/jobs";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { serializeVideoVersionBody } from "$lib/shared/artifacts/video-body";
import {
	type ComfyImageRef,
	type ComfyUiClient,
	ComfyUiError,
} from "../comfyui/client";
import { buildLtxVideoGraph } from "../comfyui/ltx-templates";
import {
	attachImageFilesToArtifact,
	getImageFile,
	readImageFileBytes,
} from "../files";
import { freeOtherPictureModels, scheduleIdleFree } from "../idle-free";
import { checkFinishedPicture } from "../picture-check";
import { discardStoredVideoFile, storeVideoFile } from "../video-files";
import { createVideoComfyClient } from "./comfy-client";
import {
	concatClips,
	extractFrameAt,
	extractLastFrame,
	VideoMediaError,
} from "./media";
import {
	parseVideoCheckpoint,
	parseVideoTakeRequest,
	VIDEO_RENDER_DEADLINE_MS,
	type VideoCheckpoint,
	type VideoTakeRequest,
	videoDurationMs,
	videoSegmentCount,
	videoSizeForSource,
} from "./request";

/** How long a video server may be unreachable mid-render before the take gives up. */
const FOLLOW_GRACE_MS = 60_000;
const FOLLOW_RETRY_MS = 1000;
const PROGRESS_WRITE_EVERY_MS = 1000;
/** Added to the remaining-steps estimate for decoding, joining and storing. */
const ETA_FINISH_SECONDS = 5;
/** The explicit filter's sample: the poster and four across the clip. */
const SAMPLE_FRACTIONS = [0, 0.25, 0.5, 0.75] as const;

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
	if (error instanceof VideoMediaError) {
		return error.code === "unavailable"
			? {
					code: "video_media_unavailable",
					message: "The video tools are not installed on this server.",
					retryable: false,
				}
			: {
					code: "video_media_failed",
					message: "The clip could not be decoded.",
					retryable: true,
				};
	}
	if (error instanceof ComfyUiError) {
		switch (error.code) {
			case "unreachable":
				return {
					code: "video_server_unreachable",
					message: "The video server did not answer.",
					retryable: true,
				};
			case "rejected":
				return {
					code: "video_graph_rejected",
					message: "The video server refused the request.",
					retryable: false,
				};
			case "timeout":
				return {
					code: "video_render_timeout",
					message: "The video took too long to render.",
					retryable: true,
				};
			case "missing_result":
				return {
					code: "video_result_missing",
					message: "The video server finished without a clip.",
					retryable: true,
				};
			default:
				return {
					code: "video_render_failed",
					message: "The video could not be rendered.",
					retryable: true,
				};
		}
	}
	return {
		code: "video_render_failed",
		message: error instanceof Error ? error.message : "The video failed.",
		retryable: true,
	};
}

type Ctx = JobRunContext<typeof videoJobs>;

export async function runVideoTake(ctx: Ctx): Promise<void> {
	const { row, signal } = ctx;
	const request = parseVideoTakeRequest(row.requestJson);
	if (!request) {
		await ctx.fail({
			code: "video_request_invalid",
			message: "The video request could not be read.",
			retryable: false,
		});
		return;
	}
	const client = createVideoComfyClient();
	if (!client) {
		await ctx.fail({
			code: "video_server_not_configured",
			message: "No video server is set up.",
			retryable: false,
		});
		return;
	}

	let currentPromptId: string | null = null;
	let stopping: Promise<void> = Promise.resolve();

	// What a Stop asked for was written on the take before the engine cancelled
	// it, so this run reads it from the row (the Stop may have come from another
	// process). Nothing in here may throw or reject: it runs inside an abort
	// listener, where an error would end the process.
	const stopPrompt = async (): Promise<void> => {
		try {
			if (!currentPromptId) return;
			const [state] = await db
				.select({ cancelInterrupt: videoJobs.cancelInterrupt })
				.from(videoJobs)
				.where(eq(videoJobs.id, row.id))
				.limit(1);
			await client.cancel(currentPromptId, {
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
			setPromptId: (id) => {
				currentPromptId = id;
			},
		});
		// A cancel that landed while the submit was in flight found no prompt.
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

/** Moves the phase and stamps when (ms), for the card's "how long has it been here". */
async function enterPhase(ctx: Ctx, phase: string): Promise<void> {
	await ctx.progress({ phase });
	await ctx.write((tx) => {
		tx.update(videoJobs)
			.set({ phaseAt: Date.now() })
			.where(eq(videoJobs.id, ctx.row.id))
			.run();
	});
}

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
 * Follows a submitted prompt. A server that stops answering (or answers with
 * an error) after the checkpoint is written is most likely reloading, so the
 * follow is retried for a grace window before the take fails.
 */
async function followWithGrace(
	ctx: Ctx,
	client: ComfyUiClient,
	promptId: string,
	startedAt: number,
) {
	let downSince = 0;
	for (;;) {
		const left = VIDEO_RENDER_DEADLINE_MS - (Date.now() - startedAt);
		if (left <= 0) throw new ComfyUiError("timeout", "ComfyUI took too long");
		try {
			return await followSegment(ctx, client, promptId, left);
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

async function followSegment(
	ctx: Ctx,
	client: ComfyUiClient,
	promptId: string,
	deadlineMs: number,
): Promise<ComfyImageRef[]> {
	let chain: Promise<unknown> = Promise.resolve();
	const queue = (work: () => Promise<unknown>) => {
		chain = chain.then(work).catch(() => undefined);
	};
	let started = false;
	let rendering = false;
	let firstStepAt = 0;
	let lastWriteAt = 0;

	const onEvent = (event: {
		type: "queued" | "started" | "progress" | "done";
		ahead?: number;
		value?: number;
		max?: number;
	}) => {
		if (event.type === "queued") {
			queue(() =>
				ctx.write((tx) => {
					tx.update(videoJobs)
						.set({ queueAhead: event.ahead ?? 0 })
						.where(eq(videoJobs.id, ctx.row.id))
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
			const done = Math.max(1, event.value ?? 0);
			const left = Math.max(0, (event.max ?? 0) - (event.value ?? 0));
			const percent = Math.min(
				100,
				Math.round(((event.value ?? 0) / Math.max(1, event.max ?? 0)) * 100),
			);
			const eta = Math.round(
				(((now - firstStepAt) / 1000) * left) / done + ETA_FINISH_SECONDS,
			);
			queue(() =>
				ctx.write((tx) => {
					tx.update(videoJobs)
						.set({ progressPercent: percent, etaSeconds: eta })
						.where(eq(videoJobs.id, ctx.row.id))
						.run();
				}),
			);
		}
	};

	try {
		return await client.followVideo(promptId, {
			signal: ctx.signal,
			deadlineMs,
			onEvent,
		});
	} finally {
		await chain;
	}
}

/** The source still, failed loudly when it is gone. */
async function readStill(ctx: Ctx, fileId: string) {
	const missing = new TakeError(
		"video_input_missing",
		"The picture this video is made from is gone.",
		false,
	);
	const file = await getImageFile({
		userId: ctx.row.userId,
		fileId,
		conversationId: ctx.row.conversationId,
	});
	if (!file) throw missing;
	try {
		return { file, bytes: await readImageFileBytes(file, "full") };
	} catch {
		throw missing;
	}
}

/** The still fitted to the clip's size, so the graph never upscales it. */
async function fitStill(
	bytes: Uint8Array,
	size: { width: number; height: number },
): Promise<Uint8Array> {
	return new Uint8Array(
		await sharp(bytes)
			.resize(size.width, size.height, {
				fit: "cover",
				position: "centre",
			})
			.png()
			.toBuffer(),
	);
}

/**
 * Renders one segment: frees the other engines once, writes the prompt id to
 * the checkpoint, posts under it, follows it and fetches the clip. Answers null
 * when the take was stopped before posting.
 */
async function renderSegment(
	ctx: Ctx,
	client: ComfyUiClient,
	input: {
		request: VideoTakeRequest;
		size: { width: number; height: number };
		imageName: string;
		segment: 1 | 2;
		checkpoint: VideoCheckpoint | null;
		startedAt: number;
		freedOthers: boolean;
		setPromptId: (id: string) => void;
	},
): Promise<{ clip: Uint8Array; record: ComfyImageRef } | null> {
	const { signal } = ctx;
	if (!input.freedOthers) {
		// The card holds one engine: free the picture servers BEFORE LTX loads.
		await freeOtherPictureModels("ltx");
	}
	if (signal.aborted) return null;
	const graph = buildLtxVideoGraph({
		prompt: input.request.prompt,
		// Segment 2 uses the next seed, so the chain does not repeat the noise.
		seed: ctx.row.seed + (input.segment - 1),
		width: input.size.width,
		height: input.size.height,
		image: input.imageName,
	});
	const promptId = randomUUID();
	const segments = [...(input.checkpoint?.segments ?? [])];
	segments[input.segment - 1] = { promptId, media: null };
	const next: VideoCheckpoint = {
		promptId,
		segment: input.segment,
		segments,
	};
	const recorded = await ctx.progress({ checkpoint: next });
	if (!recorded || signal.aborted) return null;
	input.setPromptId(promptId);
	const answer = await client.submit(graph, { promptId });
	const knownId = answer.promptId;
	if (knownId !== promptId) {
		// A ComfyUI that predates caller-supplied ids picks its own: follow that one.
		console.warn("[VIDEO] ComfyUI answered with another prompt id", {
			takeId: ctx.row.id,
			sent: promptId,
			answered: answer.promptId,
		});
		segments[input.segment - 1] = { promptId: knownId, media: null };
		next.promptId = knownId;
		input.setPromptId(knownId);
		await ctx.progress({ checkpoint: next });
	}
	await enterPhase(ctx, "submitted");
	if (signal.aborted) return null;

	const refs = await followWithGrace(ctx, client, knownId, input.startedAt);
	if (signal.aborted) return null;
	await enterPhase(ctx, "finishing");
	const ref = refs[0];
	if (!ref) {
		throw new ComfyUiError("missing_result", "ComfyUI finished without a clip");
	}
	const clip = await client.fetchImage(ref);
	segments[input.segment - 1] = { promptId: knownId, media: ref };
	await ctx.progress({
		checkpoint: {
			promptId: knownId,
			segment: input.segment,
			segments,
		} satisfies VideoCheckpoint,
	});
	return { clip, record: ref };
}

/** Whether a recorded prompt can still be followed, or ComfyUI forgot it. */
function isForgotten(error: unknown): boolean {
	return (
		error instanceof ComfyUiError &&
		(error.code === "missing_result" || error.code === "bad_response")
	);
}

async function renderTake(
	ctx: Ctx,
	request: VideoTakeRequest,
	client: ComfyUiClient,
	prompt: { setPromptId(id: string): void },
): Promise<void> {
	const { row, signal } = ctx;
	const startedAt = Date.now();
	const still = await readStill(ctx, request.sourceFileId);
	const size = videoSizeForSource({
		width: still.file.width,
		height: still.file.height,
	});
	const fitted = await fitStill(still.bytes, size);
	const uploadName = `${row.id}-1.png`;
	const uploaded = await client.uploadImage(fitted, uploadName);
	if (signal.aborted) return;

	const segmentCount = videoSegmentCount(request.durationSeconds);
	const checkpoint = parseVideoCheckpoint(row.checkpoint);
	const clips: Uint8Array[] = [];
	let imageName = uploaded.filename;
	// The card holds one engine: free the picture servers once, before the run's
	// first submit, so LTX loads into memory they no longer hold. A resumed run
	// that starts at segment 2 still owes that free.
	let freedOthers = false;

	for (let segment = 1; segment <= segmentCount; segment += 1) {
		const segmentNumber = segment as 1 | 2;
		const done = checkpoint?.segments[segmentNumber - 1];
		let clip: Uint8Array | null = null;

		// A finished segment's saved clip can be fetched again (a restart at
		// segment 2 must not render segment 1 a second time).
		if (done?.media) {
			try {
				clip = await client.fetchImage(done.media);
			} catch {
				clip = null;
			}
		}
		// A prompt recorded for this segment can be followed (an app restart
		// mid-render). ComfyUI forgetting it means one clean re-render.
		if (!clip) {
			const recordedPrompt =
				done?.promptId ??
				(checkpoint?.segment === segmentNumber ? checkpoint.promptId : null);
			if (recordedPrompt) {
				try {
					const refs = await followWithGrace(
						ctx,
						client,
						recordedPrompt,
						startedAt,
					);
					if (signal.aborted) return;
					await enterPhase(ctx, "finishing");
					const ref = refs[0];
					if (!ref) {
						throw new ComfyUiError(
							"missing_result",
							"ComfyUI finished without a clip",
						);
					}
					clip = await client.fetchImage(ref);
				} catch (error) {
					if (signal.aborted) return;
					if (!isForgotten(error)) throw error;
					// The server restarted and no longer knows the prompt.
				}
			}
		}
		if (!clip) {
			if (segmentNumber === 2) {
				// The chain's guide: the FIRST clip's last decoded frame.
				const first = clips[0];
				if (!first) {
					throw new TakeError(
						"video_result_missing",
						"The first segment produced no clip.",
						true,
					);
				}
				const lastFrame = await extractLastFrame(first);
				const guide = await client.uploadImage(lastFrame, `${row.id}-2.png`);
				imageName = guide.filename;
			}
			const rendered = await renderSegment(ctx, client, {
				request,
				size,
				imageName,
				segment: segmentNumber,
				checkpoint,
				startedAt,
				freedOthers,
				setPromptId: prompt.setPromptId,
			});
			if (!rendered) return;
			freedOthers = true;
			clip = rendered.clip;
		}
		if (signal.aborted) return;
		clips.push(clip);
	}
	if (signal.aborted || clips.length !== segmentCount) return;

	const joined =
		clips.length === 1 ? (clips[0] as Uint8Array) : await concatClips(clips);
	if (signal.aborted) return;
	const durationSeconds = request.durationSeconds;
	const productMs = videoDurationMs(durationSeconds);
	const poster = await extractFrameAt(joined, { seconds: 0 });
	const samples = await sampleFrames(joined, durationSeconds, poster);
	if (signal.aborted) return;

	// The explicit-picture filter, on the poster and four frames across the
	// clip, before anything is stored: a blocked or unchecked clip is never
	// stored, so there is no file to serve, thumbnail or download.
	const verdict = await checkFrames(ctx, row.id, samples);
	if (verdict === "blocked") {
		throw new TakeError(
			"video_blocked",
			"The video was blocked by the explicit-picture filter.",
			false,
		);
	}
	if (verdict === "unchecked") {
		throw new TakeError(
			"video_unchecked",
			"The video could not be checked, so it was not kept.",
			true,
		);
	}
	if (signal.aborted) return;

	const file = await storeVideoFile({
		userId: row.userId,
		conversationId: row.conversationId,
		role: "take",
		mp4: joined,
		poster,
		durationMs: productMs,
	});
	if (signal.aborted) {
		await discardStoredVideoFile(file).catch(() => undefined);
		return;
	}

	const serialized = serializeVideoVersionBody({
		v: 1,
		fileId: file.id,
		// The poster is served from the clip's own id today (`?variant=poster`).
		posterFileId: file.id,
		width: file.width,
		height: file.height,
		durationMs: file.durationMs ?? productMs,
		sourceFileId: request.sourceFileId,
	});
	const artifactId = await writeArtifact(ctx, request, serialized);
	if (!artifactId) {
		await discardStoredVideoFile(file).catch(() => undefined);
		return;
	}
	await attachImageFilesToArtifact([file.id], artifactId).catch(
		() => undefined,
	);

	const settled = await ctx.succeed({
		apply: (tx) => {
			tx.update(videoJobs)
				.set({
					resultFileId: file.id,
					artifactId,
					progressPercent: 100,
					etaSeconds: null,
				})
				.where(eq(videoJobs.id, row.id))
				.run();
		},
	});
	if (!settled) {
		// Stopped while storing: nothing points at the clip. A new item this
		// take made goes with it; an appended version keeps its file-less row,
		// which reads as a take that never landed.
		await discardStoredVideoFile(file).catch(() => undefined);
		if (request.artifactId === null) {
			await deleteLibraryArtifact(row.userId, artifactId).catch(
				() => undefined,
			);
		}
	}
}

/**
 * The poster and four more frames across the clip. The last sample sits just
 * inside the end, where `-ss` still finds a frame of a clip whose container
 * length and frame count disagree by a frame.
 */
async function sampleFrames(
	clip: Uint8Array,
	durationSeconds: number,
	poster: Uint8Array,
): Promise<Uint8Array[]> {
	const seconds = durationSeconds;
	const frames = [poster];
	for (const fraction of SAMPLE_FRACTIONS.slice(1)) {
		frames.push(await extractFrameAt(clip, { seconds: seconds * fraction }));
	}
	frames.push(
		await extractFrameAt(clip, { seconds: Math.max(0, seconds - 0.1) }),
	);
	return frames;
}

/**
 * Runs the explicit filter on every sample. One blocked frame blocks the clip;
 * a check that cannot run fails closed (`unchecked`), because a clip that
 * cannot be checked is not served.
 */
async function checkFrames(
	ctx: Ctx,
	takeId: string,
	frames: Uint8Array[],
): Promise<"shown" | "not_filtered" | "blocked" | "unchecked"> {
	let checkedAny = false;
	for (const png of frames) {
		const verdict = await checkFinishedPicture({
			userId: ctx.row.userId,
			takeId,
			png,
		});
		if (verdict === "blocked") return "blocked";
		if (verdict === "unchecked") return "unchecked";
		if (verdict === "shown") checkedAny = true;
		if (ctx.signal.aborted) return "not_filtered";
	}
	return checkedAny ? "shown" : "not_filtered";
}

/**
 * The `video` artifact version: a new item, or a version appended to the one
 * the take names. Answers the artifact id, or null when the item is gone (the
 * take then stores nothing).
 */
async function writeArtifact(
	ctx: Ctx,
	request: VideoTakeRequest,
	serialized: string,
): Promise<string | null> {
	const { row } = ctx;
	const summary = request.summary;
	const failed = (error: unknown): never => {
		if (error instanceof TakeError) throw error;
		throw new TakeError(
			"video_artifact_failed",
			"The video could not be saved to its item.",
			true,
		);
	};
	if (request.artifactId) {
		try {
			const written = await updateArtifactBody({
				userId: row.userId,
				artifactId: request.artifactId,
				body: serialized,
				author: "alfy",
				summary: summary ?? VERSION_SUMMARY.alfyChangedVideo,
				conversationId: row.conversationId,
			});
			if (!written.ok) {
				if (written.reason === "not_found") {
					throw new TakeError(
						"video_item_deleted",
						"The item this video belongs to is gone.",
						false,
					);
				}
				return failed(written.reason);
			}
			return request.artifactId;
		} catch (error) {
			return failed(error);
		}
	}
	try {
		const created = await createArtifact({
			userId: row.userId,
			conversationId: row.conversationId,
			kind: "video",
			title: request.title,
			body: serialized,
			author: "alfy",
			versionSummary: summary ?? VERSION_SUMMARY.alfyVideo,
		});
		if (!created.ok) return failed(created.reason);
		return created.artifact.id;
	} catch (error) {
		return failed(error);
	}
}
