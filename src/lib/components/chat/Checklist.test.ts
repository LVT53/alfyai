import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Checklist from "./Checklist.svelte";

describe("Checklist", () => {
	it("renders GFM task items as ENABLED, tick-able checkboxes", () => {
		render(Checklist, {
			props: {
				items: [
					{ checked: false, task: true, html: "todo one" },
					{ checked: true, task: true, html: "done two" },
				],
			},
		});

		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes).toHaveLength(2);
		// Interactive: NOT disabled (the old renderer emitted disabled checkboxes).
		for (const box of boxes) {
			expect(box.disabled).toBe(false);
			expect(box.hasAttribute("disabled")).toBe(false);
		}
		// Initial checked state reflects the parsed markdown.
		expect(boxes[0].checked).toBe(false);
		expect(boxes[1].checked).toBe(true);
	});

	it("toggles an item's checked state on click (ephemeral, no persistence)", async () => {
		render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "buy milk" }],
			},
		});

		const box = screen.getByRole("checkbox") as HTMLInputElement;
		expect(box.checked).toBe(false);

		await fireEvent.click(box);
		expect(box.checked).toBe(true);

		await fireEvent.click(box);
		expect(box.checked).toBe(false);
	});

	it("renders inline item HTML", () => {
		render(Checklist, {
			props: {
				items: [
					{ checked: false, task: true, html: "buy <strong>milk</strong>" },
				],
			},
		});

		expect(screen.getByText("milk").tagName).toBe("STRONG");
	});

	it("names each checkbox by its body (aria-labelledby) with the body as a sibling, not wrapped in a <label>", () => {
		const { container } = render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "buy milk" }],
			},
		});

		// The checkbox derives its accessible name from the block-level body via
		// aria-labelledby (the body may hold lists/code, so it is NOT a <label>).
		expect(screen.getByRole("checkbox", { name: "buy milk" })).toBeTruthy();
		// No <label> wraps the (potentially block-level) item body.
		expect(container.querySelector("label")).toBeNull();
	});

	it("renders a non-task item as a plain row with no checkbox", () => {
		render(Checklist, {
			props: {
				items: [
					{ checked: false, task: true, html: "a task" },
					{ checked: false, task: false, html: "a plain bullet" },
				],
			},
		});

		expect(screen.getAllByRole("checkbox")).toHaveLength(1);
		expect(screen.getByText("a plain bullet")).toBeTruthy();
	});

	it("preserves prior items' checked state when a new item is appended (streaming, Fix 3)", async () => {
		const { rerender } = render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "first" }],
			},
		});

		// User ticks the first (and only) item.
		const first = screen.getByRole("checkbox") as HTMLInputElement;
		expect(first.checked).toBe(false);
		await fireEvent.click(first);
		expect(first.checked).toBe(true);

		// A second task streams in: the block grows by one item. The prior tick
		// must survive — only the newly-appended item is seeded from its markdown.
		await rerender({
			items: [
				{ checked: false, task: true, html: "first" },
				{ checked: false, task: true, html: "second" },
			],
		});

		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes).toHaveLength(2);
		expect(boxes[0].checked).toBe(true); // preserved
		expect(boxes[1].checked).toBe(false); // newly seeded
	});

	it("seeds a newly-appended item from its own parsed checked state", async () => {
		const { rerender } = render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "first" }],
			},
		});

		await fireEvent.click(screen.getByRole("checkbox"));

		// The appended item arrives already-done in the markdown (`- [x]`).
		await rerender({
			items: [
				{ checked: false, task: true, html: "first" },
				{ checked: true, task: true, html: "second done" },
			],
		});

		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes[0].checked).toBe(true); // preserved user tick
		expect(boxes[1].checked).toBe(true); // seeded from markdown [x]
	});
});
