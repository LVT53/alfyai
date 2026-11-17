import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import type {
	ImageCardView,
	ImageTakeView,
} from "$lib/server/services/images/read-model";
import { uiLanguage } from "$lib/stores/settings";
import {
	canCompareBeforeAfter,
	cardSubtitle,
	createEtaCountdown,
	ETA_RAISE_TOLERANCE_MS,
	elapsedClock,
	hasActiveImageTakes,
	isCheckingAgain,
	shownTake,
	takeState,
	takeTime,
	takeTimeLine,
	takeTimeWords,
	visibleTakes,
	waitingLine,
} from "./image-card-view";

let n = 0;
function take(over: Partial<ImageTakeView> = {}): ImageTakeView {
	n += 1;
	return {
		id: `take-${n}`,
		status: "succeeded",
		phase: null,
		phaseAt: null,
		queueAhead: null,
		progressPercent: null,
		etaSeconds: null,
		canvas: { width: 1248, height: 832 },
		box: { width: 1248, height: 832 },
		origin: "turn",
		retryOf: null,
		held: false,
		fileId: `file-${n}`,
		width: 1248,
		height: 832,
		hasAlpha: false,
		baseFileId: null,
		sourceFileIdsInPromptOrder: [],
		retried: false,
		errorCode: null,
		retryable: false,
		versionNumber: null,
		toolCallId: null,
		createdAt: n,
		...over,
	};
}

function card(
	takes: ImageTakeView[],
	over: Partial<ImageCardView> = {},
): ImageCardView {
	return {
		id: "card-1",
		conversationId: "c1",
		turnId: "t1",
		artifactId: null,
		title: "Cosy room",
		madeFrom: "words",
		sourceCount: 0,
		pickedTakeId: null,
		takes,
		...over,
	};
}

afterEach(() => uiLanguage.set("en"));

describe("takeState", () => {
	it("queued is waiting with nobody counted", () => {
		expect(takeState(take({ status: "queued" }), 0)).toEqual({
			kind: "waiting",
			ahead: null,
		});
	});
	it("submitted counts those ahead", () => {
		expect(
			takeState(
				take({ status: "running", phase: "submitted", queueAhead: 2 }),
				0,
			),
		).toEqual({ kind: "waiting", ahead: 2 });
	});
	it("starting is making for 2 s and starting from 3 s", () => {
		const s = take({ status: "running", phase: "starting", phaseAt: 10_000 });
		expect(takeState(s, 12_000).kind).toBe("making");
		expect(takeState(s, 13_000)).toEqual({ kind: "starting" });
	});
	it("rendering is making, and finishing is its last step", () => {
		expect(
			takeState(
				take({ status: "running", phase: "rendering", etaSeconds: 8 }),
				0,
			),
		).toEqual({ kind: "making", finishing: false });
		expect(
			takeState(
				take({ status: "running", phase: "finishing", etaSeconds: 1 }),
				0,
			),
		).toEqual({ kind: "making", finishing: true });
	});
	it("a take posted again after it started is still on its way, not waiting", () => {
		expect(
			takeState(
				take({ status: "running", phase: "submitted", etaSeconds: 30 }),
				0,
			),
		).toEqual({ kind: "making", finishing: false });
	});
	it("succeeded is ready and cancelled is stopped", () => {
		expect(takeState(take(), 0)).toEqual({ kind: "ready" });
		expect(takeState(take({ status: "cancelled" }), 0)).toEqual({
			kind: "stopped",
		});
	});
	it("failed separates every cannot-reach code from a failed render", () => {
		for (const errorCode of [
			"image_server_unreachable",
			"image_server_not_configured",
		]) {
			expect(
				takeState(take({ status: "failed", errorCode, retryable: true }), 0),
			).toEqual({ kind: "failed", unavailable: true, retryable: true });
		}
		expect(
			takeState(
				take({ status: "failed", errorCode: "image_render_failed" }),
				0,
			),
		).toEqual({ kind: "failed", unavailable: false, retryable: false });
	});
});

describe("takeState for a picture the explicit-picture filter stopped", () => {
	it("is blocked, never a failure to make it", () => {
		expect(
			takeState(
				take({ status: "failed", errorCode: "image_blocked", fileId: null }),
				0,
			),
		).toEqual({ kind: "blocked", unchecked: false });
	});
	it("is blocked as unchecked when the check could not run", () => {
		expect(
			takeState(
				take({
					status: "failed",
					errorCode: "image_unchecked",
					fileId: null,
					retryable: true,
				}),
				0,
			),
		).toEqual({ kind: "blocked", unchecked: true });
	});
});

