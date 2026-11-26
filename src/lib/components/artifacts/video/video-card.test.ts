// @always-run: exercises file or process inputs outside Vitest’s import graph.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ArtifactCard, {
	type ArtifactCardView,
} from "$lib/components/artifacts/ArtifactCard.svelte";
import ToolActivityRow from "$lib/components/chat/ToolActivityRow.svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import {
	buildToolActivityItem,
	type ToolActivityItem,
} from "$lib/utils/tool-activity";
import type { ToolCallSegment } from "$lib/utils/tool-evidence-presentation";
import {
	videoCard,
	videoClip,
	videoTake,
} from "./video-card-fixtures.test-helpers";

function bodyItem(metadata: Record<string, unknown>): ToolActivityItem {
	const segment = {
		type: "tool_call",
		name: "make_video",
		input: { motion: "waves rolling in", title: "Harbour at dawn" },
		status: "done",
		metadata,
	} as ToolCallSegment;
	return buildToolActivityItem(segment, "video-row", get(t));
}

function view(over: Partial<ArtifactCardView> = {}): ArtifactCardView {
	return {
		id: "video-1",
		kind: "video",
		title: "Harbour at dawn",
		subtitle: "Video",
		openTargetId: "video-1",
		...over,
	};
}

beforeEach(async () => {
	uiLanguage.set("en");
	// Warm the card body's lazy import, so the tests wait only for the card's
	// own update rather than a module race.
	await import("./VideoCardBody.svelte");
});

describe("ArtifactCard, the Video kind", () => {
	it("draws its head and body together, with the picture card's chrome and the head's Open", async () => {
		render(ArtifactCard, {
			view: view(),
			videoCard: videoCard(videoTake({ clip: videoClip() })),
		});
		const body = await screen.findByTestId("video-card-body");
		const head = screen.getByTestId("artifact-card-head");
		expect(head).toHaveTextContent("Harbour at dawn");
		expect(head).toHaveTextContent("Video");
		expect(head).toHaveTextContent("Open");
		expect(screen.getByTestId("artifact-card")).toContainElement(body);
		expect(screen.getByTestId("artifact-card").textContent).not.toMatch(
			/artifact/i,
		);
	});

	it("loads its body with a dynamic import, never a static one", () => {
		// The card body must stay out of the chat route's first load
		// (`check:artifact-chunks` holds the built graph to it); this holds the
		// source it is built from.
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/ArtifactCard.svelte`,
			"utf-8",
		);
		expect(source).toMatch(/import\("\.\/video\/VideoCardBody\.svelte"\)/);
		expect(source).not.toMatch(
			/^import\s+VideoCardBody\s+from\s+"\.\/video\/VideoCardBody\.svelte"/m,
		);
	});

	it("holds its Open in place while the clip is being made", async () => {
		render(ArtifactCard, {
			view: view({ openTargetId: null }),
			videoCard: videoCard(
				videoTake({
					status: "running",
					phase: "rendering",
					phaseAt: Date.now(),
					clip: null,
				}),
			),
		});
		await screen.findByTestId("video-card-body");
		expect(screen.getByTestId("artifact-card-head")).toHaveTextContent("Open");
	});

	it("says a deleted video was deleted, and keeps its box (as the picture card does)", async () => {
		render(ArtifactCard, {
			view: view({
				openTargetId: null,
				deleted: true,
				subtitle: "This video was deleted",
			}),
			videoCard: videoCard(),
		});
		const gone = await screen.findByTestId("video-card-gone");
		expect(gone).toHaveTextContent("The video is no longer kept.");
		expect(screen.getByTestId("artifact-card-head")).toHaveTextContent(
			"This video was deleted",
		);
		expect(screen.queryByTestId("artifact-card-regenerate")).toBeNull();
		expect(screen.queryByTestId("video-player-media")).toBeNull();
	});
});

describe("ToolActivityRow, a make_video call", () => {
	it("carries the video card under its row, opening the item in the panel", async () => {
		const built = bodyItem({
			ok: true,
			videoStatus: "succeeded",
			videoCardId: "video-card-1",
		});
		expect(built.body).toMatchObject({ kind: "video-card" });
		expect(built.alwaysOpen).toBe(true);
		const onOpenDocument = vi.fn();
		const onVideoAction = vi.fn(async () => undefined);
		const card = videoCard(videoTake({ clip: videoClip() }));
		render(ToolActivityRow, {
			item: { ...built, body: { ...built.body, card } } as ToolActivityItem,
			onOpenDocument,
			onVideoAction,
		});
		const head = await screen.findByTestId("artifact-card-head");
		expect(head).toHaveTextContent("Harbour at dawn");
		await fireEvent.click(head);
		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({ artifactId: "video-1", kind: "video" }),
		);
		await fireEvent.click(screen.getByTestId("video-card-another"));
		expect(onVideoAction).toHaveBeenCalledWith({
			type: "another",
			cardId: "video-card-1",
		});
	});

	it("keeps its own words, not the picture card's, for a refused video", () => {
		const built = bodyItem({
			ok: false,
			videoStatus: "failed",
			videoError: "video_blocked",
		});
		expect(built.verb).toBe("The video was blocked");
		expect(built.body).toEqual({ kind: "reason", text: expect.any(String) });
	});

	it("says it is making a video while the call runs", () => {
		const segment = {
			type: "tool_call",
			name: "make_video",
			input: { title: "Harbour at dawn" },
			status: "running",
			metadata: {},
		} as ToolCallSegment;
		const built = buildToolActivityItem(segment, "video-row", get(t));
		expect(built.verb).toBe("Making a video");
		expect(built.body).toMatchObject({ kind: "video-card", cardId: null });
		expect(within(document.body).queryByText("Making a picture")).toBeNull();
	});
});
