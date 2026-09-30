import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import DocumentWorkspace from "./DocumentWorkspace.svelte";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

// A body can ask the panel to open an item in its own viewer (a Canvas's File
// block names a file). The panel answers through the host's one open — the same
// the chat's cards use — and gives a body nothing to call where the host has none.

vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: vi.fn(
		async (content: string) => `<pre><code>${content}</code></pre>`,
	),
}));

const canvasItem = () =>
	makeWorkspaceDocument({
		id: "board-1",
		kind: "canvas",
		title: "Weekend board",
		mimeType: null,
		artifactId: "board-1",
	});

describe("DocumentWorkspace: a body opening an item", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		ARTIFACT_BODIES.canvas = () =>
			import("./__fixtures__/FakeOpenItemBody.svelte");
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.canvas;
	});

	it("hands the item to the host's own open, exactly as the body gave it", async () => {
		const { onOpenDocument } = renderWorkspace({
			documents: [canvasItem()],
			activeDocumentId: "board-1",
		});

		await fireEvent.click(await screen.findByTestId("fake-open-item"));

		expect(onOpenDocument).toHaveBeenCalledTimes(1);
		expect(onOpenDocument).toHaveBeenCalledWith({
			id: "chat-file-1",
			source: "chat_generated_file",
			filename: "trip.pdf",
			title: "trip.pdf",
			mimeType: "application/pdf",
		});
	});

	it("gives the body a way to open when the host can", async () => {
		renderWorkspace({ documents: [canvasItem()], activeDocumentId: "board-1" });
		expect((await screen.findByTestId("fake-open-item")).dataset.canOpen).toBe(
			"true",
		);
	});

	it("gives the body nothing to call where the host has no open (the Knowledge page)", async () => {
		render(DocumentWorkspace, {
			props: {
				open: true,
				documents: [canvasItem()],
				availableDocuments: [],
				activeDocumentId: "board-1",
				onSelectDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
		});
		expect((await screen.findByTestId("fake-open-item")).dataset.canOpen).toBe(
			"false",
		);
	});
});
