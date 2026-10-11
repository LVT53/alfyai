import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import {
	type DeriveMomentsInput,
	deriveMoments,
	type HistoryRow,
	type HistoryRowMeta,
} from "./derive";

const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);
const MINUTE = 60_000;
/** Rows are five minutes apart: well outside the two minutes of one turn of Alfy's. */
const STEP = 5 * MINUTE;

/** A block per [id, text]: the Document body the history reads. */
const doc = (...blocks: Array<[string, string]>) =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

function row(
	n: number,
	author: "user" | "alfy",
	summary: string,
	body: string,
	extra: Partial<HistoryRow> = {},
): HistoryRow {
	return {
		id: `v${n}`,
		versionNumber: n,
		author,
		summary,
		createdAt: T0 + n * STEP,
		startedAt: null,
		label: null,
		bodyHash: `hash:${body}`,
		body,
		large: false,
		...extra,
	};
}

/** Rows in the order the history is read: newest first. */
const newestFirst = (...rows: HistoryRow[]) =>
	[...rows].sort((a, b) => b.versionNumber - a.versionNumber);

function derive(
	rows: HistoryRow[],
	overrides: Partial<DeriveMomentsInput> = {},
	kind: ArtifactKind = "document",
) {
	const ordered = newestFirst(...rows);
	const top = ordered[0];
	return deriveMoments({
		kind,
		rows: ordered,
		limit: 50,
		newest: {
			id: top.id,
			versionNumber: top.versionNumber,
			bodyHash: top.bodyHash,
		},
		review: { hasMarker: false, waiting: new Set() },
		newer: [],
		referenced: [],
		tabs: [],
		...overrides,
	});
}

const D1 = doc(["p1", "Saturday"], ["p2", "Museum in the morning."]);
const D2 = doc(
	["p1", "Saturday"],
	["p2", "Museum in the morning."],
	["p3", "Rainy-day plan"],
);

describe("deriveMoments — single rows", () => {
	it("reads each row into the moment the reader would tell, newest first", () => {
		const { moments, older, nextBefore } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(
				2,
				"user",
				"Edited",
				doc(["p1", "Saturday!"], ["p2", "Museum in the morning."]),
			),
			row(3, "alfy", "Added a rainy-day plan", D2),
		]);

		expect(moments.map((m) => [m.versionNumber, m.kind, m.author])).toEqual([
			[3, "alfy_edit", "alfy"],
			[2, "user_edit", "user"],
			[1, "first_draft", "alfy"],
		]);
		expect(moments[0]).toMatchObject({
			text: "Added a rainy-day plan",
			fold: null,
			steps: [],
			isNewest: true,
			containsNewest: true,
			parentVersionId: "v2",
			parentVersionNumber: 2,
		});
		expect(moments[2]).toMatchObject({
			parentVersionId: null,
			parentVersionNumber: null,
			detail: { type: "none" },
		});
		expect(older).toBe(false);
		expect(nextBefore).toBeNull();
	});

	it("carries a burst's first save, the reader's name and the row's id for the preview", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2, {
				startedAt: T0 + 90 * MINUTE,
				createdAt: T0 + 99 * MINUTE,
				label: "Before the client call",
			}),
		]);
		expect(moments[0]).toMatchObject({
			versionId: "v2",
			at: T0 + 99 * MINUTE,
			startedAt: T0 + 90 * MINUTE,
			label: "Before the client call",
			bodyHash: `hash:${D2}`,
		});
		expect(moments[1].startedAt).toBeNull();
	});

	it("derives what changed from the row and its parent, and a tick from a lone flipped task", () => {
		const open = doc(
			["t1", "- [ ] Renew passport"],
			["t2", "- [ ] Book train"],
		);
		const ticked = doc(
			["t1", "- [x] Renew passport"],
			["t2", "- [ ] Book train"],
		);
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", open),
			row(2, "user", "Edited", ticked),
			row(
				3,
				"user",
				"Edited",
				doc(
					["t1", "- [x] Renew passport"],
					["t2", "- [ ] Book train"],
					["t3", "- [ ] Pack"],
				),
			),
		]);
		expect(moments[0]).toMatchObject({
			kind: "user_edit",
			detail: { type: "document", added: { count: 1, first: "Pack" } },
			tick: null,
		});
		expect(moments[1]).toMatchObject({
			kind: "tick",
			tick: { text: "Renew passport", checked: true },
		});
	});

	it("tells an App's brief, its rebuild prompt and a restore from the row's own words", () => {
		const { moments } = derive(
			[
				row(1, "alfy", "Alfy made the app: a tip calculator", "<p>v1</p>"),
				row(2, "alfy", "Alfy regenerated the app: make it blue", "<p>v2</p>"),
				row(3, "user", "Restored v1", "<p>v1</p>"),
			],
			{},
			"app",
		);
		expect(moments.map((m) => [m.kind, m.text])).toEqual([
			["restore", null],
			["app_rebuilt", "make it blue"],
			["app_made", "a tip calculator"],
		]);
		expect(moments[0].restoredFrom).toMatchObject({
			versionNumber: 1,
			versionId: "v1",
		});
		expect(moments[1].detail).toEqual({
			type: "app",
			linesAdded: 1,
			linesRemoved: 1,
		});
		// An App has no review: none of its moments has a status.
		expect(moments.every((m) => m.status === null)).toBe(true);
	});

	it("never lets a model's free text pass for a row of the reader's", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "alfy", "Added a plan", D2),
			row(3, "alfy", "Undid Alfy's change: v2", D1),
		]);
		expect(moments.map((m) => [m.kind, m.fold])).toEqual([
			["alfy_edit", null],
			["alfy_edit", null],
			["first_draft", null],
		]);
	});
});

