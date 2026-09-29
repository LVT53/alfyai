import { describe, expect, it } from "vitest";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { makeBlock } from "$lib/shared/artifact-document/blocks";
import {
	commentAnchorTargets,
	commentRailWidth,
	countCommentsByTab,
	groupResolvableByTab,
	orderCommentsByPosition,
	otherTabRows,
	pickFollowedComment,
	resolveCommentAnchors,
} from "./comment-threads";

function comment(
	id: string,
	blockId: string | null,
	quote: string,
	overrides: Partial<ArtifactComment> = {},
): ArtifactComment {
	return {
		id,
		artifactId: "artifact-1",
		parentId: null,
		anchor:
			blockId === null
				? null
				: { kind: "text", blockId, quote, prefix: "", suffix: "" },
		author: "user",
		body: `body of ${id}`,
		status: "open",
		createdAt: 1_000,
		replies: [],
		...overrides,
	};
}

const BLOCKS = [
	makeBlock("h1", "heading", "## Overview"),
	makeBlock("p1", "paragraph", "Book the flight and the hotel for Vienna."),
	makeBlock("p2", "paragraph", "Then a long lunch at the Café Sperl."),
	makeBlock("h2", "heading", "## Budget"),
	makeBlock("p3", "paragraph", "The hotel is 135 euros a night."),
];

const TABS: DocumentTab[] = [
	{ id: "t-overview", title: "Overview", startBlockId: "h1" },
	{ id: "t-budget", title: "Budget", startBlockId: "h2" },
];

describe("resolveCommentAnchors", () => {
	it("maps every comment to its own resolution, orphaning a null or vanished anchor", () => {
		const resolutions = resolveCommentAnchors(
			[
				comment("a", "p1", "flight"),
				comment("b", null, ""),
				comment("c", "p2", "a phrase that is gone"),
			],
			BLOCKS,
		);
		expect(resolutions.get("a")?.blockId).toBe("p1");
		expect(resolutions.get("a")?.state).not.toBe("orphaned");
		expect(resolutions.get("b")?.state).toBe("orphaned");
		expect(resolutions.get("c")?.state).toBe("orphaned");
	});
});

describe("commentAnchorTargets", () => {
	it("reports only the anchors that still resolve, with the resolved flag", () => {
		const comments = [
			comment("a", "p1", "flight"),
			comment("b", "p2", "lunch", { status: "resolved" }),
			comment("c", "p2", "a phrase that is gone"),
		];
		const targets = commentAnchorTargets(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
		);
		expect(targets.map((t) => t.commentId)).toEqual(["a", "b"]);
		expect(targets[0]).toMatchObject({ blockId: "p1", resolved: false });
		expect(targets[1]).toMatchObject({ blockId: "p2", resolved: true });
		expect(targets[0].from).toBeGreaterThanOrEqual(0);
		expect(targets[0].to).toBeGreaterThan(targets[0].from);
	});
});

describe("orderCommentsByPosition", () => {
	it("orders by the words' position in the document, never by creation order", () => {
		const comments = [
			comment("late-block", "p2", "lunch", { createdAt: 1 }),
			comment("early-block", "p1", "flight", { createdAt: 2 }),
		];
		const ordered = orderCommentsByPosition(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
		);
		expect(ordered.map((c) => c.id)).toEqual(["early-block", "late-block"]);
	});

	it("orders two comments in one block by where their words start", () => {
		const comments = [
			comment("hotel", "p1", "hotel", { createdAt: 1 }),
			comment("flight", "p1", "flight", { createdAt: 2 }),
		];
		const ordered = orderCommentsByPosition(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
		);
		expect(ordered.map((c) => c.id)).toEqual(["flight", "hotel"]);
	});

	it("breaks a tie on the same words by creation time, then id, and never mutates its input", () => {
		const comments = [
			comment("b", "p1", "flight", { createdAt: 5 }),
			comment("a", "p1", "flight", { createdAt: 5 }),
			comment("c", "p1", "flight", { createdAt: 1 }),
		];
		const snapshot = [...comments];
		const ordered = orderCommentsByPosition(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
		);
		expect(ordered.map((c) => c.id)).toEqual(["c", "a", "b"]);
		expect(comments).toEqual(snapshot);
	});

	it("puts orphans after every placed thread, ordered by the block they once sat in", () => {
		const comments = [
			comment("orphan-late", "p3", "gone words"),
			comment("placed", "p2", "lunch"),
			comment("orphan-early", "p1", "other gone words"),
			comment("null-anchor", null, ""),
		];
		const ordered = orderCommentsByPosition(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
		);
		expect(ordered.map((c) => c.id)).toEqual([
			"placed",
			"orphan-early",
			"orphan-late",
			"null-anchor",
		]);
	});
});

