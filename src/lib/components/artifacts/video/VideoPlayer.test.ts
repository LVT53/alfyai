import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import VideoPlayer from "./VideoPlayer.svelte";

const PROPS = {
	fileId: "clip-1",
	posterFileId: "poster-1",
	title: "Harbour at dawn",
	conversationId: "conv-1",
	width: 1280,
	height: 720,
};

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let fullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
	uiLanguage.set("en");
	play = vi
		.spyOn(HTMLMediaElement.prototype, "play")
		.mockImplementation(function (this: HTMLMediaElement) {
			this.dispatchEvent(new Event("play"));
			return Promise.resolve();
		});
	pause = vi
		.spyOn(HTMLMediaElement.prototype, "pause")
		.mockImplementation(function (this: HTMLMediaElement) {
			this.dispatchEvent(new Event("pause"));
		});
	fullscreen = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
		configurable: true,
		value: fullscreen,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	uiLanguage.set("en");
});

function media(): HTMLVideoElement {
	return screen.getByTestId("video-player-media") as HTMLVideoElement;
}

function root(): HTMLElement {
	return screen.getByTestId("video-player");
}

describe("VideoPlayer", () => {
	it("starts on the poster, without autoplay, and knows its two files", () => {
		render(VideoPlayer, PROPS);
		const video = media();
		expect(video).not.toHaveAttribute("autoplay");
		expect(video).toHaveAttribute("preload", "metadata");
		expect(video).toHaveAttribute("playsinline");
		expect(video.getAttribute("src")).toBe(
			"/api/images/files/clip-1?conversationId=conv-1",
		);
		expect(video.getAttribute("poster")).toBe(
			"/api/images/files/poster-1?variant=poster&conversationId=conv-1",
		);
		expect(play).not.toHaveBeenCalled();
	});

	it("loops by default, and L turns the loop off", async () => {
		render(VideoPlayer, PROPS);
		expect(media()).toHaveAttribute("loop");
		await fireEvent.keyDown(root(), { key: "l" });
		expect(media()).not.toHaveAttribute("loop");
		await fireEvent.keyDown(root(), { key: "L" });
		expect(media()).toHaveAttribute("loop");
	});

	it("adds no Tab stop of its own, and shows a focus ring while a control has the keyboard", () => {
		render(VideoPlayer, PROPS);
		const player = root();
		expect(player).not.toHaveAttribute("tabindex");
		expect(player).toHaveAttribute("role", "group");
		expect(player).toHaveAccessibleName("Harbour at dawn video player");
		expect(
			screen.getByRole("button", { name: "Play video" }),
		).toBeInTheDocument();
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/video/VideoPlayer.svelte`,
			"utf-8",
		);
		expect(source).toMatch(/\.video-player:focus-within\s*\{[^}]*box-shadow/);
		// No key handler eats Tab: the only focus move in the file is the
		// browser's own, so the player can never trap it.
		expect(source).not.toMatch(/key === ["']Tab["']/);
		expect(source).not.toMatch(/\.focus\(\)/);
	});

	it("plays and pauses from its button, with the space bar", async () => {
		render(VideoPlayer, PROPS);
		await fireEvent.click(screen.getByRole("button", { name: "Play video" }));
		expect(play).toHaveBeenCalledTimes(1);
		expect(
			screen.getByRole("button", { name: "Pause video" }),
		).toBeInTheDocument();
		await fireEvent.keyDown(root(), { key: " " });
		expect(pause).toHaveBeenCalledTimes(1);
		expect(
			screen.getByRole("button", { name: "Play video" }),
		).toBeInTheDocument();
	});

	it("keeps Space for play/pause even over its own fullscreen control", async () => {
		render(VideoPlayer, PROPS);
		const fullscreenButton = screen.getByTestId("video-player-fullscreen");
		fullscreenButton.focus();
		await fireEvent.keyDown(fullscreenButton, { key: " " });
		expect(play).toHaveBeenCalledTimes(1);
		expect(fullscreen).not.toHaveBeenCalled();
	});

	it("seeks one second with the arrows and five with shift", async () => {
		render(VideoPlayer, PROPS);
		const video = media();
		video.currentTime = 10;
		await fireEvent.keyDown(root(), { key: "ArrowRight" });
		expect(video.currentTime).toBe(11);
		await fireEvent.keyDown(root(), { key: "ArrowRight", shiftKey: true });
		expect(video.currentTime).toBe(16);
		await fireEvent.keyDown(root(), { key: "ArrowLeft" });
		expect(video.currentTime).toBe(15);
		await fireEvent.keyDown(root(), { key: "ArrowLeft", shiftKey: true });
		expect(video.currentTime).toBe(10);
		// Never before the start of the clip.
		await fireEvent.keyDown(root(), { key: "ArrowLeft", shiftKey: true });
		await fireEvent.keyDown(root(), { key: "ArrowLeft", shiftKey: true });
		expect(video.currentTime).toBe(0);
	});

	it("changes the volume up and down, and mutes with M", async () => {
		render(VideoPlayer, PROPS);
		const video = media();
		video.volume = 0.5;
		await fireEvent.keyDown(root(), { key: "ArrowDown" });
		expect(video.volume).toBeCloseTo(0.4);
		await fireEvent.keyDown(root(), { key: "ArrowUp" });
		expect(video.volume).toBeCloseTo(0.5);
		expect(video.muted).toBe(false);
		await fireEvent.keyDown(root(), { key: "m" });
		expect(video.muted).toBe(true);
		await fireEvent.keyDown(root(), { key: "m" });
		expect(video.muted).toBe(false);
	});

	it("goes fullscreen with F, and from a double press that is not a play toggle", async () => {
		vi.useFakeTimers();
		try {
			render(VideoPlayer, PROPS);
			await fireEvent.keyDown(root(), { key: "f" });
			expect(fullscreen).toHaveBeenCalledTimes(1);
			await fireEvent.click(media());
			await fireEvent.click(media());
			await fireEvent.dblClick(media());
			vi.advanceTimersByTime(500);
			expect(fullscreen).toHaveBeenCalledTimes(2);
			expect(play).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("toggles play from one press on the picture, not from two", async () => {
		vi.useFakeTimers();
		try {
			render(VideoPlayer, PROPS);
			await fireEvent.click(media());
			vi.advanceTimersByTime(500);
			expect(play).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets only one clip play at a time", async () => {
		render(VideoPlayer, { ...PROPS, fileId: "clip-1" });
		render(VideoPlayer, { ...PROPS, fileId: "clip-2" });
		const players = screen.getAllByTestId("video-player");
		const buttons = screen.getAllByRole("button", { name: "Play video" });
		await fireEvent.keyDown(players[0] as HTMLElement, { key: " " });
		await fireEvent.keyDown(players[1] as HTMLElement, { key: " " });
		expect(play).toHaveBeenCalledTimes(2);
		// The first clip was paused when the second started.
		expect(pause).toHaveBeenCalledTimes(1);
		expect(buttons).toHaveLength(2);
	});

	it("stops when the chat is left, and comes back on its poster", async () => {
		const { unmount } = render(VideoPlayer, PROPS);
		await fireEvent.keyDown(root(), { key: " " });
		expect(play).toHaveBeenCalledTimes(1);
		unmount();
		expect(pause).toHaveBeenCalledTimes(1);
		render(VideoPlayer, PROPS);
		expect(play).toHaveBeenCalledTimes(1);
		expect(media()).toHaveAttribute("poster");
	});

	it("describes its keys for a screen reader, and needs no motion to work", () => {
		render(VideoPlayer, PROPS);
		const described = root().getAttribute("aria-describedby");
		expect(described).toBeTruthy();
		expect(document.getElementById(described as string)?.textContent).toContain(
			"Space plays or pauses",
		);
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/video/VideoPlayer.svelte`,
			"utf-8",
		);
		expect(source).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/,
		);
	});

	it("speaks Hungarian", () => {
		uiLanguage.set("hu");
		render(VideoPlayer, PROPS);
		expect(
			screen.getByRole("button", { name: "Lejátszás" }),
		).toBeInTheDocument();
		expect(root()).toHaveAccessibleName("Harbour at dawn videólejátszó");
	});
});
