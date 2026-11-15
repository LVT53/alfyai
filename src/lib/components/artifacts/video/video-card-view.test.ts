import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import artifactsDict from "$lib/i18n/artifacts";
import { uiLanguage } from "$lib/stores/settings";
import {
	videoCard as card,
	videoTake as take,
} from "./video-card-fixtures.test-helpers";
import {
	isVideoTakeActive,
	videoCardSubtitle,
	videoDurationLabel,
	videoFileUrl,
	videoStateWords,
	videoTakeState,
} from "./video-card-view";

const NOW = 100_000;

function making(over: Partial<ReturnType<typeof take>> = {}) {
	return take({
		status: "running",
		phase: "rendering",
		phaseAt: NOW - 2_000,
		clip: null,
		...over,
	});
}

describe("videoTakeState", () => {
	it("maps every status the way the picture card's own take state does", () => {
		expect(videoTakeState(null, NOW)).toEqual({
			kind: "waiting",
			ahead: null,
		});
		expect(videoTakeState(take({ status: "queued", clip: null }), NOW)).toEqual(
			{ kind: "waiting", ahead: null },
		);
		expect(
			videoTakeState(
				take({
					status: "running",
					phase: "submitted",
					clip: null,
					queueAhead: 2,
				}),
				NOW,
			),
		).toEqual({ kind: "waiting", ahead: 2 });
		expect(
			videoTakeState(take({ status: "cancelled", clip: null }), NOW),
		).toEqual({ kind: "stopped" });
		expect(videoTakeState(take(), NOW)).toEqual({ kind: "ready" });
	});

	it("says 'starting up' only after the phase has been quiet for a while", () => {
		const justStarted = take({
			status: "running",
			phase: "starting",
			phaseAt: NOW - 500,
			clip: null,
		});
		expect(videoTakeState(justStarted, NOW)).toMatchObject({ kind: "making" });
		const loading = take({
			status: "running",
			phase: "starting",
			phaseAt: NOW - 4_000,
			clip: null,
		});
		expect(videoTakeState(loading, NOW)).toEqual({ kind: "starting" });
	});

	it("carries the estimate and the phase clock while making", () => {
		const running = making({ etaSeconds: 8 });
		expect(videoTakeState(running, NOW)).toEqual({
			kind: "making",
			etaSeconds: 8,
			phaseAt: NOW - 2_000,
			createdAt: running.createdAt,
		});
	});

	it("is ready only when its clip can actually be played", () => {
		expect(videoTakeState(take({ clip: null }), NOW)).toEqual({
			kind: "failed",
			unavailable: false,
			retryable: true,
		});
	});

	it("treats a filtered back clip as blocked, not failed", () => {
		expect(
			videoTakeState(
				take({ status: "failed", clip: null, errorCode: "video_blocked" }),
				NOW,
			),
		).toEqual({ kind: "blocked", unchecked: false });
		expect(
			videoTakeState(
				take({ status: "failed", clip: null, errorCode: "video_unchecked" }),
				NOW,
			),
		).toEqual({ kind: "blocked", unchecked: true });
	});

	it("covers every way of not reaching the video server", () => {
		for (const errorCode of [
			"video_server_unreachable",
			"video_server_not_configured",
		]) {
			expect(
				videoTakeState(take({ status: "failed", clip: null, errorCode }), NOW),
			).toEqual({ kind: "failed", unavailable: true, retryable: false });
		}
	});
});

describe("videoStateWords", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("says Next up for a video waiting to start", () => {
		expect(
			videoStateWords({ kind: "waiting", ahead: null }, NOW, get(t)),
		).toEqual({ line: "Next up", detail: null });
	});

	it("puts the estimate, then the phase clock, beside the making line", () => {
		const words = videoStateWords(
			videoTakeState(making({ etaSeconds: 8 }), NOW),
			NOW,
			get(t),
		);
		expect(words.line).toBe("Making the video…");
		expect(words.detail).toBe("About 8 s left");
		const clocked = videoStateWords(
			videoTakeState(making({ phaseAt: NOW - 7_000 }), NOW),
			NOW,
			get(t),
		);
		expect(clocked.detail).toBe("0:07");
	});

	it("words failure, blocked and stopped with video words", () => {
		const translate = get(t);
		expect(
			videoStateWords(
				{ kind: "failed", unavailable: true, retryable: true },
				NOW,
				translate,
			),
		).toEqual({
			line: "Videos can't be made right now.",
			detail: "Nothing was saved.",
		});
		expect(
			videoStateWords({ kind: "blocked", unchecked: false }, NOW, translate)
				.line,
		).toBe("This video was blocked.");
		expect(
			videoStateWords({ kind: "blocked", unchecked: true }, NOW, translate)
				.line,
		).toBe("This video couldn't be checked.");
		expect(videoStateWords({ kind: "stopped" }, NOW, translate).line).toBe(
			"Stopped.",
		);
	});

	it("speaks Hungarian", () => {
		uiLanguage.set("hu");
		const words = videoStateWords(
			videoTakeState(making({ etaSeconds: 8 }), NOW),
			NOW,
			get(t),
		);
		expect(words.line).toBe("Készül a videó…");
		expect(words.detail).toBe("Még kb. 8 mp");
		expect(videoStateWords({ kind: "stopped" }, NOW, get(t)).line).toBe(
			"Leállítva.",
		);
	});
});

