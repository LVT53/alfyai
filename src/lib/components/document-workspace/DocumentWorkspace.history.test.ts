import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

// History, the open item's mode, as the panel and its host agree on it (FX-2): the
// host can ask for it (`historyWanted`: the browser's Back and Forward move through
// it as a layer of the host's history entries) and is told what actually happened
// (`onHistoryOpenChange`). The mode itself is `history/HistoryMode.svelte`'s; here a
// fake stands in for its lazy chunk.

vi.mock("$lib/components/artifacts/history/history-parts", async () => ({
	HistoryMode: (await import("./__fixtures__/FakeHistoryMode.svelte")).default,
}));

const documentItem = () =>
	makeWorkspaceDocument({
		id: "doc-1",
		artifactId: "doc-1",
		kind: "document",
		title: "Trip notes",
		// The header's History button is the latest moment, so the item has one.
		versionNumber: 3,
		updatedAt: Date.now() - 12 * 60 * 1000,
		lastAuthor: "alfy",
		lastKind: "alfy_edit",
		mimeType: null,
	});

/** Incognito: no tour is asked for, so these tests are about History and nothing else. */
function openDocument(extra: Parameters<typeof renderWorkspace>[0] = {}) {
	return renderWorkspace({
		documents: [documentItem()],
		activeDocumentId: "doc-1",
		incognito: true,
		...extra,
	});
}

/** The panel's own landmark (named for what it shows), once its header's History button is a real button. */
async function historyButton() {
	return waitFor(() => {
		const shell = screen.getAllByRole("complementary", {
			name: /, (Document|App|Canvas|Slides|File)$/,
		})[0];
		return within(shell).getByTestId("artifact-history-button");
	});
}

beforeEach(() => {
	// Reduced motion: History's slot is gone the moment it is left, not after its fade.
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
	ARTIFACT_BODIES.document = () =>
		import("./__fixtures__/FakeVersionedArtifactBody.svelte");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete ARTIFACT_BODIES.document;
});

describe("DocumentWorkspace: History as the host's layer", () => {
	it("tells the host when History opens and when it closes, whoever did it", async () => {
		const onHistoryOpenChange = vi.fn();
		openDocument({ onHistoryOpenChange });
		await waitFor(() =>
			expect(onHistoryOpenChange).toHaveBeenLastCalledWith(false),
		);

		await fireEvent.click(await historyButton());
		await screen.findByTestId("fake-history");
		await waitFor(() =>
			expect(onHistoryOpenChange).toHaveBeenLastCalledWith(true),
		);

		await fireEvent.click(screen.getByTestId("fake-history-done"));
		await waitFor(() =>
			expect(screen.queryByTestId("fake-history")).toBeNull(),
		);
		expect(onHistoryOpenChange).toHaveBeenLastCalledWith(false);
	});

	it("opens when the host wishes it and leaves when it no longer does", async () => {
		const onHistoryOpenChange = vi.fn();
		const { rerender } = openDocument({
			historyWanted: false,
			onHistoryOpenChange,
		});
		await historyButton();
		expect(screen.queryByTestId("fake-history")).toBeNull();

		await rerender({ historyWanted: true });
		await screen.findByTestId("fake-history");
		await waitFor(() =>
			expect(onHistoryOpenChange).toHaveBeenLastCalledWith(true),
		);

		await rerender({ historyWanted: false });
		await waitFor(() =>
			expect(screen.queryByTestId("fake-history")).toBeNull(),
		);
		expect(onHistoryOpenChange).toHaveBeenLastCalledWith(false);
	});

	it("does not loop: a wish the panel is already in changes nothing, and a press the host then wishes for is not opened twice", async () => {
		const onHistoryOpenChange = vi.fn();
		const { rerender } = openDocument({
			historyWanted: false,
			onHistoryOpenChange,
		});
		await fireEvent.click(await historyButton());
		await screen.findByTestId("fake-history");

		// The host follows what it was told.
		await rerender({ historyWanted: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(screen.getAllByTestId("fake-history")).toHaveLength(1);
	});

	it("drops the wish when the item has no History to open", async () => {
		ARTIFACT_BODIES.file = () =>
			import("./__fixtures__/FakeVersionedArtifactBody.svelte");
		const onHistoryOpenChange = vi.fn();
		openDocument({
			documents: [
				makeWorkspaceDocument({
					id: "file-1",
					artifactId: "file-1",
					kind: "file",
					title: "Summary.pdf",
				}),
			],
			activeDocumentId: "file-1",
			historyWanted: true,
			onHistoryOpenChange,
		});

		await waitFor(() =>
			expect(onHistoryOpenChange).toHaveBeenLastCalledWith(false),
		);
		expect(screen.queryByTestId("fake-history")).toBeNull();
		delete ARTIFACT_BODIES.file;
	});

	it("goes with the item: showing the list, or closing the panel, leaves History", async () => {
		const onHistoryOpenChange = vi.fn();
		const { rerender } = openDocument({
			list: { open: false, items: [documentItem()] },
			onHistoryOpenChange,
		});
		await fireEvent.click(await historyButton());
		await screen.findByTestId("fake-history");

		await rerender({ list: { open: true, items: [documentItem()] } });
		await waitFor(() =>
			expect(screen.queryByTestId("fake-history")).toBeNull(),
		);
		expect(onHistoryOpenChange).toHaveBeenLastCalledWith(false);

		// Back on the item, History is not still open under it.
		await rerender({ list: { open: false, items: [documentItem()] } });
		await historyButton();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(screen.queryByTestId("fake-history")).toBeNull();
	});

	it("asks for nothing and reports nothing a host that does not take part cares about", async () => {
		// No `historyWanted`, no callback: the panel alone says (the Knowledge page).
		openDocument();
		await fireEvent.click(await historyButton());
		await screen.findByTestId("fake-history");
		await fireEvent.click(screen.getByTestId("fake-history-done"));
		await waitFor(() =>
			expect(screen.queryByTestId("fake-history")).toBeNull(),
		);
	});
});
