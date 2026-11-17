import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReadAloud } from "$lib/client/read-aloud/controller";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import {
	idleReadAloudView,
	readAloudPlayerInPanel,
	setReadAloudAvailable,
	setReadAloudView,
} from "$lib/stores/read-aloud";
import { fakeReadAloudSource } from "./__fixtures__/fake-read-aloud";
import DocumentWorkspace from "./DocumentWorkspace.svelte";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

// Read aloud on a Document (read-aloud-documents): the speaker in the panel's
// header reads the Document its body hands the panel, and the panel draws the
// player for that reading wherever no composer beside it shows one.

vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: vi.fn(
		async (content: string) => `<pre><code>${content}</code></pre>`,
	),
}));

const realDocumentBody = ARTIFACT_BODIES.document;

const documentItem = (id = "doc-1") =>
	makeWorkspaceDocument({
		id,
		kind: "document",
		title: "Weekend plan",
		mimeType: null,
		artifactId: id,
	});

const reading = (key = "document:doc-1") => ({
	...idleReadAloudView,
	status: "playing" as const,
	key,
	target: "document" as const,
	count: 3,
	notches: [0, 0.3, 0.7],
});

describe("DocumentWorkspace: read aloud on a Document", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeReadAloudBody.svelte");
		setReadAloudAvailable(true);
	});

	afterEach(() => {
		ARTIFACT_BODIES.document = realDocumentBody;
		setReadAloudAvailable(false);
		setReadAloudView(idleReadAloudView);
		vi.restoreAllMocks();
	});

	it("puts the speaker in the Document's header, reading what its body hands the panel", async () => {
		const start = vi
			.spyOn(getReadAloud(), "start")
			.mockImplementation(() => {});
		renderWorkspace({
			documents: [documentItem()],
			activeDocumentId: "doc-1",
			conversationId: "c1",
		});
		const speaker = await screen.findByTestId("read-aloud-speaker-header");
		expect(speaker.getAttribute("aria-label")).toBe("Read aloud");
		await fireEvent.click(speaker);
		expect(start).toHaveBeenCalledWith({
			kind: "document",
			artifactId: "doc-1",
			conversationId: "c1",
			source: fakeReadAloudSource,
		});
	});

	it("draws no speaker while read aloud is off", async () => {
		setReadAloudAvailable(false);
		renderWorkspace({ documents: [documentItem()], activeDocumentId: "doc-1" });
		await screen.findByTestId("fake-read-aloud-body");
		expect(screen.queryByTestId("read-aloud-speaker-header")).toBeNull();
	});

	it("draws the player for its Document's reading where no composer shows it, and says so", async () => {
		// The Knowledge page: a panel with no chat beside it.
		render(DocumentWorkspace, {
			props: {
				open: true,
				documents: [documentItem()],
				availableDocuments: [],
				activeDocumentId: "doc-1",
				onSelectDocument: vi.fn(),
				onCloseDocument: vi.fn(),
				onCloseWorkspace: vi.fn(),
			},
		});
		await screen.findByTestId("fake-read-aloud-body");
		expect(get(readAloudPlayerInPanel)).toBe(true);
		setReadAloudView(reading());
		await tick();
		const player = await screen.findByTestId("workspace-read-aloud-player");
		expect(player.querySelector("[data-read-aloud-player]")).not.toBeNull();
		// A reading of something else is not this panel's to show.
		setReadAloudView(reading("m1"));
		await vi.waitFor(() =>
			expect(player.querySelector(".read-aloud-slot[data-open]")).toBeNull(),
		);
	});

	it("leaves the player to the composer beside a docked panel in a chat", async () => {
		renderWorkspace({
			documents: [documentItem()],
			activeDocumentId: "doc-1",
			conversationId: "c1",
			readAloudComposer: true,
		});
		await screen.findByTestId("fake-read-aloud-body");
		expect(get(readAloudPlayerInPanel)).toBe(false);
		setReadAloudView(reading());
		await tick();
		expect(screen.queryByTestId("workspace-read-aloud-player")).toBeNull();
	});

	it("draws the player itself when expanded over the chat", async () => {
		renderWorkspace({
			documents: [documentItem()],
			activeDocumentId: "doc-1",
			conversationId: "c1",
			readAloudComposer: true,
			presentation: "expanded",
		});
		await screen.findByTestId("fake-read-aloud-body");
		expect(get(readAloudPlayerInPanel)).toBe(true);
		setReadAloudView(reading());
		await tick();
		expect(
			await screen.findByTestId("workspace-read-aloud-player"),
		).toBeInTheDocument();
	});
});
