import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ImageVersionBody,
	serializeImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import { uiLanguage } from "$lib/stores/settings";

// An Image version in History (plan 2b T4): the picture, and when it has one
// before it, a wipe between the two. Bodies come through History's one shared
// memory (`version-bodies.ts`).

const bodies = vi.hoisted(() => ({ versionBody: vi.fn() }));
vi.mock("../history/version-bodies", () => ({
	versionBody: bodies.versionBody,
}));

import ImageVersionPreview from "./ImageVersionPreview.svelte";

function body(overrides: Partial<ImageVersionBody> = {}): string {
	return serializeImageVersionBody({
		v: 1,
		fileId: "file-2",
		width: 1248,
		height: 832,
		hasAlpha: false,
		baseFileId: "file-1",
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

const stored: Record<string, string> = {
	v1: body({ fileId: "file-1", baseFileId: null }),
	v2: body({
		fileId: "file-2",
		baseFileId: "file-1",
		prompt: "Make the sofa green",
		marks: [{ letter: "A", x: 0.1, y: 0.2, w: 0.2, h: 0.3 }],
	}),
	v3: body({ fileId: "file-3", baseFileId: "file-2" }),
	vAlpha: body({ fileId: "file-a", baseFileId: "file-1", hasAlpha: true }),
};

let rerenderPreview: (props: Record<string, unknown>) => Promise<void> =
	async () => {};

function renderPreview(
	overrides: Partial<{
		versionId: string;
		baseVersionId: string | null;
		compare: "step" | "now";
		title: string;
		onAttachPicture: (picture: { imageFileId: string; name: string }) => void;
	}> = {},
) {
	const onState = vi.fn();
	const view = render(ImageVersionPreview, {
		artifactId: "img-1",
		conversationId: "conv-1",
		versionId: "v2",
		baseVersionId: "v1",
		compare: "step",
		author: "alfy",
		nowVersionId: "v3",
		nowHash: "hash-3",
		label: "Today 10:12 · Alfy changed the picture",
		changeCursor: { index: -1, nonce: 0 },
		onState,
		...overrides,
	});
	rerenderPreview = async (props) => {
		await view.rerender(props);
	};
	return { onState };
}

beforeEach(() => {
	bodies.versionBody.mockImplementation(
		async ({ versionId }: { versionId: string }) => {
			if (!(versionId in stored)) throw new Error("not found");
			return stored[versionId];
		},
	);
});

afterEach(() => {
	bodies.versionBody.mockReset();
	uiLanguage.set("en");
});

describe("ImageVersionPreview Attach", () => {
	it("attaches the version's own picture, named after the item", async () => {
		const onAttachPicture = vi.fn();
		renderPreview({ onAttachPicture, title: "Cosy room" });
		const button = await screen.findByTestId("image-version-preview-attach");
		await waitFor(() => expect(button).not.toBeDisabled());
		await fireEvent.click(button);
		expect(onAttachPicture).toHaveBeenCalledWith({
			imageFileId: "file-2",
			name: "Cosy room",
		});
	});

	it("names the attached version on one line of at most 80 characters", async () => {
		const onAttachPicture = vi.fn();
		renderPreview({ onAttachPicture, title: `Cosy\nroom ${"x".repeat(100)}` });
		const button = await screen.findByTestId("image-version-preview-attach");
		await waitFor(() => expect(button).not.toBeDisabled());
		await fireEvent.click(button);
		const { name } = onAttachPicture.mock.calls[0][0];
		expect(name).not.toMatch(/\n/);
		expect(Array.from(name).length).toBeLessThanOrEqual(80);
	});

	it("keeps the Attach row while the version loads, disabled, so the picture never moves", async () => {
		renderPreview({ onAttachPicture: vi.fn(), versionId: "vMissing" });
		const button = await screen.findByTestId("image-version-preview-attach");
		expect(button).toBeDisabled();
	});

	it("draws no Attach row where the host cannot take a picture", async () => {
		renderPreview();
		await screen.findByTestId("compare-wipe-before");
		expect(screen.queryByTestId("image-version-preview-attach")).toBeNull();
	});
});

describe("ImageVersionPreview", () => {
	it("with a version before it, shows both pictures and the wipe at the middle", async () => {
		renderPreview();
		const before = await screen.findByTestId("compare-wipe-before");
		expect(before.getAttribute("src")).toContain("/api/images/files/file-1");
		expect(before.getAttribute("src")).toContain("conversationId=conv-1");
		expect(
			screen.getByTestId("compare-wipe-after").getAttribute("src"),
		).toContain("/api/images/files/file-2");
		const range = screen.getByRole("slider", {
			name: "Drag to compare",
		}) as HTMLInputElement;
		expect(range.value).toBe("50");
		await fireEvent.input(range, { target: { value: "30" } });
		await waitFor(() =>
			expect(screen.getByTestId("compare-wipe-after").style.clipPath).toBe(
				"inset(0 0 0 30%)",
			),
		);
	});

	it("a first version shows only its picture, with no wipe", async () => {
		renderPreview({ versionId: "v1", baseVersionId: null });
		await screen.findByTestId("image-version-picture");
		expect(screen.queryByTestId("compare-wipe")).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
	});

	it("compared with now, wipes against the newest version's picture", async () => {
		renderPreview({ compare: "now", baseVersionId: "v3" });
		const before = await screen.findByTestId("compare-wipe-before");
		expect(before.getAttribute("src")).toContain("/api/images/files/file-3");
		expect(
			screen.getByTestId("compare-wipe-after").getAttribute("src"),
		).toContain("/api/images/files/file-2");
	});

	it("keeps the prompt in a closed details named for it, in both languages", async () => {
		renderPreview();
		const summary = await screen.findByText("Prompt Alfy sent");
		const details = summary.closest("details");
		expect(details).not.toBeNull();
		expect(details?.open).toBe(false);
		expect(details?.textContent).toContain("Make the sofa green");
		uiLanguage.set("hu");
		await screen.findByText("Alfy utasítása");
	});

	it("draws the marks it was made with on the before side, in their colour and letter", async () => {
		renderPreview();
		const mark = await screen.findByTestId("image-version-mark");
		expect(mark.style.left).toBe("10%");
		expect(mark.style.width).toBe("20%");
		expect(mark.style.top).toBe("20%");
		expect(mark.style.height).toBe("30%");
		expect(mark.style.borderColor.toLowerCase()).toMatch(
			/#e53935|rgb\(229, 57, 53\)/,
		);
		expect(mark.textContent?.trim()).toBe("A");
		expect(screen.getByText("With marks A")).toBeTruthy();
	});

	it("draws no marks against a picture they were not drawn on (compared with now)", async () => {
		renderPreview({ compare: "now", baseVersionId: "v3" });
		await screen.findByTestId("compare-wipe-before");
		expect(screen.queryByTestId("image-version-mark")).toBeNull();
	});

	it("reports ready with no changes to step through", async () => {
		const { onState } = renderPreview();
		await waitFor(() =>
			expect(onState).toHaveBeenLastCalledWith({
				status: "ready",
				changeCount: 0,
			}),
		);
	});

	it("reports an error when a body cannot be read", async () => {
		bodies.versionBody.mockRejectedValue(new Error("offline"));
		const { onState } = renderPreview();
		await waitFor(() =>
			expect(onState).toHaveBeenLastCalledWith({
				status: "error",
				changeCount: 0,
			}),
		);
	});

	it("shows its error, never the picture before, when a body it switches to cannot be read", async () => {
		const { onState } = renderPreview();
		await screen.findByTestId("compare-wipe-after");
		await rerenderPreview({ compare: "now", baseVersionId: "v-missing" });
		expect(await screen.findByText("Could not open the picture.")).toBeTruthy();
		expect(screen.queryByTestId("compare-wipe")).toBeNull();
		expect(
			document.querySelector('img[src*="file-2"]'),
			"the picture before is still on screen",
		).toBeNull();
		expect(onState).toHaveBeenLastCalledWith({
			status: "error",
			changeCount: 0,
		});
	});

	it("puts the wipe on the checkerboard when a picture is see-through", async () => {
		renderPreview({ versionId: "vAlpha", baseVersionId: "v1" });
		const wipe = await screen.findByTestId("compare-wipe");
		expect(wipe.classList.contains("image-checkerboard")).toBe(true);
	});
});

describe("ImageVersionPreview's place in History (final fix wave, V3)", () => {
	it("hangs the picture from History's toolbar, as the Document's preview starts there, never centred in bands", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(
			path.join(here, "ImageVersionPreview.svelte"),
			"utf8",
		);
		const stage = /\.ivp-stage \{([^}]*)\}/.exec(source)?.[1] ?? "";
		expect(stage).toMatch(/place-items:\s*start center;/);
		// Still the size container the picture is fitted to (no re-flow by script).
		expect(stage).toMatch(/container-type:\s*size;/);
	});
});
