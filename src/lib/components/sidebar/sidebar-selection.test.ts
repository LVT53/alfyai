import { describe, expect, it } from "vitest";
import {
	bulkPinAction,
	pruneSelected,
	type ShownSections,
	selectRange,
	shownConversationOrder,
	toggleSelected,
} from "./sidebar-selection";

// Sets compare by insertion order in `toEqual`, and these tests care about
// membership only, so every set goes through here first.
function members(ids: ReadonlySet<string>): string[] {
	return [...ids].sort();
}

describe("toggleSelected", () => {
	it("adds a chat that is not selected, then takes it out again", () => {
		const added = toggleSelected(new Set(), "a");
		expect(members(added)).toEqual(["a"]);

		const withSecond = toggleSelected(added, "b");
		expect(members(withSecond)).toEqual(["a", "b"]);

		const removed = toggleSelected(withSecond, "a");
		expect(members(removed)).toEqual(["b"]);
	});

	// The list keeps its selection in state and replaces the set on every
	// change: a set changed in place would not be seen as a change.
	it("returns a new set and leaves the one it was given alone", () => {
		const before = new Set(["a"]);
		const after = toggleSelected(before, "b");

		expect(after).not.toBe(before);
		expect(members(before)).toEqual(["a"]);
	});
});

describe("selectRange", () => {
	const order = ["a", "b", "c", "d", "e"];

	it("adds every chat from the anchor to the target, both included, going down the list", () => {
		expect(members(selectRange(new Set(), order, "b", "d"))).toEqual([
			"b",
			"c",
			"d",
		]);
	});

	it("does the same going up the list", () => {
		expect(members(selectRange(new Set(), order, "d", "b"))).toEqual([
			"b",
			"c",
			"d",
		]);
	});

	it("selects the one chat when the anchor and the target are the same", () => {
		expect(members(selectRange(new Set(), order, "c", "c"))).toEqual(["c"]);
	});

	it("keeps what was already selected, inside the range or outside it", () => {
		expect(members(selectRange(new Set(["a", "c"]), order, "c", "e"))).toEqual([
			"a",
			"c",
			"d",
			"e",
		]);
	});

	it("adds only the target when there is no anchor", () => {
		expect(members(selectRange(new Set(["a"]), order, null, "d"))).toEqual([
			"a",
			"d",
		]);
	});

	it("adds only the target when the anchor is not in the order", () => {
		expect(members(selectRange(new Set(), order, "gone", "d"))).toEqual(["d"]);
	});

	it("adds only the target when the target is not in the order", () => {
		expect(members(selectRange(new Set(), order, "b", "gone"))).toEqual([
			"gone",
		]);
	});

	it("returns a new set and leaves the one it was given alone", () => {
		const before = new Set(["a"]);
		const after = selectRange(before, order, "b", "c");

		expect(after).not.toBe(before);
		expect(members(before)).toEqual(["a"]);
	});
});

describe("pruneSelected", () => {
	it("drops the chats that are no longer present and keeps the rest", () => {
		const pruned = pruneSelected(
			new Set(["a", "b", "c"]),
			new Set(["a", "c", "z"]),
		);
		expect(members(pruned)).toEqual(["a", "c"]);
	});

	it("keeps everything, in a new set, when every chat is still present", () => {
		const before = new Set(["a", "b"]);
		const pruned = pruneSelected(before, new Set(["a", "b", "c"]));

		expect(members(pruned)).toEqual(["a", "b"]);
		expect(pruned).not.toBe(before);
		// The list compares sizes to see whether anything was pruned.
		expect(pruned.size).toBe(before.size);
	});

	it("empties the selection when none of it is present", () => {
		expect(pruneSelected(new Set(["a"]), new Set()).size).toBe(0);
	});
});

describe("bulkPinAction", () => {
	it("pins when nothing is selected", () => {
		expect(bulkPinAction([])).toBe("pin");
	});

	it("unpins when every selected chat is pinned", () => {
		expect(
			bulkPinAction([{ sidebarPinned: true }, { sidebarPinned: true }]),
		).toBe("unpin");
	});

	it("pins a mixed selection, so the unpinned ones get pinned", () => {
		expect(
			bulkPinAction([{ sidebarPinned: true }, { sidebarPinned: false }]),
		).toBe("pin");
	});

	it("reads a chat with no pin flag as unpinned", () => {
		expect(bulkPinAction([{}])).toBe("pin");
		expect(bulkPinAction([{ sidebarPinned: true }, {}])).toBe("pin");
	});
});

describe("shownConversationOrder", () => {
	const everythingOpen: ShownSections = {
		pinned: { expanded: true, ids: ["p1", "p2"] },
		projects: {
			expanded: true,
			folders: [
				{ expanded: true, ids: ["f1a", "f1b"] },
				{ expanded: true, ids: ["f2a"] },
			],
		},
		chats: { expanded: true, ids: ["c1", "c2"] },
	};

	it("lists Pinned, then each folder in folder order, then Chats", () => {
		expect(shownConversationOrder(everythingOpen)).toEqual([
			"p1",
			"p2",
			"f1a",
			"f1b",
			"f2a",
			"c1",
			"c2",
		]);
	});

	it("leaves out a collapsed Pinned section", () => {
		expect(
			shownConversationOrder({
				...everythingOpen,
				pinned: { expanded: false, ids: ["p1", "p2"] },
			}),
		).toEqual(["f1a", "f1b", "f2a", "c1", "c2"]);
	});

	it("leaves out every folder when the Projects section is collapsed, open folders included", () => {
		expect(
			shownConversationOrder({
				...everythingOpen,
				projects: { ...everythingOpen.projects, expanded: false },
			}),
		).toEqual(["p1", "p2", "c1", "c2"]);
	});

	it("leaves out a collapsed folder and keeps the others in place", () => {
		expect(
			shownConversationOrder({
				...everythingOpen,
				projects: {
					expanded: true,
					folders: [
						{ expanded: false, ids: ["f1a", "f1b"] },
						{ expanded: true, ids: ["f2a"] },
					],
				},
			}),
		).toEqual(["p1", "p2", "f2a", "c1", "c2"]);
	});

	it("leaves out a collapsed Chats section", () => {
		expect(
			shownConversationOrder({
				...everythingOpen,
				chats: { expanded: false, ids: ["c1", "c2"] },
			}),
		).toEqual(["p1", "p2", "f1a", "f1b", "f2a"]);
	});

	it("is empty when everything is collapsed or there are no chats", () => {
		expect(
			shownConversationOrder({
				pinned: { expanded: false, ids: ["p1"] },
				projects: {
					expanded: false,
					folders: [{ expanded: true, ids: ["f"] }],
				},
				chats: { expanded: false, ids: ["c"] },
			}),
		).toEqual([]);
		expect(
			shownConversationOrder({
				pinned: { expanded: true, ids: [] },
				projects: { expanded: true, folders: [] },
				chats: { expanded: true, ids: [] },
			}),
		).toEqual([]);
	});
});
