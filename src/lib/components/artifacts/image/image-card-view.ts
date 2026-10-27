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
