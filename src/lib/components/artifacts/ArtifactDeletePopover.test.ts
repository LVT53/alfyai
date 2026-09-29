import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ArtifactDeletePopover from "./ArtifactDeletePopover.svelte";

function renderPopover(
	overrides: Partial<{
		kind: "document" | "app" | "canvas" | "slides" | "file";
		title: string;
		regenerable: boolean;
		initialStage: "confirm" | "menu";
		onConfirm: () => Promise<void>;
		onClose: () => void;
	}> = {},
) {
	const onClose = overrides.onClose ?? vi.fn();
	const onConfirm = overrides.onConfirm ?? vi.fn(async () => {});
	render(ArtifactDeletePopover, {
		kind: "document",
		title: "Weekend in Vienna",
		anchorTestId: "artifact-delete-button",
		...overrides,
		onConfirm,
		onClose,
	});
	return { onClose, onConfirm };
}

// Polish G2-A. The confirm names what is deleted and says it cannot be undone,
// in the reader's language and the kind's own words; a failed delete keeps the
// item and says so; the row's overflow leads to the same confirm.
describe("ArtifactDeletePopover", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
		uiLanguage.set("en");
	});

	it("asks by name, per kind, and says it cannot be undone", async () => {
		renderPopover();

		const dialog = await screen.findByRole("dialog", {
			name: "Delete this document?",
		});
		expect(dialog.textContent).toContain("“Weekend in Vienna”");
		expect(dialog.textContent).toContain("This can't be undone.");
	});

	// The security review's L2: "This can't be undone" is false once the chat can
	// make the item again. It is promised only where a source is kept.
	describe("when the chat can make the item again", () => {
		it("says so instead of that it cannot be undone", async () => {
			renderPopover({ regenerable: true });

			const dialog = await screen.findByRole("dialog", {
				name: "Delete this document?",
			});
			expect(dialog.textContent).toContain("“Weekend in Vienna”");
			expect(dialog.textContent).toContain(
				"You can regenerate it from the chat.",
			);
			expect(dialog.textContent).not.toContain("can't be undone");
		});

		it.each([
			["document", "and its versions and comments will be deleted"],
			["app", "and its saved data will be deleted"],
			["canvas", "and its versions and comments will be deleted"],
			["slides", "and its versions and comments will be deleted"],
			["file", "will be deleted"],
		] as const)("keeps what a %s loses, and adds the way back", async (kind, loses) => {
			renderPopover({ kind, regenerable: true });

			const dialog = await screen.findByRole("dialog");
			expect(dialog.textContent).toContain(loses);
			expect(dialog.textContent).toContain(
				"You can regenerate it from the chat.",
			);
		});

		it("says it in Hungarian", async () => {
			uiLanguage.set("hu");
			renderPopover({ regenerable: true });

			const dialog = await screen.findByRole("dialog", {
				name: "Törlöd ezt a dokumentumot?",
			});
			expect(dialog.textContent).toContain(
				"A beszélgetésből újra létrehozhatod.",
			);
			expect(dialog.textContent).not.toContain("Ez nem vonható vissza.");
		});

		it("also from a row's overflow, which leads to the same confirm", async () => {
			renderPopover({ regenerable: true, initialStage: "menu" });

			await fireEvent.click(
				await screen.findByRole("menuitem", { name: "Delete document" }),
			);

			expect(
				await screen.findByText(/You can regenerate it from the chat\./),
			).toBeTruthy();
		});
	});

	it("keeps the plain warning when nothing is kept to make the item again from", async () => {
		renderPopover({ regenerable: false });

		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("This can't be undone.");
		expect(dialog.textContent).not.toContain("regenerate");
	});

	it("uses the kind's own words for an app", async () => {
		renderPopover({ kind: "app", title: "Trip budget" });

		const dialog = await screen.findByRole("dialog", {
			name: "Delete this app?",
		});
		expect(dialog.textContent).toContain("saved data");
	});

	it("asks in Hungarian, with the kind's own article and ending", async () => {
		uiLanguage.set("hu");
		renderPopover({ kind: "slides", title: "Bemutató" });

		const dialog = await screen.findByRole("dialog", {
			name: "Törlöd ezt a diasort?",
		});
		expect(dialog.textContent).toContain("„Bemutató”");
		expect(dialog.textContent).toContain("Ez nem vonható vissza.");
		expect(screen.getByRole("button", { name: "Törlés" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Mégse" })).toBeTruthy();
	});

	it("Cancel closes without deleting anything", async () => {
		const { onClose, onConfirm } = renderPopover();
		await screen.findByRole("dialog");

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("Delete waits for the delete, says it is working, and closes once it is done", async () => {
		let finish: () => void = () => {};
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const { onClose } = renderPopover({ onConfirm });
		await screen.findByRole("dialog");

		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		const busy = await screen.findByRole("button", { name: "Deleting…" });
		expect((busy as HTMLButtonElement).disabled).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
		// A second press while it is working does nothing.
		await fireEvent.click(busy);
		expect(onConfirm).toHaveBeenCalledTimes(1);

		finish();
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("a failed delete stays open, says so, and can be tried again", async () => {
		const onConfirm = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);
		const { onClose } = renderPopover({ onConfirm });
		await screen.findByRole("dialog");

		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("Couldn't delete this. Try again.");
		expect(onClose).not.toHaveBeenCalled();
		const retry = screen.getByRole("button", { name: "Delete" });
		expect((retry as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(retry);
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it("from a row's overflow it starts as a one-item menu that leads to the same confirm, focus on Cancel", async () => {
		const { onConfirm } = renderPopover({ initialStage: "menu" });

		const item = await screen.findByRole("menuitem", {
			name: "Delete document",
		});
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

		await fireEvent.click(item);

		await screen.findByText(/This can't be undone\./);
		const cancel = screen.getByRole("button", { name: "Cancel" });
		await waitFor(() => expect(document.activeElement).toBe(cancel));
		expect(onConfirm).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
	});
});
