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
	etaLabel,
	hasActiveImageTakes,
	isCheckingAgain,
	shownTake,
	takeState,
	visibleTakes,
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
		sourceFileIds: [],
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
	it("rendering carries the eta", () => {
		expect(
			takeState(
				take({
					status: "running",
					phase: "rendering",
					etaSeconds: 8,
					progressPercent: 40,
				}),
				0,
			),
		).toEqual({ kind: "making", etaSeconds: 8, progressPercent: 40 });
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

describe("etaLabel", () => {
	it("rounds up and is null for nothing", () => {
		expect(etaLabel(7.2, get(t))).toBe("About 8 s left");
		uiLanguage.set("hu");
		expect(etaLabel(7.2, get(t))).toBe("Még kb. 8 mp");
		expect(etaLabel(null, get(t))).toBeNull();
		expect(etaLabel(0, get(t))).toBeNull();
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
