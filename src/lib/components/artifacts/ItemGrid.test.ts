import { readFileSync } from "node:fs";
import { FileText } from "@lucide/svelte";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ItemGrid from "./ItemGrid.svelte";

const tiles = [
	{
		id: "img-1",
		title: "Harbour at dusk",
		meta: "Image",
		icon: FileText,
		thumbnail: { fileId: "file-1", hasAlpha: false, conversationId: "conv-1" },
	},
	{
		id: "doc-1",
		title: "Trip notes",
		meta: "Document",
		icon: FileText,
		current: true,
	},
	{
		id: "app-1",
		title: "Tip calculator",
		meta: "Regenerating…",
		icon: FileText,
		disabled: true,
		busy: true,
	},
];

describe("ItemGrid, the one gallery of items", () => {
	it("draws a tile per item: the picture or the type's icon, the title and its line", () => {
		render(ItemGrid, { tiles, testId: "some-grid", onOpen: vi.fn() });
		const grid = screen.getByTestId("some-grid");
		const drawn = within(grid).getAllByTestId("some-grid-tile");
		expect(drawn).toHaveLength(3);
		expect(drawn[0]).toHaveTextContent("Harbour at dusk");
		expect(drawn[0]).toHaveTextContent("Image");
		expect(
			drawn[0]
				.querySelector('[data-testid="item-grid-thumb"] img')
				?.getAttribute("src"),
		).toBe("/api/images/files/file-1?variant=thumb&conversationId=conv-1");
		expect(
			drawn[1].querySelector('[data-testid="item-grid-thumb"]'),
		).toBeNull();
		expect(drawn[1].querySelector("svg")).not.toBeNull();
		expect(drawn[1]).toHaveAttribute("aria-current", "true");
		expect(drawn[2]).toBeDisabled();
		expect(drawn[2]).toHaveAttribute("aria-busy", "true");
	});

	it("opens the tile pressed", async () => {
		const onOpen = vi.fn();
		render(ItemGrid, { tiles, testId: "some-grid", onOpen });
		await fireEvent.click(screen.getAllByTestId("some-grid-tile")[1]);
		expect(onOpen).toHaveBeenCalledWith("doc-1");
	});

	it("sizes its columns from its own width (a container query), two at the narrowest", () => {
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/artifacts/ItemGrid.svelte`,
			"utf-8",
		);
		expect(source).toMatch(/container-type:\s*inline-size/);
		expect(source).toMatch(
			/@container[^{]*\{\s*\.item-grid\s*\{\s*grid-template-columns:\s*repeat\(2,/,
		);
		expect(source).not.toMatch(/@media \(max-width/);
	});
});
