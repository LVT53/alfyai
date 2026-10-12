import { describe, expect, it } from "vitest";
import {
	classifyVersionSummary,
	madeAppSummary,
	parseMadeApp,
	parseRedidAlfyChange,
	parseRegeneratedApp,
	parseRestoredVersion,
	parseSaveSummaryKind,
	parseSummaryVersion,
	parseUndidAlfyChange,
	parseUndidRestore,
	redidAlfyChangeSummary,
	regeneratedAppSummary,
	restoredSummary,
	saveSummaryFor,
	undidAlfyChangeSummary,
	undidRestoreSummary,
	VERSION_SUMMARY,
} from "./version-summaries";

describe("save summary kinds", () => {
	it("recognises the one named kind and nothing else", () => {
		expect(parseSaveSummaryKind("undid_alfy_change")).toBe("undid_alfy_change");
		expect(parseSaveSummaryKind("edited")).toBeNull();
		expect(parseSaveSummaryKind("Undid Alfy's change")).toBeNull();
		expect(parseSaveSummaryKind(undefined)).toBeNull();
		expect(parseSaveSummaryKind(42)).toBeNull();
		expect(parseSaveSummaryKind({})).toBeNull();
	});

	it("never mistakes an inherited property name for a kind", () => {
		for (const inherited of [
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(parseSaveSummaryKind(inherited)).toBeNull();
		}
	});

	it("stores an ordinary save as Edited and a named kind under its own summary", () => {
		expect(saveSummaryFor(null)).toBe(VERSION_SUMMARY.edited);
		expect(saveSummaryFor(undefined)).toBe("Edited");
		expect(saveSummaryFor("undid_alfy_change")).toBe("Undid Alfy's change");
	});
});

// Polish G2-A: a restore names the version it brought back ("Restored v3"),
// instead of wrapping that version's own summary ("restored Edited").
describe("restore summaries", () => {
	it("names the version a restore came from, and reads it back", () => {
		expect(restoredSummary(3)).toBe("Restored v3");
		expect(parseRestoredVersion("Restored v3")).toBe(3);
		expect(parseRestoredVersion(restoredSummary(12))).toBe(12);
	});

	it("reads only that exact shape — never the older wrapper, a free-form label or a look-alike", () => {
		for (const other of [
			"restored Edited",
			"Restored v",
			"Restored v3 by mistake",
			"Restored vx",
			"restored v3",
			"Moved the museum to Thursday",
			"",
		]) {
			expect(parseRestoredVersion(other)).toBeNull();
		}
	});
});

// Versioning (ruling 76, amendment A5): every summary the server writes is in
// this one vocabulary, an Undo or Redo names the version it acts on, and the
// older wordings in existing rows stay readable.
describe("the new vocabulary", () => {
	it("keeps the fixed literals the rows already hold", () => {
		expect(VERSION_SUMMARY.alfyEdit).toBe("Alfy's edit");
		expect(VERSION_SUMMARY.alfyCommentReply).toBe("Alfy's comment reply");
		expect(VERSION_SUMMARY.keptFromChat).toBe("Kept from a chat reply");
		expect(VERSION_SUMMARY.alfyRemade).toBe("Alfy made it again");
	});

	it("writes and reads an App's brief and rebuild prompt", () => {
		expect(madeAppSummary("a tip calculator")).toBe(
			"Alfy made the app: a tip calculator",
		);
		expect(parseMadeApp("Alfy made the app: a tip calculator")).toBe(
			"a tip calculator",
		);
		expect(parseMadeApp("Alfy made the app: ")).toBe("");
		expect(parseMadeApp("Alfy made the application")).toBeNull();
		expect(parseMadeApp("Edited")).toBeNull();
		expect(regeneratedAppSummary("make it blue")).toBe(
			"Alfy regenerated the app: make it blue",
		);
		expect(parseRegeneratedApp("Alfy regenerated the app: make it blue")).toBe(
			"make it blue",
		);
		expect(parseRegeneratedApp("Alfy made the app: x")).toBeNull();
	});

	it("names the version an Undo, a Redo and an undone restore act on, and still reads the old plain Undo", () => {
		expect(undidAlfyChangeSummary(7)).toBe("Undid Alfy's change: v7");
		expect(undidAlfyChangeSummary()).toBe("Undid Alfy's change");
		expect(parseUndidAlfyChange("Undid Alfy's change: v7")).toEqual({
			version: 7,
		});
		expect(parseUndidAlfyChange("Undid Alfy's change")).toEqual({
			version: null,
		});
		expect(redidAlfyChangeSummary(7)).toBe("Redid Alfy's change: v7");
		expect(parseRedidAlfyChange("Redid Alfy's change: v7")).toEqual({
			version: 7,
		});
		expect(undidRestoreSummary(9)).toBe("Undid restoring v9");
		expect(parseUndidRestore("Undid restoring v9")).toBe(9);
	});

	// RV-V I-3: one press can take back several of Alfy's versions (a board's Undo
	// restores the version before Alfy's whole run; the Document's "Undo all" undoes
	// every pending change in one save), so the summary names the range it took back,
	// not only the newest, or History calls the rest Kept.
	it("names a RANGE of Alfy versions an Undo or a Redo acts on, and reads it back", () => {
		expect(undidAlfyChangeSummary(3, 2)).toBe("Undid Alfy's changes: v2 to v3");
		expect(parseUndidAlfyChange("Undid Alfy's changes: v2 to v3")).toEqual({
			version: 3,
			fromVersion: 2,
		});
		expect(redidAlfyChangeSummary(3, 2)).toBe("Redid Alfy's changes: v2 to v3");
		expect(parseRedidAlfyChange("Redid Alfy's changes: v2 to v3")).toEqual({
			version: 3,
			fromVersion: 2,
		});
		// A single version stays in the form every older row has.
		expect(undidAlfyChangeSummary(3, 3)).toBe("Undid Alfy's change: v3");
		expect(parseUndidAlfyChange("Undid Alfy's change: v3")).toEqual({
			version: 3,
		});
		// A range that is not one (it starts at or after its end) names the newest alone.
		expect(undidAlfyChangeSummary(3, 5)).toBe("Undid Alfy's change: v3");
		expect(redidAlfyChangeSummary(3, 3)).toBe("Redid Alfy's change: v3");
		expect(parseUndidAlfyChange("Undid Alfy's changes: v3 to v3")).toEqual({
			version: 3,
		});
		expect(parseUndidAlfyChange("Undid Alfy's changes: v5 to v3")).toEqual({
			version: 3,
		});
		for (const other of [
			"Undid Alfy's changes: v2 to v",
			"Undid Alfy's changes: v2-v3",
			"Undid Alfy's changes: v2 to v3 twice",
			"Undid Alfy's change: v2 to v3",
			"undid Alfy's changes: v2 to v3",
		]) {
			expect(parseUndidAlfyChange(other)).toBeNull();
		}
		expect(parseRedidAlfyChange("Redid Alfy's changes: v2")).toBeNull();
	});

	it("reads only those exact shapes, never a look-alike", () => {
		for (const other of [
			"Undid Alfy's change: v",
			"Undid Alfy's change: v7 by mistake",
			"Undid Alfy's change: 7",
			"undid Alfy's change: v7",
			"Undid Alfy's change:v7",
			"Undid Alfy's changes",
		]) {
			expect(parseUndidAlfyChange(other)).toBeNull();
		}
		expect(parseRedidAlfyChange("Redid Alfy's change")).toBeNull();
		expect(parseRedidAlfyChange("Redid Alfy's change: v0x")).toBeNull();
		expect(parseUndidRestore("Undid restoring v")).toBeNull();
		expect(parseUndidRestore("Restored v9")).toBeNull();
	});

	it("accepts a summary version only as a positive integer", () => {
		expect(parseSummaryVersion(7)).toBe(7);
		for (const bad of [0, -1, 1.5, "7", null, undefined, Number.NaN, 2 ** 40]) {
			expect(parseSummaryVersion(bad)).toBeNull();
		}
	});

	it("stores an Undo or Redo under the version it names, and an unnamed Undo under the old plain summary", () => {
		expect(saveSummaryFor("undid_alfy_change", 7)).toBe(
			"Undid Alfy's change: v7",
		);
		expect(saveSummaryFor("undid_alfy_change")).toBe("Undid Alfy's change");
		expect(saveSummaryFor("redid_alfy_change", 7)).toBe(
			"Redid Alfy's change: v7",
		);
		// A Redo with no change to name is just an edit.
		expect(saveSummaryFor("redid_alfy_change")).toBe("Edited");
		expect(parseSaveSummaryKind("redid_alfy_change")).toBe("redid_alfy_change");
	});

	it("stores an Undo or Redo of several versions under the range it names", () => {
		expect(saveSummaryFor("undid_alfy_change", 3, 2)).toBe(
			"Undid Alfy's changes: v2 to v3",
		);
		expect(saveSummaryFor("redid_alfy_change", 3, 2)).toBe(
			"Redid Alfy's changes: v2 to v3",
		);
		// With no newest version there is no range to name.
		expect(saveSummaryFor("undid_alfy_change", null, 2)).toBe(
			"Undid Alfy's change",
		);
		expect(saveSummaryFor("redid_alfy_change", null, 2)).toBe("Edited");
	});
});

describe("classifying a row's summary into a moment kind", () => {
	const classify = (
		author: "user" | "alfy",
		summary: string,
		versionNumber = 4,
	) => classifyVersionSummary({ author, summary, versionNumber });

	it("reads the reader's rows", () => {
		expect(classify("user", "Edited")).toMatchObject({
			kind: "user_edit",
			actor: "user",
		});
		expect(classify("user", "Saved as a new document", 1)).toMatchObject({
			kind: "saved_as_copy",
			actor: "user",
		});
		expect(classify("user", "Restored v3")).toMatchObject({
			kind: "restore",
			version: 3,
		});
		expect(classify("user", "restored Edited")).toMatchObject({
			kind: "restore",
			version: null,
		});
		expect(classify("user", "Undid restoring v9")).toMatchObject({
			kind: "undo_restore",
			version: 9,
		});
		expect(classify("user", "Undid Alfy's change: v7")).toMatchObject({
			kind: "undo_alfy_change",
			version: 7,
		});
		expect(classify("user", "Undid Alfy's change")).toMatchObject({
			kind: "undo_alfy_change",
			version: null,
		});
		expect(classify("user", "Redid Alfy's change: v7")).toMatchObject({
			kind: "redo_alfy_change",
			version: 7,
		});
		// A range: `version` stays the newest (what every reader already uses),
		// `fromVersion` is the first version the press took back or brought back.
		expect(classify("user", "Undid Alfy's changes: v5 to v7")).toMatchObject({
			kind: "undo_alfy_change",
			version: 7,
			fromVersion: 5,
		});
		expect(classify("user", "Redid Alfy's changes: v5 to v7")).toMatchObject({
			kind: "redo_alfy_change",
			version: 7,
			fromVersion: 5,
		});
		expect(classify("user", "Undid Alfy's change: v7").fromVersion).toBe(
			undefined,
		);
	});

	it("reads Alfy's rows, with its own words as text", () => {
		expect(classify("alfy", "Alfy wrote the first draft", 1)).toMatchObject({
			kind: "first_draft",
			actor: "alfy",
			text: null,
		});
		expect(classify("alfy", "Alfy made the app: a tip calculator", 1)).toEqual({
			kind: "app_made",
			actor: "alfy",
			text: "a tip calculator",
			version: null,
		});
		// Rows made before an App's brief stopped being its markup (LV's note) carry
		// the model's whole HTML after the prefix: still readable, and never as text.
		expect(
			classify(
				"alfy",
				'Alfy made the app: <!DOCTYPE html><html lang="en"><head><title>Tip</title></head><body><h1>Tip</h1></body></html>',
				1,
			),
		).toEqual({ kind: "app_made", actor: "alfy", text: null, version: null });
		expect(classify("alfy", "Alfy regenerated the app: make it blue")).toEqual({
			kind: "app_rebuilt",
			actor: "alfy",
			text: "make it blue",
			version: null,
		});
		expect(classify("alfy", "Alfy's comment reply")).toMatchObject({
			kind: "alfy_reply_edit",
			text: null,
		});
		expect(classify("alfy", "Alfy made it again", 1)).toMatchObject({
			kind: "made_again",
		});
		expect(classify("alfy", "Moved the museum to Thursday")).toEqual({
			kind: "alfy_edit",
			actor: "alfy",
			text: "Moved the museum to Thursday",
			version: null,
		});
	});

	it("credits the reader for keeping a chat reply, though the row says Alfy wrote it", () => {
		expect(classify("alfy", "Kept from a chat reply", 1)).toMatchObject({
			kind: "kept_from_chat",
			actor: "user",
		});
	});

	it("treats the server's fallback and an empty summary as no words of Alfy's own", () => {
		expect(classify("alfy", "Alfy's edit")).toMatchObject({
			kind: "alfy_edit",
			text: null,
		});
		expect(classify("alfy", "")).toMatchObject({
			kind: "alfy_edit",
			text: null,
		});
		expect(classify("alfy", "  ")).toMatchObject({
			kind: "alfy_edit",
			text: null,
		});
	});

	it("never lets one author's rows pass for the other's, or a later version for a first one", () => {
		// A model can write any text as its summary; only the author and the
		// version decide what a row is.
		expect(classify("alfy", "Restored v3")).toMatchObject({
			kind: "alfy_edit",
			text: "Restored v3",
		});
		expect(classify("alfy", "Undid Alfy's change: v2")).toMatchObject({
			kind: "alfy_edit",
		});
		expect(classify("user", "Alfy wrote the first draft", 1)).toMatchObject({
			kind: "user_edit",
		});
		expect(classify("alfy", "Alfy wrote the first draft", 5)).toMatchObject({
			kind: "alfy_edit",
		});
		expect(classify("alfy", "Kept from a chat reply", 5)).toMatchObject({
			kind: "alfy_edit",
		});
		expect(classify("alfy", "Alfy made the app: x", 5)).toMatchObject({
			kind: "alfy_edit",
		});
	});
});