describe("videoDurationLabel", () => {
	it("prints the clip's length as m:ss", () => {
		expect(videoDurationLabel(5_000)).toBe("0:05");
		expect(videoDurationLabel(10_000)).toBe("0:10");
		expect(videoDurationLabel(65_000)).toBe("1:05");
	});
});

describe("videoFileUrl", () => {
	it("asks the serving route for the clip, its poster and its download", () => {
		expect(videoFileUrl("file-1", { conversationId: "conv-1" })).toBe(
			"/api/images/files/file-1?conversationId=conv-1",
		);
		expect(
			videoFileUrl("file-1", { variant: "poster", conversationId: "conv-1" }),
		).toBe("/api/images/files/file-1?variant=poster&conversationId=conv-1");
		expect(videoFileUrl("file-1", { download: true })).toBe(
			"/api/images/files/file-1?download=1",
		);
		expect(videoFileUrl("a/b", {})).toBe("/api/images/files/a%2Fb");
	});

	it("asks for the GIF by name, and leaves the mp4 URL exactly as it was", () => {
		expect(
			videoFileUrl("file-1", {
				download: true,
				format: "gif",
				conversationId: "conv-1",
			}),
		).toBe(
			"/api/images/files/file-1?download=1&format=gif&conversationId=conv-1",
		);
		expect(videoFileUrl("file-1", { download: true, format: "mp4" })).toBe(
			"/api/images/files/file-1?download=1",
		);
	});
});

describe("the card's own helpers", () => {
	it("names the kind, never the engineering word", () => {
		expect(videoCardSubtitle(card(), get(t))).toBe("Video");
		uiLanguage.set("hu");
		expect(videoCardSubtitle(card(), get(t))).toBe("Videó");
		uiLanguage.set("en");
	});

	it("knows a take that is still on its way", () => {
		expect(isVideoTakeActive(take({ status: "queued" }))).toBe(true);
		expect(isVideoTakeActive(take({ status: "running" }))).toBe(true);
		expect(isVideoTakeActive(take())).toBe(false);
		expect(isVideoTakeActive(null)).toBe(false);
	});
});

describe("the video dictionary", () => {
	const KEYS = [
		"artifacts.video.badge",
		"artifacts.video.card.making",
		"artifacts.video.card.starting",
		"artifacts.video.card.startingDetail",
		"artifacts.video.card.failed",
		"artifacts.video.card.nothingSaved",
		"artifacts.video.card.unavailable",
		"artifacts.video.card.blocked",
		"artifacts.video.card.blockedDetail",
		"artifacts.video.card.unchecked",
		"artifacts.video.card.uncheckedDetail",
		"artifacts.video.card.stopped",
		"artifacts.video.card.stop",
		"artifacts.video.card.tryAgain",
		"artifacts.video.card.another",
		"artifacts.video.card.download",
		"artifacts.video.card.downloadGif",
		"artifacts.video.panel.downloadMp4",
		"artifacts.video.panel.downloadTitle",
		"artifacts.video.card.more",
		"artifacts.video.card.history",
		"artifacts.video.card.historyUnavailable",
		"artifacts.video.card.lengthA11y",
		"artifacts.video.card.goneDetail",
		"artifacts.video.card.elsewhereDetail",
		"artifacts.video.panel.loading",
		"artifacts.video.panel.loadFailed",
		"artifacts.video.player.label",
		"artifacts.video.player.play",
		"artifacts.video.player.pause",
		"artifacts.video.player.fullscreen",
		"artifacts.video.player.exitFullscreen",
		"artifacts.video.player.position",
		"artifacts.video.player.positionAt",
		"artifacts.video.player.keys",
		"artifacts.video.row.making",
		"artifacts.video.row.made",
		"artifacts.video.row.stopped",
		"artifacts.video.row.stillMaking",
		"artifacts.video.row.failed",
		"artifacts.video.row.blocked",
		"artifacts.delete.button.video",
		"artifacts.delete.title.video",
		"artifacts.delete.body.video",
		"artifacts.delete.done.video",
	] as const;

	it("has every key in both languages, and never says Artifact", () => {
		for (const key of KEYS) {
			expect(artifactsDict.en[key], `${key} (en)`).toBeTruthy();
			expect(artifactsDict.hu[key], `${key} (hu)`).toBeTruthy();
			expect(artifactsDict.en[key], `${key} (en)`).not.toMatch(/artifact/i);
			expect(artifactsDict.hu[key], `${key} (hu)`).not.toMatch(/artifact/i);
		}
	});

	it("keeps the retry button's Hungarian one way", () => {
		expect(artifactsDict.hu["artifacts.video.card.tryAgain"]).toBe(
			"Újrapróbálom",
		);
	});
});
