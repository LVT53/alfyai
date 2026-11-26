// @vitest-environment jsdom
import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import artifactsDict from "$lib/i18n/artifacts";
import { uiLanguage } from "$lib/stores/settings";
import {
	createEtaCountdown,
	ETA_RAISE_TOLERANCE_MS,
	elapsedClock,
	goneWords,
	isTakeActive,
	type TakeKind,
	type TakeLike,
	takeCardState,
	takeStateWords,
	takeTime,
	takeTimeLine,
	takeTimeWords,
	waitingLine,
} from "./take-card-view";

let n = 0;
function take(over: Partial<TakeLike> = {}): TakeLike {
	n += 1;
	return {
		id: `take-${n}`,
		status: "succeeded",
		phase: null,
		phaseAt: null,
		queueAhead: null,
		etaSeconds: null,
		errorCode: null,
		retryable: false,
		...over,
	};
}

afterEach(() => uiLanguage.set("en"));

const KINDS: readonly TakeKind[] = ["image", "video"];

describe("takeCardState, one rule for a picture's take and a clip's", () => {
	it.each(KINDS)("%s: queued is waiting with nobody counted", (kind) => {
		expect(takeCardState(take({ status: "queued" }), 0, kind)).toEqual({
			kind: "waiting",
			ahead: null,
		});
	});

	it.each(KINDS)("%s: submitted counts those ahead", (kind) => {
		expect(
			takeCardState(
				take({ status: "running", phase: "submitted", queueAhead: 2 }),
				0,
				kind,
			),
		).toEqual({ kind: "waiting", ahead: 2 });
	});

	it.each(KINDS)(
		"%s: starting is making for 2 s and starting from 3 s",
		(kind) => {
			const s = take({ status: "running", phase: "starting", phaseAt: 10_000 });
			expect(takeCardState(s, 12_000, kind).kind).toBe("making");
			expect(takeCardState(s, 13_000, kind)).toEqual({ kind: "starting" });
		},
	);

	it.each(KINDS)(
		"%s: rendering is making, and finishing is its last step",
		(kind) => {
			expect(
				takeCardState(
					take({ status: "running", phase: "rendering", etaSeconds: 8 }),
					0,
					kind,
				),
			).toEqual({ kind: "making", finishing: false });
			expect(
				takeCardState(
					take({ status: "running", phase: "finishing", etaSeconds: 1 }),
					0,
					kind,
				),
			).toEqual({ kind: "making", finishing: true });
		},
	);

	it.each(KINDS)(
		"%s: a take with an estimate is on its way, not waiting (posted again, or a clip's second segment)",
		(kind) => {
			expect(
				takeCardState(
					take({ status: "running", phase: "submitted", etaSeconds: 30 }),
					0,
					kind,
				),
			).toEqual({ kind: "making", finishing: false });
		},
	);

	it.each(KINDS)("%s: succeeded is ready and cancelled is stopped", (kind) => {
		expect(takeCardState(take(), 0, kind)).toEqual({ kind: "ready" });
		expect(takeCardState(take({ status: "cancelled" }), 0, kind)).toEqual({
			kind: "stopped",
		});
	});

	it.each(KINDS)(
		"%s: a succeeded take whose result cannot be read is a failure, never an empty box",
		(kind) => {
			expect(takeCardState(take(), 0, kind, false)).toEqual({
				kind: "failed",
				unavailable: false,
				retryable: true,
				errorCode: null,
			});
		},
	);

	it.each(KINDS)(
		"%s: every way of not reaching its server is 'unavailable'",
		(kind) => {
			for (const errorCode of [
				`${kind}_server_unreachable`,
				`${kind}_server_not_configured`,
			]) {
				expect(
					takeCardState(
						take({ status: "failed", errorCode, retryable: true }),
						0,
						kind,
					),
				).toEqual({
					kind: "failed",
					unavailable: true,
					retryable: true,
					errorCode,
				});
			}
			expect(
				takeCardState(
					take({ status: "failed", errorCode: `${kind}_render_failed` }),
					0,
					kind,
				),
			).toEqual({
				kind: "failed",
				unavailable: false,
				retryable: false,
				errorCode: `${kind}_render_failed`,
			});
		},
	);

	it.each(KINDS)(
		"%s: a result the explicit-picture filter kept back is blocked, never a failure",
		(kind) => {
			expect(
				takeCardState(
					take({ status: "failed", errorCode: `${kind}_blocked` }),
					0,
					kind,
				),
			).toEqual({ kind: "blocked", unchecked: false });
			expect(
				takeCardState(
					take({
						status: "failed",
						errorCode: `${kind}_unchecked`,
						retryable: true,
					}),
					0,
					kind,
				),
			).toEqual({ kind: "blocked", unchecked: true });
		},
	);

	it("reads only its own kind's codes", () => {
		expect(
			takeCardState(
				take({ status: "failed", errorCode: "video_blocked" }),
				0,
				"image",
			).kind,
		).toBe("failed");
		expect(
			takeCardState(
				take({ status: "failed", errorCode: "image_server_unreachable" }),
				0,
				"video",
			),
		).toMatchObject({ kind: "failed", unavailable: false });
	});
});

