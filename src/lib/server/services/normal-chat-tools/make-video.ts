// make_video: make a short clip from a still picture. The call names one of
// the turn's numbered pictures (or an Image of this chat), turns the person's
// motion idea into the caption LTX reads, queues a take on the video kind,
// waits for it up to VIDEO_TOOL_WAIT_MS, and answers with ids and a sentence.
// It hands the model no picture and no address: the card in the chat shows the
// clip. A take that outlives the wait is not lost; it lands on its card later.
//
// The still is resolved exactly as make_image resolves a picture (`sourcesNamed`
// for a number or an Image id, `loadPicture` to read it), and it can be named
// in the ways a model actually has: a number, an Image id, or the takeId
// make_image just handed it. A call with NO picture animates the newest picture
// THIS TURN made, else the picture open in the panel — "make me a picture and
// animate it" works in one turn without the model knowing any id. A name that
// resolves to nothing is refused with what the turn does offer.
//
// Everything the model reads from here is ASCII English (ruling 79); titles
// and the person's motion idea ride inside it as their own data.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig, isVideoMakingConfigured } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobs, videoJobs } from "$lib/server/db/schema";
import { UserStopReason } from "$lib/server/services/chat-turn/active-streams";
import type { LtxVideoVariant } from "$lib/server/services/images/comfyui/ltx-spec";
import {
	getImageFile,
	storeImageFile,
} from "$lib/server/services/images/files";
import {
	loadPicture,
	PictureUnreadableError,
} from "$lib/server/services/images/inputs";
import {
	isExplicitFilterOnFor,
	isExplicitVariantAllowedFor,
} from "$lib/server/services/images/picture-check/policy";
import { findExplicitRequestTerm } from "$lib/server/services/images/picture-check/request-terms";
import { sourcesNamed } from "$lib/server/services/images/requests";
import { freshSeed } from "$lib/server/services/images/seeds";
import { parseTakeRequest } from "$lib/server/services/images/take-request";
import { titleFor } from "$lib/server/services/images/title-for";
import type {
	TurnPictureIndex,
	TurnPictureSource,
} from "$lib/server/services/images/turn-pictures";
import type { TurnTakes } from "$lib/server/services/images/turn-takes";
import {
	VIDEO_TOOL_WAIT_MS,
	type VideoDurationSeconds,
	type VideoTakeRequest,
	videoSizeForSource,
} from "$lib/server/services/images/video/request";
import {
	cancelVideoTake,
	enqueueVideoTake,
	videoJob,
} from "$lib/server/services/images/video/video-job";
import { waitForVerdict } from "$lib/server/services/jobs";
import {
	buildVideoContinuationPrompt,
	buildVideoPrompt,
} from "$lib/server/services/video-caption";

export const makeVideoInputSchema = z.object({
	prompt: z
		.string()
		.min(1)
		.max(2000)
		.describe(
			"The motion idea, in English: what moves in the clip, how the camera moves, and what stays as it is. This is the idea a caption is written from, not the final caption.",
		),
	picture: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe(
			'The still to animate, when the user named one: a picture number from this message ("3"), an Image id from "In this chat", or the takeId a make_image call returned. Leave it out to animate the newest picture this turn made, else the picture open in the panel.',
		),
	title: z
		.string()
		.max(80)
		.optional()
		.describe(
			"A title, 2-5 words, in the conversation's language: name the clip's subject as a person would (\"Harbour at dawn\"), never restating the request or its verbs (make, animate). Title Case in English, normal capitalisation in Hungarian. Give it on every call: a clip always starts a new Video, so it never keeps an earlier one's title.",
		),
	summary: z
		.string()
		.max(200)
		.optional()
		.describe(
			"What the clip shows, in the conversation's language: one short line with no subject and never in the first person; shown in History.",
		),
	durationSeconds: z
		.literal(5)
		.or(z.literal(10))
		.default(5)
		.describe(
			"The clip's length: 5 seconds by default, 10 only when the user asks for ten. There is nothing longer.",
		),
});
export type MakeVideoInput = z.infer<typeof makeVideoInputSchema>;

export type MakeVideoPayload =
	| {
			ok: true;
			status: "succeeded";
			takeId: string;
			videoId: string | null;
			fileId: string;
			title: string;
			summary: string | null;
			durationSeconds: VideoDurationSeconds;
			note: string;
	  }
	| {
			ok: true;
			status: "running";
			takeId: string;
			title: string;
			note: string;
	  }
	| {
			ok: false;
			status: "failed";
			takeId: string;
			errorCode: string;
			message: string;
			retryable: boolean;
	  }
	| {
			ok: false;
			errorCode: RefusalCode;
			message: string;
	  };

