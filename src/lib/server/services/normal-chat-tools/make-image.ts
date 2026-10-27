// make_image: make a new picture from words, or change one. The call becomes a
// take on the picture server (a job of the image kind), waits for it up to
// IMAGE_TOOL_WAIT_MS, and answers with ids and a sentence, never a picture or
// an address: the card in the chat shows the picture, and the model has no URL
// to embed. A take that outlives the wait is not lost; it lands on its card
// later (it is held until the call has decided about it, then released).
//
// Everything the model reads from here is ASCII English (ruling 79); titles
// and names ride inside it as the person's own data.

import { z } from "zod";
import { getConfig, isImageMakingConfigured } from "$lib/server/config-store";
import { UserStopReason } from "$lib/server/services/chat-turn/active-streams";
import {
	createCard,
	hideTake,
	markTakeRetried,
	releaseHold,
	replacePick,
} from "$lib/server/services/images/cards";
import { cancelTake, enqueueTake } from "$lib/server/services/images/image-job";
import { PictureUnreadableError } from "$lib/server/services/images/inputs";
import {
	type MakeImageRefusal,
	resolveMakeImageRequest,
	type TakePlan,
} from "$lib/server/services/images/requests";
import { queueResultLook } from "$lib/server/services/images/result-look";
import { freshSeed } from "$lib/server/services/images/seeds";
import type { TakeRequest } from "$lib/server/services/images/take-request";
import type { TurnPictureIndex } from "$lib/server/services/images/turn-pictures";
import {
	MAX_IMAGE_CALLS_PER_TURN,
	type TurnTakes,
} from "$lib/server/services/images/turn-takes";
import {
	type TakeSnapshot,
	waitForTake,
} from "$lib/server/services/images/wait";
import type { StepImageQueue } from "$lib/server/services/vision/step-images";

export const makeImageInputSchema = z.object({
	prompt: z
		.string()
		.min(1)
		.max(2000)
		.describe(
			"The instruction for the picture model, in English: what to make or change, and what must stay as it is. Refer to `pictures` as <image1>, <image2> in their order.",
		),
	pictures: z
		.array(z.string())
		.max(10)
		.optional()
		.describe(
			'Pictures to start from: a picture number from this message ("3") or an Image id from "In this chat". Put the picture being changed first. When the user says "it", it is the picture open in the panel, else the newest Image in "In this chat".',
		),
	title: z
		.string()
		.max(80)
		.optional()
		.describe(
			"For a new picture: a short title in the conversation's language.",
		),
	summary: z
		.string()
		.max(200)
		.optional()
		.describe(
			"What you changed, in the conversation's language: one short past-tense line with no subject and never in the first person; shown in History.",
		),
	size: z
		.enum(["landscape", "portrait", "square", "wide", "tall"])
		.optional()
		.describe(
			"Only for a new picture, when the user's words ask for a shape (\"for my phone\" is tall). A change keeps its picture's shape.",
		),
	print: z
		.boolean()
		.optional()
		.describe(
			"True only when the user wants print or wallpaper quality (about 4 MP, slower).",
		),
	transparent: z
		.boolean()
		.optional()
		.describe(
			"True when the user wants a cut-out on a transparent background.",
		),
	startNew: z
		.boolean()
		.optional()
		.describe(
			"True to start a separate picture even though the first picture is an existing Image.",
		),
	retryOf: z
		.string()
		.max(64)
		.optional()
		.describe(
			"A takeId from this turn whose result clearly missed: makes it again once; the better one is kept.",
		),
});
export type MakeImageInput = z.infer<typeof makeImageInputSchema>;

export type MakeImagePayload =
	| {
			ok: true;
			status: "succeeded";
			takeId: string;
			imageId: string | null;
			title: string;
			inUse: boolean;
			retried: boolean;
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
			errorCode: MakeImageRefusal | "not_configured" | "image_error";
			message: string;
	  };

/** How long a call waits for its take. A print-size change (about 70 s, 140 s with a retry) may outlive it and then lands on its card. */
export const IMAGE_TOOL_WAIT_MS = 100_000;
/** The take is held this long, longer than the wait and the envelope, so it is never promoted before the call has decided about it. */
const HOLD_MS = 130_000;
/** A clear miss is made again only when this much of the wait is left; a retry takes about as long as the take did. */
export const RETRY_MIN_LEFT_MS = 25_000;

const SUCCEEDED_NOTE =
	"The picture is now on its card in the chat for the user. You cannot see it: say in one sentence what you made or changed, do not describe how it looks, and do not write a link.";
