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
};

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
let fullscreenElement: Element | null = null;

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
	fullscreenElement = null;
	requestFullscreen = vi.fn(function (this: HTMLElement) {
		fullscreenElement = this;
		document.dispatchEvent(new Event("fullscreenchange"));
		return Promise.resolve();
	});
	exitFullscreen = vi.fn(async () => {
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));
	});
	Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
		configurable: true,
		value: requestFullscreen,
	});
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		get: () => fullscreenElement,
	});
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: exitFullscreen,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (document as unknown as { fullscreenElement?: unknown })
		.fullscreenElement;
	delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
	uiLanguage.set("en");
});

function media(): HTMLVideoElement {
	return screen.getByTestId("video-player-media") as HTMLVideoElement;
}

function root(): HTMLElement {
	return screen.getByTestId("video-player");
}

function fullscreenButton(): HTMLElement {
	return screen.getByTestId("video-player-fullscreen");
}

function scrubber(): HTMLInputElement {
	return screen.getByTestId("video-player-scrubber") as HTMLInputElement;
}

/** jsdom has no media clock: give this element the duration and buffered range a loaded clip would. */
function withClock(
	video: HTMLVideoElement,
	durationSeconds: number,
	bufferedEnd = 0,
): void {
	Object.defineProperty(video, "duration", {
		configurable: true,
		get: () => durationSeconds,
	});
	Object.defineProperty(video, "buffered", {
		configurable: true,
		get: () => ({
			length: bufferedEnd > 0 ? 1 : 0,
			end: () => bufferedEnd,
		}),
	});
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

	it("is one Tab stop, and a press on the clip takes the keyboard", async () => {
		render(VideoPlayer, PROPS);
		const player = root();
		expect(player).toHaveAttribute("tabindex", "0");
		expect(player).toHaveAttribute("role", "group");
		expect(player).toHaveAccessibleName("Harbour at dawn video player");
		expect(
			screen.getByRole("button", { name: "Play video" }),
		).toBeInTheDocument();

		expect(player).not.toHaveFocus();
		await fireEvent.pointerDown(media());
		expect(player).toHaveFocus();

		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/video/VideoPlayer.svelte`,
			"utf-8",
		);
		expect(source).toMatch(/\.video-player:focus-within\s*\{[^}]*box-shadow/);
		// No key handler eats Tab: the only focus moves in the file are the
		// player's own and the browser's, so Tab can never be trapped.
		expect(source).not.toMatch(/key === ["']Tab["']/);
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

	it("plays and pauses from the keyboard after a press on the clip", async () => {
		render(VideoPlayer, PROPS);
		await fireEvent.pointerDown(media());
		expect(root()).toHaveFocus();
		await fireEvent.keyDown(root(), { key: " " });
		expect(play).toHaveBeenCalledTimes(1);
		await fireEvent.keyDown(root(), { key: " " });
		expect(pause).toHaveBeenCalledTimes(1);
	});

	it("leaves Space and Enter to a focused button, so its own activation runs", async () => {
		render(VideoPlayer, PROPS);
		const button = fullscreenButton();
		button.focus();
		for (const key of [" ", "Enter"]) {
			const keydown = new KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
			});
			button.dispatchEvent(keydown);
			expect(keydown.defaultPrevented, key).toBe(false);
		}
		expect(play).not.toHaveBeenCalled();
		// What the browser's own activation does.
		await fireEvent.click(button);
		expect(requestFullscreen).toHaveBeenCalledTimes(1);
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

	it("toggles fullscreen from its button, and the button says which way it will go", async () => {
		render(VideoPlayer, PROPS);
		const button = fullscreenButton();
		expect(button).toHaveAttribute("aria-label", "Enter fullscreen");
		await fireEvent.click(button);
		expect(requestFullscreen).toHaveBeenCalledTimes(1);
		expect(document.fullscreenElement).not.toBeNull();
		expect(button).toHaveAttribute("aria-label", "Exit fullscreen");
		await fireEvent.click(button);
		expect(exitFullscreen).toHaveBeenCalledTimes(1);
		expect(document.fullscreenElement).toBeNull();
		expect(button).toHaveAttribute("aria-label", "Enter fullscreen");
	});

	it("follows a fullscreen exit the browser made, such as Escape", async () => {
		render(VideoPlayer, PROPS);
		const button = fullscreenButton();
		await fireEvent.click(button);
		expect(button).toHaveAttribute("aria-label", "Exit fullscreen");
		// The browser takes the player out of fullscreen without our button.
		fullscreenElement = null;
		await fireEvent(document, new Event("fullscreenchange"));
		expect(button).toHaveAttribute("aria-label", "Enter fullscreen");
	});

	it("goes fullscreen with F, and from a double press that is not a play toggle", async () => {
		vi.useFakeTimers();
		try {
			render(VideoPlayer, PROPS);
			await fireEvent.keyDown(root(), { key: "f" });
			expect(requestFullscreen).toHaveBeenCalledTimes(1);
			// Leave fullscreen the way Escape does, then the double press enters again.
			fullscreenElement = null;
			await fireEvent(document, new Event("fullscreenchange"));
			await fireEvent.click(media());
			await fireEvent.click(media());
			await fireEvent.dblClick(media());
			vi.advanceTimersByTime(500);
			expect(requestFullscreen).toHaveBeenCalledTimes(2);
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

	it("shows the clip's length, position and buffered range in a scrubber", async () => {
		render(VideoPlayer, PROPS);
		const video = media();
		withClock(video, 5, 2);
		await fireEvent.loadedMetadata(video);

		const slider = scrubber();
		expect(slider).toHaveAttribute("aria-label", "Position");
		expect(slider).toHaveAttribute("max", "5");
		expect(slider).toHaveAttribute("aria-valuetext", "0 of 5 seconds");
		expect(screen.getByTestId("video-player-time")).toHaveTextContent(
			"0:00 / 0:05",
		);
		const row = screen.getByTestId("video-player-scrubber-row");
		expect(row.style.getPropertyValue("--buffered")).toBe("40%");
		expect(row.style.getPropertyValue("--played")).toBe("0%");

		await fireEvent.input(slider, { target: { value: "2" } });
		expect(video.currentTime).toBe(2);
		expect(slider).toHaveAttribute("aria-valuetext", "2 of 5 seconds");
		expect(screen.getByTestId("video-player-time")).toHaveTextContent(
			"0:02 / 0:05",
		);
		expect(row.style.getPropertyValue("--played")).toBe("40%");

		// The clock updates while it plays.
		video.currentTime = 3;
		await fireEvent.timeUpdate(video);
		expect(slider.value).toBe("3");
		expect(screen.getByTestId("video-player-time")).toHaveTextContent(
			"0:03 / 0:05",
		);

		// And the buffered range catches up.
		withClock(video, 5, 4.5);
		await fireEvent.progress(video);
		expect(row.style.getPropertyValue("--buffered")).toBe("90%");
	});

	it("seeks from the scrubber's own keyboard", async () => {
		render(VideoPlayer, PROPS);
		const video = media();
		withClock(video, 5, 5);
		await fireEvent.loadedMetadata(video);
		video.currentTime = 1;
		const slider = scrubber();
		slider.focus();
		await fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(video.currentTime).toBe(2);
		expect(slider).toHaveAttribute("aria-valuetext", "2 of 5 seconds");
	});

	it("announces the loop and mute changes it makes, never silently", async () => {
		render(VideoPlayer, PROPS);
		const status = screen.getByRole("status");
		expect(status).toHaveClass("sr-only");
		expect(status).toHaveTextContent("");
		await fireEvent.keyDown(root(), { key: "l" });
		expect(status).toHaveTextContent("Loop off");
		await fireEvent.keyDown(root(), { key: "L" });
		expect(status).toHaveTextContent("Loop on");
		await fireEvent.keyDown(root(), { key: "m" });
		expect(status).toHaveTextContent("Muted");
		await fireEvent.keyDown(root(), { key: "m" });
		expect(status).toHaveTextContent("Unmuted");
	});

	it("announces the loop and mute changes in Hungarian too", async () => {
		uiLanguage.set("hu");
		render(VideoPlayer, PROPS);
		const status = screen.getByRole("status");
		await fireEvent.keyDown(root(), { key: "l" });
		expect(status).toHaveTextContent("Ismétlés ki");
		await fireEvent.keyDown(root(), { key: "l" });
		expect(status).toHaveTextContent("Ismétlés be");
		await fireEvent.keyDown(root(), { key: "m" });
		expect(status).toHaveTextContent("Némítva");
		await fireEvent.keyDown(root(), { key: "m" });
		expect(status).toHaveTextContent("Némítás kikapcsolva");
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
		expect(
			screen.getByRole("button", { name: "Belépés a teljes képernyőbe" }),
		).toBeInTheDocument();
		expect(screen.getByRole("slider")).toHaveAttribute("aria-label", "Pozíció");
		expect(root()).toHaveAccessibleName("Harbour at dawn videólejátszó");
	});
});