describe("deriveMoments — folding (versioning.md §3.3)", () => {
	const A = row(2, "alfy", "Added a rainy-day plan", D2);

	it("F1: an Undo that immediately follows the change it undid is one moment", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change: v2", D1),
		]);
		expect(moments).toHaveLength(2);
		const [folded] = moments;
		expect(folded).toMatchObject({
			versionId: "v2",
			kind: "alfy_edit",
			fold: "undone",
			status: "undone",
			containsNewest: true,
			isNewest: false,
			undoneBy: { versionId: "v3", versionNumber: 3 },
			quiet: false,
		});
		expect(
			folded.steps.map((s) => [s.versionNumber, s.kind, s.author]),
		).toEqual([[3, "undo_alfy_change", "user"]]);
		// The step is the newest row and, because the Undo put the old text back,
		// it is the same text the first draft had.
		expect(folded.steps[0]).toMatchObject({
			isNewest: true,
			sameAs: { versionNumber: 1 },
		});
	});

	it("F1 does not fold an Undo that does not follow its change: it stays a line of its own, in time order", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(
				3,
				"user",
				"Edited",
				doc(
					["p1", "Saturday!"],
					["p2", "Museum in the morning."],
					["p3", "Rainy-day plan"],
				),
			),
			row(
				4,
				"user",
				"Undid Alfy's change: v2",
				doc(["p1", "Saturday!"], ["p2", "Museum in the morning."]),
			),
		]);
		expect(moments.map((m) => [m.versionNumber, m.kind, m.fold])).toEqual([
			[4, "undo_alfy_change", null],
			[3, "user_edit", null],
			[2, "alfy_edit", null],
			[1, "first_draft", null],
		]);
		// The Undo names the change it took back, with Alfy's own words.
		expect(moments[0].target).toMatchObject({
			versionId: "v2",
			versionNumber: 2,
			text: "Added a rainy-day plan",
		});
		// And the change knows it was undone later.
		expect(moments[2]).toMatchObject({
			status: "undone",
			undoneBy: { versionId: "v4", versionNumber: 4 },
		});
	});

	it("F2: the Redo that brings the change back completes the story, and the change reads Kept", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change: v2", D1),
			row(4, "user", "Redid Alfy's change: v2", D2),
		]);
		expect(moments).toHaveLength(2);
		expect(moments[0]).toMatchObject({
			versionId: "v2",
			fold: "redone",
			status: "kept",
			undoneBy: null,
			containsNewest: true,
		});
		expect(moments[0].steps.map((s) => [s.versionNumber, s.kind])).toEqual([
			[3, "undo_alfy_change"],
			[4, "redo_alfy_change"],
		]);
	});

	it("F2 does not complete a story the Redo is not about: it stays a line of its own after the folded Undo", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change: v2", D1),
			row(4, "user", "Redid Alfy's change: v9", D2),
		]);
		expect(moments.map((m) => [m.versionNumber, m.kind, m.fold])).toEqual([
			[4, "redo_alfy_change", null],
			[2, "alfy_edit", "undone"],
			[1, "first_draft", null],
		]);
	});

	it("F2 reads an older Redo (an ordinary save) by its body matching the change it brought back", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change", D1),
			row(4, "user", "Edited", D2),
		]);
		expect(moments).toHaveLength(2);
		expect(moments[0]).toMatchObject({ fold: "redone", status: "kept" });
		expect(moments[0].steps.map((s) => s.kind)).toEqual([
			"undo_alfy_change",
			"redo_alfy_change",
		]);
	});

	it("F1 folds an older, unnumbered Undo when it put back blocks the change touched", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change", D1),
		]);
		expect(moments[0]).toMatchObject({ fold: "undone", status: "undone" });
	});

	it("F1 does not fold an unnumbered Undo whose blocks Alfy's change never touched", () => {
		const elsewhere = doc(
			["p1", "Saturday?"],
			["p2", "Museum in the morning."],
			["p3", "Rainy-day plan"],
		);
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			A,
			row(3, "user", "Undid Alfy's change", elsewhere),
		]);
		expect(moments.map((m) => [m.kind, m.fold])).toEqual([
			["undo_alfy_change", null],
			["alfy_edit", null],
			["first_draft", null],
		]);
	});

	it("F3: a restore and its Undo are one quiet moment, and the Undo is the same text as before the restore", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2),
			row(3, "user", "Restored v1", D1),
			row(4, "user", "Undid restoring v3", D2),
		]);
		expect(
			moments.map((m) => [m.versionNumber, m.kind, m.fold, m.quiet]),
		).toEqual([
			[3, "restore", "restore_undone", true],
			[2, "user_edit", null, false],
			[1, "first_draft", null, false],
		]);
		expect(moments[0].steps).toHaveLength(1);
		expect(moments[0].steps[0]).toMatchObject({
			kind: "undo_restore",
			sameAs: { versionNumber: 2 },
			isNewest: true,
		});
		expect(moments[0].restoredFrom).toMatchObject({ versionNumber: 1 });
	});

	it("F3 does not fold a restore with the edit that came after it", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2),
			row(3, "user", "Restored v1", D1),
			row(
				4,
				"user",
				"Edited",
				doc(["p1", "Saturday!"], ["p2", "Museum in the morning."]),
			),
		]);
		expect(moments.map((m) => [m.kind, m.fold])).toEqual([
			["user_edit", null],
			["restore", null],
			["user_edit", null],
			["first_draft", null],
		]);
	});

	describe("F4: one turn of Alfy's", () => {
		const bodies = [
			doc(["p1", "Saturday"]),
			doc(["p1", "Saturday"], ["p2", "One"]),
			doc(["p1", "Saturday"], ["p2", "One"], ["p3", "Two"]),
			doc(["p1", "Saturday"], ["p2", "One"], ["p3", "Two"], ["p4", "Three"]),
		];
		const at = (n: number, seconds: number) =>
			T0 + 20 * MINUTE + seconds * 1000 + n;

		it("draws consecutive edits less than two minutes apart as one moment with a step each", () => {
			const { moments } = derive([
				row(1, "alfy", "Alfy wrote the first draft", bodies[0]),
				row(2, "alfy", "Added one", bodies[1], { createdAt: at(2, 0) }),
				row(3, "alfy", "Added two", bodies[2], { createdAt: at(3, 40) }),
				row(4, "alfy", "Added three", bodies[3], { createdAt: at(4, 100) }),
			]);
			expect(moments).toHaveLength(2);
			const [turn] = moments;
			expect(turn).toMatchObject({
				kind: "alfy_turn",
				fold: "alfy_turn",
				versionId: "v4",
				parentVersionId: "v1",
				isNewest: true,
				text: null,
			});
			expect(turn.steps.map((s) => [s.versionNumber, s.text])).toEqual([
				[2, "Added one"],
				[3, "Added two"],
				[4, "Added three"],
			]);
			// The turn's detail is what the whole turn did, not its last step.
			expect(turn.detail).toMatchObject({
				type: "document",
				added: { count: 3, first: "One" },
			});
		});

		it("does not fold edits two minutes apart, an edit with the reader's between, or a comment reply", () => {
			const { moments } = derive([
				row(1, "alfy", "Alfy wrote the first draft", bodies[0]),
				row(2, "alfy", "Added one", bodies[1], { createdAt: at(2, 0) }),
				row(3, "alfy", "Added two", bodies[2], { createdAt: at(3, 120) }),
				row(
					4,
					"user",
					"Edited",
					doc(["p1", "Saturday!"], ["p2", "One"], ["p3", "Two"]),
				),
				row(5, "alfy", "Added three", bodies[3], { createdAt: at(5, 130) }),
				row(
					6,
					"alfy",
					"Alfy's comment reply",
					doc(
						["p1", "Saturday!"],
						["p2", "One"],
						["p3", "Two"],
						["p4", "Three"],
						["p5", "Four"],
					),
					{ createdAt: at(6, 135) },
				),
			]);
			expect(moments.map((m) => [m.versionNumber, m.kind, m.fold])).toEqual([
				[6, "alfy_reply_edit", null],
				[5, "alfy_edit", null],
				[4, "user_edit", null],
				[3, "alfy_edit", null],
				[2, "alfy_edit", null],
				[1, "first_draft", null],
			]);
		});

		it("closes a turn after twelve rows, from the newest down, so a page boundary never changes a moment", () => {
			const many = Array.from({ length: 15 }, (_, i) =>
				row(i + 2, "alfy", `Step ${i + 1}`, doc(["p1", `Text ${i}`]), {
					createdAt: at(i, i),
				}),
			);
			const { moments } = derive([
				row(1, "alfy", "Alfy wrote the first draft", bodies[0]),
				...many,
			]);
			expect(moments.map((m) => [m.kind, m.steps.length])).toEqual([
				["alfy_turn", 12],
				["alfy_turn", 3],
				["first_draft", 0],
			]);
		});
	});
});