type RefusalCode =
	| "not_configured"
	| "not_asked_for"
	| "explicit_request"
	| "unknown_picture"
	| "video_error"
	| "video_stopped";

/** A take as the tool reads it: what the job row says at the end of the wait. */
export type VideoTakeSnapshot = {
	takeId: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	resultFileId: string | null;
	artifactId: string | null;
	errorCode: string | null;
	retryable: boolean;
};

export type WaitForVideoTake = (
	takeId: string,
	options: { budgetMs: number; signal: AbortSignal; onTick?: () => void },
) => Promise<VideoTakeSnapshot>;

/**
 * What the call has queued, for the envelope's failure path: a call that
 * queued a take and then timed out is still coming, and must not be reported
 * as a failure that made nothing.
 */
export type MakeVideoCallState = { takeId: string | null };

const FAILURE_MESSAGES: Record<string, string> = {
	video_server_unreachable: "The video server could not be reached.",
	video_graph_rejected: "The video server refused this request.",
	video_render_failed: "The video server could not render the clip.",
	video_render_timeout: "The clip took too long to render.",
	video_result_missing: "The video server lost the result.",
	video_input_missing: "The picture this clip is made from is gone.",
	video_server_not_configured: "No video server is set up.",
	video_request_invalid: "The video request could not be read.",
	video_item_deleted: "The Video item this clip belongs to is gone.",
	video_media_unavailable: "The server that makes videos has no video tools.",
	video_media_failed: "The clip could not be put together.",
	video_artifact_failed: "The video could not be saved to its item.",
	video_blocked:
		"The finished clip was blocked by the explicit-picture filter: it was not shown to the user and not kept. Tell the user plainly that it was blocked. Do not call make_video again for this request.",
	video_unchecked:
		"The finished clip could not be checked by the explicit-picture filter, so it was not shown to the user and not kept. Tell the user it could not be checked right now. Do not call make_video again for it now.",
	video_take_missing: "The video take is gone.",
};
/** A take the filter stopped is never the model's to repeat, whatever the card offers. */
const NOT_FOR_THE_MODEL_TO_RETRY = new Set([
	"video_blocked",
	"video_unchecked",
]);
const FAILURE_FALLBACK = "The video could not be made.";
const STOPPED_MESSAGE =
	"The user stopped the turn before this video started, so it was not made.";
/**
 * The refusal a take gets when the explicit-picture filter refuses its request.
 * The video card's Another route reuses it for a new take whose cloned request
 * is no longer allowed.
 */
export const EXPLICIT_REQUEST_MESSAGE =
	"Explicit or sexual videos are not made here: the explicit-picture filter refused this request and no clip was made. Tell the user plainly that this video cannot be made. Do not call make_video again for this request.";

const SUCCEEDED_NOTE =
	"The clip is now on its card in the chat for the user. You cannot see it. Then say in one sentence what you made, do not describe every frame, and do not write a link.";
const RUNNING_NOTE =
	"The video is still being made and will appear on its card in the chat when it is ready. Tell the user it is on its way; do not call make_video again for it.";

/** A turn already stopped makes nothing, and pays for no caption. */
function stoppedRefusal(): Outcome {
	return {
		modelPayload: {
			ok: false,
			errorCode: "video_stopped",
			message: STOPPED_MESSAGE,
		},
		metadata: { ok: false, videoStopped: true },
	};
}

const TITLE_FALLBACK = "Video";

type Metadata = Record<string, string | number | boolean | null>;
type Outcome = { modelPayload: MakeVideoPayload; metadata: Metadata };

/** What the model is told when the person did not ask for a video: ask first. */
const NOT_ASKED_FOR_VIDEO_MESSAGE =
	"The user did not ask for a video in so many words, so none was started. Ask with ask_user whether they want a short video of the picture, offering a changed still picture as the other choice, and make the video only once they choose it.";

function refusal(errorCode: RefusalCode, message: string): Outcome {
	return {
		modelPayload: { ok: false, errorCode, message },
		// No `error` text: the row the person reads is made from the code, in their language.
		metadata: { ok: false, videoError: errorCode },
	};
}

