import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { buildJumpRailTurns, railTurnLabel } from "./jump-rail";

/**
 * Minimal factory that only sets the fields the helper reads. Keeps the
 * tests focused on the pure turn-building logic (ADR-0043 Slice 17).
 */
function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	railSummary?: string,
): ChatMessage {
	return {
		id,
		renderKey: id,
		role,
		content,
		timestamp: 0,
		...(railSummary !== undefined ? { railSummary } : {}),
	};
}

/** `count` question-and-answer pairs, ids u1/a1 ... */
function conversation(count: number): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (let i = 1; i <= count; i += 1) {
		messages.push(msg(`u${i}`, "user", `Question ${i}`));
		messages.push(msg(`a${i}`, "assistant", `Answer ${i}`));
	}
	return messages;
}

describe("buildJumpRailTurns", () => {
	it("returns an empty array for an empty message list", () => {
		expect(buildJumpRailTurns([])).toEqual([]);
	});

	it("returns an empty array when there are fewer than 6 assistant messages", () => {
		expect(buildJumpRailTurns(conversation(5))).toEqual([]);
	});

	it("maps each assistant message to a turn of just its id and label once there are 6+", () => {
		const turns = buildJumpRailTurns(conversation(6));

		expect(turns).toHaveLength(6);
		expect(turns[0]).toEqual({ id: "a1", label: "Question 1" });
		expect(turns[5]).toEqual({ id: "a6", label: "Question 6" });
	});

	it("only counts assistant messages as turns, in order", () => {
		const turns = buildJumpRailTurns(conversation(7));

		expect(turns.map((turn) => turn.id)).toEqual([
			"a1",
			"a2",
			"a3",
			"a4",
			"a5",
			"a6",
			"a7",
		]);
	});

	it("labels an opening reply with no question before it by the start of the reply", () => {
		const messages = [
			msg("a0", "assistant", "Welcome back."),
			...conversation(5),
		];

		const turns = buildJumpRailTurns(messages);

		expect(turns[0]).toEqual({ id: "a0", label: "Welcome back." });
	});

	it("does not borrow the question of an earlier turn for an assistant message that follows another", () => {
		const messages = [
			...conversation(5),
			msg("a-extra", "assistant", "More to say."),
		];

		const turns = buildJumpRailTurns(messages);

		expect(turns.at(-1)).toEqual({ id: "a-extra", label: "More to say." });
	});

	it("prefers the persisted railSummary over the question", () => {
		const messages = conversation(6);
		messages[1] = msg(
			"a1",
			"assistant",
			"Answer 1",
			"Plans a weekend at Balaton",
		);

		const turns = buildJumpRailTurns(messages);

		expect(turns[0].label).toBe("Plans a weekend at Balaton");
	});
});

describe("railTurnLabel", () => {
	it("returns the rail summary when present", () => {
		expect(
			railTurnLabel(
				{ railSummary: "A short summary", content: "The long reply" },
				{ role: "user", content: "The question" },
			),
		).toBe("A short summary");
	});

	it("uses the question, without quotes, when there is no summary", () => {
		expect(
			railTurnLabel(
				{ railSummary: undefined, content: "The reply" },
				{ role: "user", content: "How far is the sea?" },
			),
		).toBe("How far is the sea?");
	});

	it("cuts a long question at about 60 characters with an ellipsis", () => {
		const question = "x".repeat(100);

		const label = railTurnLabel(
			{ railSummary: undefined, content: "The reply" },
			{ role: "user", content: question },
		);

		expect(label).toBe(`${"x".repeat(60)}…`);
	});

	it("leaves a question of exactly 60 characters whole", () => {
		const question = "y".repeat(60);

		expect(
			railTurnLabel(
				{ railSummary: undefined, content: "The reply" },
				{ role: "user", content: question },
			),
		).toBe(question);
	});

	it("trims the question and folds its line breaks into spaces", () => {
		expect(
			railTurnLabel(
				{ railSummary: undefined, content: "The reply" },
				{ role: "user", content: "  First line\n\nsecond   line \n" },
			),
		).toBe("First line second line");
	});

	it("falls back to the start of the reply when there is no question", () => {
		expect(
			railTurnLabel({
				railSummary: undefined,
				content: "The reply starts here.",
			}),
		).toBe("The reply starts here.");
	});

	it("falls back to the start of the reply when the question is only whitespace", () => {
		expect(
			railTurnLabel(
				{ railSummary: undefined, content: "The reply starts here." },
				{ role: "user", content: "  \n " },
			),
		).toBe("The reply starts here.");
	});

	it("cuts the reply start at about 60 characters too", () => {
		expect(
			railTurnLabel({ railSummary: undefined, content: "z".repeat(90) }),
		).toBe(`${"z".repeat(60)}…`);
	});

	it("falls through a blank or whitespace-only summary", () => {
		expect(
			railTurnLabel(
				{ railSummary: "", content: "The reply" },
				{ role: "user", content: "The question" },
			),
		).toBe("The question");
		expect(
			railTurnLabel(
				{ railSummary: "   \n ", content: "The reply" },
				{ role: "user", content: "The question" },
			),
		).toBe("The question");
	});

	it("ignores a preceding message that is not from the person", () => {
		expect(
			railTurnLabel(
				{ railSummary: undefined, content: "The reply" },
				{ role: "assistant", content: "An earlier reply" },
			),
		).toBe("The reply");
	});
});
