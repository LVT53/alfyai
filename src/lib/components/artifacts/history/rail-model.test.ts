import { describe, expect, it } from "vitest";
import { at, makeMoment, makeStep } from "./__fixtures__/moments";
import {
	buildRailGroups,
	dayKeyOf,
	entryIsNow,
	findRailEntry,
	flattenRailGroups,
	mergeFirstPage,
	newestEntryKey,
	nextRailKey,
	reconcileSelection,
	visibleSteps,
} from "./rail-model";

// Two days, three moments, one folded: the rail's whole vocabulary.
function twoDays() {
	return [
		makeMoment({
			versionNumber: 6,
			at: at(2026, 10, 11, 10, 31),
			containsNewest: true,
			isNewest: true,
		}),
		makeMoment({
			versionNumber: 4,
			kind: "alfy_edit",
			author: "alfy",
			fold: "undone",
			at: at(2026, 10, 11, 9, 12),
			steps: [makeStep({ versionNumber: 5, at: at(2026, 10, 11, 9, 13) })],
		}),
		makeMoment({
			versionNumber: 3,
			at: at(2026, 10, 10, 18, 5),
			label: "Before the client call",
		}),
		makeMoment({
			versionNumber: 1,
			kind: "first_draft",
			author: "alfy",
			at: at(2026, 10, 10, 10, 0),
		}),
	];
}

