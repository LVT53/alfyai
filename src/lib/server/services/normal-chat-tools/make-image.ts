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
import { createCard, releaseHold } from "$lib/server/services/images/cards";
import { cancelTake, enqueueTake } from "$lib/server/services/images/image-job";
import { PictureUnreadableError } from "$lib/server/services/images/inputs";
import {
	type MakeImageRefusal,
	resolveMakeImageRequest,
} from "$lib/server/services/images/requests";
import { freshSeed } from "$lib/server/services/images/seeds";
import type { TurnPictureIndex } from "$lib/server/services/images/turn-pictures";
import {
	MAX_IMAGE_CALLS_PER_TURN,
	type TurnTakes,
} from "$lib/server/services/images/turn-takes";
import { waitForTake } from "$lib/server/services/images/wait";
import { ToolTimeoutError } from "./shared";

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

const SUCCEEDED_NOTE =
	"The picture is now on its card in the chat for the user. You cannot see it: say in one sentence what you made or changed, do not describe how it looks, and do not write a link.";
const SET_ASIDE_NOTE =
	"The picture is on its card in the chat as another take; the user can choose it there. You cannot see it: do not describe how it looks, and do not write a link.";
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

function refusal(
	errorCode: MakeImageRefusal | "not_configured" | "image_error",
	message: string,
): { modelPayload: MakeImagePayload; metadata: Metadata } {
	return {
		modelPayload: { ok: false, errorCode, message },
		metadata: { ok: false, error: message, imageRefusal: errorCode },
	};
}

/** The turn's own abort (the composer's Stop), not the envelope running out of time. */
function isUserStop(signal: AbortSignal): boolean {
	return signal.aborted && !(signal.reason instanceof ToolTimeoutError);
}

export async function runMakeImageTool(params: {
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
	/** How long to wait for the take; tests shorten it. */
	waitBudgetMs?: number;
}): Promise<{ modelPayload: MakeImagePayload; metadata: Metadata }> {
	const { userId, conversationId, turnTakes, input } = params;
	const call = turnTakes.countCall();
	if (!isImageMakingConfigured(getConfig())) {
		return refusal("not_configured", "No picture server is set up.");
	}
	if (call > MAX_IMAGE_CALLS_PER_TURN) {
		return refusal(
			"too_many_calls",
			`make_image has already been called ${MAX_IMAGE_CALLS_PER_TURN} times in this turn, the limit. Do not call it again now; tell the user what you made.`,
		);
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
			return refusal("unknown_picture", error.message);
		}
		throw error;
	}
	if (!resolved.ok) return refusal(resolved.refusal, resolved.message);
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

	const seed = freshSeed(plan.request.avoidSeeds);
	const { takeId } = await enqueueTake({
		userId,
		conversationId,
		cardId,
		toolCallId: params.toolCallId,
		origin: plan.retryOf ? "retry" : "turn",
		retryOf: plan.retryOf,
		request: plan.request,
		seed,
		heldUntil: Date.now() + HOLD_MS,
	});
	turnTakes.noteTake({
		takeId,
		cardId,
		cardKey: plan.cardKey,
		seed,
		request: plan.request,
		isRetry: plan.retryOf !== null,
	});
	if (plan.retryOf) turnTakes.markRetried(plan.retryOf);

	const edit = plan.request.mode === "edit";
	const base: Metadata = {
		imageCardId: cardId,
		imageTakeId: takeId,
		imageArtifactId: plan.artifactId,
		imageEdit: edit,
		imageTitle: plan.title,
		imageRetried: plan.retryOf !== null,
	};

	let stopped = false;
	let snapshot: Awaited<ReturnType<typeof waitForTake>>;
	let settled: Awaited<ReturnType<typeof releaseHold>>;
	try {
		snapshot = await waitForTake(takeId, {
			budgetMs: params.waitBudgetMs ?? IMAGE_TOOL_WAIT_MS,
			signal: params.signal,
			onTick: params.onTick,
		});
		// Only the composer's Stop cancels, and only a take not yet rendering
		// (the card's own Stop is for one that is). An envelope timeout lets go:
		// the take lands later onto its card.
		if (isUserStop(params.signal)) {
			stopped = await cancelTake(userId, takeId, { interrupt: false }).catch(
				() => false,
			);
		}
	} finally {
		settled = await releaseHold(takeId);
	}

	if (stopped) {
		return {
			modelPayload: {
				ok: false,
				status: "failed",
				takeId,
				errorCode: "image_stopped",
				message: STOPPED_MESSAGE,
				retryable: false,
			},
			metadata: { ...base, ok: false, imageStatus: "failed" },
		};
	}

	if (snapshot.status === "succeeded") {
		const inUse = settled.pickedTakeId === takeId;
		const imageId = settled.artifactId ?? plan.artifactId;
		return {
			modelPayload: {
				ok: true,
				status: "succeeded",
				takeId,
				imageId,
				title: plan.title,
				inUse,
				retried: plan.retryOf !== null,
				note: inUse ? SUCCEEDED_NOTE : SET_ASIDE_NOTE,
			},
			metadata: {
				...base,
				ok: true,
				imageStatus: "succeeded",
				imageArtifactId: imageId,
				imageInUse: inUse,
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
			metadata: { ...base, ok: true, imageStatus: "running" },
		};
	}

	const errorCode =
		snapshot.status === "cancelled"
			? "image_stopped"
			: (snapshot.errorCode ?? "image_render_failed");
	return {
		modelPayload: {
			ok: false,
			status: "failed",
			takeId,
			errorCode,
			message:
				snapshot.status === "cancelled"
					? STOPPED_MESSAGE
					: (FAILURE_MESSAGES[errorCode] ?? FAILURE_FALLBACK),
			retryable: snapshot.status === "cancelled" ? false : snapshot.retryable,
		},
		metadata: {
			...base,
			ok: false,
			imageStatus: "failed",
			imageError: errorCode,
		},
	};
}
