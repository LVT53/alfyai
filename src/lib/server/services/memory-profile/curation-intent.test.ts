import { describe, expect, it } from "vitest";
import {
	type ActionIntentRecord,
	sourceEditChangedFacts,
	sourceEditTakenFacts,
	sourceEditTookAway,
} from "./curation-intent";

/** A changed resend's source edit: the message before and after, its proposal. */
function sourceEdit(
	before: string,
	after: string,
	proposal: Array<{ id: string; text: string }> = [],
): ActionIntentRecord {
	return {
		request: {
			kind: "edit",
			requestId: "edited",
			text: after,
			ref: {
				scope: { kind: "personal" },
				generation: "source-edit",
				rowId: "edited",
			},
		},
		before,
		sourceIds: ["chat"],
		facts: [
			{ id: "colour", text: "Mák is black.", sourceId: "chat" },
			{ id: "name", text: "The user has a cat named Mák.", sourceId: "chat" },
		],
		proposal,
	};
}

describe("what a person's edit of their message took away", () => {
	it.each([
		["a deleted detail", "Mák is black and sleeps a lot.", "Mák sleeps a lot."],
		["a changed value", "I prefer decaf.", "I prefer black tea."],
		["a word said once less", "Very very tired.", "Very tired."],
		["a Hungarian value", "A varródobozom kék.", "A varródobozom zöld."],
		["a deleted number", "I have 3 cats.", "I have cats."],
	])("took something away: %s", (_case, before, after) => {
		expect(sourceEditTookAway(sourceEdit(before, after))).toBe(true);
	});
	it.each([
		["an added sentence", "Mák is black.", "Mák is black. I like coffee."],
		["case and punctuation", "Mák is black!", "mák is black."],
		["the same words reordered", "black is Mák", "Mák is black"],
		[
			"an added Hungarian sentence",
			"Mák fekete.",
			"Mák fekete. Szeretem a kávét.",
		],
	])("took nothing away: %s", (_case, before, after) => {
		expect(sourceEditTookAway(sourceEdit(before, after))).toBe(false);
	});
	it("excludes every fact the proposal changed only when the edit took something away", () => {
		const proposal = [
			{ id: "colour", text: "" },
			{ id: "name", text: "The user has a cat named Mák." },
		];
		const removal = sourceEdit("Mák is black.", "Mák.", proposal);
		expect(sourceEditChangedFacts(removal).map(({ id }) => id)).toEqual([
			"colour",
		]);
		expect(sourceEditTakenFacts(removal).map(({ id }) => id)).toEqual([
			"colour",
		]);
		const addition = sourceEdit(
			"Mák is black.",
			"Mák is black. I like coffee.",
			proposal,
		);
		expect(sourceEditChangedFacts(addition).map(({ id }) => id)).toEqual([
			"colour",
		]);
		expect(sourceEditTakenFacts(addition)).toEqual([]);
	});
	it("treats a request that is not an edit as taking something away", () => {
		expect(
			sourceEditTookAway({
				...sourceEdit("a", "a b"),
				request: {
					kind: "remove",
					requestId: "r",
					ref: { scope: { kind: "personal" }, generation: "g", rowId: "x" },
				},
			}),
		).toBe(true);
	});
});