/**
 * The composer's Stop, and nothing else: it aborts with `UserStopReason`. The
 * envelope's clock, the stream watchdog and a fallback abort with other
 * reasons (or none) and only let go of the wait; the take lands later.
 */
function isUserStop(signal: AbortSignal): boolean {
	return signal.aborted && signal.reason instanceof UserStopReason;
}

/** The picture a marked copy was painted from: the boxes are for the model's eyes, never for a clip. */
function unmarkedPicture(
	turnPictures: TurnPictureIndex | null,
	source: TurnPictureSource,
): TurnPictureSource {
	if (source.type !== "image_file" || source.role !== "marked") return source;
	const marks = turnPictures?.metadata?.marks;
	if (!marks) return source;
	const base = turnPictures?.pictures.find((picture) =>
		picture.source.type === "upload"
			? picture.source.artifactId === marks.uploadArtifactId
			: picture.source.fileId === marks.imageFileId,
	)?.source;
	return base ?? source;
}

/**
 * The picture a take made, as a source of this chat: its result file and the
 * Image item that file belongs to. Scoped to THIS person and THIS chat, so
 * another person's take, or a take of another chat, resolves to nothing.
 */
async function pictureFromTake(params: {
	userId: string;
	conversationId: string;
	takeId: string;
}): Promise<TurnPictureSource | null> {
	const [row] = await db
		.select({
			resultFileId: imageJobs.resultFileId,
			requestJson: imageJobs.requestJson,
		})
		.from(imageJobs)
		.where(
			and(
				eq(imageJobs.id, params.takeId),
				eq(imageJobs.userId, params.userId),
				eq(imageJobs.conversationId, params.conversationId),
				// A hidden take is one the card does not show: never the turn's picture.
				eq(imageJobs.hidden, 0),
			),
		)
		.limit(1);
	if (!row?.resultFileId) return null;
	const file = await getImageFile({
		userId: params.userId,
		fileId: row.resultFileId,
		conversationId: params.conversationId,
	});
	if (!file) return null;
	return {
		type: "image_file",
		fileId: file.id,
		name: parseTakeRequest(row.requestJson)?.title ?? "Picture",
		artifactId: file.artifactId,
		role: "attached",
	};
}

/** The newest picture this turn made: its newest take that has a result file. */
async function newestPictureThisTurn(params: {
	userId: string;
	conversationId: string;
	turnTakes: TurnTakes;
}): Promise<{ source: TurnPictureSource; takeId: string } | null> {
	const takes = params.turnTakes.takes();
	for (let index = takes.length - 1; index >= 0; index -= 1) {
		const take = takes[index];
		if (!take) continue;
		const source = await pictureFromTake({
			userId: params.userId,
			conversationId: params.conversationId,
			takeId: take.takeId,
		});
		if (source) return { source, takeId: take.takeId };
	}
	return null;
}

/** The picture open in the panel, when the turn numbered it. */
function openPictureSource(
	turnPictures: TurnPictureIndex | null,
): TurnPictureSource | null {
	return (
		turnPictures?.pictures.find(
			(picture) =>
				picture.source.type === "image_file" && picture.source.role === "open",
		)?.source ?? null
	);
}

/** The numbers and Image ids this turn does offer, for a refusal that names them. */
function picturesOnOffer(turnPictures: TurnPictureIndex | null): string[] {
	const options: string[] = [];
	const numbers = (turnPictures?.pictures ?? [])
		.map((picture) => picture.number)
		.slice(0, 5);
	if (numbers.length > 0) {
		options.push(`a picture number from this message (${numbers.join(", ")})`);
	}
	const items = (turnPictures?.pictures ?? [])
		.filter(
			(picture) =>
				picture.source.type === "image_file" &&
				Boolean(picture.source.artifactId),
		)
		.slice(0, 3)
		.map((picture) => {
			const source = picture.source as Extract<
				TurnPictureSource,
				{ type: "image_file" }
			>;
			return `${source.artifactId} is ${JSON.stringify(source.name)}`;
		});
	if (items.length > 0) {
		options.push(`an Image id from "In this chat" (${items.join(", ")})`);
	}
	return options;
}

/**
 * What a call that could not find its still is told: the ways it CAN name a
 * picture, with this turn's own numbers and Image ids, and the picture the turn
 * just made — which is the one a model that has only read make_image's result
 * does not know the id of.
 */
