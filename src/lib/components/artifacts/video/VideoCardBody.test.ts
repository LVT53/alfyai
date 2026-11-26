// @vitest-environment jsdom
// @always-run: exercises file or process inputs outside Vitest’s import graph.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	downloadAuthenticatedBlob,
	startAuthenticatedDownload,
} from "$lib/client/downloads";
import { uiLanguage } from "$lib/stores/settings";
import { showToast } from "$lib/stores/toast";
import VideoCardBody from "./VideoCardBody.svelte";
import {
	videoCard as card,
	videoTake as take,
	videoClip,
} from "./video-card-fixtures.test-helpers";

/** A landed clip whose two files are named, so a URL assertion is not fixture numbering. */
function clip(over: Parameters<typeof videoClip>[0] = {}) {
	return videoClip({
		fileId: "clip-1",
		posterFileId: "poster-1",
		durationMs: 10_000,
		...over,
	});
}

vi.mock("$lib/client/downloads", () => ({
	startAuthenticatedDownload: vi.fn(() => Promise.resolve()),
	downloadAuthenticatedBlob: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("$lib/stores/toast", () => ({ showToast: vi.fn() }));

beforeEach(() => {
	uiLanguage.set("en");
	vi.mocked(startAuthenticatedDownload).mockClear();
	vi.mocked(downloadAuthenticatedBlob).mockReset();
	vi.mocked(downloadAuthenticatedBlob).mockResolvedValue(true);
	vi.mocked(showToast).mockClear();
});

afterEach(() => {
	uiLanguage.set("en");
});

describe("VideoCardBody, while the clip is made", () => {
	it("shows one shimmer over the box, the VIDEO badge, its words for screen readers only, and Stop in the picture card's slot", () => {
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			etaSeconds: 8,
			clip: null,
		});
		const onAction = vi.fn();
		render(VideoCardBody, { card: card(making), onAction });

		const stage = screen.getByTestId("video-card-stage");
		const shimmer = screen.getByTestId("video-card-shimmer");
		expect(shimmer).toHaveAttribute("aria-hidden", "true");
		expect(shimmer.closest('[data-testid="video-card-stage"]')).toBe(stage);
		expect(screen.queryByTestId("video-card-state")).toBeNull();
		expect(screen.queryByTestId("video-card-media")).toBeNull();
		expect(screen.queryByTestId("video-card-duration")).toBeNull();
		expect(screen.getByTestId("video-card-badge")).toHaveTextContent("VIDEO");

		const status = screen.getByTestId("video-card-status");
		expect(status).toHaveAttribute("role", "status");
		expect(status).toHaveClass("sr-only");
		expect(status).toHaveTextContent(/^Making the video…$/);
		const detail = screen.getByTestId("video-card-status-detail");
		expect(detail).toHaveClass("sr-only");
		expect(detail).not.toHaveAttribute("role");
		expect(detail).toHaveTextContent("About 8 s left");

		// One status line, and no visible words in the box: the time is the
		// card head's to show (the owner's call of 17 Nov).
		expect(within(shimmer).queryByText(/^Making the video…$/)).toBeNull();
		expect(shimmer.textContent?.trim()).toBe("");
		expect(screen.queryByTestId("video-card-time")).toBeNull();
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

		const stop = screen.getByTestId("video-card-stop");
		expect(stop.parentElement).toBe(screen.getByTestId("video-card-swap"));
		expect(stop.closest('[data-testid="video-card-actions"]')).not.toBeNull();
		expect(screen.getByTestId("video-card-another")).toBeDisabled();
	});

	describe("the time it hands to the card's head", () => {
		const making = (over: Parameters<typeof take>[0] = {}) =>
			take({
				id: "video-take-making",
				status: "running",
				phase: "rendering",
				phaseAt: 100_000,
				clip: null,
				...over,
			});
		const lastTime = (onTime: ReturnType<typeof vi.fn>) =>
			onTime.mock.calls.at(-1)?.[0];

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
			vi.setSystemTime(100_000);
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("counts down between polls and never re-announces the time", async () => {
			const onTime = vi.fn();
			const { rerender } = render(VideoCardBody, {
				card: card(making({ etaSeconds: 12 })),
				onTime,
			});
			await tick();
			expect(lastTime(onTime)).toBe("About 12 s left");
			const status = screen.getByTestId("video-card-status");
			const before = status.textContent;
			for (const etaSeconds of [9, 6]) {
				await vi.advanceTimersByTimeAsync(3_000);
				await rerender({ card: card(making({ etaSeconds })), onTime });
				await tick();
			}
			expect(status.textContent).toBe(before);
			expect(lastTime(onTime)).toBe("About 6 s left");
			expect(screen.getByTestId("video-card-status-detail")).toHaveTextContent(
				"About 6 s left",
			);
		});

		it("says what it is still doing once its time is up, never a clock counting up", async () => {
			const onTime = vi.fn();
			const { rerender } = render(VideoCardBody, {
				card: card(making({ etaSeconds: 3 })),
				onTime,
			});
			await tick();
			await vi.advanceTimersByTimeAsync(1_000);
			await tick();
			expect(lastTime(onTime)).toBe("About 2 s left");
			await vi.advanceTimersByTimeAsync(3_000);
			await rerender({ card: card(making({ etaSeconds: 0 })), onTime });
			await tick();
			expect(lastTime(onTime)).toBe("Taking a little longer…");
			await rerender({
				card: card(making({ phase: "finishing", etaSeconds: 0 })),
				onTime,
			});
			await tick();
			expect(lastTime(onTime)).toBe("Almost done…");
			expect(
				onTime.mock.calls.some(([words]) => /\d:\d\d/.test(String(words))),
			).toBe(false);
		});
	});

	it("does not change the box's shape between states", async () => {
		const { rerender } = render(VideoCardBody, {
			card: card(
				take({
					status: "running",
					phase: "rendering",
					phaseAt: Date.now(),
					clip: null,
				}),
			),
		});
		const box = () =>
			screen.getByTestId("video-card-stage").getAttribute("style");
		const making = box();
		await rerender({ card: card(take()) });
		expect(box()).toBe(making);
	});

	it("asks for the take to be stopped", async () => {
		const onAction = vi.fn(async () => undefined);
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			clip: null,
		});
		render(VideoCardBody, { card: card(making), onAction });
		await fireEvent.click(screen.getByTestId("video-card-stop"));
		expect(onAction).toHaveBeenCalledWith({ type: "stop", takeId: making.id });
	});
});