const SET_ASIDE_NOTE =
	"The picture is on its card in the chat as another take; the user can choose it there. You cannot see it: do not describe how it looks, and do not write a link.";
const lookNote = (takeId: string, retried: boolean) =>
	retried
		? "The result follows as a picture: say in one or two sentences what changed. It was already made again once; do not call make_image again for it."
		: `The result follows as a picture: say in one or two sentences what changed. If it clearly missed (the wrong thing changed), call make_image once with retryOf "${takeId}".`;
const RUNNING_NOTE =
	"The picture is still being made and will appear on its card in the chat when it is ready. Tell the user it is on its way; do not call make_image again for it.";

const FAILURE_MESSAGES: Record<string, string> = {
	image_server_unreachable: "The picture server could not be reached.",
	image_graph_rejected: "The picture server refused this request.",
	image_render_failed: "The picture server could not render the picture.",
	image_render_timeout: "The picture took too long to render.",
	image_result_missing: "The picture server lost the result.",
	image_input_missing: "A picture this one is made from is gone.",
	image_server_not_configured: "No picture server is set up.",
	image_request_invalid: "The picture request could not be read.",
};
const FAILURE_FALLBACK = "The picture could not be made.";
const STOPPED_MESSAGE =
	"The user stopped the turn before this picture started, so it was not made.";

type Metadata = Record<string, string | number | boolean | null>;
type Outcome = { modelPayload: MakeImagePayload; metadata: Metadata };

function refusal(
	errorCode: MakeImageRefusal | "not_configured" | "image_error",
	message: string,
): Outcome {
	return {
		modelPayload: { ok: false, errorCode, message },
		// No `error` text: the row the person reads is made from the code, in their language.
		metadata: { ok: false, imageRefusal: errorCode },
	};
}

/**
 * The composer's Stop, and nothing else: it aborts with `UserStopReason`. The
 * envelope's clock, the stream watchdog and a fallback abort with other
 * reasons (or none) and only let go of the holds; the take lands later.
 */
function isUserStop(signal: AbortSignal): boolean {
	return signal.aborted && signal.reason instanceof UserStopReason;
}

type MakeImageParams = {
	userId: string;
	conversationId: string;
	turnId: string;
	toolCallId: string;
	input: MakeImageInput;
	turnPictures: TurnPictureIndex | null;
	turnTakes: TurnTakes;
	requestText: string;
	signal: AbortSignal;
	onTick?: () => void;
	/** The turn's queue of pictures the model is shown in the step after this result (the look). */
	stepImages?: StepImageQueue;
	/** Whether the turn's model can see pictures; when it cannot, there is no look and the note says only that the picture is on its card. */
	modelCanSee?: boolean;
	/** How long to wait for the take; tests shorten it. */
	waitBudgetMs?: number;
	/** Least wait to leave for the automatic retry; tests lower it. */
	retryMinLeftMs?: number;
};

/** The call's gates, the request it names and the card it lands on; a refusal is what the model is told. */
async function planTake(
	params: MakeImageParams,
): Promise<
	{ ok: true; plan: TakePlan; cardId: string } | { ok: false; refused: Outcome }
> {
	const { userId, conversationId, turnTakes, input } = params;
	const callNumber = turnTakes.countCall();
	if (!isImageMakingConfigured(getConfig())) {
		return {
			ok: false,
			refused: refusal("not_configured", "No picture server is set up."),
		};
	}
	if (callNumber > MAX_IMAGE_CALLS_PER_TURN) {
		return {
			ok: false,
			refused: refusal(
				"too_many_calls",
				`make_image has already been called ${MAX_IMAGE_CALLS_PER_TURN} times in this turn, the limit. Do not call it again now; tell the user what you made.`,
			),
		};
	}
	let resolved: Awaited<ReturnType<typeof resolveMakeImageRequest>>;
	try {
		resolved = await resolveMakeImageRequest({
			userId,
			conversationId,
			input,
			turnPictures: params.turnPictures,
			turnTakes,
			requestText: params.requestText,
		});
	} catch (error) {
		// A picture that is gone or cannot be decoded is the model's to hear about.
		if (error instanceof PictureUnreadableError) {
			const refused = refusal("unknown_picture", error.message);
			return {
				ok: false,
				// The person's own picture cannot be read: that one is theirs to hear about.
				refused: {
					...refused,
					metadata: { ...refused.metadata, imageUnreadable: true },
				},
			};
		}
		throw error;
	}
	if (!resolved.ok) {
		return {
			ok: false,
			refused: refusal(resolved.refusal, resolved.message),
		};
	}
	const { plan } = resolved;
	let cardId = plan.cardId ?? turnTakes.cardFor(plan.cardKey) ?? null;
	if (!cardId) {
		cardId = (
			await createCard({
				userId,
				conversationId,
				turnId: params.turnId,
				artifactId: plan.artifactId,
				title: plan.title,
				madeFrom: plan.madeFrom,
				sourceCount: plan.sourceCount,
			})
		).cardId;
		turnTakes.rememberCard(plan.cardKey, cardId);
	}
	return { ok: true, plan, cardId };
}

