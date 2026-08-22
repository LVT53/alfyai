import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Checklist from "./Checklist.svelte";

describe("Checklist", () => {
	it("renders GFM task items as READ-ONLY checkboxes mirroring the model's state", () => {
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
		// Read-only: every checkbox is disabled (not a false 'it saved' affordance).
		for (const box of boxes) {
			expect(box.disabled).toBe(true);
			expect(box.hasAttribute("disabled")).toBe(true);
		}
		// The rendered state reflects the parsed markdown [ ] / [x].
		expect(boxes[0].checked).toBe(false);
		expect(boxes[1].checked).toBe(true);
	});

	it("marks the checkbox disabled — the read-only guard that blocks interaction", () => {
		// The `disabled` attribute is what makes the box read-only in a real
		// browser (jsdom's fireEvent does not enforce activation-blocking, so we
		// assert the mechanism rather than simulate a browser-blocked click).
		render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "buy milk" }],
			},
		});

		const box = screen.getByRole("checkbox") as HTMLInputElement;
		expect(box.disabled).toBe(true);
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

	it("always mirrors the model's checked state across re-renders (streaming append)", async () => {
		const { rerender } = render(Checklist, {
			props: {
				items: [{ checked: false, task: true, html: "first" }],
			},
		});

		const first = screen.getByRole("checkbox") as HTMLInputElement;
		expect(first.checked).toBe(false);

		// A second task streams in already-done (`- [x]`). Each box reflects its
		// own parsed state directly — there is no user-tick state to preserve.
		await rerender({
			items: [
				{ checked: false, task: true, html: "first" },
				{ checked: true, task: true, html: "second done" },
			],
		});

		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes).toHaveLength(2);
		expect(boxes[0].checked).toBe(false);
		expect(boxes[1].checked).toBe(true);
	});
});
