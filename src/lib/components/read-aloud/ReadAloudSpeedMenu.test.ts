import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudSpeedMenu from "./ReadAloudSpeedMenu.svelte";

afterEach(() => {
	uiLanguage.set("en");
});

function renderMenu(speed = 1) {
	const onSelect = vi.fn();
	const result = render(ReadAloudSpeedMenu, { speed, onSelect });
	return { ...result, onSelect, chip: screen.getByTestId("read-aloud-speed") };
}

const items = () => screen.getAllByRole("menuitemradio") as HTMLElement[];

describe("ReadAloudSpeedMenu", () => {
	it("shows the speed on a chip, closed", () => {
		const { chip } = renderMenu(1.5);
		expect(chip.textContent?.trim()).toBe("1.5×");
		expect(chip.getAttribute("aria-haspopup")).toBe("menu");
		expect(chip.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("the menu offers six speeds, checks the current one and picks with the keyboard", async () => {
		const { chip, onSelect } = renderMenu(1);
		await fireEvent.click(chip);
		await tick();
		expect(screen.getByRole("menu")).toBeTruthy();
		expect(chip.getAttribute("aria-expanded")).toBe("true");
		expect(items().map((item) => item.textContent?.trim())).toEqual([
			"0.75×",
			"1×",
			"1.25×",
			"1.5×",
			"1.75×",
			"2×",
		]);
		expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual([
			"false",
			"true",
			"false",
			"false",
			"false",
			"false",
		]);
		// The checked speed has the focus on open.
		expect(document.activeElement).toBe(items()[1]);

		await fireEvent.keyDown(items()[1] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items()[2]);
		await fireEvent.keyDown(items()[2] as HTMLElement, { key: "ArrowDown" });
		await fireEvent.keyDown(items()[3] as HTMLElement, { key: "ArrowUp" });
		expect(document.activeElement).toBe(items()[2]);
		await fireEvent.keyDown(items()[2] as HTMLElement, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(1.25);
		// Picking closes the menu and gives the focus back to the chip.
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(chip);
	});

	it("picks with a click", async () => {
		const { chip, onSelect } = renderMenu(1);
		await fireEvent.click(chip);
		await fireEvent.click(items()[5] as HTMLElement);
		expect(onSelect).toHaveBeenCalledWith(2);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("wraps from the last speed to the first", async () => {
		const { chip } = renderMenu(2);
		await fireEvent.click(chip);
		await tick();
		await fireEvent.keyDown(items()[5] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items()[0]);
		await fireEvent.keyDown(items()[0] as HTMLElement, { key: "End" });
		expect(document.activeElement).toBe(items()[5]);
		await fireEvent.keyDown(items()[5] as HTMLElement, { key: "Home" });
		expect(document.activeElement).toBe(items()[0]);
	});

	it("closes on Escape and on a click outside, and gives the focus back to the chip", async () => {
		const { chip, onSelect } = renderMenu(1);
		await fireEvent.click(chip);
		await tick();
		await fireEvent.keyDown(items()[1] as HTMLElement, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(chip);

		await fireEvent.click(chip);
		await tick();
		expect(screen.getByRole("menu")).toBeTruthy();
		await fireEvent.click(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('writes 1.25 as "1,25×" in Hungarian', async () => {
		uiLanguage.set("hu");
		const { chip } = renderMenu(1.25);
		expect(chip.textContent?.trim()).toBe("1,25×");
		await fireEvent.click(chip);
		await tick();
		expect(items().map((item) => item.textContent?.trim())).toEqual([
			"0,75×",
			"1×",
			"1,25×",
			"1,5×",
			"1,75×",
			"2×",
		]);
		expect(chip.getAttribute("aria-label")).toBe("Sebesség: 1,25×");
	});
});