export async function runMakeImageTool(
	params: MakeImageParams,
): Promise<Outcome> {
	const startedAt = Date.now();
	// Planning, the card and the first take go one call at a time, so parallel
	// calls of one step share a card and respect the four-takes cap.
	const started = await params.turnTakes.exclusive(async () => {
		const planned = await planTake(params);
		if (!planned.ok) return planned;
		const call = makeCallHelpers({
			params,
			plan: planned.plan,
			cardId: planned.cardId,
			budgetMs: params.waitBudgetMs ?? IMAGE_TOOL_WAIT_MS,
			startedAt,
		});
		const firstId = await call.queue(
			planned.plan.request,
			planned.plan.retryOf,
			params.toolCallId,
		);
		return { ok: true as const, call, firstId };
	});
	if (!started.ok) return started.refused;
	const { call, firstId } = started;
	const { plan, cardId } = call;
	const retriedByModel = plan.retryOf !== null;

	const held = new Set<string>([firstId]);
	const released = new Set<string>();

	let winnerId = firstId;
	let winner: TakeSnapshot;
	let autoRetried = false;
	let stopped = false;
	let settled: Awaited<ReturnType<typeof releaseHold>> | null = null;
	try {
		const first = await call.waitOn(firstId);
		winner = first.snapshot;
		stopped = first.stopped;

		// A clear miss the guards measured is made again once, inside this call.
		if (
			!stopped &&
			!retriedByModel &&
			winner.status === "succeeded" &&
			winner.measures?.miss &&
			!params.signal.aborted
		) {
			const outcome = await runClearMissRetry(call, {
				firstId,
				first: winner,
				held,
			});
			winnerId = outcome.winnerId;
			winner = outcome.winner;
			autoRetried = outcome.autoRetried;
		}

		if (!stopped && winner.status === "succeeded") {
			released.add(winnerId);
			settled = await releaseHold(winnerId);
			if (plan.retryOf) {
				settled = await placeModelRetry({
					cardId,
					oldId: plan.retryOf,
					winnerId,
					settled,
				});
			}
		}
	} finally {
		for (const id of held) {
			if (released.has(id)) continue;
			released.add(id);
			await releaseHold(id).catch(
				warnAbout("A hold could not be released", id),
			);
		}
	}

	const retried = retriedByModel || autoRetried;
	if (retried && winner.status === "succeeded") {
		await markTakeRetried(winnerId).catch(
			warnAbout("A retried take could not be marked", winnerId),
		);
	}
	return presentOutcome({
		call,
		cardId,
		winnerId,
		snapshot: winner,
		stopped,
		retried,
		settled,
	});
}

function warnAbout(what: string, takeId: string) {
	return (error: unknown): void => {
		console.warn(`[IMAGES] ${what}`, {
			takeId,
			reason: error instanceof Error ? error.message : String(error),
		});
	};
}

type CallHelpers = ReturnType<typeof makeCallHelpers>;

