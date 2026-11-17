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
	discardArtifactVersion,
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
import {
	engineLooksWarm,
	freeOtherPictureModels,
	scheduleIdleFree,
	waitForOtherEnginesIdle,
} from "../idle-free";
import { checkFinishedFrames } from "../picture-check";
import { isExplicitFilterOnFor } from "../picture-check/policy";
import { createTakeEta, type TakeEta } from "../take-eta";
import { discardStoredVideoFile, storeVideoFile } from "../video-files";
import { createVideoComfyClient } from "./comfy-client";
import { videoPlan } from "./eta";
import {
	concatClips,
	decodeCheckFrames,
	extractFrameAt,
	extractLastFrame,
	type MediaCallOptions,
	mediaTimeoutMs,
	stripClipMetadata,
	VideoMediaError,
} from "./media";
import {
	parseVideoCheckpoint,
	parseVideoTakeRequest,
	VIDEO_RENDER_DEADLINE_MS,
	type VideoCheckpoint,
	type VideoSegmentRecord,
	type VideoTakeRequest,
	videoDurationMs,
	videoSegmentCount,
	videoSizeForSource,
} from "./request";

/** How long a video server may be unreachable mid-render before the take gives up. */
const FOLLOW_GRACE_MS = 60_000;
const FOLLOW_RETRY_MS = 1000;
const PROGRESS_WRITE_EVERY_MS = 1000;
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
		tx.update(videoJobs)
			.set({
				phaseAt: Date.now(),
				...(etaAt === undefined ? {} : { etaAt }),
			})
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
	eta: TakeEta,
) {
	let downSince = 0;
	for (;;) {
		const left = VIDEO_RENDER_DEADLINE_MS - (Date.now() - startedAt);
		if (left <= 0) throw new ComfyUiError("timeout", "ComfyUI took too long");
		try {
			return await followSegment(ctx, client, promptId, left, eta);
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
	eta: TakeEta,
): Promise<ComfyImageRef[]> {
	let chain: Promise<unknown> = Promise.resolve();
	const queue = (work: () => Promise<unknown>) => {
		chain = chain.then(work).catch(() => undefined);
	};
	let started = false;
	let rendering = false;
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
			// The segment's prompt is on the GPU: the first one starts the
			// countdown with the whole plan, a later one its own segment's load.
			const etaAt = eta.start(Date.now());
			queue(() => enterPhase(ctx, "starting", etaAt));
		} else if (event.type === "progress") {
			const now = Date.now();
			if (!rendering) {
				rendering = true;
				queue(() => enterPhase(ctx, "rendering"));
			}
			// The estimate sees every event (so a node reset starts the next
			// pass), but the row is written at most once a second.
			const value = event.value ?? 0;
			const max = event.max ?? 0;
			const etaAt = eta.progress({ value, max }, now);
			// A node that just finished is worth a write even inside the throttle:
			// it is where a pass ends (and the second pass begins).
			const passFinished = max > 0 && value >= max;
			if (
				!passFinished &&
				lastWriteAt !== 0 &&
				now - lastWriteAt < PROGRESS_WRITE_EVERY_MS
			) {
				return;
			}
			lastWriteAt = now;
			queue(() =>
				ctx.write((tx) => {
					tx.update(videoJobs)
						.set({ etaAt })
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
 * The one budget every media call runs under: the attempt's remaining render
 * deadline, capped by `MEDIA_TIMEOUT_MS`. A spent deadline throws instead of
 * starting another call, and the signal carries the take's Stop into the child.
 */
function mediaOptions(ctx: Ctx, startedAt: number): MediaCallOptions {
	const left = VIDEO_RENDER_DEADLINE_MS - (Date.now() - startedAt);
	if (left <= 0) {
		throw new TakeError(
			"video_render_timeout",
			"The video took too long to render.",
			true,
		);
	}
	return { signal: ctx.signal, timeoutMs: Math.min(mediaTimeoutMs(), left) };
}

/**
 * Renders one segment: frees the other engines once, writes the prompt id and
 * the dense segment list to the checkpoint, posts under it, follows it and
 * fetches the clip. Answers null when the take was stopped before posting.
 *
 * `segments` holds every finished segment of THIS attempt, in order and with no
 * hole: the checkpoint written for segment 2 is `[segment 1, segment 2]`, so a
 * later attempt can read it back and fetch segment 1 instead of re-rendering it.
 */
async function renderSegment(
	ctx: Ctx,
	client: ComfyUiClient,
	input: {
		request: VideoTakeRequest;
		size: { width: number; height: number };
		imageName: string;
		segment: 1 | 2;
		/** The finished segments before this one; at segment n this is length n-1. */
		segments: readonly VideoSegmentRecord[];
		startedAt: number;
		eta: TakeEta;
		freedOthers: boolean;
		setPromptId: (id: string) => void;
	},
): Promise<{
	clip: Uint8Array;
	record: VideoSegmentRecord;
	checkpoint: VideoCheckpoint;
} | null> {
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
	const record: VideoSegmentRecord = { promptId, media: null };
	const segments = [...input.segments, record];
	const checkpoint: VideoCheckpoint = {
		promptId,
		segment: input.segment,
		segments,
	};
	const recorded = await ctx.progress({ checkpoint });
	if (!recorded || signal.aborted) return null;
	input.setPromptId(promptId);
	const answer = await client.submit(graph, { promptId });
	if (answer.promptId !== promptId) {
		// A ComfyUI that predates caller-supplied ids picks its own: follow that one.
		console.warn("[VIDEO] ComfyUI answered with another prompt id", {
			takeId: ctx.row.id,
			sent: promptId,
			answered: answer.promptId,
		});
		record.promptId = answer.promptId;
		checkpoint.promptId = answer.promptId;
		input.setPromptId(answer.promptId);
		await ctx.progress({ checkpoint });
	}
	await enterPhase(ctx, "submitted");
	if (signal.aborted) return null;

	const refs = await followWithGrace(
		ctx,
		client,
		record.promptId,
		input.startedAt,
		input.eta,
	);
	if (signal.aborted) return null;
	await enterPhase(ctx, "finishing", input.eta.enter("finish"));
	const ref = refs[0];
	if (!ref) {
		throw new ComfyUiError("missing_result", "ComfyUI finished without a clip");
	}
	const clip = await client.fetchImage(ref);
	record.media = ref;
	await ctx.progress({ checkpoint });
	return { clip, record, checkpoint };
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
	// The take's own clock starts now: the cross-engine gate orders takes still
	// inside it by this stamp.
	const stamped = await ctx.write((tx) => {
		tx.update(videoJobs)
			.set({ phaseAt: Date.now() })
			.where(eq(videoJobs.id, row.id))
			.run();
	});
	if (!stamped || signal.aborted) return;

	// One GPU, one engine's models: wait until no picture take is queued or
	// running before touching the LTX server. The card shows the take as
	// waiting; its countdown starts when ComfyUI starts the prompt.
	const waited = await waitForOtherEnginesIdle("ltx", {
		signal,
		deadlineMs: VIDEO_RENDER_DEADLINE_MS - (Date.now() - startedAt),
		claim: { id: row.id, phaseAt: row.phaseAt ?? Date.now() },
	});
	if (waited === "cancelled") return;
	if (waited === "timeout") {
		throw new TakeError(
			"video_render_timeout",
			"The video waited too long for the other engine to finish.",
			true,
		);
	}
	if (signal.aborted) return;
	// The estimate's plan: LTX's staging (short while it is still warm from a
	// clip a moment ago), both passes and the decode, segment by segment.
	const eta = createTakeEta(
		videoPlan(request.durationSeconds, await engineLooksWarm("ltx", row.id)),
	);

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
	const saved = parseVideoCheckpoint(row.checkpoint);
	// The checkpoint read once, then kept here and rewritten by every step: a
	// segment list with no hole, so a restart at segment 2 can read it back.
	let segments: VideoSegmentRecord[] = saved ? [...saved.segments] : [];
	const resumedPromptId = saved?.promptId ?? null;
	const resumedSegment = saved?.segment ?? 1;
	const clips: Uint8Array[] = [];
	let imageName = uploaded.filename;
	// The card holds one engine: free the picture servers once, before the run's
	// first submit, so LTX loads into memory they no longer hold. A resumed run
	// that starts at segment 2 still owes that free.
	let freedOthers = false;

	for (let segment = 1; segment <= segmentCount; segment += 1) {
		const segmentNumber = segment as 1 | 2;
		const done = segments[segmentNumber - 1];
		let clip: Uint8Array | null = null;

		// A finished segment's saved clip can be fetched again (a restart at
		// segment 2 must not render segment 1 a second time).
		if (done?.media) {
			try {
				clip = await client.fetchImage(done.media);
			} catch {
				// The clip is gone too: drop this segment and everything after it.
				clip = null;
				segments = segments.slice(0, segmentNumber - 1);
			}
		}
		// A prompt recorded for this segment can be followed (an app restart
		// mid-render). ComfyUI forgetting it means one clean re-render, with every
		// later record dropped first so an old segment cannot be joined to a new
		// one.
		if (!clip) {
			const recordedPrompt =
				done?.promptId ??
				(resumedSegment === segmentNumber ? resumedPromptId : null);
			if (recordedPrompt) {
				try {
					const refs = await followWithGrace(
						ctx,
						client,
						recordedPrompt,
						startedAt,
						eta,
					);
					if (signal.aborted) return;
					await enterPhase(ctx, "finishing", eta.enter("finish"));
					const ref = refs[0];
					if (!ref) {
						throw new ComfyUiError(
							"missing_result",
							"ComfyUI finished without a clip",
						);
					}
					clip = await client.fetchImage(ref);
					segments[segmentNumber - 1] = {
						promptId: recordedPrompt,
						media: ref,
					};
					await ctx.progress({
						checkpoint: {
							promptId: recordedPrompt,
							segment: segmentNumber,
							segments: segments.slice(0, segmentNumber),
						} satisfies VideoCheckpoint,
					});
				} catch (error) {
					if (signal.aborted) return;
					if (!isForgotten(error)) throw error;
					// The server restarted and no longer knows the prompt; the chain
					// from here is re-rendered.
					segments = segments.slice(0, segmentNumber - 1);
				}
			}
		}
		if (!clip) {
			mediaOptions(ctx, startedAt);
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
				const lastFrame = await extractLastFrame(
					first,
					mediaOptions(ctx, startedAt),
				);
				const guide = await client.uploadImage(lastFrame, `${row.id}-2.png`);
				imageName = guide.filename;
			}
			const rendered = await renderSegment(ctx, client, {
				request,
				size,
				imageName,
				segment: segmentNumber,
				segments: segments.slice(0, segmentNumber - 1),
				startedAt,
				eta,
				freedOthers,
				setPromptId: prompt.setPromptId,
			});
			if (!rendered) return;
			freedOthers = true;
			segments[segmentNumber - 1] = rendered.record;
			clip = rendered.clip;
		}
		if (signal.aborted) return;
		clips.push(clip);
	}
	// The attempt's own check before every media phase: a take that burned its
	// deadline fails here instead of starting another decode or the join.
	mediaOptions(ctx, startedAt);
	if (signal.aborted || clips.length !== segmentCount) return;

	const joined =
		clips.length === 1
			? (clips[0] as Uint8Array)
			: await concatClips(clips, mediaOptions(ctx, startedAt));
	if (signal.aborted) return;

	const durationSeconds = request.durationSeconds;
	const productMs = videoDurationMs(durationSeconds);

	// The explicit-picture filter, on EVERY frame of the clip, before anything is
	// stored. A picture is classified whole; a clip is too, so an explicit moment
	// between old sample points cannot pass. The decision is made ONCE here: an
	// exempt person needs only the poster, so the check stream is never decoded
	// (no frame files, no scaling, no temp directory); a filtered person gets one
	// ffmpeg pass producing the model's 224 x 224 raw input and the full-size
	// poster together, and the classifier runs it in batches of 16 on ONE session
	// (8 inference runs for 121 frames). `checkFinishedFrames` is still the
	// authority and answers `not_filtered` first for the empty list. Its clock is
	// the take's: a batch that cannot start before the deadline makes the clip
	// unchecked, and the take keeps nothing.
	const filterOn = await isExplicitFilterOnFor(row.userId);
	if (signal.aborted) return;
	let poster: Uint8Array;
	let checkFrames: Uint8Array[] = [];
	if (filterOn) {
		const decoded = await decodeCheckFrames(
			joined,
			mediaOptions(ctx, startedAt),
		);
		poster = decoded.poster;
		checkFrames = decoded.frames;
	} else {
		poster = await extractFrameAt(
			joined,
			{ seconds: 0 },
			mediaOptions(ctx, startedAt),
		);
	}
	if (signal.aborted) return;
	const verdict = await checkFinishedFrames({
		userId: row.userId,
		takeId: row.id,
		frames: checkFrames,
		signal,
		deadlineAt: startedAt + VIDEO_RENDER_DEADLINE_MS,
	});
	if (signal.aborted) return;
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

	// ComfyUI writes its prompt and node graph into the mp4's tags; a 5 s take
	// never touches ffmpeg otherwise, so every stored clip goes through this.
	const storedBytes =
		clips.length === 1
			? await stripClipMetadata(joined, mediaOptions(ctx, startedAt))
			: joined;
	mediaOptions(ctx, startedAt);
	if (signal.aborted) return;

	const file = await storeVideoFile({
		userId: row.userId,
		conversationId: row.conversationId,
		role: "take",
		mp4: storedBytes,
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
	// A failed write (the item was deleted mid-take) must not leave the stored
	// clip behind: nothing points at it once this throws.
	let artifact: {
		artifactId: string;
		versionId: string | null;
		created: boolean;
	};
	try {
		artifact = await writeArtifact(ctx, request, serialized);
	} catch (error) {
		await discardStoredVideoFile(file).catch(() => undefined);
		throw error;
	}
	await attachImageFilesToArtifact([file.id], artifact.artifactId).catch(
		(error) => {
			// The clip is served by its file id and the item's body points at it,
			// but the item's own delete cannot reach a row it does not own. Say so
			// the way the artifact delete path does.
			console.warn(
				"[VIDEO] Stored a clip but could not attach it to its item",
				{ takeId: row.id, artifactId: artifact.artifactId, error },
			);
		},
	);

	const settled = await ctx.succeed({
		apply: (tx) => {
			tx.update(videoJobs)
				.set({
					resultFileId: file.id,
					artifactId: artifact.artifactId,
					progressPercent: 100,
					etaAt: null,
				})
				.where(eq(videoJobs.id, row.id))
				.run();
		},
	});
	if (!settled) {
		// Stopped between the store and the settle: nothing may point at the clip.
		await discardStoredVideoFile(file).catch(() => undefined);
		if (artifact.created) {
			// The item exists only for this take; it goes with the clip.
			await deleteLibraryArtifact(row.userId, artifact.artifactId).catch(
				() => undefined,
			);
			await db
				.update(videoJobs)
				.set({ createdArtifactId: null })
				.where(eq(videoJobs.id, row.id))
				.run();
		} else if (artifact.versionId) {
			// The version was appended before the settle was refused; taking it
			// back keeps the item's current body on the version that still has a
			// file. Only the newest version is ever taken back.
			await discardArtifactVersion({
				userId: row.userId,
				artifactId: artifact.artifactId,
				versionId: artifact.versionId,
				conversationId: row.conversationId,
			}).catch(() => undefined);
		}
	}
}

/**
 * The `video` artifact version: a new item, or a version appended to the one
 * the take names. A worker lost after creating the item left its id on the take
 * (`createdArtifactId`), so the retry appends to it instead of making a second
 * item. Never answers null: a missing item throws `video_item_deleted`, and the
 * caller discards the clip.
 */
async function writeArtifact(
	ctx: Ctx,
	request: VideoTakeRequest,
	serialized: string,
): Promise<{ artifactId: string; versionId: string | null; created: boolean }> {
	const { row } = ctx;
	const summary = request.summary;
	const target = request.artifactId ?? row.createdArtifactId ?? null;
	if (target) {
		let written: Awaited<ReturnType<typeof updateArtifactBody>>;
		try {
			written = await updateArtifactBody({
				userId: row.userId,
				artifactId: target,
				body: serialized,
				author: "alfy",
				summary: summary ?? VERSION_SUMMARY.alfyChangedVideo,
				conversationId: row.conversationId,
			});
		} catch {
			throw new TakeError(
				"video_artifact_failed",
				"The video could not be saved to its item.",
				true,
			);
		}
		if (!written.ok) {
			if (written.reason === "not_found") {
				throw new TakeError(
					"video_item_deleted",
					"The item this video belongs to is gone.",
					false,
				);
			}
			throw new TakeError(
				"video_artifact_failed",
				"The video could not be saved to its item.",
				true,
			);
		}
		return {
			artifactId: target,
			versionId: written.versionId,
			created: false,
		};
	}
	let created: Awaited<ReturnType<typeof createArtifact>>;
	try {
		created = await createArtifact({
			userId: row.userId,
			conversationId: row.conversationId,
			kind: "video",
			title: request.title,
			body: serialized,
			author: "alfy",
			versionSummary: summary ?? VERSION_SUMMARY.alfyVideo,
		});
	} catch {
		throw new TakeError(
			"video_artifact_failed",
			"The video could not be saved to its item.",
			true,
		);
	}
	if (!created.ok) {
		throw new TakeError(
			"video_artifact_failed",
			"The video could not be saved to its item.",
			true,
		);
	}
	const artifactId = created.artifact.id;
	// The engine's fenced write records the item the take made BEFORE it settles,
	// so a worker lost here leaves the id for its retry. A refused write means the
	// take was stopped: the item goes with this run.
	const recorded = await ctx.write((tx) => {
		tx.update(videoJobs)
			.set({ createdArtifactId: artifactId })
			.where(eq(videoJobs.id, row.id))
			.run();
	});
	if (!recorded) {
		await deleteLibraryArtifact(row.userId, artifactId).catch(() => undefined);
		throw new TakeError(
			"video_artifact_failed",
			"The take stopped before it could keep its item.",
			false,
		);
	}
	return { artifactId, versionId: null, created: true };
}
