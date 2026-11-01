import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("attaches a frame's own picture, named after the item, without opening History", async () => {
		const onAttachPicture = vi.fn();
		const onOpenHistory = vi.fn();
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			title: "Cosy room",
			onOpenHistory,
			onAttachPicture,
		});
		const attach = screen.getAllByTestId("image-version-attach");
		expect(attach).toHaveLength(3);
		await fireEvent.click(attach[0]);
		expect(onAttachPicture).toHaveBeenCalledWith({
			imageFileId: "file-1",
			name: "Cosy room",
			at: expect.any(Number),
		});
		expect(onOpenHistory).not.toHaveBeenCalled();
	});

	it("names an attached frame on one line of at most 80 characters", async () => {
		const onAttachPicture = vi.fn();
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			title: `Cosy\nroom ${"x".repeat(100)}`,
			onAttachPicture,
		});
		await fireEvent.click(screen.getAllByTestId("image-version-attach")[0]);
		const { name } = onAttachPicture.mock.calls[0][0];
		expect(name).not.toMatch(/\n/);
		expect(Array.from(name).length).toBeLessThanOrEqual(80);
	});

	it("draws the Attach dot at least 24 px across (WCAG 2.5.8)", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "VersionStrip.svelte"),
			"utf-8",
		);
		const rule = source.slice(source.indexOf(".attach {"));
		expect(rule.slice(0, 400)).toContain("width: 1.5rem");
		expect(rule.slice(0, 400)).toContain("height: 1.5rem");
	});

	it("draws no Attach where the host cannot take a picture", () => {
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
		});
		expect(screen.queryByTestId("image-version-attach")).toBeNull();
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

// Final review B-I5: on a phone the strip shows about two frames, and the
// current one (always last: oldest first) was the one cut in half.
describe("VersionStrip on a narrow row", () => {
	const FRAME = 56;
	const GAP = 6;
	let restore: () => void = () => {};

	beforeEach(() => {
		uiLanguage.set("en");
		// A 130 px strip holding three 56 px frames: the layout jsdom lacks.
		const rect = Object.getOwnPropertyDescriptor(
			Element.prototype,
			"getBoundingClientRect",
		);
		const widths = ["clientWidth", "scrollWidth"].map((name) => [
			name,
			Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
		]);
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const strip = this.closest('[data-testid="image-version-strip"]');
			const scrollLeft = strip ? (strip as HTMLElement).scrollLeft : 0;
			const index = ["v1", "v2", "v3"].indexOf(
				(this as HTMLElement).dataset?.versionId ?? "",
			);
			const left = index < 0 ? 0 : index * (FRAME + GAP) - scrollLeft;
			const width = index < 0 ? 130 : FRAME;
			return {
				left,
				right: left + width,
				width,
				top: 0,
				bottom: FRAME,
				height: FRAME,
				x: left,
				y: 0,
				toJSON: () => ({}),
			} as DOMRect;
		};
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get(this: HTMLElement) {
				return this.dataset?.testid === "image-version-strip" ? 130 : 0;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
			configurable: true,
			get(this: HTMLElement) {
				return this.dataset?.testid === "image-version-strip"
					? 3 * FRAME + 2 * GAP
					: 0;
			},
		});
		restore = () => {
			if (rect)
				Object.defineProperty(Element.prototype, "getBoundingClientRect", rect);
			for (const [name, descriptor] of widths) {
				if (descriptor)
					Object.defineProperty(
						HTMLElement.prototype,
						name as string,
						descriptor as PropertyDescriptor,
					);
				else
					delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
						name as string
					];
			}
		};
	});

	afterEach(() => restore());

	it("scrolls the current frame whole into view and fades the side that hides frames", async () => {
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v3",
			conversationId: "conv-1",
			onOpenHistory: vi.fn(),
		});
		const strip = screen.getByTestId("image-version-strip");
		await waitFor(() =>
			expect(strip.scrollLeft).toBe(3 * FRAME + 2 * GAP - 130),
		);
		await waitFor(() => expect(strip).toHaveClass("fade-start"));
		expect(strip).not.toHaveClass("fade-end");
	});

	it("fades the end while the current frame is the first", async () => {
		render(VersionStrip, {
			moments: photoItemMoments(),
			currentVersionId: "v1",
			conversationId: "conv-1",
			onOpenHistory: vi.fn(),
		});
		const strip = screen.getByTestId("image-version-strip");
		await waitFor(() => expect(strip).toHaveClass("fade-end"));
		expect(strip.scrollLeft).toBe(0);
		expect(strip).not.toHaveClass("fade-start");
	});
});