describe("deriveMoments — pages", () => {
	function longHistory() {
		const rows: HistoryRow[] = [
			row(1, "alfy", "Alfy wrote the first draft", doc(["p1", "T0"])),
		];
		let n = 1;
		const push = (
			author: "user" | "alfy",
			summary: string,
			text: string,
			extra: Partial<HistoryRow> = {},
		) => {
			n += 1;
			rows.push(row(n, author, summary, doc(["p1", text]), extra));
		};
		for (let i = 0; i < 6; i += 1) {
			push("user", "Edited", `edit ${i}`);
			push("alfy", `Alfy ${i}`, `alfy ${i}`);
			push("user", `Undid Alfy's change: v${n}`, `after undo ${i}`);
		}
		return rows;
	}

	it("never cuts a folded moment in two: a page ends where a moment ends", () => {
		const rows = longHistory();
		const ordered = newestFirst(...rows);
		const first = deriveMoments({
			kind: "document",
			rows: ordered,
			limit: 4,
			newest: {
				id: ordered[0].id,
				versionNumber: ordered[0].versionNumber,
				bodyHash: ordered[0].bodyHash,
			},
			review: { hasMarker: false, waiting: new Set() },
			newer: [],
			referenced: [],
			tabs: [],
		});
		expect(first.moments.length).toBeGreaterThanOrEqual(1);
		expect(first.older).toBe(true);
		// Every moment's rows are whole: a folded Undo is never the oldest row of a page without its change.
		for (const moment of first.moments) {
			if (moment.fold === "undone") {
				expect(moment.steps).toHaveLength(1);
			}
		}
		const lowest = Math.min(
			...first.moments.flatMap((m) => [
				m.versionNumber,
				...m.steps.map((s) => s.versionNumber),
			]),
		);
		expect(first.nextBefore).toBe(lowest);
	});

	it("gives the same moments paged as read in one go", () => {
		const rows = longHistory();
		const whole = derive(rows).moments;

		const collected: typeof whole = [];
		let before = Infinity;
		for (let guard = 0; guard < 30; guard += 1) {
			const window = newestFirst(
				...rows.filter((r) => r.versionNumber < before),
			);
			if (window.length === 0) break;
			const page = deriveMoments({
				kind: "document",
				rows: window,
				limit: 5,
				newest: {
					id: "v19",
					versionNumber: 19,
					bodyHash: rows[rows.length - 1].bodyHash,
				},
				review: { hasMarker: false, waiting: new Set() },
				newer: [],
				referenced: [],
				tabs: [],
			});
			collected.push(...page.moments);
			if (!page.older || page.nextBefore === null) break;
			before = page.nextBefore;
		}
		const strip = (moments: typeof whole) =>
			moments.map((m) => [
				m.versionNumber,
				m.kind,
				m.fold,
				m.steps.map((s) => s.versionNumber),
			]);
		expect(strip(collected)).toEqual(strip(whole));
	});
});