describe("countCommentsByTab and otherTabRows", () => {
	it("counts open and resolved threads per tab by the block each one was made on, orphans included", () => {
		const comments = [
			comment("a", "p1", "flight"),
			// Orphaned words, but its block still sits in the Overview tab: the
			// tab badge counts it, so this count must too.
			comment("b", "p1", "words that are gone"),
			comment("c", "p3", "hotel", { status: "resolved" }),
			comment("d", "p3", "euros"),
		];
		const counts = countCommentsByTab(comments, BLOCKS, TABS);
		expect(counts.get("t-overview")).toEqual({ open: 2, resolved: 0 });
		expect(counts.get("t-budget")).toEqual({ open: 1, resolved: 1 });
	});

	it("counts nothing for a document with one tab or none", () => {
		const comments = [comment("a", "p1", "flight")];
		expect(countCommentsByTab(comments, BLOCKS, []).size).toBe(0);
		expect(countCommentsByTab(comments, BLOCKS, [TABS[0]]).size).toBe(0);
	});

	it("lists every other tab that has comments, in tab order, with no zero counts", () => {
		const comments = [
			comment("a", "p1", "flight"),
			comment("c", "p3", "hotel", { status: "resolved" }),
		];
		const rows = otherTabRows(comments, BLOCKS, TABS, "t-overview");
		expect(rows).toEqual([{ tab: TABS[1], open: 0, resolved: 1 }]);
		expect(otherTabRows(comments, BLOCKS, TABS, "t-budget")).toEqual([
			{ tab: TABS[0], open: 1, resolved: 0 },
		]);
	});

	it("leaves out a tab with no comments at all", () => {
		const comments = [comment("a", "p1", "flight")];
		expect(otherTabRows(comments, BLOCKS, TABS, "t-overview")).toEqual([]);
	});
});

describe("groupResolvableByTab", () => {
	it("groups placed threads by tab in tab order, each group in document order, skipping empty tabs", () => {
		const comments = [
			comment("budget-1", "p3", "hotel"),
			comment("overview-2", "p2", "lunch"),
			comment("overview-1", "p1", "flight"),
			comment("orphan", "p1", "gone words"),
		];
		const groups = groupResolvableByTab(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
			TABS,
		);
		expect(groups.map((g) => g.tab?.id)).toEqual(["t-overview", "t-budget"]);
		expect(groups[0].comments.map((c) => c.id)).toEqual([
			"overview-1",
			"overview-2",
		]);
		expect(groups[1].comments.map((c) => c.id)).toEqual(["budget-1"]);
	});

	it("returns one group without a tab for a document with a single section", () => {
		const comments = [comment("a", "p1", "flight")];
		const groups = groupResolvableByTab(
			comments,
			resolveCommentAnchors(comments, BLOCKS),
			BLOCKS,
			[],
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].tab).toBeNull();
		expect(groups[0].comments.map((c) => c.id)).toEqual(["a"]);
	});

	it("returns no groups when nothing is placed", () => {
		expect(groupResolvableByTab([], new Map(), BLOCKS, TABS)).toEqual([]);
	});
});

describe("pickFollowedComment", () => {
	const viewport = { top: 100, bottom: 600 };

	it("returns null with nothing to follow", () => {
		expect(pickFollowedComment([], viewport)).toBeNull();
	});

	it("picks the words nearest the top of the reading area", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "below", top: 400, bottom: 420 },
					{ commentId: "near-top", top: 130, bottom: 150 },
				],
				viewport,
			),
		).toBe("near-top");
	});

	it("ignores words wholly above or below the reading area", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "above", top: 20, bottom: 40 },
					{ commentId: "below", top: 700, bottom: 720 },
				],
				viewport,
			),
		).toBeNull();
	});

	it("counts words that straddle the top edge while their end is still readable", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "straddling", top: 80, bottom: 140 },
					{ commentId: "lower", top: 300, bottom: 320 },
				],
				viewport,
			),
		).toBe("straddling");
	});

	it("treats words that have all but scrolled off the top as already read", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "gone-by", top: 80, bottom: 102 },
					{ commentId: "next", top: 300, bottom: 320 },
				],
				viewport,
			),
		).toBe("next");
	});

	it("keeps document order on a tie", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "first", top: 200, bottom: 220 },
					{ commentId: "second", top: 200, bottom: 220 },
				],
				viewport,
			),
		).toBe("first");
	});

	it("ignores an anchor that has no box at all (its tab is hidden)", () => {
		expect(
			pickFollowedComment(
				[
					{ commentId: "hidden", top: 150, bottom: 150 },
					{ commentId: "shown", top: 250, bottom: 270 },
				],
				viewport,
			),
		).toBe("shown");
	});
});

describe("commentRailWidth", () => {
	it("gives a roomy panel the full 300px column", () => {
		expect(commentRailWidth(1000)).toBe(300);
		expect(commentRailWidth(1240)).toBe(300);
	});

	it("narrows the column, never the text, as the panel narrows", () => {
		expect(commentRailWidth(760)).toBe(280);
		expect(commentRailWidth(740)).toBe(260);
		expect(commentRailWidth(720)).toBe(240);
	});

	it("says there is no room for an inline column once the text would drop below 480px", () => {
		expect(commentRailWidth(719)).toBeNull();
		expect(commentRailWidth(600)).toBeNull();
	});

	it("assumes there is room before the panel has been measured", () => {
		expect(commentRailWidth(0)).toBe(300);
	});

	it("keeps 480px or more for the text at every panel width that shows the column", () => {
		for (let width = 720; width <= 1700; width += 7) {
			const rail = commentRailWidth(width);
			expect(rail).not.toBeNull();
			expect(rail).toBeGreaterThanOrEqual(240);
			expect(rail).toBeLessThanOrEqual(300);
			expect(width - (rail ?? 0)).toBeGreaterThanOrEqual(480);
		}
	});

	it("is what the laptop layouts get: the docked panel at 1280, 1366, 1440 and 1512 wide windows", () => {
		// The docked panel is min(68% of the window, 950px), less its 1px border.
		for (const window of [1280, 1366, 1440, 1512]) {
			const panel = Math.min(window * 0.68, 950) - 1;
			expect(commentRailWidth(panel)).toBe(300);
		}
	});
});
