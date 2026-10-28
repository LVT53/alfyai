import { readFileSync } from "node:fs";
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
	type ImageMarksRequest,
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
		// After stays until Before has loaded.
		await fireEvent.load(shown);
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

	it("hands the panel's Attach to the strip, named after the item", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 2));
		const onAttachPicture = vi.fn();
		renderBody({ onAttachPicture });
		await waitFor(() =>
			expect(screen.getAllByTestId("image-version-attach")).toHaveLength(2),
		);
		await fireEvent.click(screen.getAllByTestId("image-version-attach")[1]);
		expect(onAttachPicture).toHaveBeenCalledWith({
			imageFileId: "file-2",
			name: "Cosy room",
			at: expect.any(Number),
		});
	});

	it("says so when the item cannot be read", async () => {
		api.fetchArtifact.mockRejectedValue(new Error("offline"));
		renderBody();
		expect(await screen.findByTestId("image-body-error")).toBeInTheDocument();
	});

	it("loads again when a reload is asked for while a load is still out", async () => {
		let answerFirst: (value: unknown) => void = () => undefined;
		api.fetchArtifact.mockImplementationOnce(
			() => new Promise((resolve) => (answerFirst = resolve)),
		);
		api.fetchArtifact.mockResolvedValueOnce(
			detail(body({ fileId: "file-3", baseFileId: "file-2" }), 3),
		);
		let actions: ArtifactPanelBodyActions | null = null;
		renderBody({
			registerPanelActions: (registered: ArtifactPanelBodyActions) => {
				actions = registered;
			},
		});
		await waitFor(() => expect(actions?.reload).toBeTypeOf("function"));
		// A restore wrote version 3 while the first read (of version 2) was out.
		(actions as unknown as ArtifactPanelBodyActions).reload?.();
		answerFirst(detail(body(), 2));
		await waitFor(() =>
			expect(
				screen
					.getByTestId("image-body-picture")
					.querySelector('[data-testid="image-picture-after"]')
					?.getAttribute("src"),
			).toBe("/api/images/files/file-3?conversationId=conv-1"),
		);
		expect(api.fetchArtifact).toHaveBeenCalledTimes(2);
	});

	it("keeps the strip of the latest History read when an older read answers last", async () => {
		api.fetchArtifact.mockResolvedValue(detail(body(), 2));
		let answerFirst: (value: unknown) => void = () => undefined;
		api.fetchArtifactHistory.mockImplementationOnce(
			() => new Promise((resolve) => (answerFirst = resolve)),
		);
		api.fetchArtifactHistory.mockResolvedValueOnce(history(3));
		const { rerender } = renderBody({ versionNumber: 2 });
		await screen.findByTestId("image-body-picture");
		api.fetchArtifact.mockResolvedValue(
			detail(body({ fileId: "file-3", baseFileId: "file-2" }), 3),
		);
		await rerender({ versionNumber: 3 });
		await waitFor(() =>
			expect(screen.getAllByTestId("image-version-frame")).toHaveLength(3),
		);
		answerFirst(history(2));
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.getAllByTestId("image-version-frame")).toHaveLength(3);
	});

	it("keeps Before / After in the strip's row under the picture, so the picture has the rest of the height", async () => {
		api.fetchArtifact.mockResolvedValue(
			detail(body({ baseFileId: "file-1" }), 2),
		);
		renderBody();
		const before = await screen.findByRole("button", { name: "Before" });
		const foot = screen.getByTestId("image-body-foot");
		expect(foot).toContainElement(before);
		expect(foot).toContainElement(screen.getByTestId("image-version-strip"));
		// Nothing of the panel's own sits above the picture.
		const stage = screen.getByTestId("image-body-stage");
		expect(stage.previousElementSibling).toBeNull();
	});

	describe("Mark (T6)", () => {
		function pointer(type: string, x: number, y: number): Event {
			const event = new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
			});
			Object.defineProperty(event, "pointerId", { value: 1 });
			Object.defineProperty(event, "pointerType", { value: "mouse" });
			return event;
		}

		/** The layer is 400 x 200 at the page's corner. */
		async function drag(from: [number, number], to: [number, number]) {
			const layer = screen.getByTestId("mark-layer");
			layer.getBoundingClientRect = () =>
				({
					left: 0,
					top: 0,
					x: 0,
					y: 0,
					width: 400,
					height: 200,
					right: 400,
					bottom: 200,
					toJSON: () => ({}),
				}) as DOMRect;
			await fireEvent(layer, pointer("pointerdown", ...from));
			await fireEvent(layer, pointer("pointermove", ...to));
			await fireEvent(layer, pointer("pointerup", ...to));
			await tick();
		}

		/** The body as the panel holds it: the page keeps the marks and hands them back. */
		async function renderMarking(stored = body()) {
			api.fetchArtifact.mockResolvedValue(detail(stored, 2));
			const onMarksChange = vi.fn();
			const view = renderBody({
				marks: null,
				onMarksChange: (request: ImageMarksRequest | null) => {
					onMarksChange(request);
					void view.rerender({ marks: request });
				},
			});
			await screen.findByTestId("image-body-picture");
			return { ...view, onMarksChange };
		}

		it("offers no Mark where nothing can take the marks (the Knowledge page)", async () => {
			api.fetchArtifact.mockResolvedValue(detail(body(), 2));
			renderBody();
			await screen.findByTestId("image-body-picture");
			expect(screen.queryByRole("button", { name: "Mark" })).toBeNull();
		});

		it("draws a box with Mark on and hands the page the marks on this picture's file", async () => {
			const view = await renderMarking();
			const mark = screen.getByRole("button", { name: "Mark" });
			expect(mark).toHaveAttribute("aria-pressed", "false");
			await drag([40, 20], [200, 120]);
			expect(view.onMarksChange).not.toHaveBeenCalled();

			await fireEvent.click(mark);
			expect(mark).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByText("Drag to draw a box")).toBeTruthy();
			await drag([40, 20], [200, 120]);
			expect(view.onMarksChange).toHaveBeenLastCalledWith({
				imageFileId: "file-2",
				marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.5 }],
			});
			expect(
				screen.getByRole("button", { name: "Mark A, tap to remove" }),
			).toBeTruthy();
			// The layer lives in the picture's own rectangle, which the zoom transforms.
			expect(screen.getByTestId("image-body-frame")).toContainElement(
				screen.getByTestId("mark-layer"),
			);
		});

		it("hands the page no marks once the last box is removed", async () => {
			const view = await renderMarking();
			await fireEvent.click(screen.getByRole("button", { name: "Mark" }));
			await drag([40, 20], [200, 120]);
			await fireEvent.click(
				screen.getByRole("button", { name: "Mark A, tap to remove" }),
			);
			expect(view.onMarksChange).toHaveBeenLastCalledWith(null);
		});

		it("keeps Mark on when its own last box is removed", async () => {
			await renderMarking();
			const mark = screen.getByRole("button", { name: "Mark" });
			await fireEvent.click(mark);
			await drag([40, 20], [200, 120]);
			await fireEvent.click(
				screen.getByRole("button", { name: "Mark A, tap to remove" }),
			);
			await tick();
			expect(mark).toHaveAttribute("aria-pressed", "true");
		});

		// Task 17 (rehearsal): after a marked message was sent the page let its
		// marks go, but Mark stayed armed, so the next drag drew a new box. Marks
		// the page lets go (sent, queued, or the chip's ×) switch the tool off.
		it("switches Mark off when the page lets the marks go (the message was sent)", async () => {
			const view = await renderMarking();
			const mark = screen.getByRole("button", { name: "Mark" });
			await fireEvent.click(mark);
			await drag([40, 20], [200, 120]);
			expect(mark).toHaveAttribute("aria-pressed", "true");

			await view.rerender({ marks: null });
			await tick();
			expect(mark).toHaveAttribute("aria-pressed", "false");
			expect(screen.queryByText("Drag to draw a box")).toBeNull();
		});

		it("says Up to 8 marks when a ninth box is drawn, in English and Hungarian", async () => {
			await renderMarking();
			await fireEvent.click(screen.getByRole("button", { name: "Mark" }));
			for (let index = 0; index < 9; index++) {
				const left = index * 40;
				await drag([left + 2, 20], [left + 30, 100]);
			}
			expect(screen.getAllByTestId("mark-box")).toHaveLength(8);
			expect(screen.getByRole("status")).toHaveTextContent("Up to 8 marks");
			uiLanguage.set("hu");
			await tick();
			expect(screen.getByRole("status")).toHaveTextContent(
				"Legfeljebb 8 jelölés",
			);
		});

		it("turns Mark off and holds it off while Before is showing", async () => {
			await renderMarking(body({ baseFileId: "file-1" }));
			const mark = screen.getByRole("button", { name: "Mark" });
			await fireEvent.click(mark);
			await fireEvent.click(screen.getByRole("button", { name: "Before" }));
			expect(mark).toHaveAttribute("aria-pressed", "false");
			expect(mark).toBeDisabled();
			await fireEvent.click(screen.getByRole("button", { name: "After" }));
			expect(mark).not.toBeDisabled();
		});

		it("shows no marks drawn on another picture, and lets them go (a restored turn's marks on an older version)", async () => {
			api.fetchArtifact.mockResolvedValue(
				detail(body({ fileId: "file-3", baseFileId: "file-2" }), 3),
			);
			const onMarksChange = vi.fn();
			renderBody({
				marks: {
					imageFileId: "file-2",
					marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.5 }],
				},
				onMarksChange,
			});
			await screen.findByTestId("image-body-picture");
			expect(screen.queryByTestId("mark-box")).toBeNull();
			await waitFor(() => expect(onMarksChange).toHaveBeenCalledWith(null));
		});

		it("lets the marks go when a newer picture lands in the open body", async () => {
			const view = await renderMarking();
			await fireEvent.click(screen.getByRole("button", { name: "Mark" }));
			await drag([40, 20], [200, 120]);
			api.fetchArtifact.mockResolvedValue(
				detail(body({ fileId: "file-3", baseFileId: "file-2" }), 3),
			);
			await view.rerender({ versionNumber: 3 });
			await waitFor(() =>
				expect(view.onMarksChange).toHaveBeenLastCalledWith(null),
			);
		});
	});
});

// Task 12 (crowding with the sidebar open): expanded, the picture filled the stage
// to within 12 px of the header and the tools row; the body's room is the family's
// space tokens, not literal rems.
describe("the panel body's room", () => {
	const source = readFileSync(
		`${process.cwd()}/src/lib/components/artifacts/image/ImageBody.svelte`,
		"utf-8",
	);
	const rule = (name: string) =>
		source.match(new RegExp(`\\n\\t\\.${name} \\{([\\s\\S]*?)\\n\\t\\}`))?.[1] ?? "";

	it("pads the body and spaces the picture from its row with space tokens", () => {
		expect(rule("image-body")).toMatch(/padding:\s*var\(--space-md\)/);
		expect(rule("image-body")).toMatch(/gap:\s*var\(--space-md\)/);
		expect(rule("image-body")).not.toMatch(/\d(\.\d+)?rem/);
	});

	it("spaces the tools row with space tokens", () => {
		expect(rule("image-body-foot")).toMatch(/gap:\s*var\(--space-/);
		expect(rule("image-body-toolbar")).toMatch(/gap:\s*var\(--space-/);
	});
});