describe("takeStateWords", () => {
	it("says Next up for a take waiting to start, whatever it makes", () => {
		for (const kind of KINDS) {
			expect(
				takeStateWords({ kind: "waiting", ahead: null }, kind, get(t)),
			).toEqual({ line: "Next up", detail: null });
		}
	});

	it("says what is being made, and leaves the time to the countdown", () => {
		// Never a clock counting up: the time is the head's countdown.
		expect(
			takeStateWords({ kind: "making", finishing: false }, "image", get(t)),
		).toEqual({ line: "Making the picture…", detail: null });
		expect(
			takeStateWords({ kind: "making", finishing: false }, "video", get(t)),
		).toEqual({ line: "Making the video…", detail: null });
	});

	it("words failure, blocked and stopped in the kind's own words where they differ", () => {
		const translate = get(t);
		expect(
			takeStateWords(
				{
					kind: "failed",
					unavailable: true,
					retryable: true,
					errorCode: "video_server_unreachable",
				},
				"video",
				translate,
			),
		).toEqual({
			line: "Videos can't be made right now.",
			detail: "Nothing was saved.",
		});
		// A failure with no code (a result that cannot be read) keeps the card's own line.
		expect(
			takeStateWords(
				{
					kind: "failed",
					unavailable: false,
					retryable: true,
					errorCode: null,
				},
				"image",
				translate,
			),
		).toEqual({
			line: "Couldn't make this one.",
			detail: "Nothing was saved.",
		});
		expect(
			takeStateWords({ kind: "blocked", unchecked: false }, "video", translate)
				.line,
		).toBe("This video was blocked.");
		expect(
			takeStateWords({ kind: "blocked", unchecked: true }, "image", translate)
				.line,
		).toBe("This picture couldn't be checked.");
		expect(takeStateWords({ kind: "stopped" }, "video", translate).line).toBe(
			"Stopped.",
		);
		expect(takeStateWords({ kind: "starting" }, "image", translate)).toEqual({
			line: "Starting the picture maker…",
			detail: artifactsDict.en["artifacts.image.card.startingDetail"],
		});
	});

	// A failed take's card says its code's own sentence, the one its tool row says
	// (the registry), for a picture and a clip alike, and never the model's words.
	it("a failed take's card gives its code's sentence", () => {
		const translate = get(t);
		const failed = (errorCode: string | null) =>
			({
				kind: "failed",
				unavailable: false,
				retryable: true,
				errorCode,
			}) as const;
		expect(
			takeStateWords(failed("image_render_timeout"), "image", translate),
		).toEqual({
			line: "The picture took too long to render.",
			detail: "Nothing was saved.",
		});
		expect(
			takeStateWords(failed("video_render_failed"), "video", translate),
		).toEqual({
			line: "The video server couldn't make the clip.",
			detail: "Nothing was saved.",
		});
		expect(
			takeStateWords(failed("video_render_timeout"), "video", translate).line,
		).toBe("The clip took too long to make.");
		// Every code a take can end with has a sentence of its own, never a code.
		for (const code of [
			"image_graph_rejected",
			"image_result_missing",
			"image_input_missing",
			"image_worker_lost",
			"image_error",
		]) {
			const line = takeStateWords(failed(code), "image", translate).line;
			expect(line, code).not.toContain("image_");
			expect(line, code).not.toBe("Couldn't make this one.");
		}
		for (const code of [
			"video_graph_rejected",
			"video_result_missing",
			"video_item_deleted",
			"video_media_failed",
			"video_artifact_failed",
			"video_take_missing",
			"video_error",
		]) {
			const line = takeStateWords(failed(code), "video", translate).line;
			expect(line, code).not.toContain("video_");
			expect(line, code).not.toBe("Couldn't make this one.");
		}
		// A code this version does not know reads as the kind's fallback, never as the code.
		expect(
			takeStateWords(failed("a_newer_code"), "video", translate).line,
		).toBe("The video couldn't be made.");
		expect(
			takeStateWords(failed("a_newer_code"), "image", translate).line,
		).toBe("The picture could not be made.");
	});

	it("speaks Hungarian", () => {
		uiLanguage.set("hu");
		expect(
			takeStateWords(
				{
					kind: "failed",
					unavailable: false,
					retryable: true,
					errorCode: "video_render_timeout",
				},
				"video",
				get(t),
			).line,
		).toBe("A klip túl sokáig készült.");
		expect(
			takeStateWords(
				{
					kind: "failed",
					unavailable: false,
					retryable: true,
					errorCode: "image_render_timeout",
				},
				"image",
				get(t),
			).line,
		).toBe("A kép túl sokáig készült.");
		expect(
			takeStateWords({ kind: "making", finishing: false }, "video", get(t))
				.line,
		).toBe("Készül a videó…");
		expect(takeStateWords({ kind: "stopped" }, "image", get(t)).line).toBe(
			"Leállítva.",
		);
	});
});

