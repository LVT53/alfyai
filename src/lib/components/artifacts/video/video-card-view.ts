// What a video card shows, worked out from its one take. Pure: the component
// threads its own clock and `$t` in, so every state is testable here.
//
// The picture card's `image-card-view.ts` is the model this one mirrors: the
// same states, the same time rule (an estimate when the render reports one,
// the phase's `m:ss` clock otherwise), and the same "Next up / N ahead" line
// for a take that has not started. The parts that are genuinely shared are
// imported from there rather than copied (`elapsedClock`, `makingDetail`,
// `waitingLine`, `STARTING_SHOWN_AFTER_MS`).
import type { VideoVersionBody } from "$lib/shared/artifacts/video-body";
import type { Translate } from "$lib/utils/tool-evidence-presentation";
import {
	elapsedClock,
	makingDetail,
	STARTING_SHOWN_AFTER_MS,
	waitingLine,
} from "../image/image-card-view";

export type VideoTakeStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type VideoTakePhase =
	| "submitted"
	| "starting"
	| "rendering"
	| "finishing";

/**
 * One video take as the card draws it. `clip` is the landed version body (the
 * shared `VideoVersionBody`): the mp4, the poster frame it is served from and
 * the measured length. A take that has not landed has none.
 *
 * The runner slice's read model produces this shape; a video card has one take
 * at a time and no takes strip; its versions exist, but History is not shown
 * for a clip yet, so Another replaces what the card shows rather than adding a
 * tile.
 */
export type VideoTakeView = {
	id: string;
	status: VideoTakeStatus;
	phase: VideoTakePhase | null;
	/** Milliseconds: when the take entered its phase. */
	phaseAt: number | null;
	queueAhead: number | null;
	etaSeconds: number | null;
	errorCode: string | null;
	retryable: boolean;
	/** The `make_video` call that made this take, so a running call finds its card. */
	toolCallId: string | null;
	/** Milliseconds. */
	createdAt: number;
	clip: VideoVersionBody | null;
};

export type VideoCardView = {
	id: string;
	conversationId: string;
	artifactId: string | null;
	title: string;
	/** The clip's shape, known before it lands so the box never changes size. */
	width: number;
	height: number;
	/** The length asked for (5000 or 10000), so the badge is right even before the clip is measured. */
	durationMs: number;
	take: VideoTakeView | null;
};

export type VideoCardState =
	| { kind: "waiting"; ahead: number | null }
	| { kind: "starting" }
	| {
			kind: "making";
			etaSeconds: number | null;
			/** When the take entered this phase, and when the take began. */
			phaseAt: number | null;
			createdAt: number;
	  }
	| { kind: "failed"; unavailable: boolean; retryable: boolean }
	| { kind: "blocked"; unchecked: boolean }
	| { kind: "stopped" }
	| { kind: "ready" };

/** Every way of not reaching the video server (not only an unreachable one). */
const UNAVAILABLE_CODES: readonly string[] = [
	"video_server_unreachable",
	"video_server_not_configured",
];

export function isVideoTakeActive(take: VideoTakeView | null): boolean {
	return take?.status === "queued" || take?.status === "running";
}

/**
 * The take's state. A succeeded take whose clip cannot be read is a failure,
 * never a player with nothing behind it: there is no way to play an unreadable
 * body, and saying so is a state with a way out (Try again).
 */
