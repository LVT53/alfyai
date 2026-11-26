// @always-run: exercises file or process inputs outside Vitest’s import graph.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as artifactsApi from "$lib/client/api/artifacts";
import {
	downloadAuthenticatedBlob,
	startAuthenticatedDownload,
} from "$lib/client/downloads";
import { serializeVideoVersionBody } from "$lib/shared/artifacts/video-body";
import { uiLanguage } from "$lib/stores/settings";
import { showToast } from "$lib/stores/toast";
import {
	ARTIFACT_BODIES,
	type ArtifactPanelBodyActions,
} from "../artifact-bodies";
import VideoBody from "./VideoBody.svelte";

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: vi.fn(),
	fetchArtifactHistory: vi.fn(),
}));
vi.mock("$lib/client/downloads", () => ({
	startAuthenticatedDownload: vi.fn(() => Promise.resolve()),
	downloadAuthenticatedBlob: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("$lib/stores/toast", () => ({ showToast: vi.fn() }));

const BODY = serializeVideoVersionBody({
	v: 1,
	fileId: "clip-1",
	posterFileId: "poster-1",
	width: 1280,
	height: 720,
	durationMs: 10_000,
	sourceFileId: null,
});

function answer(body: string | null, versionNumber = 1) {
	vi.mocked(artifactsApi.fetchArtifact).mockResolvedValue({
		artifact: {
			id: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body,
			versionNumber,
		},
	} as unknown as Awaited<ReturnType<typeof artifactsApi.fetchArtifact>>);
}

beforeEach(() => {
	uiLanguage.set("en");
	vi.mocked(startAuthenticatedDownload).mockClear();
	vi.mocked(downloadAuthenticatedBlob).mockReset();
	vi.mocked(downloadAuthenticatedBlob).mockResolvedValue(true);
	vi.mocked(showToast).mockClear();
});

afterEach(() => {
	uiLanguage.set("en");
	vi.mocked(artifactsApi.fetchArtifact).mockReset();
});

describe("VideoBody (the panel)", () => {
	it("opens the stored clip as a player, on its poster", async () => {
		answer(BODY);
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			conversationId: "conv-1",
		});
		const video = await screen.findByTestId("video-player-media");
		expect(video).not.toHaveAttribute("autoplay");
		expect(video.getAttribute("poster")).toBe(
			"/api/images/files/poster-1?variant=poster&conversationId=conv-1",
		);
		expect(video.getAttribute("src")).toBe(
			"/api/images/files/clip-1?conversationId=conv-1",
		);
		expect(screen.getByTestId("video-body")).toBeInTheDocument();
	});

	it("says so, in the panel's own line, when the clip cannot be opened", async () => {
		answer("not a clip");
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't open the video.",
		);
		expect(screen.queryByTestId("video-player-media")).toBeNull();
	});

	it("reads the item again when the page hears of a newer version", async () => {
		answer(BODY, 1);
		const { rerender } = render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			versionNumber: 1,
		});
		await screen.findByTestId("video-player-media");
		expect(artifactsApi.fetchArtifact).toHaveBeenCalledTimes(1);
		answer(
			serializeVideoVersionBody({
				v: 1,
				fileId: "clip-2",
				posterFileId: "poster-2",
				width: 1280,
				height: 720,
				durationMs: 5000,
				sourceFileId: null,
			}),
			2,
		);
		await rerender({
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			versionNumber: 2,
		});
		await vi.waitFor(() =>
			expect(artifactsApi.fetchArtifact).toHaveBeenCalledTimes(2),
		);
	});

	it("opens the panel's Download as a choice, with the mp4 first and the GIF under it", async () => {
		answer(BODY);
		let actions: ArtifactPanelBodyActions | undefined;
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			conversationId: "conv-1",
			registerPanelActions: (next) => (actions = next),
		});
		await screen.findByTestId("video-player-media");
		expect(screen.queryByTestId("video-download-popover")).toBeNull();
		expect(actions?.openDownload).toBeTypeOf("function");

		actions?.openDownload?.();

		const sheet = await screen.findByRole("dialog", {
			name: "Download Harbour at dawn",
		});
		expect(
			within(sheet)
				.getAllByRole("button")
				.map((row) => row.getAttribute("data-testid"))
				.slice(-2),
		).toEqual(["video-download-mp4", "video-download-gif"]);
		expect(within(sheet).getByTestId("video-download-mp4")).toHaveTextContent(
			"Download as MP4",
		);
		expect(within(sheet).getByTestId("video-download-gif")).toHaveTextContent(
			"Download as GIF",
		);

		// The mp4 is still the default choice.
		await fireEvent.click(within(sheet).getByTestId("video-download-mp4"));
		expect(startAuthenticatedDownload).toHaveBeenCalledWith(
			"/api/images/files/clip-1?download=1&conversationId=conv-1",
		);
		expect(screen.queryByTestId("video-download-popover")).toBeNull();
	});

	it("downloads the clip as a GIF from the panel's Download, reading the response first", async () => {
		answer(BODY);
		let actions: ArtifactPanelBodyActions | undefined;
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			conversationId: "conv-1",
			registerPanelActions: (next) => (actions = next),
		});
		await screen.findByTestId("video-player-media");

		actions?.openDownload?.();
		await fireEvent.click(await screen.findByTestId("video-download-gif"));

		expect(downloadAuthenticatedBlob).toHaveBeenCalledWith(
			"/api/images/files/clip-1?download=1&format=gif&conversationId=conv-1",
			{ fallbackFilename: "Harbour at dawn.gif" },
		);
		expect(startAuthenticatedDownload).not.toHaveBeenCalled();
		expect(screen.queryByTestId("video-download-popover")).toBeNull();
	});

	it("shows the GIF row busy while it is made, and says so when it failed", async () => {
		answer(BODY);
		let answerGif!: (started: boolean) => void;
		vi.mocked(downloadAuthenticatedBlob).mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				answerGif = resolve;
			}),
		);
		let actions: ArtifactPanelBodyActions | undefined;
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			conversationId: "conv-1",
			registerPanelActions: (next) => (actions = next),
		});
		await screen.findByTestId("video-player-media");

		actions?.openDownload?.();
		const gifRow = await screen.findByTestId("video-download-gif");
		await fireEvent.click(gifRow);
		expect(gifRow).toBeDisabled();
		expect(screen.getByTestId("video-download-popover")).toBeInTheDocument();

		answerGif(false);
		await vi.waitFor(() =>
			expect(screen.queryByTestId("video-download-popover")).toBeNull(),
		);
		expect(showToast).toHaveBeenCalledWith({
			type: "error",
			message: "That didn't work. Try again in a moment.",
		});
	});

	it("offers no Download while there is no clip", async () => {
		answer("not a clip");
		let actions: ArtifactPanelBodyActions | undefined;
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			registerPanelActions: (next) => (actions = next),
		});
		await screen.findByRole("alert");
		expect(actions?.openDownload).toBeUndefined();
	});

	it("speaks Hungarian for the GIF choice", async () => {
		uiLanguage.set("hu");
		answer(BODY);
		let actions: ArtifactPanelBodyActions | undefined;
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			registerPanelActions: (next) => (actions = next),
		});
		await screen.findByTestId("video-player-media");
		actions?.openDownload?.();
		const sheet = await screen.findByTestId("video-download-popover");
		expect(within(sheet).getByTestId("video-download-mp4")).toHaveTextContent(
			"Letöltés MP4-ként",
		);
		expect(within(sheet).getByTestId("video-download-gif")).toHaveTextContent(
			"Letöltés GIF-ként",
		);
	});

	it("speaks Hungarian when a clip cannot be opened", async () => {
		uiLanguage.set("hu");
		answer(null);
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Nem sikerült megnyitni a videót.",
		);
	});

	it("fits the clip both ways in the panel, in a size container, and uses the panel's spacing token", async () => {
		answer(BODY);
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
			conversationId: "conv-1",
		});
		await screen.findByTestId("video-player-media");
		const stage = screen.getByTestId("video-body-stage");
		const frame = screen.getByTestId("video-body-frame");
		expect(frame.style.getPropertyValue("--ratio")).toBe(String(1280 / 720));
		// The length row is a sibling of the container, never inside its height
		// budget.
		expect(stage.contains(screen.getByTestId("video-body-length"))).toBe(false);
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/video/VideoBody.svelte`,
			"utf-8",
		);
		// The STAGE is the size container, as the picture body's is; the body is
		// not, or `100cqh` would count the gap and the length row too.
		expect(source).toMatch(
			/\.video-body-stage\s*\{[^}]*container-type:\s*size/,
		);
		expect(source).not.toMatch(/\.video-body\s*\{[^}]*container-type:\s*size/);
		expect(source).toMatch(
			/\.video-body-frame\s*\{[^}]*width:\s*min\(\s*100cqw,\s*calc\(\s*100cqh\s*\*\s*var\(--ratio\)\s*\)\s*\)/,
		);
		expect(source).toMatch(/\.video-body\s*\{[^}]*gap:\s*var\(--space-md\)/);
		expect(source).toMatch(
			/\.video-body\s*\{[^}]*padding:\s*var\(--space-md\)/,
		);
	});

	it("is the Video kind's registered body, loaded by a dynamic import", async () => {
		const loader = ARTIFACT_BODIES.video;
		expect(loader).toBeTypeOf("function");
		const module = await loader?.();
		expect(module?.default).toBe(VideoBody);
	});

	it("never says Artifact", async () => {
		answer(BODY);
		render(VideoBody, {
			artifactId: "video-1",
			kind: "video",
			title: "Harbour at dawn",
			body: null,
		});
		await screen.findByTestId("video-player-media");
		expect(document.body.textContent).not.toMatch(/artifact/i);
		await fireEvent.keyDown(screen.getByTestId("video-body-player"), {
			key: " ",
		});
	});
});
