// What a picture or a video card shows of the take it is about, worked out
// from the take alone; `TakeCardShell.svelte` draws it. Pure: the component
// threads its own clock and `$t` in, so every state is testable here.
//
// One rule for both kinds (the one-shell waiver in docs/plans/ltx-video): the
// states, their words, the queue line and the countdown in the card's head. A
// kind differs only in its words: the server's codes carry the kind
// (`image_blocked`, `video_blocked`), and the kind's own sentences say
// "picture" or "video" (`KIND_WORDS`). Everything a card says whatever it is
// about is `artifacts.take.*`.

import type { I18nKey } from "$lib/i18n";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

/** The kinds a take makes: a picture card's takes, a video card's take. */
export type TakeKind = "image" | "video";

export type TakeStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type TakePhase = "submitted" | "starting" | "rendering" | "finishing";

/** What the shell reads of a take: the picture and the video take views both carry it. */
export type TakeLike = {
	id: string;
	status: TakeStatus;
	phase: TakePhase | null;
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
};

export type TakeCardState =
	| { kind: "waiting"; ahead: number | null }
	| { kind: "starting" }
	/** `finishing`: ComfyUI is done; the decode and the app's own work are left. */
	| { kind: "making"; finishing: boolean }
	| { kind: "failed"; unavailable: boolean; retryable: boolean }
	/** The explicit-picture filter kept the result back: it looked explicit, or (unchecked) the check could not run. */
	| { kind: "blocked"; unchecked: boolean }
	| { kind: "stopped" }
	| { kind: "ready" };

/** A take that has sat in its "starting" phase this long says the model is loading. */
const STARTING_SHOWN_AFTER_MS = 3_000;

export function isTakeActive(take: Pick<TakeLike, "status"> | null): boolean {
	return take?.status === "queued" || take?.status === "running";
}

/**
 * The take's state. `landed` says the result can be shown: a succeeded take
 * whose result cannot be read is a failure, never a box with nothing behind
 * it, and saying so is a state with a way out (Another).
 */
export function takeCardState(
	take: TakeLike,
	now: number,
	kind: TakeKind,
	landed = true,
): TakeCardState {
	switch (take.status) {
		case "queued":
			return { kind: "waiting", ahead: null };
		case "running": {
			// Submitted and never started: it waits its turn. A take that already
			// has an estimate is past that (a prompt posted again, a 10 s clip's
			// second segment), still on its way.
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
			return landed
				? { kind: "ready" }
				: { kind: "failed", unavailable: false, retryable: true };
		case "cancelled":
			return { kind: "stopped" };
		case "failed":
			if (take.errorCode === `${kind}_blocked`) {
				return { kind: "blocked", unchecked: false };
			}
			if (take.errorCode === `${kind}_unchecked`) {
				return { kind: "blocked", unchecked: true };
			}
			return {
				kind: "failed",
				// Every way of not reaching the kind's server, not only an unreachable one.
				unavailable:
					take.errorCode === `${kind}_server_unreachable` ||
					take.errorCode === `${kind}_server_not_configured`,
				retryable: take.retryable,
			};
	}
}

/** The sentences that name what the kind makes ("the picture", "the video"). */
const KIND_WORDS = {
	image: {
		making: "artifacts.image.card.making",
		starting: "artifacts.image.card.starting",
		startingDetail: "artifacts.image.card.startingDetail",
		unavailable: "artifacts.image.card.unavailable",
		blocked: "artifacts.image.card.blocked",
		blockedDetail: "artifacts.image.card.blockedDetail",
		unchecked: "artifacts.image.card.unchecked",
		uncheckedDetail: "artifacts.image.card.uncheckedDetail",
		goneDetail: "artifacts.image.card.goneDetail",
	},
	video: {
		making: "artifacts.video.card.making",
		starting: "artifacts.video.card.starting",
		startingDetail: "artifacts.video.card.startingDetail",
		unavailable: "artifacts.video.card.unavailable",
		blocked: "artifacts.video.card.blocked",
		blockedDetail: "artifacts.video.card.blockedDetail",
		unchecked: "artifacts.video.card.unchecked",
		uncheckedDetail: "artifacts.video.card.uncheckedDetail",
		goneDetail: "artifacts.video.card.goneDetail",
	},
} as const satisfies Record<TakeKind, Record<string, I18nKey>>;

/** What the card says in its box when its item is gone, or lives in another chat. */
export function goneWords(
	gone: "deleted" | "unreachable",
	kind: TakeKind,
	t: Translate,
): string {
	return gone === "unreachable"
		? t("artifacts.take.elsewhereDetail")
		: t(KIND_WORDS[kind].goneDetail);
}

/**
 * The card's one status line and its detail, in the reader's language. While
 * the take is being made the detail is the countdown, which the card keeps
 * (`takeTimeLine`): it is the card's own clock, not the state's.
 */
export function takeStateWords(
	state: TakeCardState,
	kind: TakeKind,
	t: Translate,
): { line: string; detail: string | null } {
	const words = KIND_WORDS[kind];
	switch (state.kind) {
		case "waiting":
			return { line: waitingLine(state.ahead, t), detail: null };
		case "starting":
			return { line: t(words.starting), detail: t(words.startingDetail) };
		case "making":
			return { line: t(words.making), detail: null };
		case "failed":
			return {
				line: state.unavailable
					? t(words.unavailable)
					: t("artifacts.take.failed"),
				detail: t("artifacts.take.nothingSaved"),
			};
		case "blocked":
			return state.unchecked
				? { line: t(words.unchecked), detail: t(words.uncheckedDetail) }
				: { line: t(words.blocked), detail: t(words.blockedDetail) };
		case "stopped":
			return { line: t("artifacts.take.stopped"), detail: null };
		case "ready":
			return { line: "", detail: null };
	}
}

/**
 * A waiting take's line: how many takes are ahead of it, or Next up when none
 * are (or none is counted yet: a take waiting in the app's own queue is there
 * for a moment before it reaches the server). Never "another picture is being
 * made": on a chat's first picture or right after Another that read as
 * something else being busy.
 */
export function waitingLine(ahead: number | null, t: Translate): string {
	return ahead !== null && ahead >= 1
		? t("artifacts.take.ahead", { count: ahead })
		: t("artifacts.take.nextUp");
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
			time.finishing ? "artifacts.take.almostDone" : "artifacts.take.longer",
		);
	}
	return time.seconds >= MINUTES_FROM_SECONDS
		? t("artifacts.take.etaMinutes", {
				count: Math.max(2, Math.round(time.seconds / 60)),
			})
		: t("artifacts.take.eta", { count: time.seconds });
}

/**
 * The words beside the kind in the card's head while its take is on its way:
 * its place in the queue while it waits, then the countdown. Null when the
 * take is not on its way, or has no estimate yet.
 */
export function takeTimeLine(
	state: TakeCardState,
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