async function noPictureMessage(params: {
	name: string | null;
	userId: string;
	conversationId: string;
	turnPictures: TurnPictureIndex | null;
	turnTakes: TurnTakes;
}): Promise<string> {
	const opener = params.name
		? `make_video has no picture ${JSON.stringify(params.name)}.`
		: "This turn has no picture to animate yet.";
	const options: string[] = [];
	const made = await newestPictureThisTurn({
		userId: params.userId,
		conversationId: params.conversationId,
		turnTakes: params.turnTakes,
	});
	if (made) {
		options.push(
			`the newest picture this turn made (${JSON.stringify(made.source.name)}, takeId ${made.takeId}) by leaving "picture" out or by passing that takeId`,
		);
	} else {
		options.push("the takeId a make_image call returned");
	}
	options.push(...picturesOnOffer(params.turnPictures));
	if (options.length === 1 && !made && !params.turnPictures) {
		return `${opener} This message carries no picture and this turn made none: make one with make_image first, or ask the user to attach a picture.`;
	}
	return `${opener} It can animate ${options.join(", ")}.`;
}

type Plan = {
	request: VideoTakeRequest;
	title: string;
	width: number;
	height: number;
};

type Planned = { ok: true; plan: Plan } | { ok: false; refused: Outcome };

/** The gates, the still and the caption: everything a refused call must not pay for. */
async function planTake(params: {
	userId: string;
	conversationId: string;
	input: MakeVideoInput;
	/** The person's own message this turn, for a title the model did not give. */
	requestText: string;
	turnPictures: TurnPictureIndex | null;
	turnTakes: TurnTakes;
	signal: AbortSignal;
	/** Whether the person asked for a video (video-request.ts); omitted, nothing is asked. */
	askedForVideo?: () => Promise<boolean | null>;
}): Promise<Planned> {
	const { userId, conversationId, input, turnPictures, turnTakes } = params;
	if (params.signal.aborted) return { ok: false, refused: stoppedRefusal() };
	if (!isVideoMakingConfigured(getConfig())) {
		return {
			ok: false,
			refused: refusal("not_configured", "No video server is set up."),
		};
	}
	// The request half of the explicit-picture filter: the model was told to
	// decline (make_video's description); a plain case it let through stops
	// here, before a caption, a still or a take exists.
	if (
		findExplicitRequestTerm(`${input.prompt}\n${input.title ?? ""}`) !== null &&
		(await isExplicitFilterOnFor(userId))
	) {
		return {
			ok: false,
			refused: refusal("explicit_request", EXPLICIT_REQUEST_MESSAGE),
		};
	}
	// A video starts only on a clear request for one (video-request.ts): a "no"
	// stops the call here, before a still, a caption or a take, and sends the
	// model to ask. No answer is the model's own call, which goes on.
	if (params.askedForVideo && (await params.askedForVideo()) === false) {
		return {
			ok: false,
			refused: refusal("not_asked_for", NOT_ASKED_FOR_VIDEO_MESSAGE),
		};
	}

	// The still, named in a way the model actually has: a number, an Image id or
	// the takeId make_image handed it; with no name, the picture this turn made,
	// else the picture open in the panel.
	let source: TurnPictureSource | null = null;
	const name = input.picture?.trim();
	if (name) {
		const named = await sourcesNamed({
			userId,
			conversationId,
			names: [name],
			turnPictures,
			tool: "make_video",
		});
		source = named.ok ? named.sources[0] : null;
		if (!source) {
			source = await pictureFromTake({ userId, conversationId, takeId: name });
		}
	} else {
		source =
			(await newestPictureThisTurn({ userId, conversationId, turnTakes }))
				?.source ?? openPictureSource(turnPictures);
	}
	if (!source) {
		return {
			ok: false,
			refused: refusal(
				"unknown_picture",
				await noPictureMessage({
					name: name ?? null,
					userId,
					conversationId,
					turnPictures,
					turnTakes,
				}),
			),
		};
	}
	const still = unmarkedPicture(turnPictures, source);

	let loaded: Awaited<ReturnType<typeof loadPicture>>;
	try {
		loaded = await loadPicture({ userId, conversationId, source: still });
	} catch (error) {
		// A picture that is gone or cannot be decoded is the model's to hear about.
		if (error instanceof PictureUnreadableError) {
			return {
				ok: false,
				refused: refusal("unknown_picture", error.message),
			};
		}
		throw error;
	}

	const durationSeconds = input.durationSeconds;
	// The exemption selects the second engine variant for the whole take: read
	// once here, so both captions and the take's row agree.
	const explicitVariant = await isExplicitVariantAllowedFor(userId);
	const variant: LtxVideoVariant = explicitVariant ? "alt" : "standard";
	// The caption is a model call: it happens only for a take that will be made.
	const prompt = await buildVideoPrompt(input.prompt.trim(), {
		signal: params.signal,
		variant,
	});
	// A 10 s take's second segment starts on the first one's last frame: its
	// caption goes on from there, never the first one's again (review C-2).
	const continuationPrompt =
		durationSeconds === 10 && !params.signal.aborted
			? await buildVideoContinuationPrompt(input.prompt.trim(), prompt, {
					signal: params.signal,
					variant,
				})
			: null;
	// Stopped while the caption was written: no still is kept and nothing is
	// queued, because a render started here would run for minutes for nothing.
	if (params.signal.aborted) return { ok: false, refused: stoppedRefusal() };

	// The take renders a picture FILE of this chat. An uploaded photo, and a
	// picture of another chat, has no file here yet: a copy becomes the still,
	// as a photo's first version does for a picture take.
	let sourceFileId = loaded.fileId;
	if (!sourceFileId) {
		const stored = await storeImageFile({
			userId,
			conversationId,
			// The still is the take's INPUT: it is what the clip is made from, and
			// it is never a take's own result or a marked copy for eyes.
			role: "input",
			png: loaded.png,
			mayBeSeeThrough: true,
		});
		sourceFileId = stored.id;
	}

	const title = titleFor(input.title, params.requestText, TITLE_FALLBACK);
	const summary = input.summary?.trim() ? input.summary.trim() : null;
	const size = videoSizeForSource({
		width: loaded.width,
		height: loaded.height,
	});
	return {
		ok: true,
		plan: {
			title,
			width: size.width,
			height: size.height,
			request: {
				v: 1,
				prompt,
				...(continuationPrompt ? { continuationPrompt } : {}),
				durationSeconds,
				sourceFileId,
				title,
				summary,
				artifactId: null,
				explicitVariant,
			},
		},
	};
}

