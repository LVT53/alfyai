import { describe, expect, it } from "vitest";
import {
	accountsBadge,
	accountsIsOn,
	accountsTooltip,
	attachIsOn,
	attachTooltip,
	buildComposerMenuRows,
	type ComposerMenuInput,
	isSectionStart,
	nextMenuIndex,
	thinkingTooltip,
} from "./composer-bar";

describe("accountsBadge", () => {
	it("is nothing at zero — the bare 0 bubble is gone", () => {
		expect(accountsBadge(0)).toBeNull();
	});

	it("is the count above zero", () => {
		expect(accountsBadge(1)).toBe(1);
		expect(accountsBadge(3)).toBe(3);
	});

	it("never reports a negative count as a badge", () => {
		expect(accountsBadge(-1)).toBeNull();
	});
});

describe("on-state derivation", () => {
	it("fills attach for an uploaded file or a linked document", () => {
		expect(attachIsOn(0, 0)).toBe(false);
		expect(attachIsOn(1, 0)).toBe(true);
		expect(attachIsOn(0, 1)).toBe(true);
		expect(attachIsOn(2, 3)).toBe(true);
	});

	it("leaves accounts unfilled with nothing connected, whatever the count says", () => {
		expect(accountsIsOn(false, 2)).toBe(false);
		expect(accountsIsOn(true, 0)).toBe(false);
		expect(accountsIsOn(true, 2)).toBe(true);
	});
});

describe("tooltips name the control and its state", () => {
	it("says what attach would do, and what it is holding", () => {
		expect(attachTooltip(false, 0, 0)).toEqual({
			key: "composerBar.attachUnavailable",
		});
		expect(attachTooltip(true, 0, 0)).toEqual({ key: "composerBar.attachOff" });
		expect(attachTooltip(true, 1, 1)).toEqual({
			key: "composerBar.attachOn",
			params: { count: 2 },
		});
	});

	it("counts accounts for this message", () => {
		expect(accountsTooltip(false, 0, 0)).toEqual({
			key: "composerBar.accountsNone",
		});
		expect(accountsTooltip(true, 0, 3)).toEqual({
			key: "composerBar.accountsOff",
		});
		expect(accountsTooltip(true, 2, 3)).toEqual({
			key: "composerBar.accountsOn",
			params: { on: 2, total: 3 },
		});
	});

	it("states thinking either way rather than only when it is on", () => {
		expect(thinkingTooltip(true)).toEqual({ key: "composerBar.thinkingOn" });
		expect(thinkingTooltip(false)).toEqual({ key: "composerBar.thinkingOff" });
	});
});

const fullMenu: ComposerMenuInput = {
	canAttach: true,
	skillsEnabled: true,
	atlasVisible: true,
	atlasAvailable: true,
	thinkingAvailable: true,
	hasConnections: true,
	readyAccountIds: ["nextcloud-1", "google-1", "immich-1"],
	personalityCount: 4,
};

describe("buildComposerMenuRows", () => {
	it("draws the board's order: actions, switches, accounts, conversation", () => {
		expect(buildComposerMenuRows(fullMenu).map((row) => row.id)).toEqual([
			"attach",
			"skills",
			"atlas",
			"web-search",
			"thinking",
			"incognito",
			"accounts-master",
			"account:nextcloud-1",
			"account:google-1",
			"account:immich-1",
			"manage-connections",
			"model",
			"style",
		]);
	});

	it("keeps incognito in the menu and nowhere else", () => {
		const rows = buildComposerMenuRows(fullMenu);
		const incognito = rows.find((row) => row.id === "incognito");
		expect(incognito).toEqual({
			id: "incognito",
			kind: "switch",
			section: "switches",
		});
	});

	it("drops thinking where the model has no reasoning controls", () => {
		const rows = buildComposerMenuRows({
			...fullMenu,
			thinkingAvailable: false,
		});
		expect(rows.some((row) => row.id === "thinking")).toBe(false);
	});

	it("drops style when there are no profiles to choose between", () => {
		const rows = buildComposerMenuRows({ ...fullMenu, personalityCount: 0 });
		expect(rows.some((row) => row.id === "style")).toBe(false);
		expect(rows.some((row) => row.id === "model")).toBe(true);
	});

	it("keeps a way through to Connections even with no accounts", () => {
		const rows = buildComposerMenuRows({
			...fullMenu,
			hasConnections: false,
			readyAccountIds: [],
		});
		expect(rows.some((row) => row.id === "accounts-master")).toBe(false);
		expect(rows.some((row) => row.id === "manage-connections")).toBe(true);
	});

	it("shows Atlas disabled rather than hiding the reason", () => {
		const rows = buildComposerMenuRows({ ...fullMenu, atlasAvailable: false });
		expect(rows.find((row) => row.id === "atlas")?.disabled).toBe(true);
	});

	it("hides Atlas entirely where the deployment does not offer it", () => {
		const rows = buildComposerMenuRows({ ...fullMenu, atlasVisible: false });
		expect(rows.some((row) => row.id === "atlas")).toBe(false);
	});

	it("marks a heading at each section boundary and nowhere inside one", () => {
		const rows = buildComposerMenuRows(fullMenu);
		const headings = rows
			.map((row, index) => (isSectionStart(rows, index) ? row.id : null))
			.filter((id): id is string => id !== null);
		expect(headings).toEqual([
			"attach",
			"web-search",
			"accounts-master",
			"model",
		]);
	});
});

describe("nextMenuIndex", () => {
	const rows = [{}, {}, { disabled: true }, {}];

	it("walks down and wraps at the bottom", () => {
		expect(nextMenuIndex(rows, 0, "ArrowDown")).toBe(1);
		expect(nextMenuIndex(rows, 3, "ArrowDown")).toBe(0);
	});

	it("walks up and wraps at the top", () => {
		expect(nextMenuIndex(rows, 1, "ArrowUp")).toBe(0);
		expect(nextMenuIndex(rows, 0, "ArrowUp")).toBe(3);
	});

	it("steps over a disabled row instead of parking on it", () => {
		expect(nextMenuIndex(rows, 1, "ArrowDown")).toBe(3);
		expect(nextMenuIndex(rows, 3, "ArrowUp")).toBe(1);
	});

	it("jumps to the ends", () => {
		expect(nextMenuIndex(rows, 1, "Home")).toBe(0);
		expect(nextMenuIndex(rows, 1, "End")).toBe(3);
	});

	it("lands on the first row when nothing is focused yet", () => {
		expect(nextMenuIndex(rows, -1, "ArrowDown")).toBe(0);
		expect(nextMenuIndex(rows, -1, "ArrowUp")).toBe(3);
	});

	it("returns null for a key the menu does not own", () => {
		expect(nextMenuIndex(rows, 0, "Tab")).toBeNull();
		expect(nextMenuIndex(rows, 0, "a")).toBeNull();
	});

	it("returns null when every row is disabled", () => {
		expect(nextMenuIndex([{ disabled: true }], 0, "ArrowDown")).toBeNull();
	});
});
