// What a picture card shows, worked out from its takes. Pure: the component
// threads its own clock and `$t` in, so every state is testable here.

import type {
	ImageCardView,
	ImageTakeView,
} from "$lib/server/services/images/read-model";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

export type ImageCardState =
	| { kind: "waiting"; ahead: number | null }
	| { kind: "starting" }
	| {
			kind: "making";
			etaSeconds: number | null;
			progressPercent: number | null;
	  }
	| { kind: "failed"; unavailable: boolean; retryable: boolean }
	| { kind: "stopped" }
	| { kind: "ready" };

/** A take that has sat in its "starting" phase this long says the model is loading. */
export const STARTING_SHOWN_AFTER_MS = 3_000;

/** Every way of not reaching the picture server (not only an unreachable one). */
const UNAVAILABLE_CODES: readonly string[] = [
	"image_server_unreachable",
	"image_server_not_configured",
];

/**
 * The takes the card shows, oldest first. Only the server's automatic retry
 * (origin "auto_retry") that is still held lives in its first take's slot, so
 * the card never shows two takes for one retry and a held take is never
 * offered; once released the server hides one of the pair. The model's own
 * retry (origin "retry") is an ordinary take with its own progress, failure
 * and "Use this".
 */
export function visibleTakes(card: ImageCardView): ImageTakeView[] {
	const ids = new Set(card.takes.map((take) => take.id));
	return card.takes.filter(
		(take) =>
			!(
				take.origin === "auto_retry" &&
				take.held &&
				take.retryOf &&
				ids.has(take.retryOf)
			),
	);
}

/**
 * The server is making its one automatic retry of `take` (a clear miss) and has
 * not yet chosen between the two: the card keeps showing `take` with a quiet
 * "checking again" note over it, and swaps in place if the retry wins.
 */
export function isCheckingAgain(
	card: ImageCardView,
	take: ImageTakeView | null,
): boolean {
	if (!take) return false;
	return card.takes.some(
		(other) =>
			other.origin === "auto_retry" &&
			other.held &&
			other.retryOf === take.id &&
			other.status !== "failed" &&
			other.status !== "cancelled",
	);
}

const isBeingMade = (take: ImageTakeView) =>
	take.status === "queued" || take.status === "running";

export function shownTake(
	card: ImageCardView,
	selectedTakeId: string | null,
): ImageTakeView | null {
	const takes = visibleTakes(card);
	const byId = (id: string | null) =>
		id ? (takes.find((take) => take.id === id) ?? null) : null;
	return (
		byId(selectedTakeId) ??
		byId(card.pickedTakeId) ??
		takes.findLast(isBeingMade) ??
		takes.at(-1) ??
		null
	);
}

export function takeState(take: ImageTakeView, now: number): ImageCardState {
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
				progressPercent: take.progressPercent,
			};
		}
		case "succeeded":
			return { kind: "ready" };
		case "cancelled":
			return { kind: "stopped" };
		case "failed":
			return {
				kind: "failed",
				unavailable:
					take.errorCode !== null && UNAVAILABLE_CODES.includes(take.errorCode),
				retryable: take.retryable,
			};
	}
}

/** The card's second line. A change reads as words: no "edited ... ago". */
export function cardSubtitle(card: ImageCardView, t: Translate): string {
	if (card.madeFrom === "photo") return t("artifacts.image.subtitle.photo");
	if (card.madeFrom === "pictures") {
		return t("artifacts.image.subtitle.pictures", { count: card.sourceCount });
	}
	const count = visibleTakes(card).length;
	return count >= 2
		? t("artifacts.image.subtitle.takes", { count })
		: t("artifacts.type.image");
}

/**
 * A waiting take's line: how many pictures are ahead of it, or Next up when
 * none are (or none is counted yet: a take waiting in the app's own queue is
 * there for a moment before it reaches the picture server). Never "another
 * picture is being made": on a chat's first picture or right after Another
 * that read as something else being busy.
 */
export function waitingLine(ahead: number | null, t: Translate): string {
	return ahead !== null && ahead >= 1
		? t("artifacts.image.card.ahead", { count: ahead })
		: t("artifacts.image.card.nextUp");
}

export function etaLabel(seconds: number | null, t: Translate): string | null {
	if (seconds === null || seconds <= 0) return null;
	return t("artifacts.image.card.eta", { count: Math.ceil(seconds) });
}

export function canCompareBeforeAfter(take: ImageTakeView | null): boolean {
	return Boolean(take?.fileId && take.baseFileId);
}

export function hasActiveImageTakes(cards: readonly ImageCardView[]): boolean {
	return cards.some((card) => card.takes.some(isBeingMade));
}

/**
 * A held take (the server's automatic retry, or a take a dead turn left held)
 * is settled for the card only once its hold is let go or runs out, which
 * nothing announces: `held` is the server's word at read time, so the page
 * keeps reading while any take is held (holds are short, about 130 s at most).
 */
export function hasHeldImageTakes(cards: readonly ImageCardView[]): boolean {
	return cards.some((card) => card.takes.some((take) => take.held));
}

/** What a picture card asks the chat page to do (plan 2b T2; T5 adds `attach`). */
export type ImageCardAction =
	| { type: "another"; cardId: string }
	| { type: "use"; takeId: string }
	| { type: "stop"; takeId: string }
	| { type: "retry"; takeId: string }
	| { type: "download"; fileId: string; title: string }
	| { type: "history"; artifactId: string }
	| { type: "open"; artifactId: string }
	| { type: "attach"; fileId: string; name: string };

/**
 * The page's answer to an action: Another names the take it queued, so the
 * card can show it at once. A rejected promise means nothing happened (the
 * page has already said so).
 */
export type ImageCardActionResult = { takeId?: string } | undefined;

/** The chat page's answer to a picture card's buttons, threaded down to the card. */
export type ImageCardActionHandler = (
	action: ImageCardAction,
) => Promise<ImageCardActionResult>;