describe("deriveMoments — markers", () => {
	it("marks the version that equals now, and the one a later version is the same as", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2),
			row(3, "user", "Restored v1", D1),
			row(4, "user", "Edited", D1),
		]);
		const byNumber = (n: number) => moments.find((m) => m.versionNumber === n);
		// v4 is the newest; v3 and v1 hold the same text.
		expect(byNumber(4)).toMatchObject({ isNewest: true, sameAsNow: false });
		expect(byNumber(3)).toMatchObject({
			sameAsNow: true,
			sameAs: { versionNumber: 1 },
		});
		expect(byNumber(1)).toMatchObject({ sameAsNow: true, sameAs: null });
		expect(byNumber(2)).toMatchObject({ sameAsNow: false, sameAs: null });
		// The source of the restore knows it was restored from, and when.
		expect(byNumber(1)?.restoredHere).toEqual([
			{ versionId: "v3", versionNumber: 3, at: T0 + 3 * STEP },
		]);
	});

	it("knows 'same as now' on a page that does not hold the newest row, and restores made after it", () => {
		const old = newestFirst(
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2),
		);
		const { moments } = deriveMoments({
			kind: "document",
			rows: old,
			limit: 50,
			newest: { id: "v9", versionNumber: 9, bodyHash: `hash:${D1}` },
			review: { hasMarker: false, waiting: new Set() },
			newer: [
				{
					id: "v7",
					versionNumber: 7,
					author: "user",
					summary: "Restored v1",
					createdAt: T0 + 7 * STEP,
				},
				{
					id: "v8",
					versionNumber: 8,
					author: "user",
					summary: "Restored v1",
					createdAt: T0 + 8 * STEP,
				},
			],
			referenced: [],
			tabs: [],
		});
		const first = moments.find((m) => m.versionNumber === 1);
		expect(first).toMatchObject({ sameAsNow: true, containsNewest: false });
		// Newest first, however many there are.
		expect(first?.restoredHere.map((r) => r.versionNumber)).toEqual([8, 7]);
		expect(moments.find((m) => m.versionNumber === 2)?.sameAsNow).toBe(false);
	});

	it("names the version a restore brought back even when that row is on an older page", () => {
		const rows = newestFirst(
			row(5, "user", "Restored v2", D2),
			row(4, "user", "Edited", D1),
		);
		const referenced: HistoryRowMeta[] = [
			{
				id: "v2",
				versionNumber: 2,
				author: "user",
				summary: "Edited",
				createdAt: T0 + 2 * STEP,
			},
		];
		const { moments } = derive([...rows, row(3, "user", "Edited", D1)], {
			referenced,
		});
		expect(moments[0].restoredFrom).toEqual({
			versionId: "v2",
			versionNumber: 2,
			at: T0 + 2 * STEP,
		});
	});
});

