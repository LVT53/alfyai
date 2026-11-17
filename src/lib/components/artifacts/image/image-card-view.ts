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
	/** `finishing`: ComfyUI is done; the decode and the app's own work are left. */
	| { kind: "making"; finishing: boolean }
	| { kind: "failed"; unavailable: boolean; retryable: boolean }
	/** The explicit-picture filter kept the picture back: it looked explicit, or (unchecked) the check could not run. */
	| { kind: "blocked"; unchecked: boolean }
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
			// Submitted and never started: it waits its turn. A take that already
			// has an estimate is past that (a prompt posted again), still on its way.
			if (take.phase === "submitted" && take.etaSeconds === null) {
				return { kind: "waiting", ahead: take.queueAhead || null };
			}
			if (
				take.phase === "starting" &&
				take.phaseAt !== null &&
				now - take.phaseAt >= STARTING_SHOWN_AFTER_MS
			) {
				return { kind: "starting" };
			}
			return { kind: "making", finishing: take.phase === "finishing" };
		}
		case "succeeded":
			return { kind: "ready" };
		case "cancelled":
			return { kind: "stopped" };
		case "failed":
			if (take.errorCode === "image_blocked") {
				return { kind: "blocked", unchecked: false };
			}
			if (take.errorCode === "image_unchecked") {
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

/**
 * A length as `m:ss` (`0:05`), and `h:mm:ss` past an hour: a clip's duration.
 * Numeric and locale-neutral on purpose: no dictionary entry, and nothing to
 * translate. Never negative.
 */
export function elapsedClock(elapsedMs: number): string {
	const total = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const two = (value: number) => String(value).padStart(2, "0");
	return hours > 0
		? `${hours}:${two(minutes)}:${two(seconds)}`
		: `${minutes}:${two(seconds)}`;
}

// ---- The countdown --------------------------------------------------------
//
// The server sends a take's seconds left as of each read (`take-eta.ts`): a
// finish time that only ever moves earlier. The card anchors each reading on
// its own clock and counts down by itself, so the number moves every second
// whatever the poll does, and no clock is shared with the server.

/** How often a card being made reads its countdown: each second shows on time. */
export const COUNTDOWN_TICK_MS = 250;

/**
 * A reading later than the countdown by more than this is the server starting
 * the render over (the one real reason to show more time), not a slow answer.
 */
export const ETA_RAISE_TOLERANCE_MS = 5_000;

/** From this many seconds left the countdown speaks in minutes. */
const MINUTES_FROM_SECONDS = 100;

export type EtaCountdown = {
	/** A poll's reading: the server's seconds left for take `takeId`, at `now`. */
	read(takeId: string, etaSeconds: number | null, now: number): void;
	/** The finish time the card counts to at `now`, on this clock; null with no estimate. */
	at(now: number): number | null;
};

/**
 * One card's countdown. It never moves later, except when a reading is later
 * by more than `ETA_RAISE_TOLERANCE_MS` (the server started over); an earlier
 * reading is eased in at no more than one extra second per second, so a take
 * that turns out faster counts down quicker for a while, never by a jump.
 */
export function createEtaCountdown(): EtaCountdown {
	let takeId: string | null = null;
	let target: number | null = null;
	let shown: number | null = null;
	let movedAt = 0;
	return {
		read(id, etaSeconds, now) {
			if (etaSeconds === null) {
				takeId = id;
				target = null;
				shown = null;
				return;
			}
			const candidate = now + etaSeconds * 1000;
			if (id !== takeId || target === null || shown === null) {
				takeId = id;
				target = candidate;
				shown = candidate;
				movedAt = now;
				return;
			}
			// A reading a little later than the target is the answer's own delay.
			if (candidate < target || candidate > target + ETA_RAISE_TOLERANCE_MS) {
				target = candidate;
			}
			if (target > shown + ETA_RAISE_TOLERANCE_MS) {
				shown = target;
				movedAt = now;
			}
		},
		at(now) {
			if (shown === null || target === null) return null;
			if (target < shown) {
				shown = Math.max(target, shown - Math.max(0, now - movedAt));
			}
			movedAt = now;
			return shown;
		},
	};
}

/** Where a take stands against its countdown: whole seconds left, or past its time. */
export type TakeTime =
	| { kind: "left"; seconds: number }
	| { kind: "over"; finishing: boolean };

export function takeTime(
	deadline: number | null,
	finishing: boolean,
	now: number,
): TakeTime | null {
	if (deadline === null) return null;
	const seconds = Math.ceil((deadline - now) / 1000);
	return seconds > 0 ? { kind: "left", seconds } : { kind: "over", finishing };
}

/**
 * The countdown in words: "About 24 s left", minutes from 100 s; past its time
 * never a number, but what the take is still doing: "Almost done…" in its last
 * step, "Taking a little longer…" before it.
 */
export function takeTimeWords(
	time: TakeTime | null,
	t: Translate,
): string | null {
	if (time === null) return null;
	if (time.kind === "over") {
		return t(
			time.finishing
				? "artifacts.image.card.almostDone"
				: "artifacts.image.card.longer",
		);
	}
	return time.seconds >= MINUTES_FROM_SECONDS
		? t("artifacts.image.card.etaMinutes", {
				count: Math.max(2, Math.round(time.seconds / 60)),
			})
		: t("artifacts.image.card.eta", { count: time.seconds });
}

/**
 * The words beside the kind in the card's head while its take is on its way:
 * its place in the queue while it waits, then the countdown. Null when the
 * take is not on its way, or has no estimate yet.
 */
export function takeTimeLine(
	state:
		| { kind: "waiting"; ahead: number | null }
		| { kind: "starting" }
		| { kind: "making"; finishing: boolean }
		| { kind: "failed" | "blocked" | "stopped" | "ready" },
	deadline: number | null,
	now: number,
	t: Translate,
): string | null {
	switch (state.kind) {
		case "waiting":
			return waitingLine(state.ahead, t);
		case "starting":
			return takeTimeWords(takeTime(deadline, false, now), t);
		case "making":
			return takeTimeWords(takeTime(deadline, state.finishing, now), t);
		default:
			return null;
	}
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
	| { type: "attach"; fileId: string; name: string; at?: number };

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