describe("goneWords", () => {
	it("says the kind is no longer kept, or where it opens", () => {
		expect(goneWords("deleted", "image", get(t))).toBe(
			"The picture is no longer kept.",
		);
		expect(goneWords("deleted", "video", get(t))).toBe(
			"The video is no longer kept.",
		);
		expect(goneWords("unreachable", "video", get(t))).toBe(
			"Open it from the chat it was made in.",
		);
		uiLanguage.set("hu");
		expect(goneWords("unreachable", "image", get(t))).toBe(
			"Abban a beszélgetésben nyitható meg, ahol készült.",
		);
	});
});

describe("isTakeActive", () => {
	it("knows a take that is still on its way", () => {
		expect(isTakeActive(take({ status: "queued" }))).toBe(true);
		expect(isTakeActive(take({ status: "running" }))).toBe(true);
		expect(isTakeActive(take())).toBe(false);
		expect(isTakeActive(null)).toBe(false);
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
	it("counts the takes ahead, and says Next up when none are (never 'another picture')", () => {
		expect(waitingLine(2, get(t))).toBe("2 ahead of this one");
		expect(waitingLine(0, get(t))).toBe("Next up");
		expect(waitingLine(null, get(t))).toBe("Next up");
		uiLanguage.set("hu");
		expect(waitingLine(2, get(t))).toBe("2 van előtte");
		expect(waitingLine(null, get(t))).toBe("Következik");
	});
});

describe("the take card's dictionary", () => {
	it("has every shared word in both languages, and never says Artifact", () => {
		const keys = Object.keys(artifactsDict.en).filter((key) =>
			key.startsWith("artifacts.take."),
		) as Array<keyof typeof artifactsDict.en>;
		expect(keys.length).toBeGreaterThan(10);
		for (const key of keys) {
			expect(artifactsDict.en[key], `${key} (en)`).toBeTruthy();
			expect(artifactsDict.hu[key], `${key} (hu)`).toBeTruthy();
			expect(artifactsDict.en[key], `${key} (en)`).not.toMatch(/artifact/i);
			expect(artifactsDict.hu[key], `${key} (hu)`).not.toMatch(/artifact/i);
		}
	});
});