describe("VideoCardBody, when the clip is ready", () => {
	it("draws the poster, the play control, the duration and the picture card's actions row", () => {
		render(VideoCardBody, {
			card: card(take({ clip: clip() })),
			onAction: vi.fn(async () => undefined),
		});
		const video = screen.getByTestId("video-player-media");
		expect(video).not.toHaveAttribute("autoplay");
		expect(video.getAttribute("poster")).toBe(
			"/api/images/files/poster-1?variant=poster&conversationId=conv-1",
		);
		expect(screen.getByTestId("video-card-duration")).toHaveTextContent("0:10");
		expect(screen.getByTestId("video-card-badge")).toHaveTextContent("VIDEO");
		expect(
			screen.getByRole("button", { name: "Play video" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("video-card-another")).toBeEnabled();
		expect(screen.queryByTestId("video-card-stop")).toBeNull();
		expect(screen.getByTestId("video-card-swap").children).toHaveLength(0);
	});

	it("downloads the clip itself from More, and says History is not shown for a clip yet", async () => {
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		const menu = await screen.findByTestId("video-card-menu");
		const history = within(menu).getByTestId("video-card-history");
		expect(history).toBeDisabled();
		expect(history).toHaveAttribute(
			"title",
			"History isn't shown for a clip yet.",
		);
		expect(
			within(menu).queryByTestId("video-card-attach"),
		).not.toBeInTheDocument();
		await fireEvent.click(within(menu).getByTestId("video-card-download"));
		expect(startAuthenticatedDownload).toHaveBeenCalledWith(
			"/api/images/files/clip-1?download=1&conversationId=conv-1",
		);
	});

	it("offers Download as GIF under Download, disabled while there is no clip", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			clip: null,
		});
		const { rerender } = render(VideoCardBody, { card: card(making) });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		const menu = await screen.findByTestId("video-card-menu");
		const gifRow = within(menu).getByTestId("video-card-download-gif");
		expect(gifRow).toHaveTextContent("Download as GIF");
		expect(gifRow).toBeDisabled();
		expect(within(menu).getByTestId("video-card-download")).toBeDisabled();
		// The mp4 stays the first, default row; the GIF sits under it.
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((row) => row.getAttribute("data-testid")),
		).toEqual([
			"video-card-download",
			"video-card-download-gif",
			"video-card-history",
		]);

		await rerender({ card: card(take({ clip: clip() })) });
		expect(screen.getByTestId("video-card-download-gif")).toBeEnabled();
	});

	it("downloads the clip as a GIF from More, with the item's own scope", async () => {
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		const menu = await screen.findByTestId("video-card-menu");
		await fireEvent.click(within(menu).getByTestId("video-card-download-gif"));
		expect(downloadAuthenticatedBlob).toHaveBeenCalledWith(
			"/api/images/files/clip-1?download=1&format=gif&conversationId=conv-1",
			{ fallbackFilename: "Harbour at dawn.gif" },
		);
		// The mp4 is still the native download; only the GIF is read first.
		expect(startAuthenticatedDownload).not.toHaveBeenCalled();
	});

	it("keeps the GIF row disabled while the GIF is made, then says so when it failed", async () => {
		let answer!: (started: boolean) => void;
		vi.mocked(downloadAuthenticatedBlob).mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				answer = resolve;
			}),
		);
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		const menu = await screen.findByTestId("video-card-menu");
		const gifRow = within(menu).getByTestId("video-card-download-gif");
		const mp4Row = within(menu).getByTestId("video-card-download");
		await fireEvent.click(gifRow);
		// The card's own disabled treatment is the busy state; the menu stays open
		// so the reader can see it.
		expect(gifRow).toBeDisabled();
		expect(mp4Row).toBeDisabled();
		expect(screen.getByTestId("video-card-menu")).toBeInTheDocument();

		answer(false);
		await vi.waitFor(() =>
			expect(screen.queryByTestId("video-card-menu")).toBeNull(),
		);
		expect(showToast).toHaveBeenCalledWith({
			type: "error",
			message: "That didn't work. Try again in a moment.",
		});
	});

	it("stands on the one card shell: no state, threshold or countdown of its own", () => {
		const read = (file: string) =>
			readFileSync(
				`${process.cwd()}/src/lib/components/artifacts/video/${file}`,
				"utf-8",
			);
		const body = read("VideoCardBody.svelte");
		const view = read("video-card-view.ts");
		expect(body).not.toMatch(/\b3_000\b/);
		expect(view).not.toMatch(/\b3_000\b/);
		expect(body).toMatch(
			/import\s+TakeCardShell\s+from\s*"\.\.\/takes\/TakeCardShell\.svelte"/,
		);
		expect(body).not.toMatch(/createEtaCountdown|takeCardState|takeTimeLine/);
		expect(view).not.toMatch(/function\s+\w*[Ss]tate\w*\s*\(/);
	});

	it("asks for another take, and holds Another while one is on its way", async () => {
		const onAction = vi.fn(async () => ({ takeId: "next" }));
		const { rerender } = render(VideoCardBody, { card: card(), onAction });
		await fireEvent.click(screen.getByTestId("video-card-another"));
		expect(onAction).toHaveBeenCalledWith({
			type: "another",
			cardId: "video-card-1",
		});
		expect(screen.getByTestId("video-card-another")).toBeDisabled();
		// The page refreshed the card with the new take: Another is offered again.
		await rerender({ card: card(take()) });
		expect(screen.getByTestId("video-card-another")).toBeEnabled();
	});

	it("offers no Another while the take is still running, and no handler means no dead buttons", () => {
		render(VideoCardBody, {
			card: card(
				take({
					status: "running",
					phase: "rendering",
					phaseAt: Date.now(),
					clip: null,
				}),
			),
		});
		expect(screen.getByTestId("video-card-another")).toBeDisabled();
		expect(screen.getByTestId("video-card-stop")).toBeDisabled();
	});

	it("lets a press through the duration chip, as the badge already does", () => {
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		// The duration is the card's chip, which the shell's stylesheet keeps out
		// of the way of the clip under it.
		expect(screen.getByTestId("video-card-duration")).toHaveClass(
			"take-card-chip",
		);
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/takes/take-card.css`,
			"utf-8",
		);
		const chipRule = source.match(/\.take-card-chip\s*\{([^}]*)\}/)?.[1];
		expect(chipRule).toMatch(/pointer-events:\s*none/);
	});

	it("keeps the play control where the picture card keeps its Enlarge", () => {
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		expect(screen.getByTestId("video-player-fullscreen")).toBeInTheDocument();
		expect(screen.queryByTestId("video-card-picture")).toBeNull();
	});
});

describe("VideoCardBody, when it cannot play", () => {
	it("says the video cannot be made right now, and tries again", async () => {
		const onAction = vi.fn(async () => undefined);
		const failed = take({
			status: "failed",
			clip: null,
			errorCode: "video_server_unreachable",
		});
		render(VideoCardBody, { card: card(failed), onAction });
		expect(screen.getByTestId("video-card-state")).toHaveTextContent(
			"Videos can't be made right now.",
		);
		expect(screen.getByTestId("video-card-state")).toHaveTextContent(
			"Nothing was saved.",
		);
		await fireEvent.click(screen.getByTestId("video-card-retry"));
		expect(onAction).toHaveBeenCalledWith({ type: "retry", takeId: failed.id });
	});

	it("says a blocked video was not shown, and offers no Try again", () => {
		render(VideoCardBody, {
			card: card(
				take({ status: "failed", clip: null, errorCode: "video_blocked" }),
			),
		});
		expect(screen.getByTestId("video-card-blocked")).toHaveTextContent(
			"This video was blocked.",
		);
		expect(screen.queryByTestId("video-card-retry")).toBeNull();
	});

	it("says a video that could not be checked was not kept, and may be tried again", () => {
		render(VideoCardBody, {
			card: card(
				take({ status: "failed", clip: null, errorCode: "video_unchecked" }),
			),
		});
		expect(screen.getByTestId("video-card-blocked")).toHaveTextContent(
			"This video couldn't be checked.",
		);
		expect(screen.getByTestId("video-card-retry")).toBeInTheDocument();
	});

	it("keeps a stopped clip's words and offers a retry", async () => {
		const onAction = vi.fn(async () => undefined);
		const stopped = take({ status: "cancelled", clip: null });
		render(VideoCardBody, { card: card(stopped), onAction });
		expect(screen.getByTestId("video-card-state")).toHaveTextContent(
			"Stopped.",
		);
		await fireEvent.click(screen.getByTestId("video-card-retry"));
		expect(onAction).toHaveBeenCalledWith({
			type: "retry",
			takeId: stopped.id,
		});
	});

	it("says a deleted video is gone, keeps its box, and presses nothing", async () => {
		render(VideoCardBody, { card: card(), gone: "deleted" });
		expect(screen.getByTestId("video-card-gone")).toHaveTextContent(
			"The video is no longer kept.",
		);
		expect(screen.queryByTestId("video-player-media")).toBeNull();
		expect(screen.getByTestId("video-card-another")).toBeDisabled();
		expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
		expect(screen.queryByTestId("video-card-retry")).toBeNull();
	});

	it("says a video out of this chat's reach opens where it was made", () => {
		render(VideoCardBody, { card: card(), gone: "unreachable" });
		expect(screen.getByTestId("video-card-gone")).toHaveTextContent(
			"Open it from the chat it was made in.",
		);
	});

	it("speaks Hungarian", () => {
		uiLanguage.set("hu");
		render(VideoCardBody, {
			card: card(take({ status: "cancelled", clip: null })),
		});
		expect(screen.getByTestId("video-card-state")).toHaveTextContent(
			"Leállítva.",
		);
		expect(screen.getByTestId("video-card-badge")).toHaveTextContent("VIDEÓ");
		expect(screen.getByTestId("video-card-another")).toHaveTextContent("Másik");
	});

	it("speaks Hungarian for the GIF row", async () => {
		uiLanguage.set("hu");
		render(VideoCardBody, { card: card(take({ clip: clip() })) });
		await fireEvent.click(screen.getByRole("button", { name: "Továbbiak" }));
		const menu = await screen.findByTestId("video-card-menu");
		expect(
			within(menu).getByTestId("video-card-download-gif"),
		).toHaveTextContent("Letöltés GIF-ként");
	});
});