describe("visibleTakes and shownTake", () => {
	it("folds a held automatic retry into its first take's slot", () => {
		const first = take();
		const retry = take({
			origin: "auto_retry",
			retryOf: first.id,
			held: true,
			status: "running",
		});
		const c = card([first, retry]);
		expect(visibleTakes(c)).toEqual([first]);
		expect(shownTake(c, null)).toBe(first);
	});
	it("shows one take once an automatic retry is released (winner or loser)", () => {
		const first = take();
		const winner = take({ origin: "auto_retry", retryOf: first.id });
		// Loser hidden by the server: the first stays alone.
		expect(visibleTakes(card([first]))).toEqual([first]);
		// Winner: the first is hidden by the server, the retry shows.
		expect(visibleTakes(card([winner]))).toEqual([winner]);
	});
	it("shows a model retry that is running as being made", () => {
		const first = take();
		const retry = take({
			origin: "retry",
			retryOf: first.id,
			status: "running",
			phase: "rendering",
		});
		const c = card([first, retry]);
		expect(visibleTakes(c)).toEqual([first, retry]);
		expect(shownTake(c, null)).toBe(retry);
	});
	it("shows a model retry that failed, with its failure", () => {
		const first = take();
		const retry = take({
			origin: "retry",
			retryOf: first.id,
			status: "failed",
			errorCode: "image_render_failed",
			retryable: true,
		});
		const c = card([first, retry]);
		expect(visibleTakes(c)).toContain(retry);
		expect(takeState(retry, 0)).toEqual({
			kind: "failed",
			unavailable: false,
			retryable: true,
		});
	});
	it("offers a model retry that landed late as a take", () => {
		const first = take();
		const late = take({ origin: "retry", retryOf: first.id });
		const c = card([first, late], { pickedTakeId: first.id });
		expect(visibleTakes(c)).toEqual([first, late]);
		expect(shownTake(c, late.id)).toBe(late);
	});
	it("shows the new take when a model retry of the pick replaced it", () => {
		const replacement = take({ origin: "retry", retryOf: "hidden-old" });
		const c = card([replacement], { pickedTakeId: replacement.id });
		expect(shownTake(c, null)).toBe(replacement);
	});
	it("treats starting with no phase time as making", () => {
		expect(
			takeState(
				take({ status: "running", phase: "starting", phaseAt: null }),
				99_000,
			).kind,
		).toBe("making");
	});
	it("does not count zero ahead", () => {
		expect(
			takeState(
				take({ status: "running", phase: "submitted", queueAhead: 0 }),
				0,
			),
		).toEqual({ kind: "waiting", ahead: null });
	});
	it("prefers selected, then the pick, then the newest being made, then the newest", () => {
		const a = take();
		const b = take();
		const c = take({ status: "running", phase: "rendering" });
		const d = take();
		expect(shownTake(card([a, b, c, d], { pickedTakeId: b.id }), a.id)).toBe(a);
		expect(shownTake(card([a, b, c, d], { pickedTakeId: b.id }), "x")).toBe(b);
		expect(shownTake(card([a, b, c, d]), null)).toBe(c);
		expect(shownTake(card([a, b, d]), null)).toBe(d);
		expect(shownTake(card([]), null)).toBeNull();
	});
});

describe("cardSubtitle", () => {
	it("reads in English and Hungarian", () => {
		const two = [take(), take()];
		const cases: [ImageCardView, string, string][] = [
			[
				card([take()], { madeFrom: "photo" }),
				"Image · from your photo",
				"Kép · a fotódból",
			],
			[
				card([take()], { madeFrom: "pictures", sourceCount: 3 }),
				"Image · from 3 pictures",
				"Kép · 3 képből",
			],
			[card(two), "Image · 2 takes", "Kép · 2 változat"],
			[card([take()]), "Image", "Kép"],
			[
				card(two, { madeFrom: "change" }),
				"Image · 2 takes",
				"Kép · 2 változat",
			],
			[card([take()], { madeFrom: "change" }), "Image", "Kép"],
		];
		for (const [c, en, hu] of cases) {
			uiLanguage.set("en");
			expect(cardSubtitle(c, get(t))).toBe(en);
			uiLanguage.set("hu");
			expect(cardSubtitle(c, get(t))).toBe(hu);
		}
	});
	it("counts a folded retry once", () => {
		const first = take();
		const c = card([
			first,
			take({ origin: "auto_retry", retryOf: first.id, held: true }),
		]);
		expect(cardSubtitle(c, get(t))).toBe("Image");
	});
});

