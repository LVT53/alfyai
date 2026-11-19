// What a video card shows, worked out from its one take. Pure. The take's own
// state, its words and the countdown are every take card's
// (`../takes/take-card-view.ts`, drawn by `TakeCardShell.svelte`); what is here
// is the clip's own: its card and take shapes, its length, its file URLs and
// the actions its card asks the page for.
import type { VideoVersionBody } from "$lib/shared/artifacts/video-body";
import type { Translate } from "$lib/utils/tool-evidence-presentation";
import {
	elapsedClock,
	type TakePhase,
	type TakeStatus,
} from "../takes/take-card-view";

export type VideoTakeStatus = TakeStatus;

export type VideoTakePhase = TakePhase;

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
	/**
	 * Seconds left as of the read (to a tenth), 0 once the take runs past its
	 * time, null with no estimate (`take-eta.ts` `etaSecondsAt`).
	 */
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

/** The card's second line: the kind, as the picture card names its own kind. */
export function videoCardSubtitle(t: Translate): string {
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
