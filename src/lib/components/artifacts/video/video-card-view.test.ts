// @vitest-environment jsdom
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import artifactsDict from "$lib/i18n/artifacts";
import { uiLanguage } from "$lib/stores/settings";
import {
	videoCardSubtitle,
	videoDurationLabel,
	videoFileUrl,
} from "./video-card-view";

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
		expect(videoCardSubtitle(get(t))).toBe("Video");
		uiLanguage.set("hu");
		expect(videoCardSubtitle(get(t))).toBe("Videó");
		uiLanguage.set("en");
	});
});

describe("the video dictionary", () => {
	const KEYS = [
		"artifacts.video.badge",
		"artifacts.video.card.making",
		"artifacts.video.card.starting",
		"artifacts.video.card.startingDetail",
		"artifacts.video.card.unavailable",
		"artifacts.video.card.blocked",
		"artifacts.video.card.blockedDetail",
		"artifacts.video.card.unchecked",
		"artifacts.video.card.uncheckedDetail",
		"artifacts.video.card.downloadGif",
		"artifacts.video.panel.downloadMp4",
		"artifacts.video.panel.downloadTitle",
		"artifacts.video.card.historyUnavailable",
		"artifacts.video.card.lengthA11y",
		"artifacts.video.card.goneDetail",
		"artifacts.video.panel.loading",
		"artifacts.video.panel.loadFailed",
		"artifacts.video.player.label",
		"artifacts.video.player.play",
		"artifacts.video.player.pause",
		"artifacts.video.player.fullscreen",
		"artifacts.video.player.exitFullscreen",
		"artifacts.video.player.position",
		"artifacts.video.player.positionAt",
		"artifacts.video.player.loop",
		"artifacts.video.player.mute",
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
});