describe("deriveMoments — review statuses (rulings 61, 63; amendment A4)", () => {
	const base = [
		row(1, "alfy", "Alfy wrote the first draft", D1),
		row(2, "alfy", "Added a rainy-day plan", D2),
	];

	it("says Waiting for a change the review still holds, Kept once it is decided, and nothing for the reader's own", () => {
		const waiting = derive(
			[
				...base,
				row(
					3,
					"user",
					"Edited",
					doc(
						["p1", "Saturday!"],
						["p2", "Museum in the morning."],
						["p3", "Rainy-day plan"],
					),
				),
			],
			{ review: { hasMarker: true, waiting: new Set([2]) } },
		);
		expect(waiting.moments.map((m) => [m.versionNumber, m.status])).toEqual([
			[3, null],
			[2, "waiting"],
			[1, null],
		]);

		const decided = derive(base, {
			review: { hasMarker: true, waiting: new Set() },
		});
		expect(decided.moments.map((m) => [m.versionNumber, m.status])).toEqual([
			[2, "kept"],
			[1, null],
		]);
	});

	it("reads a change made before the marker existed as kept, never as waiting", () => {
		const { moments } = derive(base, {
			review: { hasMarker: false, waiting: new Set() },
		});
		expect(moments[0].status).toBe("kept");
	});

	it("aggregates a turn of Alfy's: waiting if any step waits", () => {
		const bodies = [
			doc(["p1", "a"]),
			doc(["p1", "a"], ["p2", "b"]),
			doc(["p1", "a"], ["p2", "b"], ["p3", "c"]),
		];
		const rows = [
			row(1, "alfy", "Alfy wrote the first draft", bodies[0]),
			row(2, "alfy", "One", bodies[1], { createdAt: T0 + 10 * MINUTE }),
			row(3, "alfy", "Two", bodies[2], {
				createdAt: T0 + 10 * MINUTE + 30_000,
			}),
		];
		const { moments } = derive(rows, {
			review: { hasMarker: true, waiting: new Set([3]) },
		});
		expect(moments[0]).toMatchObject({ kind: "alfy_turn", status: "waiting" });
		const decided = derive(rows, {
			review: { hasMarker: true, waiting: new Set() },
		});
		expect(decided.moments[0].status).toBe("kept");
	});

	it("leaves a change a later restore put back before no status: neither Kept nor Undone is true of it", () => {
		const { moments } = derive([...base, row(3, "user", "Restored v1", D1)], {
			review: { hasMarker: true, waiting: new Set() },
		});
		expect(moments.find((m) => m.versionNumber === 2)?.status).toBeNull();
	});

	it("reads Partly kept when the reader undid only some of the blocks Alfy changed", () => {
		const before = doc(["p1", "One"], ["p2", "Two"]);
		const alfy = doc(["p1", "One, edited"], ["p2", "Two, edited"]);
		const history = (undoBody: string) =>
			derive(
				[
					row(1, "alfy", "Alfy wrote the first draft", before),
					row(2, "alfy", "Edited both", alfy),
					row(
						3,
						"user",
						"Edited",
						doc(
							["p1", "One, edited"],
							["p2", "Two, edited"],
							["p9", "Typed elsewhere"],
						),
					),
					row(4, "user", "Undid Alfy's change: v2", undoBody),
				],
				{ review: { hasMarker: true, waiting: new Set() } },
			).moments.find((m) => m.versionNumber === 2);
		expect(
			history(
				doc(["p1", "One"], ["p2", "Two, edited"], ["p9", "Typed elsewhere"]),
			)?.status,
		).toBe("partly_kept");
		expect(
			history(doc(["p1", "One"], ["p2", "Two"], ["p9", "Typed elsewhere"]))
				?.status,
		).toBe("undone");
	});

	it("gives a board's change one status: waiting, undone or kept", () => {
		const board = (text: string) =>
			JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "a",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text, tone: "yellow" },
					},
				],
				edges: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				annotations: [],
			});
		const rows = [
			row(1, "alfy", "Alfy wrote the first draft", board("one")),
			row(2, "alfy", "Reworded", board("two")),
		];
		expect(
			derive(
				rows,
				{ review: { hasMarker: true, waiting: new Set([2]) } },
				"canvas",
			).moments[0],
		).toMatchObject({
			status: "waiting",
			detail: { type: "canvas", blocksChanged: { count: 1, first: "two" } },
		});
		const undone = derive(
			[...rows, row(3, "user", "Undid Alfy's change: v2", board("one"))],
			{ review: { hasMarker: true, waiting: new Set() } },
			"canvas",
		);
		expect(undone.moments[0]).toMatchObject({
			fold: "undone",
			status: "undone",
		});
	});
});