describe("buildRailGroups", () => {
	it("groups moments by the local day they were saved on, newest first, a folded step under its moment", () => {
		const groups = buildRailGroups(twoDays());
		expect(groups.map((group) => group.dayKey)).toEqual([
			"2026-10-11",
			"2026-10-10",
		]);
		expect(groups[0].entries.map((entry) => entry.key)).toEqual([
			"m:v6",
			"m:v4",
			"s:v5",
		]);
		expect(groups[1].entries.map((entry) => entry.key)).toEqual([
			"m:v3",
			"m:v1",
		]);
	});

	it("marks a step as folded and carries its own row's facts", () => {
		const step = flattenRailGroups(buildRailGroups(twoDays())).find(
			(entry) => entry.key === "s:v5",
		);
		expect(step).toMatchObject({
			type: "step",
			folded: true,
			versionNumber: 5,
			kind: "undo_alfy_change",
			author: "user",
		});
	});

	it("leaves out a step that only restates its moment's own version, except in one turn of Alfy's edits", () => {
		const restates = makeMoment({
			versionNumber: 4,
			fold: "undone",
			steps: [makeStep({ versionNumber: 4 }), makeStep({ versionNumber: 5 })],
		});
		expect(visibleSteps(restates).map((step) => step.versionNumber)).toEqual([
			5,
		]);
		const turn = makeMoment({
			versionNumber: 9,
			fold: "alfy_turn",
			steps: [
				makeStep({ versionNumber: 7, kind: "alfy_edit", author: "alfy" }),
				makeStep({ versionNumber: 8, kind: "alfy_edit", author: "alfy" }),
				makeStep({ versionNumber: 9, kind: "alfy_edit", author: "alfy" }),
			],
		});
		expect(visibleSteps(turn).map((step) => step.versionNumber)).toEqual([
			7, 8, 9,
		]);
		// And the moment and its last step stay two options with two keys.
		const keys = flattenRailGroups(buildRailGroups([turn])).map(
			(entry) => entry.key,
		);
		expect(keys).toEqual(["m:v9", "s:v7", "s:v8", "s:v9"]);
	});

	it("the Named filter lists only what the reader named, dropping empty days", () => {
		const groups = buildRailGroups(twoDays(), "named");
		expect(groups).toHaveLength(1);
		expect(groups[0].dayKey).toBe("2026-10-10");
		expect(groups[0].entries.map((entry) => entry.key)).toEqual(["m:v3"]);
	});

	it("a day group keeps one heading across pages: adjacent moments of one day are one group", () => {
		const groups = buildRailGroups([
			makeMoment({ versionNumber: 3, at: at(2026, 10, 11, 12, 0) }),
			makeMoment({ versionNumber: 2, at: at(2026, 10, 11, 8, 0) }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].entries).toHaveLength(2);
	});
});

describe("dayKeyOf", () => {
	it("is the local calendar day", () => {
		expect(dayKeyOf(at(2026, 1, 5, 23, 59))).toBe("2026-01-05");
		expect(dayKeyOf(at(2026, 12, 31, 0, 0))).toBe("2026-12-31");
	});
});

describe("nextRailKey (selection follows focus)", () => {
	const groups = buildRailGroups(twoDays());

	it("steps one entry with the arrows, in time order, and stops at the ends", () => {
		expect(nextRailKey(groups, "m:v6", "ArrowDown")).toBe("m:v4");
		expect(nextRailKey(groups, "m:v4", "ArrowDown")).toBe("s:v5");
		expect(nextRailKey(groups, "s:v5", "ArrowDown")).toBe("m:v3");
		expect(nextRailKey(groups, "m:v1", "ArrowDown")).toBe("m:v1");
		expect(nextRailKey(groups, "m:v4", "ArrowUp")).toBe("m:v6");
		expect(nextRailKey(groups, "m:v6", "ArrowUp")).toBe("m:v6");
	});

	it("jumps to the ends with Home and End", () => {
		expect(nextRailKey(groups, "m:v4", "Home")).toBe("m:v6");
		expect(nextRailKey(groups, "m:v4", "End")).toBe("m:v1");
	});

	it("moves a day with PageDown and PageUp", () => {
		expect(nextRailKey(groups, "m:v4", "PageDown")).toBe("m:v3");
		// Already on the oldest day: PageDown goes to the very end.
		expect(nextRailKey(groups, "m:v3", "PageDown")).toBe("m:v1");
		// From the middle of a day, PageUp goes to the day's own first entry …
		expect(nextRailKey(groups, "s:v5", "PageUp")).toBe("m:v6");
		// … and from the first entry to the previous day's first.
		expect(nextRailKey(groups, "m:v3", "PageUp")).toBe("m:v6");
		expect(nextRailKey(groups, "m:v6", "PageUp")).toBe("m:v6");
	});

	it("starts from the newest when nothing is selected, and answers null for an empty rail", () => {
		expect(nextRailKey(groups, null, "ArrowDown")).toBe("m:v4");
		expect(nextRailKey(groups, "gone", "ArrowUp")).toBe("m:v6");
		expect(nextRailKey([], null, "ArrowDown")).toBeNull();
	});
});

describe("reconcileSelection", () => {
	it("keeps a selection that is still listed and falls back to the newest otherwise", () => {
		const groups = buildRailGroups(twoDays());
		expect(reconcileSelection(groups, "m:v3")).toBe("m:v3");
		expect(reconcileSelection(groups, "m:v99")).toBe("m:v6");
		expect(reconcileSelection(groups, null)).toBe("m:v6");
		expect(reconcileSelection([], "m:v3")).toBeNull();
		// A filter that hides the selection falls back too.
		expect(
			reconcileSelection(buildRailGroups(twoDays(), "named"), "m:v6"),
		).toBe("m:v3");
	});

	it("finds an entry by its key", () => {
		const groups = buildRailGroups(twoDays());
		expect(findRailEntry(groups, "s:v5")?.versionNumber).toBe(5);
		expect(findRailEntry(groups, "nope")).toBeNull();
		expect(findRailEntry(groups, null)).toBeNull();
	});
});

describe("mergeFirstPage", () => {
	it("lays a fresh first page over what is loaded and keeps what was paged in beyond it", () => {
		const loaded = [
			makeMoment({ versionNumber: 5 }),
			makeMoment({ versionNumber: 4 }),
			makeMoment({ versionNumber: 3 }),
			makeMoment({ versionNumber: 2 }),
		];
		const fresh = [
			makeMoment({ versionNumber: 7 }),
			makeMoment({ versionNumber: 6 }),
			makeMoment({ versionNumber: 5 }),
			makeMoment({ versionNumber: 4 }),
		];
		expect(
			mergeFirstPage(fresh, loaded).map((moment) => moment.versionNumber),
		).toEqual([7, 6, 5, 4, 3, 2]);
	});

	it("takes the fresh page's folded moment over the loose moments it now covers", () => {
		const loaded = [
			makeMoment({ versionNumber: 5 }),
			makeMoment({ versionNumber: 4, kind: "alfy_edit", author: "alfy" }),
			makeMoment({ versionNumber: 3 }),
		];
		// Version 5 turned out to be the Undo of 4: one moment now covers both.
		const fresh = [
			makeMoment({
				versionNumber: 4,
				fold: "undone",
				steps: [makeStep({ versionNumber: 5 })],
			}),
		];
		expect(
			mergeFirstPage(fresh, loaded).map((moment) => moment.versionNumber),
		).toEqual([4, 3]);
	});

	it("is the loaded list when there is no fresh page", () => {
		const loaded = [makeMoment({ versionNumber: 2 })];
		expect(mergeFirstPage([], loaded)).toEqual(loaded);
	});
});

// RV-V I-4: "Now" belongs to the ONE entry whose own row is the newest, and a write
// History made lands the selection on it. A fold shows its OLDEST row as the moment
// (the Alfy change an Undo took back, the restore its Undo reversed), so the moment
// is not where the current version is: its newest step is.
describe("the entry that holds the newest row", () => {
	/** A restore (v3) and the Undo that took it back (v4): one quiet moment, the Undo its step. */
	function foldedRestore() {
		return [
			makeMoment({
				versionNumber: 3,
				kind: "restore",
				author: "user",
				fold: "restore_undone",
				quiet: true,
				containsNewest: true,
				steps: [
					makeStep({
						versionNumber: 4,
						kind: "undo_restore",
						isNewest: true,
					}),
				],
			}),
			makeMoment({ versionNumber: 2, kind: "alfy_edit", author: "alfy" }),
			makeMoment({ versionNumber: 1, kind: "first_draft", author: "alfy" }),
		];
	}

	it("is the step of a fold, not the moment that shows its oldest row", () => {
		const groups = buildRailGroups(foldedRestore());
		expect(newestEntryKey(groups)).toBe("s:v4");
	});

	it("is the moment itself when its own row is the newest", () => {
		const groups = buildRailGroups(twoDays());
		expect(newestEntryKey(groups)).toBe("m:v6");
	});

	it("is the newest entry in the groups it is given, else the first one, else nothing", () => {
		// Under the Named filter the newest row may not be listed: the first entry stands.
		const named = buildRailGroups(twoDays(), "named");
		expect(newestEntryKey(named)).toBe("m:v3");
		expect(newestEntryKey([])).toBeNull();
	});

	it("marks Now on one entry only: a fold's moment never repeats it, and a turn's newest step does not repeat its moment's", () => {
		const entriesOf = (moments: ReturnType<typeof foldedRestore>) =>
			flattenRailGroups(buildRailGroups(moments));
		const nows = (moments: ReturnType<typeof foldedRestore>) =>
			entriesOf(moments)
				.filter(entryIsNow)
				.map((entry) => entry.key);

		// The fold: the moment contains the newest row, the step IS it.
		expect(nows(foldedRestore())).toEqual(["s:v4"]);

		// A turn of Alfy's: the moment is its LAST edit's state and every edit is a step,
		// the newest of them restating the moment.
		const turn = [
			makeMoment({
				versionNumber: 3,
				kind: "alfy_turn",
				author: "alfy",
				fold: "alfy_turn",
				isNewest: true,
				containsNewest: true,
				steps: [
					makeStep({
						versionNumber: 3,
						kind: "alfy_edit",
						author: "alfy",
						isNewest: true,
					}),
					makeStep({ versionNumber: 2, kind: "alfy_edit", author: "alfy" }),
				],
			}),
		];
		expect(nows(turn)).toEqual(["m:v3"]);

		// A plain newest moment, and none when the newest row is not on this list.
		expect(nows(twoDays())).toEqual(["m:v6"]);
		expect(
			flattenRailGroups(buildRailGroups(twoDays().slice(1)))
				.filter(entryIsNow)
				.map((entry) => entry.key),
		).toEqual([]);
	});
});
