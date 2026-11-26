// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudSpeedMenu from "./ReadAloudSpeedMenu.svelte";

afterEach(() => {
	uiLanguage.set("en");
});

describe("ReadAloudSpeedMenu", () => {
	it("the menu offers six speeds, checks the current one and picks with the keyboard", async () => {
		const onSelect = vi.fn();
		render(ReadAloudSpeedMenu, { props: { speed: 1, onSelect } });
		const chip = screen.getByRole("button", { name: /Speed/ });
		expect(chip.textContent?.trim()).toBe("1×");
		expect(chip.getAttribute("aria-haspopup")).toBe("menu");
		await fireEvent.click(chip);
		const items = screen.getAllByRole("menuitemradio");
		expect(items.map((item) => item.textContent?.trim())).toEqual([
			"0.75×",
			"1×",
			"1.25×",
			"1.5×",
			"1.75×",
			"2×",
		]);
		expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
			"false",
			"true",
			"false",
			"false",
			"false",
			"false",
		]);
		await tick();
		expect(document.activeElement).toBe(items[1]);
		await fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowDown" });
		expect(document.activeElement).toBe(items[2]);
		await fireEvent.keyDown(items[2] as HTMLElement, { key: "ArrowUp" });
		await fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowDown" });
		await fireEvent.keyDown(items[2] as HTMLElement, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith(1.25);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(chip);
	});

	it("closes on Escape and on a click outside, giving focus back to the chip", async () => {
		const onSelect = vi.fn();
		render(ReadAloudSpeedMenu, { props: { speed: 1.5, onSelect } });
		const chip = screen.getByRole("button", { name: /Speed/ });
		await fireEvent.click(chip);
		const menu = screen.getByRole("menu");
		await fireEvent.keyDown(menu, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(chip);
		await fireEvent.click(chip);
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('writes 1.25 as "1,25×" in Hungarian', async () => {
		uiLanguage.set("hu");
		render(ReadAloudSpeedMenu, { props: { speed: 1.25, onSelect: vi.fn() } });
		const chip = screen.getByRole("button", { name: /Sebesség/ });
		expect(chip.textContent?.trim()).toBe("1,25×");
	});
});
