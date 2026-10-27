import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	at,
	makeMoment,
	makeStep,
} from "$lib/components/artifacts/history/__fixtures__/moments";
import { uiLanguage } from "$lib/stores/settings";
import VersionStrip from "./VersionStrip.svelte";

const imageDetail = (fileId: string) => ({
	type: "image" as const,
	fileId,
	sourceCount: 0,
});

/** History's first page, newest first, as the route answers it. */
function photoItemMoments() {
	return [
		makeMoment({
			versionNumber: 3,
			kind: "picked_take",
			author: "user",
			at: at(2026, 10, 27, 10, 20),
			detail: imageDetail("file-3"),
			isNewest: true,
			containsNewest: true,
		}),
		makeMoment({
			versionNumber: 2,
			kind: "alfy_edit",
			author: "alfy",
			at: at(2026, 10, 27, 10, 12),
			detail: imageDetail("file-2"),
		}),
		makeMoment({
			versionNumber: 1,
			kind: "user_photo",
			author: "user",
			at: at(2026, 10, 27, 10, 9),
			detail: imageDetail("file-1"),
		}),
	];
}

describe("VersionStrip", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("lists one thumbnail per version, oldest first, from History's image moments", () => {
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			conversationId: "conv-1",
			onOpenHistory: vi.fn(),
		});
		const frames = screen.getAllByTestId("image-version-frame");
		expect(frames.map((frame) => frame.dataset.versionId)).toEqual([
			"v1",
			"v2",
			"v3",
		]);
		const thumb = within(frames[0]).getByTestId("image-picture-after");
		expect(thumb.getAttribute("src")).toContain("/api/images/files/file-1");
		expect(thumb.getAttribute("src")).toContain("variant=thumb");
		expect(thumb.getAttribute("src")).toContain("conversationId=conv-1");
		expect(frames[2]).toHaveAttribute("aria-current", "true");
	});

	it("names a photo item's first frame as the photo, in words and never a version number", () => {
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			onOpenHistory: vi.fn(),
		});
		const [first, ...rest] = screen.getAllByTestId("image-version-frame");
		expect(first.getAttribute("aria-label")).toContain("Your photo");
		expect(first.getAttribute("title")).toContain("Your photo");
		for (const frame of [first, ...rest]) {
			expect(frame.getAttribute("aria-label")).not.toMatch(/\bv\d/);
		}
	});

	it("says the photo in Hungarian", () => {
		uiLanguage.set("hu");
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			onOpenHistory: vi.fn(),
		});
		expect(
			screen
				.getAllByTestId("image-version-frame")[0]
				.getAttribute("aria-label"),
		).toContain("A fotód");
	});

	it("opens History on the version a frame shows", async () => {
		const onOpenHistory = vi.fn();
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			onOpenHistory,
		});
		await fireEvent.click(screen.getAllByTestId("image-version-frame")[1]);
		expect(onOpenHistory).toHaveBeenCalledWith("v2");
	});

	it("keeps its row but shows no frames for an item with one version, so a second version moves nothing", () => {
		render(VersionStrip, {
			moments: [photoItemMoments()[2]],
			currentVersionId: "v1",
			onOpenHistory: vi.fn(),
		});
		expect(screen.getByTestId("image-version-strip")).toBeInTheDocument();
		expect(screen.queryAllByTestId("image-version-frame")).toHaveLength(0);
	});
});

describe("VersionStrip and History's moments (plan 2b T4)", () => {
	it("draws one frame per History moment, so a folded run's frame opens History on the moment the rail shows", async () => {
		uiLanguage.set("en");
		const onOpenHistory = vi.fn();
		render(VersionStrip, {
			moments: [
				// Two changes of Alfy's a minute apart fold into one moment (F4): the
				// rail shows the moment with the newer as its version.
				makeMoment({
					versionNumber: 3,
					kind: "alfy_turn",
					author: "alfy",
					fold: "alfy_turn",
					at: at(2026, 10, 27, 10, 13),
					detail: imageDetail("file-3"),
					isNewest: true,
					containsNewest: true,
					steps: [
						makeStep({ versionNumber: 2, kind: "alfy_edit", author: "alfy" }),
						makeStep({
							versionNumber: 3,
							kind: "alfy_edit",
							author: "alfy",
							isNewest: true,
						}),
					],
				}),
				makeMoment({
					versionNumber: 1,
					kind: "first_draft",
					author: "alfy",
					at: at(2026, 10, 27, 10, 0),
					detail: imageDetail("file-1"),
				}),
			],
			conversationId: "conv-1",
			onOpenHistory,
		});
		const frames = screen.getAllByTestId("image-version-frame");
		expect(frames.map((frame) => frame.dataset.versionId)).toEqual([
			"v1",
			"v3",
		]);
		// The first picture is named in the picture's own words.
		expect(frames[0].getAttribute("aria-label")).toContain(
			"Alfy made the picture",
		);
		await fireEvent.click(frames[1]);
		expect(onOpenHistory).toHaveBeenCalledWith("v3");
	});
});
