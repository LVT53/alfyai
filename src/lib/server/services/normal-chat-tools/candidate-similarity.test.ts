// The rule that decides whether a file from ANOTHER conversation may be named
// back to the model on a miss.
//
// Two failure modes, opposite directions. Too strict and the rule drops the
// file the model was reaching for, which is the whole reason candidates exist —
// a miss is usually a name the model had slightly wrong. Too loose and a miss
// discloses the names of unrelated files from unrelated chats, to a model that
// will read them aloud, at the exact moment the user referred to none of them.

import { describe, expect, it } from "vitest";
import { isPlausibleCandidateName } from "./read-generated-file";

describe("isPlausibleCandidateName", () => {
	it("accepts the same stem whatever the punctuation and case", () => {
		for (const name of [
			"release-notes.md",
			"Release Notes.md",
			"release_notes.md",
			"RELEASE-NOTES.md",
		]) {
			expect(isPlausibleCandidateName(name, "release notes.pdf"), name).toBe(
				true,
			);
		}
	});

	it("accepts a shared significant word", () => {
		expect(
			isPlausibleCandidateName("release-notes-v2.md", "release notes"),
		).toBe(true);
		expect(isPlausibleCandidateName("2026-budget-final.xlsx", "budget")).toBe(
			true,
		);
	});

	it("accepts a typo in the stem", () => {
		expect(
			isPlausibleCandidateName("release-notes.md", "relase-notes.md"),
		).toBe(true);
		expect(
			isPlausibleCandidateName("release-notes.md", "release-note.md"),
		).toBe(true);
	});

	it("refuses an unrelated name of the same type", () => {
		expect(
			isPlausibleCandidateName("holiday-photos.md", "release-notes.md"),
		).toBe(false);
		expect(
			isPlausibleCandidateName("quarterly-budget.xlsx", "staff-rota.xlsx"),
		).toBe(false);
	});

	it("does not let a short word match everything", () => {
		// "v2", "of", "the" are below the significant-token floor; without it a
		// request for `notes-v2.md` would pull in every versioned file the user
		// has ever made.
		expect(isPlausibleCandidateName("invoice-v2.pdf", "roadmap-v2.pdf")).toBe(
			false,
		);
	});

	it("refuses a blank or extension-only name", () => {
		expect(isPlausibleCandidateName("", "release-notes.md")).toBe(false);
		expect(isPlausibleCandidateName("release-notes.md", "")).toBe(false);
		expect(isPlausibleCandidateName(".md", "release-notes.md")).toBe(false);
	});

	it("scales the edit-distance threshold with length", () => {
		// Short names get one edit, not three: `a.md` and `b.md` are different
		// files, not a typo.
		expect(isPlausibleCandidateName("ab.md", "cd.md")).toBe(false);
		// A long name absorbs a couple of slips.
		expect(
			isPlausibleCandidateName(
				"quarterly-financial-summary.md",
				"quartrly-financail-summary.md",
			),
		).toBe(true);
	});
});
