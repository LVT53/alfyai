import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import FileAttachment from "./FileAttachment.svelte";

describe("FileAttachment — long-document comfort cost line", () => {
	it("renders the file type, page count, and formatted token estimate", () => {
		const { getByTestId, getByText } = render(FileAttachment, {
			props: {
				attachment: {
					id: "a1",
					name: "contract.pdf",
					mimeType: "application/pdf",
					tokenEstimate: 118_234,
					pageCount: 38,
				},
			},
		});

		const costLine = getByTestId("file-attachment-cost-line");
		expect(costLine.textContent).toContain("PDF");
		expect(costLine.textContent).toContain("38 pages");
		expect(getByText("118k tokens per turn")).toBeInTheDocument();
	});

	it("does not render a cost line when tokenEstimate is absent", () => {
		const { queryByTestId } = render(FileAttachment, {
			props: {
				attachment: { id: "a2", name: "notes.txt", mimeType: "text/plain" },
			},
		});

		expect(queryByTestId("file-attachment-cost-line")).toBeNull();
	});

	it("omits the page count segment when pageCount is not known", () => {
		const { getByTestId } = render(FileAttachment, {
			props: {
				attachment: {
					id: "a3",
					name: "notes.md",
					mimeType: "text/markdown",
					tokenEstimate: 500,
				},
			},
		});

		const costLine = getByTestId("file-attachment-cost-line");
		expect(costLine.textContent).not.toContain("pages");
		expect(costLine.textContent).toContain("500 tokens per turn");
	});

	it("still supports the remove button alongside the cost line", async () => {
		const onRemove = vi.fn();
		const { getByRole } = render(FileAttachment, {
			props: {
				attachment: {
					id: "a4",
					name: "contract.pdf",
					tokenEstimate: 1000,
				},
				removable: true,
				onRemove,
			},
		});

		getByRole("button", { name: /remove/i }).click();
		expect(onRemove).toHaveBeenCalledWith({ id: "a4" });
	});

	it("localizes the remove button's label, which is its only name", () => {
		// The button is an X icon with `aria-hidden` on the glyph, so this
		// aria-label is the entire accessible name. It was a template literal,
		// `Remove ${name}`, which a Hungarian screen-reader user heard in
		// English.
		uiLanguage.set("hu");
		const { getByRole } = render(FileAttachment, {
			props: {
				attachment: { id: "a5", name: "szerzodes.pdf" },
				removable: true,
			},
		});

		expect(
			getByRole("button", { name: "szerzodes.pdf eltávolítása" }),
		).toBeInTheDocument();
		uiLanguage.set("en");
	});
});

// Chips redesign (owner-approved boards, 2026-09-15) — the "chip" variant is
// the shape a SENT attachment takes inside a message: the same pill the
// composer drew a second earlier, 22px instead of 28px, and without the ×,
// because it is a record of what happened rather than a promise about the
// next turn. It delegates to ComposerChip so there is one chip in the
// product, not two that can drift.
describe("FileAttachment — the in-message chip variant", () => {
	it("renders the shared 22px pill with the cost in muted meta", () => {
		const { getByTestId } = render(FileAttachment, {
			props: {
				attachment: {
					id: "a5",
					name: "Lease agreement 2026.pdf",
					mimeType: "application/pdf",
					tokenEstimate: 18_400,
					pageCount: 24,
				},
				variant: "chip" as const,
			},
		});

		const chip = getByTestId("message-attachment-chip");
		expect(chip.dataset.chipKind).toBe("file");
		expect(chip.dataset.chipSize).toBe("message");
		expect(chip.textContent).toContain("Lease agreement 2026.pdf");
		expect(chip.textContent).toContain("24 pp · 18k tok");
	});

	it("wears a crop of the file itself when the attachment is an image", () => {
		const { getByTestId } = render(FileAttachment, {
			props: {
				attachment: {
					id: "artifact-floorplan",
					name: "floor-plan-level-2.png",
					mimeType: "image/png",
				},
				variant: "chip" as const,
			},
		});

		const chip = getByTestId("message-attachment-chip");
		expect(chip.dataset.chipKind).toBe("image");
		const thumb = chip.querySelector(
			"img.composer-chip__thumb",
		) as HTMLImageElement | null;
		expect(thumb?.getAttribute("src")).toBe(
			"/api/knowledge/artifact-floorplan/preview",
		);
	});

	it("stays clickable — it still opens the document workspace", () => {
		const onView = vi.fn();
		const { getByRole } = render(FileAttachment, {
			props: {
				attachment: { id: "a6", name: "brief.docx" },
				variant: "chip" as const,
				viewable: true,
				onView,
			},
		});

		getByRole("button", { name: "Open brief.docx" }).click();
		expect(onView).toHaveBeenCalledTimes(1);
	});

	it("has no remove control unless one is asked for", () => {
		const { queryByRole } = render(FileAttachment, {
			props: {
				attachment: { id: "a7", name: "brief.docx" },
				variant: "chip" as const,
			},
		});
		expect(queryByRole("button")).toBeNull();
	});

	// The bug this redesign was asked to fix, seen through the component that
	// had it: a Word file used to draw the source-code glyph.
	it("draws a .docx as a document rather than as source code", () => {
		const { getByTestId } = render(FileAttachment, {
			props: {
				attachment: {
					id: "a8",
					name: "Employee handbook.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				},
				variant: "chip" as const,
			},
		});
		// Neutral "file" kind, and — the part that regressed — never "image".
		expect(getByTestId("message-attachment-chip").dataset.chipKind).toBe(
			"file",
		);
	});
});
