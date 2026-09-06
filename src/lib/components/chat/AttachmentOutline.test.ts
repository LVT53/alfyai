import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { DocumentOutlineEntry } from "$lib/server/services/knowledge/types";
import AttachmentOutline from "./AttachmentOutline.svelte";

function buildOutline(count: number): DocumentOutlineEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		level: index % 2 === 0 ? 1 : 2,
		title: `Section ${index}`,
		offset: index * 10,
		preview: `Preview text for section ${index}`,
	}));
}

describe("AttachmentOutline", () => {
	it("renders nothing when the outline is empty", () => {
		const { container } = render(AttachmentOutline, {
			props: { outline: [], onQuote: vi.fn() },
		});
		expect(container.textContent?.trim()).toBe("");
	});

	it("shows the header with the section count and lists rows", () => {
		const { getByText } = render(AttachmentOutline, {
			props: {
				outline: [
					{ level: 1, title: "Contract", offset: 0, preview: "Text" },
					{ level: 2, title: "Break clause", offset: 20, preview: "More" },
				],
				onQuote: vi.fn(),
			},
		});

		expect(getByText("Outline · 2 sections")).toBeInTheDocument();
		expect(getByText("Contract")).toBeInTheDocument();
		expect(getByText("Break clause")).toBeInTheDocument();
	});

	it("quotes 'Title: preview…' when a row is clicked", async () => {
		const onQuote = vi.fn();
		const { getByText } = render(AttachmentOutline, {
			props: {
				outline: [
					{
						level: 2,
						title: "Section 2.3 Break clause",
						offset: 0,
						preview: "Either party may terminate this agreement",
					},
				],
				onQuote,
			},
		});

		getByText("Section 2.3 Break clause").click();

		expect(onQuote).toHaveBeenCalledWith(
			"Section 2.3 Break clause: Either party may terminate this agreement…",
		);
	});

	it("collapses the row list when the header is clicked", async () => {
		const { getByText, queryByText } = render(AttachmentOutline, {
			props: {
				outline: [{ level: 1, title: "Contract", offset: 0, preview: "Text" }],
				onQuote: vi.fn(),
			},
		});

		expect(getByText("Contract")).toBeInTheDocument();
		await fireEvent.click(getByText("Outline · 1 sections"));
		expect(queryByText("Contract")).toBeNull();
	});

	it("caps the visible rows at 40 and reveals the rest via the 'more' toggle", async () => {
		const outline = buildOutline(45);
		const { getByText, queryByText } = render(AttachmentOutline, {
			props: { outline, onQuote: vi.fn() },
		});

		expect(getByText("Section 0")).toBeInTheDocument();
		expect(getByText("Section 39")).toBeInTheDocument();
		expect(queryByText("Section 40")).toBeNull();

		const moreButton = getByText("… 5 more");
		await fireEvent.click(moreButton);

		expect(getByText("Section 40")).toBeInTheDocument();
		expect(getByText("Section 44")).toBeInTheDocument();
	});
});
