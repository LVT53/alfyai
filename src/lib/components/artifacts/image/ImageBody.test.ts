import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactPanelBodyActions } from "$lib/components/artifacts/artifact-bodies";
import {
	at,
	makeMoment,
} from "$lib/components/artifacts/history/__fixtures__/moments";
import {
	type ImageVersionBody,
	serializeImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import { uiLanguage } from "$lib/stores/settings";

const api = vi.hoisted(() => ({
	fetchArtifact: vi.fn(),
	fetchArtifactHistory: vi.fn(),
	startAuthenticatedDownload: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: api.fetchArtifact,
	fetchArtifactHistory: api.fetchArtifactHistory,
}));
vi.mock("$lib/client/downloads", () => ({
	startAuthenticatedDownload: api.startAuthenticatedDownload,
}));

import ImageBody from "./ImageBody.svelte";

function body(overrides: Partial<ImageVersionBody> = {}): string {
	return serializeImageVersionBody({
		v: 1,
		fileId: "file-2",
		width: 1248,
		height: 832,
		hasAlpha: false,
		baseFileId: null,
		sources: [],
		marks: null,
		prompt: null,
		takeId: null,
		seed: null,
		anchorFileId: null,
		chainSinceAnchor: 0,
		...overrides,
	});
}

function detail(stored: string, versionNumber: number) {
	return {
		artifact: {
			id: "img-1",
			kind: "image",
			title: "Cosy room",
			body: stored,
			versionNumber,
			conversationId: "conv-1",
			metadata: {},
		},
		versions: [],
		comments: [],
	};
}

const imageDetail = (fileId: string) => ({
	type: "image" as const,
	fileId,
	sourceCount: 0,
});

function history(count: number) {
	const moments = [];
	for (let version = count; version >= 1; version--) {
		moments.push(
			makeMoment({
				versionNumber: version,
				kind: version === 1 ? "first_draft" : "alfy_edit",
				author: "alfy",
				at: at(2026, 10, 27, 10, version),
				detail: imageDetail(`file-${version}`),
				isNewest: version === count,
				containsNewest: version === count,
			}),
		);
	}
	return {
		ok: true,
		artifactKind: "image",
		moments,
		older: false,
		nextBefore: null,
		newestVersion: count,
		newestHash: `hash-${count}`,
	};
}

function renderBody(props: Record<string, unknown> = {}) {
	return render(ImageBody, {
		artifactId: "img-1",
		kind: "image",
		title: "Cosy room",
		body: null,
		conversationId: "conv-1",
		...props,
	});
}

describe("ImageBody", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		api.fetchArtifact.mockReset();
		api.fetchArtifactHistory.mockReset();
		api.startAuthenticatedDownload.mockReset();
		api.fetchArtifactHistory.mockResolvedValue(history(2));
	});

	it("shows the version's picture, full size, in a box of its width and height", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 2));
		renderBody();
		const picture = await screen.findByTestId("image-body-picture");
		const img = picture.querySelector<HTMLImageElement>(
			'[data-testid="image-picture-after"]',
		);
		expect(img?.getAttribute("src")).toBe(
			"/api/images/files/file-2?conversationId=conv-1",
		);
		expect(img?.getAttribute("srcset")).toBeNull();
		expect(img).toHaveAttribute("width", "1248");
		expect(img).toHaveAttribute("height", "832");
		expect(
			screen.getByTestId("image-body-frame").style.getPropertyValue("--ratio"),
		).toBe("1.5");
		expect(api.fetchArtifact).toHaveBeenCalledWith("img-1", "conv-1");
	});

	it("shows the base under Before when the version was made from one", async () => {
		api.fetchArtifact.mockResolvedValue(
			detail(body({ baseFileId: "file-1" }), 2),
		);
		renderBody();
		const before = await screen.findByRole("button", { name: "Before" });
		await fireEvent.click(before);
		const shown = await screen.findByTestId("image-picture-before");
		expect(shown.getAttribute("src")).toBe(
			"/api/images/files/file-1?conversationId=conv-1",
		);
		expect(
			within(screen.getByTestId("image-body-picture")).getByTestId(
				"image-picture",
			),
		).toHaveAttribute("data-showing", "before");
		expect(before).toHaveAttribute("aria-pressed", "true");
	});

	it("offers no Before / After for a first picture", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 1));
		renderBody();
		await screen.findByTestId("image-body-picture");
		expect(screen.queryByRole("button", { name: "Before" })).toBeNull();
	});

	it("registers a Download of the picture's file with the chat named", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 2));
		let actions: ArtifactPanelBodyActions | null = null;
		renderBody({
			registerPanelActions: (registered: ArtifactPanelBodyActions) => {
				actions = registered;
			},
		});
		await screen.findByTestId("image-body-picture");
		await waitFor(() => expect(actions?.openDownload).toBeTypeOf("function"));
		(actions as unknown as ArtifactPanelBodyActions).openDownload?.();
		expect(api.startAuthenticatedDownload).toHaveBeenCalledWith(
			"/api/images/files/file-2?download=1&conversationId=conv-1",
		);
		expect(actions).toHaveProperty("reload");
	});

	it("loads the item again when the page hears of a newer version, and the strip reads History again", async () => {
		api.fetchArtifact.mockResolvedValueOnce(detail(body(), 2));
		const { rerender } = renderBody({ versionNumber: 2 });
		await screen.findByTestId("image-body-picture");
		await waitFor(() =>
			expect(screen.getAllByTestId("image-version-frame")).toHaveLength(2),
		);
		expect(api.fetchArtifact).toHaveBeenCalledTimes(1);

		// The same number again (a poll) changes nothing.
		await rerender({ versionNumber: 2 });
		await tick();
		expect(api.fetchArtifact).toHaveBeenCalledTimes(1);

		api.fetchArtifact.mockResolvedValueOnce(
			detail(body({ fileId: "file-3", baseFileId: "file-2" }), 3),
		);
		api.fetchArtifactHistory.mockResolvedValue(history(3));
		await rerender({ versionNumber: 3 });
		await waitFor(() =>
			expect(
				screen
					.getByTestId("image-body-picture")
					.querySelector('[data-testid="image-picture-after"]')
					?.getAttribute("src"),
			).toBe("/api/images/files/file-3?conversationId=conv-1"),
		);
		await waitFor(() =>
			expect(screen.getAllByTestId("image-version-frame")).toHaveLength(3),
		);
		expect(api.fetchArtifactHistory).toHaveBeenLastCalledWith("img-1", {
			limit: expect.any(Number),
			conversationId: "conv-1",
		});
	});

	it("opens History on a frame's version", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 2));
		const onOpenHistory = vi.fn();
		renderBody({ onOpenHistory });
		await waitFor(() =>
			expect(screen.getAllByTestId("image-version-frame")).toHaveLength(2),
		);
		await fireEvent.click(screen.getAllByTestId("image-version-frame")[0]);
		expect(onOpenHistory).toHaveBeenCalledWith("v1");
	});

	it("says so when the item cannot be read", async () => {
		api.fetchArtifact.mockRejectedValue(new Error("offline"));
		renderBody();
		expect(await screen.findByTestId("image-body-error")).toBeInTheDocument();
	});
});
