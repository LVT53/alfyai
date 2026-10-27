import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import { fakePreviewStatus } from "./__fixtures__/fake-preview-status";
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

describe("HistoryMode for an Image (plan 2b T4)", () => {
	it("hands the chat's scope to the rail, so an incognito chat's thumbnails load (F25)", async () => {
		api.fetchArtifactHistory.mockResolvedValue({
			ok: true,
			artifactKind: "image",
			moments: [
				makeMoment({
					versionNumber: 2,
					kind: "alfy_edit",
					author: "alfy",
					isNewest: true,
					containsNewest: true,
					detail: { type: "image", fileId: "file-2", sourceCount: 1 },
				}),
				makeMoment({
					versionNumber: 1,
					kind: "first_draft",
					author: "alfy",
					detail: { type: "image", fileId: "file-1", sourceCount: 0 },
				}),
			],
			older: false,
			nextBefore: null,
			newestVersion: 2,
			newestHash: "hash-2",
		});
		render(HistoryMode, {
			artifactId: "img-1",
			kind: "image",
			title: "Cosy room",
			conversationId: "conv-incognito",
			onDone: vi.fn(),
		});
		const thumbs = await screen.findAllByTestId("history-thumb");
		expect(thumbs[0].querySelector("img")?.getAttribute("src")).toBe(
			"/api/images/files/file-2?variant=thumb&conversationId=conv-incognito",
		);
	});
});

describe("HistoryMode when a version's preview fails (plan 2b T4 fix round 1)", () => {
	afterEach(() => {
		fakePreviewStatus.value = "ready";
	});

	it("offers no Restore on a version it could not show, and says why", async () => {
		fakePreviewStatus.value = "error";
		renderHistory("v1");
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("m:v1"));
		await screen.findAllByTestId("fake-version-preview");
		await waitFor(() =>
			expect(screen.queryByTestId("history-restore")).toBeNull(),
		);
		expect(screen.getByTestId("history-restore-note").textContent).toBe(
			"This version didn't open.",
		);
	});

	it("offers Restore on the same version once its preview shows it", async () => {
		renderHistory("v1");
		await waitFor(() => expect(selectedOption()?.dataset.key).toBe("m:v1"));
		expect(await screen.findByTestId("history-restore")).toBeTruthy();
	});
});
