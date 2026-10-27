import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import { at, makeMoment, makeStep } from "./__fixtures__/moments";

// History opened on one version (plan 2b T3, F11): a picture strip's frame asks
// for its version, and the rail selects the entry that holds it, not the newest.
// The kind's preview is a fake that says which version it was handed.

const api = vi.hoisted(() => ({
	fetchArtifactHistory: vi.fn(),
	fetchArtifact: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: api.fetchArtifact,
	fetchArtifactHistory: api.fetchArtifactHistory,
	nameArtifactVersion: vi.fn(),
	restoreArtifactVersion: vi.fn(),
	subscribeArtifactChanges: () => () => undefined,
	VersionRestoreRefusedError: class extends Error {},
}));

vi.mock("./history-previews", () => ({
	HISTORY_PREVIEWS: {
		document: () => import("./__fixtures__/FakeVersionPreview.svelte"),
	},
	kindHasHistory: () => true,
}));

import HistoryMode from "./HistoryMode.svelte";

/** A Document's history: the newest edit, an Alfy change with the Undo folded under it, and the first draft. */
function moments() {
	return [
		makeMoment({
			versionNumber: 4,
			at: at(2026, 10, 27, 10, 31),
			isNewest: true,
			containsNewest: true,
		}),
		makeMoment({
			versionNumber: 2,
			kind: "alfy_edit",
			author: "alfy",
			fold: "undone",
			at: at(2026, 10, 27, 10, 12),
			steps: [makeStep({ versionNumber: 3, at: at(2026, 10, 27, 10, 13) })],
		}),
		makeMoment({
			versionNumber: 1,
			kind: "first_draft",
			author: "alfy",
			at: at(2026, 10, 27, 10, 0),
		}),
	];
}

function renderHistory(initialVersionId?: string) {
	return render(HistoryMode, {
		artifactId: "doc-1",
		kind: "document",
		title: "Trip notes",
		conversationId: "conv-1",
		onDone: vi.fn(),
		...(initialVersionId ? { initialVersionId } : {}),
	});
}

function selectedOption() {
	return screen
		.getAllByTestId("history-option")
		.find((option) => option.getAttribute("aria-selected") === "true");
}

beforeEach(() => {
	uiLanguage.set("en");
	// History measures its own width to pick a layout; jsdom has no observer.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	api.fetchArtifact.mockRejectedValue(new Error("not needed"));
	api.fetchArtifactHistory.mockResolvedValue({
		ok: true,
		artifactKind: "document",
		moments: moments(),
		older: false,
		nextBefore: null,
		newestVersion: 4,
		newestHash: "hash-4",
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("HistoryMode opened on a version", () => {
	it("selects the newest moment when no version is asked for", async () => {
		renderHistory();
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("m:v4"));
	});

	it("selects the entry that holds the version, a step folded under its moment included", async () => {
		renderHistory("v3");
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("s:v3"));
		await waitFor(() =>
			expect(
				screen.getAllByTestId("fake-version-preview").at(-1),
			).toHaveAttribute("data-version-id", "v3"),
		);
	});

	it("selects an older moment's own entry", async () => {
		renderHistory("v1");
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("m:v1"));
	});

	it("falls back to the newest moment for a version it does not hold", async () => {
		renderHistory("v99");
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("m:v4"));
	});
});
