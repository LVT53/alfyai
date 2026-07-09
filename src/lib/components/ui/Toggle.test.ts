import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import Toggle from "./Toggle.svelte";

function renderToggle(overrides: Record<string, unknown> = {}) {
	return render(Toggle, {
		props: {
			checked: false,
			ariaLabel: "Allow writes",
			...overrides,
		},
	});
}

describe("Toggle", () => {
	it("reflects the checked prop via aria-checked", () => {
		renderToggle({ checked: true });

		const toggle = screen.getByRole("switch", { name: "Allow writes" });
		expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	it("reflects checked=false via aria-checked", () => {
		renderToggle({ checked: false });

		const toggle = screen.getByRole("switch", { name: "Allow writes" });
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	it("calls onChange with the negation of checked when clicked", async () => {
		const onChange = vi.fn();
		renderToggle({ checked: false, onChange });

		await fireEvent.click(screen.getByRole("switch", { name: "Allow writes" }));

		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("does not call onChange when disabled", async () => {
		const onChange = vi.fn();
		renderToggle({ checked: false, disabled: true, onChange });

		await fireEvent.click(screen.getByRole("switch", { name: "Allow writes" }));

		expect(onChange).not.toHaveBeenCalled();
	});
});