export async function runMakeVideoTool(params: {
	userId: string;
	conversationId: string;
	toolCallId: string;
	input: MakeVideoInput;
	/** The person's own message this turn, for a title the model did not give. */
	requestText: string;
	turnPictures: TurnPictureIndex | null;
	/** What this turn has made with make_image: the picture a call with no name animates. */
	turnTakes: TurnTakes;
	signal: AbortSignal;
	state: MakeVideoCallState;
	onTick?: () => void;
	/** How long to wait for the take; tests shorten it. */
	waitBudgetMs?: number;
	/** The wait itself; tests replace it, production reads the video kind. */
	waitForTake?: WaitForVideoTake;
	/** Whether the person asked for a video (video-request.ts); omitted, nothing is asked. */
	askedForVideo?: () => Promise<boolean | null>;
}): Promise<Outcome> {
	const planned = await planTake(params);
	if (!planned.ok) return planned.refused;
	const { plan } = planned;

	// A turn the person stopped (or whose deadline passed) while the caption
	// was written must not start a render that takes minutes: nothing is queued.
	if (params.signal.aborted) return stoppedRefusal();

	// A fresh item, never a version of an existing one: the plan's `artifactId`
	// is always null, which is what makes `videoCardId` the take (see
	// `presentOutcome`'s note and `make-video-card.test.ts`).
	const { takeId } = await enqueueVideoTake({
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: plan.request.artifactId,
		toolCallId: params.toolCallId,
		origin: "turn",
		retryOf: null,
		request: plan.request,
		seed: freshSeed([]),
	});
	params.state.takeId = takeId;

	const wait = params.waitForTake ?? waitForVideoTake;
	const snapshot = await wait(takeId, {
		budgetMs: Math.max(0, params.waitBudgetMs ?? VIDEO_TOOL_WAIT_MS),
		signal: params.signal,
		onTick: params.onTick,
	});

	let stopped = false;
	if (isUserStop(params.signal)) {
		stopped = await cancelVideoTake(params.userId, takeId, {
			interrupt: false,
		}).catch((error: unknown) => {
			console.warn("[VIDEO] A stopped take could not be cancelled", {
				takeId,
				reason: error instanceof Error ? error.message : String(error),
			});
			return false;
		});
	}

	const base: Metadata = {
		videoTakeId: takeId,
		// The card one take draws IS this take, and that is checked, not a
		// coincidence: `make_video` only ever queues a fresh item (the request's
		// `artifactId` is null and no input can set it), and the read model
		// (`images/video/read-model.ts`) groups a fresh take by its call and names
		// the card after the group's FIRST take. One take per call makes that this
		// take (`make-video-card.test.ts` holds it against the real read model).
		// A take that appends to an existing item would have to READ the card id.
		videoCardId: takeId,
		videoTitle: plan.title,
		videoDurationSeconds: plan.request.durationSeconds,
		videoWidth: plan.width,
		videoHeight: plan.height,
	};
	if (plan.request.summary) base.videoSummary = plan.request.summary;
	if (stopped) return failedOutcome(base, takeId, "video_stopped", false);
	if (snapshot.status === "succeeded" && snapshot.resultFileId) {
		return {
			modelPayload: {
				ok: true,
				status: "succeeded",
				takeId,
				videoId: snapshot.artifactId,
				fileId: snapshot.resultFileId,
				title: plan.title,
				summary: plan.request.summary,
				durationSeconds: plan.request.durationSeconds,
				note: SUCCEEDED_NOTE,
			},
			metadata: {
				...base,
				ok: true,
				videoStatus: "succeeded",
				videoArtifactId: snapshot.artifactId,
				videoFileId: snapshot.resultFileId,
			},
		};
	}
	if (snapshot.status === "queued" || snapshot.status === "running") {
		return {
			modelPayload: {
				ok: true,
				status: "running",
				takeId,
				title: plan.title,
				note: RUNNING_NOTE,
			},
			metadata: { ...base, ok: true, videoStatus: "running" },
		};
	}
	if (snapshot.status === "cancelled") {
		return failedOutcome(base, takeId, "video_stopped", false);
	}
	return failedOutcome(
		base,
		takeId,
		snapshot.errorCode ?? "video_render_failed",
		snapshot.retryable,
	);
}

