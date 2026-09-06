import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
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
});