describe("the countdown", () => {
	const T0 = 5_000_000;
	/** The words the head shows for a take being made, at `now`. */
	const words = (deadline: number | null, now: number, finishing = false) =>
		takeTimeWords(takeTime(deadline, finishing, now), get(t));

	it("counts down one second a second between polls, from one reading", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 24, T0);
		const shown = [0, 1_000, 2_000, 3_000, 10_000].map((after) =>
			words(countdown.at(T0 + after), T0 + after),
		);
		expect(shown).toEqual([
			"About 24 s left",
			"About 23 s left",
			"About 22 s left",
			"About 21 s left",
			"About 14 s left",
		]);
	});

	it("does not climb back when a poll's answer is a little late", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 24, T0);
		// The next poll says 23.6 s at T0 + 750 ms: 350 ms later than the
		// countdown, the network's delay, not the take's.
		countdown.read("take-a", 23.6, T0 + 750);
		expect(countdown.at(T0 + 750)).toBe(T0 + 24_000);
		expect(words(countdown.at(T0 + 1_000), T0 + 1_000)).toBe("About 23 s left");
	});

	it("never moves later for a slow take: it runs past its time, then says so", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 5, T0);
		// The server holds its finish time: each poll says less is left.
		countdown.read("take-a", 2, T0 + 3_000);
		countdown.read("take-a", 0, T0 + 6_000);
		countdown.read("take-a", 0, T0 + 9_000);
		const at = countdown.at(T0 + 9_000);
		expect(at).toBe(T0 + 5_000);
		expect(words(at, T0 + 9_000)).toBe("Taking a little longer…");
		expect(words(at, T0 + 9_000, true)).toBe("Almost done…");
		// Never a number below zero, however long it runs over.
		expect(words(at, T0 + 600_000)).toBe("Taking a little longer…");
	});

	it("eases a faster take in at no more than one extra second a second", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 30, T0);
		countdown.at(T0);
		// The plan was pessimistic: at 2 s the sampler says 20 s are left.
		countdown.read("take-a", 20, T0 + 2_000);
		const left = (now: number) => ((countdown.at(now) ?? 0) - now) / 1000;
		const seconds = [2_000, 3_000, 4_000, 5_000].map((after) =>
			Math.round(left(T0 + after)),
		);
		// Two seconds a second, never a jump down to 20.
		expect(seconds).toEqual([26, 24, 22, 20]);
		// It meets the new time at 8 s, then counts one a second again.
		expect(left(T0 + 8_000)).toBeCloseTo(14, 1);
		expect(left(T0 + 10_000)).toBeCloseTo(12, 1);
	});

	it("shows more time only when the server starts over", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 4, T0);
		countdown.read(
			"take-a",
			4 + (ETA_RAISE_TOLERANCE_MS + 25_000) / 1000,
			T0 + 1_000,
		);
		expect(words(countdown.at(T0 + 1_000), T0 + 1_000)).toBe("About 34 s left");
	});

	it("starts afresh for another take, and has nothing without an estimate", () => {
		const countdown = createEtaCountdown();
		countdown.read("take-a", 4, T0);
		countdown.read("take-b", 40, T0 + 1_000);
		expect(words(countdown.at(T0 + 1_000), T0 + 1_000)).toBe("About 40 s left");
		countdown.read("take-b", null, T0 + 2_000);
		expect(countdown.at(T0 + 2_000)).toBeNull();
		expect(words(null, T0 + 2_000)).toBeNull();
	});

	it("speaks in minutes from 100 s, in English and Hungarian", () => {
		expect(words(T0 + 99_000, T0)).toBe("About 99 s left");
		expect(words(T0 + 100_000, T0)).toBe("About 2 min left");
		expect(words(T0 + 200_000, T0)).toBe("About 3 min left");
		uiLanguage.set("hu");
		expect(words(T0 + 24_000, T0)).toBe("Még kb. 24 mp");
		expect(words(T0 + 200_000, T0)).toBe("Még kb. 3 perc");
		expect(words(T0, T0 + 1_000, true)).toBe("Mindjárt kész…");
		expect(words(T0, T0 + 1_000)).toBe("Kicsit tovább tart…");
	});
});

