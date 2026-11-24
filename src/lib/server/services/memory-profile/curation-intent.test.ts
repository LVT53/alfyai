import { describe, expect, it } from "vitest";
import {
	type ActionIntentRecord,
	sourceEditChangedFacts,
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
		["a Hungarian value", "A varródobozom kék.", "A varródobozom zöld."],
		["a deleted number", "I have 3 cats.", "I have cats."],
		["a deleted sentence", "Mák is black. Bodza is white.", "Mák is black."],
		["a sentence said once less", "I am tired. I am tired.", "I am tired."],
		[
			"the same words, other meaning",
			"Luca is vegan, I am not.",
			"I am vegan, Luca is not.",
		],
		["a letter's case", "Mák is black.", "mák is black."],
		["a word added inside a sentence", "Mák is black.", "Mák is very black."],
	])("took something away: %s", (_case, before, after) => {
		expect(sourceEditTookAway(sourceEdit(before, after))).toBe(true);
	});
	it.each([
		["an added sentence", "Mák is black.", "Mák is black. I like coffee."],
		[
			"a sentence added in the middle",
			"Mák is black. Bodza is white.",
			"Mák is black. I like coffee. Bodza is white.",
		],
		[
			"a sentence added after one without its full stop",
			"Mák is black",
			"Mák is black. I like coffee.",
		],
		["changed spacing", "Mák  is   black.", "Mák is black."],
		[
			"a line added to a list",
			"- Mák is black\n- Bodza is white",
			"- Mák is black\n- Bodza is white\n- Luca is vegan",
		],
		[
			"an added Hungarian sentence",
			"Mák fekete, Bodza fehér.",
			"Mák fekete, Bodza fehér. Szeretem a reggeli kávét.",
		],
	])("took nothing away: %s", (_case, before, after) => {
		expect(sourceEditTookAway(sourceEdit(before, after))).toBe(false);
	});
	it("lists the facts the proposal changed, whatever the edit took away", () => {
		const proposal = [
			{ id: "colour", text: "" },
			{ id: "name", text: "The user has a cat named Mák." },
		];
		const removal = sourceEdit("Mák is black.", "Mák.", proposal);
		expect(sourceEditChangedFacts(removal).map(({ id }) => id)).toEqual([
			"colour",
		]);
		expect(sourceEditTookAway(removal)).toBe(true);
		const addition = sourceEdit(
			"Mák is black.",
			"Mák is black. I like coffee.",
			proposal,
		);
		expect(sourceEditChangedFacts(addition).map(({ id }) => id)).toEqual([
			"colour",
		]);
		expect(sourceEditTookAway(addition)).toBe(false);
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