export function videoTakeState(
	take: VideoTakeView | null,
	now: number,
): VideoCardState {
	if (!take) return { kind: "waiting", ahead: null };
	switch (take.status) {
		case "queued":
			return { kind: "waiting", ahead: null };
		case "running": {
			if (take.phase === "submitted") {
				return { kind: "waiting", ahead: take.queueAhead || null };
			}
			if (
				take.phase === "starting" &&
				take.phaseAt !== null &&
				now - take.phaseAt >= STARTING_SHOWN_AFTER_MS
			) {
				return { kind: "starting" };
			}
			return {
				kind: "making",
				etaSeconds: take.etaSeconds,
				phaseAt: take.phaseAt,
				createdAt: take.createdAt,
			};
		}
		case "succeeded":
			return take.clip
				? { kind: "ready" }
				: { kind: "failed", unavailable: false, retryable: true };
		case "cancelled":
			return { kind: "stopped" };
		case "failed": {
			if (take.errorCode === "video_blocked") {
				return { kind: "blocked", unchecked: false };
			}
			if (take.errorCode === "video_unchecked") {
				return { kind: "blocked", unchecked: true };
			}
			return {
				kind: "failed",
				unavailable:
					take.errorCode !== null && UNAVAILABLE_CODES.includes(take.errorCode),
				retryable: take.retryable,
			};
		}
	}
}

/** The card's one status line and its detail, in the reader's language. */
export function videoStateWords(
	state: VideoCardState,
	now: number,
	t: Translate,
): { line: string; detail: string | null } {
	switch (state.kind) {
		case "waiting":
			return { line: waitingLine(state.ahead, t), detail: null };
		case "starting":
			return {
				line: t("artifacts.video.card.starting"),
				detail: t("artifacts.video.card.startingDetail"),
			};
		case "making":
			return {
				line: t("artifacts.video.card.making"),
				// The estimate when the render reports one, the time this phase has
				// taken otherwise: never blank while a video is made.
				detail: makingDetail(state, now, t),
			};
		case "failed":
			return {
				line: state.unavailable
					? t("artifacts.video.card.unavailable")
					: t("artifacts.video.card.failed"),
				detail: t("artifacts.video.card.nothingSaved"),
			};
		case "blocked":
			return state.unchecked
				? {
						line: t("artifacts.video.card.unchecked"),
						detail: t("artifacts.video.card.uncheckedDetail"),
					}
				: {
						line: t("artifacts.video.card.blocked"),
						detail: t("artifacts.video.card.blockedDetail"),
					};
		case "stopped":
			return { line: t("artifacts.video.card.stopped"), detail: null };
		case "ready":
			return { line: "", detail: null };
	}
}

/** The card's second line: the kind, as the picture card names its own kind. */
export function videoCardSubtitle(_card: VideoCardView, t: Translate): string {
	return t("artifacts.type.video");
}

/** The clip's length as `m:ss` — numeric and locale-neutral, the same clock a take being made reads. */
export function videoDurationLabel(durationMs: number): string {
	return elapsedClock(durationMs);
}

/**
 * The serving route's URL for a clip's file: `?variant=poster`/`?variant=thumb`
 * for its poster frame, `?download=1` for the whole original, `conversationId`
 * for a chat's own scope, and `format=gif` for the GIF download. The picture
 * path's helper (`imageFileUrl`) has no poster variant, so the video body owns
 * this one URL builder. The mp4 is the default: its URL is unchanged.
 */
export function videoFileUrl(
	fileId: string,
	options: {
		variant?: "poster" | "thumb";
		download?: boolean;
		format?: "mp4" | "gif";
		conversationId?: string | null;
	} = {},
): string {
	const query = new URLSearchParams();
	if (options.variant) query.set("variant", options.variant);
	if (options.download) query.set("download", "1");
	if (options.format === "gif") query.set("format", "gif");
	if (options.conversationId) {
		query.set("conversationId", options.conversationId);
	}
	const suffix = query.toString();
	return `/api/images/files/${encodeURIComponent(fileId)}${suffix ? `?${suffix}` : ""}`;
}

/** What a video card asks the chat page to do. */
export type VideoCardAction =
	| { type: "another"; cardId: string }
	| { type: "stop"; takeId: string }
	| { type: "retry"; takeId: string };

/**
 * The page's answer to an action: Another names the take it queued. A rejected
 * promise means nothing happened (the page has already said so).
 */
export type VideoCardActionResult = { takeId?: string } | undefined;

/** The chat page's answer to a video card's buttons, threaded down to the card. */
export type VideoCardActionHandler = (
	action: VideoCardAction,
) => Promise<VideoCardActionResult>;
