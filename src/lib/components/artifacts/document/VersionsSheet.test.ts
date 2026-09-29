import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import { toasts } from "$lib/stores/toast";
import VersionsSheet from "./VersionsSheet.svelte";

const { mockFetchVersions, mockRestoreVersion } = vi.hoisted(() => ({
	mockFetchVersions: vi.fn(),
	mockRestoreVersion: vi.fn(),
}));

vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifactVersions: mockFetchVersions,
	restoreArtifactVersion: mockRestoreVersion,
}));

const VERSIONS = [
	{
		id: "v3",
		versionNumber: 3,
		author: "user",
		summary: "Shortened Saturday",
		createdAt: Date.now(),
	},
	{
		id: "v2",
		versionNumber: 2,
		author: "alfy",
		summary: "Added bookings table",
		createdAt: Date.now() - 60_000,
	},
	{
		id: "v1",
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		createdAt: Date.now() - 120_000,
	},
];

// jsdom's default `window.innerWidth` (1024) is above the phone threshold
// (`isPhoneViewport`, 640px), so every test here — like `AppBody.test.ts`'s
// own regenerate-popover suite — exercises the DESKTOP popover branch. The
// phone `DialogShell` sheet branch reuses the same `versionsList` snippet and
// is covered by `DialogShell.test.ts` plus the Playwright suite (per the
// brief: real viewport-driven behaviour belongs there, not in jsdom).
describe("VersionsSheet", () => {
	beforeEach(() => {
		mockFetchVersions.mockReset();
		mockRestoreVersion.mockReset();
		toasts.set([]);
	});

	afterEach(() => {
		cleanup();
		uiLanguage.set("en");
	});

	it("lists versions newest first, each with author, version number and summary, the newest marked Current", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
		expect(screen.getByText("Current")).toBeInTheDocument();
		expect(screen.getAllByText("You")).toHaveLength(1);
		expect(screen.getAllByText("Alfy")).toHaveLength(2);
		expect(screen.getByText("v3")).toBeInTheDocument();
		expect(screen.getByText("v2")).toBeInTheDocument();
		expect(screen.getByText("v1")).toBeInTheDocument();
		// Only the two non-current rows offer Restore.
		expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
	});

	// rd/review-2-5.md:272-275 — the user-authored row showed a placeholder
	// "U" instead of the signed-in user's real avatar.
	it("shows a placeholder 'U' on the user-authored row when the caller supplies no current user", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });
		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
		// Portaled onto <body> (`portalToBody`), not inside the render container
		// — see "renders as an anchored popover naming Versions" below.
		expect(document.querySelector(".avatar-circle")?.textContent?.trim()).toBe(
			"U",
		);
	});

	it("shows the signed-in user's own initial on the user-authored row once the caller supplies currentUserId/currentUserName", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);

		render(VersionsSheet, {
			artifactId: "artifact-1",
			onClose: vi.fn(),
			currentUserId: "alice-1",
			currentUserName: "Alice",
		});
		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
		expect(document.querySelector(".avatar-circle")?.textContent?.trim()).toBe(
			"A",
		);
	});

	// rd/review-2-5.md:256-260 — the save route's own literal "Edited" and the
	// restore handler's own "restored …" wrapper were shown verbatim, English
	// even under a Hungarian UI. An Alfy-authored free-form summary (e.g.
	// "Shortened Saturday", already covered by the very first test above) is
	// real content and stays exactly as stored, in every locale.
	describe("localized version summaries", () => {
		it('localizes the save route\'s own literal "Edited" summary', async () => {
			mockFetchVersions.mockResolvedValue([
				{
					id: "v1",
					versionNumber: 1,
					author: "user",
					summary: "Edited",
					createdAt: Date.now(),
				},
			]);
			uiLanguage.set("hu");

			render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

			await waitFor(() => {
				expect(screen.getByText("Szerkesztve")).toBeInTheDocument();
			});
			expect(screen.queryByText("Edited")).not.toBeInTheDocument();
		});

		it('localizes the "restored …" wrapper, keeping an Alfy-authored inner summary as-is', async () => {
			mockFetchVersions.mockResolvedValue([
				{
					id: "v2",
					versionNumber: 2,
					author: "user",
					summary: "restored Shortened Saturday",
					createdAt: Date.now(),
				},
			]);
			uiLanguage.set("hu");

			render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

			await waitFor(() => {
				expect(
					screen.getByText("visszaállítva: Shortened Saturday"),
				).toBeInTheDocument();
			});
		});

		it('localizes BOTH layers when "restored …" wraps the save route\'s own "Edited"', async () => {
			mockFetchVersions.mockResolvedValue([
				{
					id: "v3",
					versionNumber: 3,
					author: "user",
					summary: "restored Edited",
					createdAt: Date.now(),
				},
			]);
			uiLanguage.set("hu");

			render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

			await waitFor(() => {
				expect(
					screen.getByText("visszaállítva: Szerkesztve"),
				).toBeInTheDocument();
			});
		});

		it("shows an Alfy-authored free-form summary exactly as stored, even in Hungarian", async () => {
			mockFetchVersions.mockResolvedValue([
				{
					id: "v4",
					versionNumber: 4,
					author: "alfy",
					summary: "Booked the hotel",
					createdAt: Date.now(),
				},
			]);
			uiLanguage.set("hu");

			render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

			await waitFor(() => {
				expect(screen.getByText("Booked the hotel")).toBeInTheDocument();
			});
		});
	});

	it("renders as an anchored popover naming Versions", async () => {
		mockFetchVersions.mockResolvedValue([]);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		const dialog = await screen.findByRole("dialog", { name: "Versions" });
		expect(dialog).toBeInTheDocument();
		// Portaled straight onto <body> (`portalToBody`) rather than nested
		// somewhere the panel's own overflow could clip it.
		expect(dialog.parentElement).toBe(document.body);
	});

	it("restores a version after an inline confirm (never a modal), closes, and offers Undo", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);
		mockRestoreVersion.mockResolvedValue(4);
		const onRestored = vi.fn();

		render(VersionsSheet, {
			artifactId: "artifact-1",
			conversationId: "conv-1",
			onClose: vi.fn(),
			onRestored,
		});

		await waitFor(() => screen.getByText("Shortened Saturday"));
		const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
		await fireEvent.click(restoreButtons[0]);

		// Inline, in the same row — never a separate ConfirmDialog.
		expect(mockRestoreVersion).not.toHaveBeenCalled();
		expect(
			screen.getByText("Restore v2? Your current text stays as a version."),
		).toBeInTheDocument();

		await fireEvent.click(
			screen.getAllByRole("button", { name: "Restore" })[0],
		);

		await waitFor(() => {
			expect(mockRestoreVersion).toHaveBeenCalledWith(
				"artifact-1",
				"v2",
				"conv-1",
			);
		});
		expect(onRestored).toHaveBeenCalledWith(4);

		const toastEntry = get(toasts).at(-1);
		expect(toastEntry).toMatchObject({
			type: "success",
			message: "Restored v2 as v4",
			actionLabel: "Undo",
		});
	});

	it("Cancel on the inline confirm leaves the version untouched", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		await waitFor(() => screen.getByText("Shortened Saturday"));
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Restore" })[0],
		);
		expect(
			screen.getByText("Restore v2? Your current text stays as a version."),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(
			screen.queryByText("Restore v2? Your current text stays as a version."),
		).not.toBeInTheDocument();
		expect(mockRestoreVersion).not.toHaveBeenCalled();
	});

	it("the restore toast's Undo restores whatever was current a moment before, and reports it too", async () => {
		mockFetchVersions.mockResolvedValue(VERSIONS);
		mockRestoreVersion.mockResolvedValueOnce(4).mockResolvedValueOnce(5);
		const onRestored = vi.fn();

		render(VersionsSheet, {
			artifactId: "artifact-1",
			conversationId: "conv-1",
			onClose: vi.fn(),
			onRestored,
		});

		await waitFor(() => screen.getByText("Shortened Saturday"));
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Restore" })[0],
		);
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Restore" })[0],
		);
		await waitFor(() => expect(mockRestoreVersion).toHaveBeenCalledTimes(1));

		const toastEntry = get(toasts).at(-1);
		toastEntry?.onAction?.();

		// v3 (index 0, "Current") was current a moment before the v2 restore —
		// Undo puts it back, never re-restores v2.
		await waitFor(() => {
			expect(mockRestoreVersion).toHaveBeenLastCalledWith(
				"artifact-1",
				"v3",
				"conv-1",
			);
		});
		expect(onRestored).toHaveBeenLastCalledWith(5);
	});

	it("shows a retry option when loading fails", async () => {
		mockFetchVersions.mockRejectedValueOnce(new Error("network down"));
		mockFetchVersions.mockResolvedValueOnce(VERSIONS);

		render(VersionsSheet, { artifactId: "artifact-1", onClose: vi.fn() });

		await waitFor(() => {
			expect(
				screen.getByText("Could not load the version history."),
			).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => {
			expect(screen.getByText("Shortened Saturday")).toBeInTheDocument();
		});
	});

	it("closes via the close button", async () => {
		mockFetchVersions.mockResolvedValue([]);
		const onClose = vi.fn();

		render(VersionsSheet, { artifactId: "artifact-1", onClose });

		await waitFor(() => screen.getByText("No earlier versions yet."));
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on Escape", async () => {
		mockFetchVersions.mockResolvedValue([]);
		const onClose = vi.fn();

		render(VersionsSheet, { artifactId: "artifact-1", onClose });

		await waitFor(() => screen.getByText("No earlier versions yet."));
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});
});