describe("deriveMoments — facts that need a body", () => {
	it("says 'large change' for a pair it did not compare, and never throws on a body it does not have", () => {
		const { moments } = derive([
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", "x".repeat(10), { large: true, body: null }),
			row(3, "user", "Edited", D2),
			row(4, "user", "Edited", "unread", { body: null }),
		]);
		const detail = (n: number) =>
			moments.find((m) => m.versionNumber === n)?.detail;
		expect(detail(2)).toEqual({ type: "large" });
		// A version whose parent was too large to read is not compared with it either.
		expect(detail(3)).toEqual({ type: "large" });
		expect(detail(4)).toEqual({ type: "none" });
		expect(detail(1)).toEqual({ type: "none" });
	});

	it("reuses what it derived for a row, keyed by the row and its hash", () => {
		const cache = new Map();
		const rows = [
			row(1, "alfy", "Alfy wrote the first draft", D1),
			row(2, "user", "Edited", D2),
		];
		derive(rows, { cache });
		expect(cache.size).toBeGreaterThan(0);
		const again = derive(rows, { cache }).moments;
		expect(again[0].detail).toMatchObject({
			type: "document",
			added: { count: 1 },
		});
		// A row that changed (same id, new hash) is derived afresh.
		const changed = derive(
			[
				rows[0],
				{
					...rows[1],
					bodyHash: "hash:other",
					body: doc(
						["p1", "Saturday"],
						["p2", "Museum in the morning."],
						["p3", "Rainy-day plan"],
						["p4", "More"],
					),
				},
			],
			{ cache },
		).moments;
		expect(changed[0].detail).toMatchObject({ added: { count: 2 } });
	});

	it("attaches Alfy's reply comment to an edit that answered it", () => {
		const { moments } = derive(
			[
				row(1, "alfy", "Alfy wrote the first draft", D1),
				row(2, "alfy", "Alfy's comment reply", D2),
			],
			{ commentByVersion: new Map([[2, "comment-7"]]) },
		);
		expect(moments[0]).toMatchObject({
			kind: "alfy_reply_edit",
			commentId: "comment-7",
		});
		expect(moments[1].commentId).toBeNull();
	});
});