function failedOutcome(
	base: Metadata,
	takeId: string,
	errorCode: string,
	retryable: boolean,
): Outcome {
	return {
		modelPayload: {
			ok: false,
			status: "failed",
			takeId,
			errorCode,
			message:
				errorCode === "video_stopped"
					? STOPPED_MESSAGE
					: (FAILURE_MESSAGES[errorCode] ?? FAILURE_FALLBACK),
			retryable: retryable && !NOT_FOR_THE_MODEL_TO_RETRY.has(errorCode),
		},
		metadata: {
			...base,
			ok: false,
			videoStatus: "failed",
			...(errorCode === "video_stopped"
				? { videoStopped: true }
				: { videoError: errorCode }),
		},
	};
}

/**
 * Waits up to `budgetMs` for the take to settle, calling `onTick` every second
 * meanwhile, then reads the take once. A take that has not settled comes back
 * `queued` or `running`; the signal ends the wait early the same way.
 */
export async function waitForVideoTake(
	takeId: string,
	options: { budgetMs: number; signal: AbortSignal; onTick?: () => void },
): Promise<VideoTakeSnapshot> {
	const ticker = options.onTick
		? setInterval(() => {
				try {
					options.onTick?.();
				} catch {
					// A heartbeat that fails never ends the wait.
				}
			}, 1_000)
		: null;
	ticker?.unref?.();
	try {
		await waitForVerdict(videoJob, takeId, {
			timeoutMs: options.budgetMs,
			signal: options.signal,
		});
	} finally {
		if (ticker) clearInterval(ticker);
	}
	return readVideoTake(takeId);
}

async function readVideoTake(takeId: string): Promise<VideoTakeSnapshot> {
	const [row] = await db
		.select()
		.from(videoJobs)
		.where(eq(videoJobs.id, takeId))
		.limit(1);
	if (!row) {
		return {
			takeId,
			status: "failed",
			resultFileId: null,
			artifactId: null,
			errorCode: "video_take_missing",
			retryable: false,
		};
	}
	return {
		takeId,
		status:
			row.status === "queued" ||
			row.status === "running" ||
			row.status === "succeeded" ||
			row.status === "cancelled"
				? row.status
				: "failed",
		resultFileId: row.resultFileId,
		artifactId: row.artifactId,
		errorCode: row.errorCode,
		retryable: Boolean(row.retryable),
	};
}
