import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as artifactsApi from "$lib/client/api/artifacts";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { serializeVideoVersionBody } from "$lib/shared/artifacts/video-body";
import { uiLanguage } from "$lib/stores/settings";
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
}));

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

	it("registers the panel's Download for the clip's own file", async () => {
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
		expect(actions?.openDownload).toBeTypeOf("function");
		actions?.openDownload?.();
		expect(startAuthenticatedDownload).toHaveBeenCalledWith(
			"/api/images/files/clip-1?download=1&conversationId=conv-1",
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