/** What the pieces of one call share: its plan, its clock, and how it queues and waits for a take. */
function makeCallHelpers(input: {
	params: MakeImageParams;
	plan: TakePlan;
	cardId: string;
	budgetMs: number;
	/** When the tool call began: the wait is measured from here, not from after planning. */
	startedAt: number;
}) {
	const { params, plan, cardId, budgetMs, startedAt } = input;
	const { userId, conversationId, turnTakes } = params;
	const elapsedMs = () => Date.now() - startedAt;
	const leftMs = () => budgetMs - elapsedMs();

	/** Queues one take of this call; it is held until the call has decided about it. */
	const queue = async (
		request: TakeRequest,
		retryOf: string | null,
		toolCallId: string | null,
	): Promise<string> => {
		const seed = freshSeed(request.avoidSeeds);
		const { takeId } = await enqueueTake({
			userId,
			conversationId,
			cardId,
			toolCallId,
			origin: retryOf ? "retry" : "turn",
			retryOf,
			request,
			seed,
			heldUntil: Date.now() + HOLD_MS,
		});
		turnTakes.noteTake({
			takeId,
			toolCallId,
			cardId,
			cardKey: plan.cardKey,
			callKey: plan.callKey,
			seed,
			request,
			isRetry: retryOf !== null,
			baseNumber: plan.baseNumber,
		});
		if (retryOf) turnTakes.markRetried(retryOf);
		return takeId;
	};

	/** Waits for a take. Only the composer's Stop cancels, and only a take not yet rendering (the card's own Stop is for one that is); an envelope timeout lets go and the take lands later onto its card. */
	const waitOn = async (
		takeId: string,
	): Promise<{ snapshot: TakeSnapshot; stopped: boolean }> => {
		const snapshot = await waitForTake(takeId, {
			budgetMs: Math.max(0, leftMs()),
			signal: params.signal,
			onTick: params.onTick,
		});
		let stopped = false;
		if (isUserStop(params.signal)) {
			stopped = await cancelTake(userId, takeId, { interrupt: false }).catch(
				(error: unknown) => {
					warnAbout("A stopped take could not be cancelled", takeId)(error);
					return false;
				},
			);
		}
		return { snapshot, stopped };
	};

	return { params, plan, cardId, queue, waitOn, leftMs, elapsedMs };
}

/**
 * The one automatic retry of a take that landed with a clear miss. Made only
 * when the wait has room for a second take as long as the first took (and at
 * least RETRY_MIN_LEFT_MS). The take not shown is hidden at once, also a retry
 * that has not landed when the call ends (it then lands hidden): only the better
 * take is ever shown.
 */
