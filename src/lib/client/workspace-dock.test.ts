import { describe, expect, it } from "vitest";
import {
	CHAT_COLUMN_FLOOR,
	chatWouldBeSqueezed,
	dockedPanelWidth,
	dockedWidthCss,
} from "./workspace-dock";

describe("the docked panel's width", () => {
	it("is what it asks for when the stage has room for it and the chat", () => {
		expect(dockedPanelWidth(700, 1600)).toBe(700);
	});

	it("never takes more than 68% of the stage", () => {
		// 1140 is the 1440 window with the sidebar open: 68% is 775.2.
		expect(dockedPanelWidth(950, 1140)).toBeCloseTo(775.2, 5);
	});

	it("gives up width before the chat column goes under the floor", () => {
		// 1052 is the 1100 window with the sidebar on its rail: 68% would leave 337.
		const panel = dockedPanelWidth(950, 1052);
		expect(1052 - panel).toBe(CHAT_COLUMN_FLOOR);
		expect(panel).toBeLessThan(0.68 * 1052);
	});

	it("is never narrower than a panel can be used", () => {
		// A 768 window cannot hold the floor and a usable panel: the panel keeps its minimum.
		expect(dockedPanelWidth(950, 768)).toBe(440);
		// And never more than the stage there is.
		expect(dockedPanelWidth(950, 300)).toBe(300);
	});

	it("is spelled in CSS the same way, so the browser and the script cannot disagree", () => {
		expect(dockedWidthCss(950)).toBe(
			"max(min(440px, 100%), min(950px, 68%, calc(100% - 364px)))",
		);
	});
});

describe("when the chat is squeezed", () => {
	it("is not at 1440 with the sidebar open, and is at 1280", () => {
		expect(chatWouldBeSqueezed(950, 1140)).toBe(false);
		expect(chatWouldBeSqueezed(950, 980)).toBe(true);
	});

	it("is not once the sidebar is on its rail", () => {
		expect(chatWouldBeSqueezed(950, 1280 - 48)).toBe(false);
	});

	it("takes the panel's own ask into account", () => {
		// Narrowed by hand to 620, the panel leaves the chat its floor on a 1020 px stage as it is.
		expect(chatWouldBeSqueezed(950, 1020)).toBe(true);
		expect(chatWouldBeSqueezed(620, 1020)).toBe(false);
	});
});