describe("takeTimeLine", () => {
	it("is the place in the queue while waiting, then the countdown, then nothing", () => {
		const now = 1_000;
		expect(takeTimeLine({ kind: "waiting", ahead: 2 }, null, now, get(t))).toBe(
			"2 ahead of this one",
		);
		expect(
			takeTimeLine({ kind: "waiting", ahead: null }, null, now, get(t)),
		).toBe("Next up");
		expect(takeTimeLine({ kind: "starting" }, 25_000, now, get(t))).toBe(
			"About 24 s left",
		);
		expect(
			takeTimeLine({ kind: "making", finishing: true }, 500, now, get(t)),
		).toBe("Almost done…");
		expect(
			takeTimeLine({ kind: "making", finishing: false }, null, now, get(t)),
		).toBeNull();
		expect(takeTimeLine({ kind: "ready" }, 25_000, now, get(t))).toBeNull();
	});
});

describe("elapsedClock", () => {
	it("is m:ss, and h:mm:ss once an hour has gone", () => {
		expect(elapsedClock(0)).toBe("0:00");
		expect(elapsedClock(7_000)).toBe("0:07");
		expect(elapsedClock(7_999)).toBe("0:07");
		expect(elapsedClock(59_999)).toBe("0:59");
		expect(elapsedClock(60_000)).toBe("1:00");
		expect(elapsedClock(3_599_000)).toBe("59:59");
		expect(elapsedClock(3_600_000)).toBe("1:00:00");
		expect(elapsedClock(3_661_000)).toBe("1:01:01");
	});
	it("never counts below zero", () => {
		expect(elapsedClock(-2_000)).toBe("0:00");
	});
});

describe("waitingLine", () => {
	it("counts the pictures ahead, and says Next up when none are (never 'another picture')", () => {
		expect(waitingLine(2, get(t))).toBe("2 ahead of this one");
		expect(waitingLine(0, get(t))).toBe("Next up");
		expect(waitingLine(null, get(t))).toBe("Next up");
		uiLanguage.set("hu");
		expect(waitingLine(2, get(t))).toBe("2 van előtte");
		expect(waitingLine(null, get(t))).toBe("Következik");
	});
});

describe("canCompareBeforeAfter and hasActiveImageTakes", () => {
	it("needs both a file and a base", () => {
		expect(canCompareBeforeAfter(take({ baseFileId: "b" }))).toBe(true);
		expect(canCompareBeforeAfter(take())).toBe(false);
		expect(canCompareBeforeAfter(take({ baseFileId: "b", fileId: null }))).toBe(
			false,
		);
		expect(canCompareBeforeAfter(null)).toBe(false);
	});
	it("is true while any take is queued or running", () => {
		expect(hasActiveImageTakes([card([take()])])).toBe(false);
		expect(
			hasActiveImageTakes([card([take(), take({ status: "queued" })])]),
		).toBe(true);
		expect(hasActiveImageTakes([card([take({ status: "running" })])])).toBe(
			true,
		);
		expect(hasActiveImageTakes([])).toBe(false);
	});
});

describe("isCheckingAgain", () => {
	it("is true while the server's held automatic retry of the shown take runs", () => {
		const first = take();
		const retry = take({
			origin: "auto_retry",
			held: true,
			retryOf: first.id,
			status: "running",
			fileId: null,
		});
		expect(isCheckingAgain(card([first, retry]), first)).toBe(true);
		expect(
			isCheckingAgain(card([first, { ...retry, status: "succeeded" }]), first),
		).toBe(true);
		expect(
			isCheckingAgain(card([first, { ...retry, held: false }]), first),
		).toBe(false);
		expect(
			isCheckingAgain(card([first, { ...retry, origin: "retry" }]), first),
		).toBe(false);
		expect(
			isCheckingAgain(card([first, { ...retry, status: "failed" }]), first),
		).toBe(false);
		expect(isCheckingAgain(card([first]), first)).toBe(false);
		expect(isCheckingAgain(card([first]), null)).toBe(false);
	});
});