async function runClearMissRetry(
	call: CallHelpers,
	input: { firstId: string; first: TakeSnapshot; held: Set<string> },
): Promise<{
	winnerId: string;
	winner: TakeSnapshot;
	autoRetried: boolean;
}> {
	const { firstId, first, held } = input;
	const keep = { winnerId: firstId, winner: first, autoRetried: false };
	const record = call.params.turnTakes.take(firstId);
	if (!record) return keep;
	if (
		call.leftMs() <
		Math.max(call.params.retryMinLeftMs ?? RETRY_MIN_LEFT_MS, call.elapsedMs())
	) {
		return keep;
	}
	try {
		const request: TakeRequest = {
			...call.plan.request,
			avoidSeeds: [...new Set([...call.plan.request.avoidSeeds, record.seed])],
		};
		const retryId = await call.queue(request, firstId, null);
		held.add(retryId);
		keep.autoRetried = true;
		const second = await call.waitOn(retryId);
		if (pickBetterTake(first, second.snapshot) === "retry") {
			await hideTake(firstId).catch(
				warnAbout("A missed take could not be hidden", firstId),
			);
			return {
				winnerId: retryId,
				winner: second.snapshot,
				autoRetried: true,
			};
		}
		// Failed, missed worse, not landed by the end of the call, or stopped.
		await hideTake(retryId).catch(
			warnAbout("A retry take could not be hidden", retryId),
		);
	} catch (error) {
		console.warn("[IMAGES] The automatic retry could not be made", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	return keep;
}

/** The model's retry takes the place of the take it repeats: a version when that one is in use, else it only leaves the tray. */
async function placeModelRetry(input: {
	cardId: string;
	oldId: string;
	winnerId: string;
	settled: Awaited<ReturnType<typeof releaseHold>>;
}): Promise<Awaited<ReturnType<typeof releaseHold>>> {
	const { cardId, oldId, winnerId, settled } = input;
	if (settled.pickedTakeId === oldId) {
		const { versionNumber } = await replacePick({ cardId, takeId: winnerId });
		return versionNumber === null
			? settled
			: { ...settled, pickedTakeId: winnerId, versionNumber };
	}
	await hideTake(oldId).catch(
		warnAbout("A replaced take could not be hidden", oldId),
	);
	return settled;
}

/** What the model is told, and the metadata the row keeps, for the take the call ends with. */
async function presentOutcome(input: {
	call: CallHelpers;
	cardId: string;
	winnerId: string;
	snapshot: TakeSnapshot;
	stopped: boolean;
	retried: boolean;
	settled: Awaited<ReturnType<typeof releaseHold>> | null;
}): Promise<Outcome> {
	const { call, cardId, winnerId, snapshot, stopped, retried, settled } = input;
	const { plan } = call;
	const base: Metadata = {
		imageCardId: cardId,
		imageTakeId: winnerId,
		imageArtifactId: plan.artifactId,
		imageEdit: plan.request.mode === "edit",
		imageTitle: plan.title,
		imageRetried: retried,
	};
	if (stopped) return failedOutcome(base, winnerId, "image_stopped", false);
	if (snapshot.status === "succeeded") {
		return succeededOutcome({
			call,
			base,
			winnerId,
			snapshot,
			retried,
			settled,
		});
	}
	if (snapshot.status === "queued" || snapshot.status === "running") {
		return {
			modelPayload: {
				ok: true,
				status: "running",
				takeId: winnerId,
				title: plan.title,
				note: RUNNING_NOTE,
			},
			metadata: { ...base, ok: true, imageStatus: "running" },
		};
	}
	if (snapshot.status === "cancelled") {
		return failedOutcome(base, winnerId, "image_stopped", false);
	}
	return failedOutcome(
		base,
		winnerId,
		snapshot.errorCode ?? "image_render_failed",
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
				errorCode === "image_stopped"
					? STOPPED_MESSAGE
					: (FAILURE_MESSAGES[errorCode] ?? FAILURE_FALLBACK),
			retryable,
		},
		metadata: {
			...base,
			ok: false,
			imageStatus: "failed",
			...(errorCode === "image_stopped"
				? { imageStopped: true }
				: { imageError: errorCode }),
		},
	};
}

/** The look: only for a picture that landed inside the wait, and only when the turn has room left in its picture budget. */
async function lookAtResult(
	call: CallHelpers,
	winnerId: string,
	snapshot: TakeSnapshot,
): Promise<boolean> {
	const { params, plan } = call;
	if (
		!params.stepImages ||
		params.modelCanSee === false ||
		!snapshot.resultFileId ||
		params.signal.aborted
	) {
		return false;
	}
	const request = params.turnTakes.take(winnerId)?.request ?? plan.request;
	try {
		return await queueResultLook({
			userId: params.userId,
			conversationId: params.conversationId,
			queue: params.stepImages,
			signal: params.signal,
			takeId: winnerId,
			resultFileId: snapshot.resultFileId,
			baseFileId:
				request.inputs.find((item) => item.role === "base")?.fileId ?? null,
			baseNumber: plan.baseNumber,
		});
	} catch (error) {
		warnAbout("The look at a made picture failed", winnerId)(error);
		return false;
	}
}

async function succeededOutcome(input: {
	call: CallHelpers;
	base: Metadata;
	winnerId: string;
	snapshot: TakeSnapshot;
	retried: boolean;
	settled: Awaited<ReturnType<typeof releaseHold>> | null;
}): Promise<Outcome> {
	const { call, base, winnerId, snapshot, retried, settled } = input;
	const { plan } = call;
	const inUse = settled?.pickedTakeId === winnerId;
	const imageId = settled?.artifactId ?? plan.artifactId;
	const looked = await lookAtResult(call, winnerId, snapshot);
	const plainNote = inUse ? SUCCEEDED_NOTE : SET_ASIDE_NOTE;
	return {
		modelPayload: {
			ok: true,
			status: "succeeded",
			takeId: winnerId,
			imageId,
			title: plan.title,
			inUse,
			retried,
			note: looked ? lookNote(winnerId, retried) : plainNote,
		},
		metadata: {
			...base,
			ok: true,
			imageStatus: "succeeded",
			imageArtifactId: imageId,
			imageInUse: inUse,
			imageLooked: looked,
		},
	};
}

/**
 * Which of two takes of one request to show. The retry, unless it did not
 * land, or it also missed while the first did not. When both missed, the one
 * with more change inside the marks (or more change overall, without marks).
 */
export function pickBetterTake(
	first: TakeSnapshot,
	retry: TakeSnapshot,
): "first" | "retry" {
	if (retry.status !== "succeeded") return "first";
	const firstMiss = Boolean(first.measures?.miss);
	const retryMiss = Boolean(retry.measures?.miss);
	if (retryMiss && !firstMiss) return "first";
	if (!(retryMiss && firstMiss)) return "retry";
	const score = (snapshot: TakeSnapshot): number => {
		const measures = snapshot.measures;
		if (!measures) return 0;
		return measures.insideMarksShare === null
			? measures.changedShare
			: measures.changedShare * measures.insideMarksShare;
	};
	return score(retry) >= score(first) ? "retry" : "first";
}
