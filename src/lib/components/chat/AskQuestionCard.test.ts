import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readAskLineDrafts,
	storeAskLineDrafts,
} from "$lib/client/conversation-session";
import type {
	AskAnswer,
	AskQuestion,
	AskQuestionDto,
} from "$lib/shared/ask-user";
import { uiLanguage } from "$lib/stores/settings";
import AskQuestionCard from "./AskQuestionCard.svelte";
import AskQuestionCardHarness from "./AskQuestionCardHarness.test.svelte";

// The mockup's questions (docs/plans/ask-me-first/mockups.html, sections 1, 2 and 7).
const WAY: AskQuestion = {
	question: "Which way should we take it?",
	options: [
		{
			label: "A party at home",
			note: "Easiest to organise, and the whole family can come",
			recommended: true,
		},
		{
			label: "Dinner out, just close family",
			note: "Quieter; book three or four weeks ahead",
		},
		{
			label: "A weekend away together",
			note: "The most memorable, and the most to arrange",
		},
	],
};

// Section 7: the Recommended answer is the second, and stays the second.
const GARDEN: AskQuestion = {
	question: "Inside or in the garden?",
	options: [
		{ label: "Inside", note: "No weather worries, but tight for 30" },
		{
			label: "In the garden, with a tent",
			note: "Room for everyone; book the tent by February",
			recommended: true,
		},
	],
};

// Takes several picks, and there a Recommended mark is optional (here there is none).
const WHO: AskQuestion = {
	question: "Who's coming?",
	multiple: true,
	options: [{ label: "Adults" }, { label: "Kids" }, { label: "Grandma" }],
};

const SPLIT: AskQuestion = {
	question: "How should the list be split?",
	options: [
		{
			label: "One shared list",
			note: "Shortest; you tick things off together",
			recommended: true,
		},
		{ label: "A list per person", note: "Everyone packs their own" },
	],
};

const WAY_HU: AskQuestion = {
	question: "Merre induljunk el?",
	options: [
		{
			label: "Házibuli otthon",
			note: "Ezt a legkönnyebb megszervezni, és az egész család ott lehet",
			recommended: true,
		},
		{ label: "Vacsora étteremben, szűk családdal" },
		{ label: "Közös hétvége valahol" },
	],
};

type OneAnswer = { picked: number[]; ownWords: string | null };

const pick = (...picked: number[]): OneAnswer => ({ picked, ownWords: null });
const own = (ownWords: string): OneAnswer => ({ picked: [], ownWords });
const answered = (...answers: OneAnswer[]): AskAnswer => ({
	kind: "answered",
	answers,
});

function dto(
	questions: AskQuestion[],
	overrides: Partial<AskQuestionDto> = {},
): AskQuestionDto {
	return {
		id: "q-1",
		conversationId: "conv-1",
		assistantMessageId: "msg-1",
		toolCallId: "call-1",
		questions,
		status: "waiting",
		answer: null,
		createdAt: 1_700_000_000_000,
		...overrides,
	};
}

type CardProps = {
	question: AskQuestionDto;
	busy?: boolean;
	failed?: boolean;
	onAnswer?: (questionId: string, answer: AskAnswer) => void;
};

// The card, once the 400 ms it keeps its answers off have passed.
async function renderCard(
	question: AskQuestionDto,
	props: Omit<CardProps, "question" | "onAnswer"> = {},
) {
	const onAnswer = vi.fn<(questionId: string, answer: AskAnswer) => void>();
	const view = render(AskQuestionCard, { question, onAnswer, ...props });
	await vi.advanceTimersByTimeAsync(400);
	return { onAnswer, ...view };
}

// The card with the chat page's side of it (AskQuestionCardHarness.test.svelte): the page
// takes an answer by raising `busy` inside `onAnswer`, and `settle` says what it says once
// the server has answered. `renderCard`'s plain `onAnswer` raises nothing, as a page that
// refused the answer would.
async function renderPage(question: AskQuestionDto) {
	const onAnswer = vi.fn<(questionId: string, answer: AskAnswer) => void>();
	const view = render(AskQuestionCardHarness, { question, onAnswer });
	await vi.advanceTimersByTimeAsync(400);
	const settle = async (next: { busy?: boolean; failed?: boolean }) => {
		view.component.settle(next);
		await tick();
	};
	return { onAnswer, settle, ...view };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("AskQuestionCard", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		sessionStorage.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("what it draws", () => {
		it("draws the question, its options in Alfy's order, Recommended where Alfy put it, Other, Decide for me and the X", async () => {
			await renderCard(dto([GARDEN]));

			expect(screen.getByText("Inside or in the garden?")).toBeInTheDocument();
			const options = screen.getAllByTestId("ask-option");
			expect(options).toHaveLength(2);
			// The second option is the Recommended one and stays the second.
			expect(options[0]).toHaveTextContent("Inside");
			expect(options[0]).toHaveTextContent(
				"No weather worries, but tight for 30",
			);
			expect(within(options[0]).queryByText("Recommended")).toBeNull();
			expect(options[1]).toHaveTextContent("In the garden, with a tent");
			expect(options[1]).toHaveTextContent(
				"Room for everyone; book the tent by February",
			);
			expect(within(options[1]).getByText("Recommended")).toBeInTheDocument();

			expect(screen.getByTestId("ask-own-row")).toHaveTextContent("Other");
			expect(button("Decide for me")).toBeInTheDocument();
			expect(button("Close the question")).toBeInTheDocument();
			// One question with one pick: a click answers, so there is no Send.
			expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
		});

		it("puts the X last in the order, so the first Tab lands on an answer and not on the way out", async () => {
			await renderCard(dto([WAY]));

			const order = [
				...screen.getByTestId("ask-card").querySelectorAll("button"),
			];

			expect(order[0]).toBe(screen.getAllByTestId("ask-option")[0]);
			expect(order.at(-1)).toBe(button("Close the question"));
		});

		it("draws the Hungarian labels in a Hungarian UI", async () => {
			uiLanguage.set("hu");
			await renderCard(dto([WAY_HU]));

			expect(
				screen.getByRole("article", { name: "Alfy kérdése" }),
			).toBeInTheDocument();
			expect(screen.getByText("Javasolt")).toBeInTheDocument();
			expect(screen.getByTestId("ask-own-row")).toHaveTextContent("Egyéb");
			expect(button("Rád bízom")).toBeInTheDocument();
			expect(button("Kérdés bezárása")).toBeInTheDocument();
			expect(button("Házibuli otthon, javasolt")).toBeInTheDocument();
		});

		it("draws each question's number only on a card of several, and Pick any beside any question that takes several picks", async () => {
			const many = await renderCard(dto([WHO, SPLIT]));

			const questions = screen.getAllByTestId("ask-question");
			expect(questions).toHaveLength(2);
			expect(within(questions[0]).getByText("1")).toBeInTheDocument();
			expect(within(questions[1]).getByText("2")).toBeInTheDocument();
			expect(within(questions[0]).getByText("Pick any")).toBeInTheDocument();
			expect(within(questions[1]).queryByText("Pick any")).toBeNull();
			many.unmount();

			// A one-question card has no number, and no hint when its question takes one pick.
			const one = await renderCard(dto([WAY]));
			expect(screen.queryByText("1")).toBeNull();
			expect(screen.queryByText("Pick any")).toBeNull();
			one.unmount();

			// The hint belongs to the question, not to the card: it shows on a one-question
			// card whose question takes several picks.
			await renderCard(dto([WHO]));
			expect(screen.queryByText("1")).toBeNull();
			expect(screen.getByText("Pick any")).toBeInTheDocument();
		});

		it("names itself for a screen reader", async () => {
			const one = await renderCard(dto([WAY]));

			expect(
				screen.getByRole("article", { name: "Alfy's question" }),
			).toBeInTheDocument();
			const party = button("A party at home, recommended");
			// The mark is drawn, but the name says it, and the note is the description.
			expect(within(party).getByText("Recommended")).toHaveAttribute(
				"aria-hidden",
				"true",
			);
			expect(party).toHaveAccessibleDescription(
				"Easiest to organise, and the whole family can come",
			);
			expect(
				button("Dinner out, just close family"),
			).toHaveAccessibleDescription("Quieter; book three or four weeks ahead");
			one.unmount();

			await renderCard(dto([WHO, SPLIT]));
			expect(
				screen.getByRole("article", { name: "Alfy's questions (2)" }),
			).toBeInTheDocument();
			// Each question's options are a group named by its words.
			expect(
				screen.getByRole("group", { name: "Who's coming?" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("radiogroup", {
					name: "How should the list be split?",
				}),
			).toBeInTheDocument();
			expect(
				screen.getByRole("checkbox", { name: "Adults" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("radio", { name: "One shared list, recommended" }),
			).toBeInTheDocument();
		});
	});

	describe("waking", () => {
		it("takes no press for 400 ms after it appears, and none before its segment is saved", async () => {
			const onAnswer = vi.fn();
			const view = render(AskQuestionCard, {
				question: dto([WAY], { assistantMessageId: null }),
				onAnswer,
			});
			const everything = () => [
				button("A party at home, recommended"),
				screen.getByTestId("ask-own-row"),
				button("Decide for me"),
				button("Close the question"),
			];

			// Just appeared: off, and a press does nothing.
			for (const control of everything()) expect(control).toBeDisabled();
			await fireEvent.click(button("A party at home, recommended"));
			await fireEvent.click(button("Decide for me"));
			await fireEvent.click(button("Close the question"));
			expect(onAnswer).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(399);
			for (const control of everything()) expect(control).toBeDisabled();

			// The 400 ms are over, but the segment is not saved yet.
			await vi.advanceTimersByTimeAsync(1);
			for (const control of everything()) expect(control).toBeDisabled();
			await fireEvent.click(button("A party at home, recommended"));
			expect(onAnswer).not.toHaveBeenCalled();

			await view.rerender({
				question: dto([WAY], { assistantMessageId: "msg-1" }),
			});
			for (const control of everything()) expect(control).toBeEnabled();
			await fireEvent.click(button("A party at home, recommended"));
			expect(onAnswer).toHaveBeenCalledTimes(1);
		});

		it("keeps a card that comes back to waiting off for another 400 ms", async () => {
			const answer = answered(pick(0));
			const view = await renderCard(dto([WAY]));
			expect(button("Decide for me")).toBeEnabled();

			await view.rerender({
				question: dto([WAY], { status: "answering", answer }),
			});
			expect(screen.queryByTestId("ask-card")).toBeNull();

			await view.rerender({ question: dto([WAY], { answer }), failed: true });
			expect(button("Decide for me")).toBeDisabled();
			await vi.advanceTimersByTimeAsync(400);
			expect(button("Decide for me")).toBeEnabled();
		});
	});

	describe("answering", () => {
		it("answers a one-question, one-pick card on a click", async () => {
			const { onAnswer } = await renderCard(dto([WAY]));

			await fireEvent.click(button("A party at home, recommended"));

			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(pick(0)));
		});

		it("answers with the option's place in Alfy's list, whether it is Recommended or not", async () => {
			const { onAnswer } = await renderCard(dto([GARDEN]));

			await fireEvent.click(button("In the garden, with a tent, recommended"));

			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(pick(1)));
		});

		it("needs Send on a card of several questions, on only once every question has an answer", async () => {
			const { onAnswer } = await renderCard(dto([WHO, SPLIT]));
			const send = () => button("Send");
			expect(send()).toBeDisabled();

			// A pick on a larger card only marks the answer.
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Kids" }));
			expect(onAnswer).not.toHaveBeenCalled();
			expect(screen.getByRole("checkbox", { name: "Adults" })).toBeChecked();
			expect(screen.getByRole("checkbox", { name: "Kids" })).toBeChecked();
			// The second question has no answer yet.
			expect(send()).toBeDisabled();

			await fireEvent.click(
				screen.getByRole("radio", { name: "A list per person" }),
			);
			expect(
				screen.getByRole("radio", { name: "A list per person" }),
			).toBeChecked();
			expect(send()).toBeEnabled();
			expect(onAnswer).not.toHaveBeenCalled();

			// Taking the picks of the first question back off turns Send off again.
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Kids" }));
			expect(send()).toBeDisabled();
			await fireEvent.click(screen.getByRole("checkbox", { name: "Kids" }));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			expect(send()).toBeEnabled();

			await fireEvent.click(send());
			// The picks go in the order they were made.
			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(pick(1, 0), pick(1)),
			);
		});

		it("lets a one-pick question take one answer at a time", async () => {
			await renderCard(dto([WHO, SPLIT]));
			const shared = screen.getByRole("radio", {
				name: "One shared list, recommended",
			});
			const perPerson = screen.getByRole("radio", {
				name: "A list per person",
			});

			await fireEvent.click(shared);
			await fireEvent.click(perPerson);

			expect(perPerson).toBeChecked();
			expect(shared).not.toBeChecked();
			// Picking the one that is picked leaves it picked.
			await fireEvent.click(perPerson);
			expect(perPerson).toBeChecked();
		});

		it("needs Send on a one-question card whose question takes several picks, and sends on it", async () => {
			const { onAnswer } = await renderCard(dto([WHO]));
			expect(button("Send")).toBeDisabled();

			await fireEvent.click(screen.getByRole("checkbox", { name: "Grandma" }));
			expect(onAnswer).not.toHaveBeenCalled();
			expect(button("Send")).toBeEnabled();

			await fireEvent.click(button("Send"));
			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(pick(2)));
		});

		it("draws one Send on a one-question card that takes several picks", async () => {
			const { onAnswer } = await renderCard(dto([WHO]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const line = screen.getByRole("textbox");
			await fireEvent.input(line, { target: { value: "Just the two of us" } });

			// The footer has the Send, so the open line has none of its own: two buttons
			// named Send side by side would be one action twice.
			expect(screen.getAllByRole("button", { name: "Send" })).toHaveLength(1);
			expect(screen.queryByTestId("ask-line-send")).toBeNull();
			expect(button("Send")).toBeEnabled();

			// Enter in the line still sends a one-question card, and so does that Send.
			await fireEvent.keyDown(line, { key: "Enter" });
			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(own("Just the two of us")),
			);
		});

		it("sends from the footer's Send a one-question card that takes several picks, own words and all", async () => {
			const { onAnswer } = await renderCard(dto([WHO]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Just the two of us" },
			});

			await fireEvent.click(button("Send"));

			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(own("Just the two of us")),
			);
		});

		it("answers left_to_alfy for Decide for me and closed for the X", async () => {
			const one = await renderCard(dto([WAY]));
			await fireEvent.click(button("Decide for me"));
			expect(one.onAnswer).toHaveBeenCalledWith("q-1", {
				kind: "left_to_alfy",
			});
			one.unmount();

			const two = await renderCard(dto([WAY]));
			await fireEvent.click(button("Close the question"));
			expect(two.onAnswer).toHaveBeenCalledWith("q-1", { kind: "closed" });
			two.unmount();

			// On a larger card they need no Send and no answers.
			const three = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(button("Decide for me"));
			expect(three.onAnswer).toHaveBeenCalledWith("q-1", {
				kind: "left_to_alfy",
			});
			three.unmount();

			const four = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(button("Close the question"));
			expect(four.onAnswer).toHaveBeenCalledWith("q-1", { kind: "closed" });
		});
	});

	describe("own words", () => {
		it("opens a question's line from the Other row, with the words kept short enough to send", async () => {
			await renderCard(dto([WAY]));

			await fireEvent.click(screen.getByTestId("ask-own-row"));

			// The row is the line now.
			expect(screen.queryByTestId("ask-own-row")).toBeNull();
			const line = screen.getByRole("textbox", { name: "Other" });
			expect(line).toHaveFocus();
			expect(line).toHaveAttribute("maxlength", "500");
			expect(line).toHaveAttribute("placeholder", "Other");
		});

		it("lets own words replace a question's picks, and a pick take them back", async () => {
			const { onAnswer } = await renderCard(dto([WHO, SPLIT]));
			const adults = screen.getByRole("checkbox", { name: "Adults" });
			const shared = screen.getByRole("radio", {
				name: "One shared list, recommended",
			});

			await fireEvent.click(adults);
			await fireEvent.click(shared);
			// The own row of the second question is the second row of the buttons.
			const rows = screen.getAllByTestId("ask-own-row");
			await fireEvent.click(rows[1]);
			const line = screen.getByRole("textbox", { name: "Other" });
			await fireEvent.input(line, {
				target: { value: "One list, with a section for the kids' things" },
			});

			// The words replaced that question's pick and left the other question alone.
			expect(shared).not.toBeChecked();
			expect(adults).toBeChecked();
			expect(button("Send")).toBeEnabled();

			await fireEvent.click(button("Send"));
			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(pick(0), own("One list, with a section for the kids' things")),
			);
		});

		it("keeps a question's picks while its line holds only spaces", async () => {
			const { onAnswer } = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(
				screen.getByRole("radio", { name: "A list per person" }),
			);
			await fireEvent.click(screen.getAllByTestId("ask-own-row")[0]);

			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "   " },
			});

			expect(screen.getByRole("checkbox", { name: "Adults" })).toBeChecked();
			expect(button("Send")).toBeEnabled();
			await fireEvent.click(button("Send"));
			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(pick(0), pick(1)));
		});

		it("clears a question's words and closes its line when an option is picked", async () => {
			await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(screen.getAllByTestId("ask-own-row")[1]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Something else" },
			});
			expect(readAskLineDrafts("q-1")).toEqual({ 1: "Something else" });

			await fireEvent.click(
				screen.getByRole("radio", { name: "A list per person" }),
			);

			expect(screen.queryByRole("textbox")).toBeNull();
			expect(screen.getAllByTestId("ask-own-row")).toHaveLength(2);
			expect(
				screen.getByRole("radio", { name: "A list per person" }),
			).toBeChecked();
			// A line with no words is not kept for a reload either.
			expect(readAskLineDrafts("q-1")).toEqual({});
		});

		it("sends a one-question card on Enter, with the words trimmed", async () => {
			const { onAnswer } = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const line = screen.getByRole("textbox");

			await fireEvent.input(line, {
				target: { value: "  Smaller, maybe a picnic by the lake " },
			});
			expect(onAnswer).not.toHaveBeenCalled();
			await fireEvent.keyDown(line, { key: "Enter" });

			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(own("Smaller, maybe a picnic by the lake")),
			);
		});

		it("sends a one-question card from the line's own send button", async () => {
			const { onAnswer } = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const send = screen.getByTestId("ask-line-send");
			// No words, nothing to send.
			expect(send).toBeDisabled();

			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "A picnic" },
			});
			expect(send).toBeEnabled();
			await fireEvent.click(send);

			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(own("A picnic")));
		});

		it("sends nothing on Enter in an empty line, or while the words are still being composed", async () => {
			const { onAnswer } = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const line = screen.getByRole("textbox");

			await fireEvent.keyDown(line, { key: "Enter" });
			await fireEvent.input(line, { target: { value: "   " } });
			await fireEvent.keyDown(line, { key: "Enter" });
			await fireEvent.input(line, { target: { value: "A pic" } });
			await fireEvent.keyDown(line, { key: "Enter", isComposing: true });

			expect(onAnswer).not.toHaveBeenCalled();
		});

		it("only sets the answer on Enter on a larger card, and Send sends the card", async () => {
			const { onAnswer } = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Kids" }));
			await fireEvent.click(screen.getAllByTestId("ask-own-row")[1]);
			const line = screen.getByRole("textbox");
			// A larger card's lines have no send button of their own.
			expect(screen.queryByTestId("ask-line-send")).toBeNull();

			await fireEvent.input(line, { target: { value: "Per room" } });
			await fireEvent.keyDown(line, { key: "Enter" });

			expect(onAnswer).not.toHaveBeenCalled();
			expect(button("Send")).toBeEnabled();
			await fireEvent.click(button("Send"));
			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(pick(1), own("Per room")),
			);
		});

		it("lets own words replace the picks of a one-question card whose question takes several", async () => {
			const { onAnswer } = await renderCard(dto([WHO]));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(screen.getByTestId("ask-own-row"));

			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Just the two of us" },
			});
			expect(
				screen.getByRole("checkbox", { name: "Adults" }),
			).not.toBeChecked();
			await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

			expect(onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(own("Just the two of us")),
			);
		});

		it("keeps typed own words through a remount", async () => {
			const first = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Smaller, maybe a picnic" },
			});
			expect(readAskLineDrafts("q-1")).toEqual({
				0: "Smaller, maybe a picnic",
			});
			first.unmount();

			await renderCard(dto([WAY]));

			// The line is open again, with the words in it.
			expect(screen.getByRole("textbox")).toHaveValue(
				"Smaller, maybe a picnic",
			);
			expect(screen.queryByTestId("ask-own-row")).toBeNull();
		});

		it("keeps a line that was opened and left empty only for as long as the card lives", async () => {
			const first = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			expect(screen.getByRole("textbox")).toBeInTheDocument();
			expect(readAskLineDrafts("q-1")).toEqual({});
			first.unmount();

			await renderCard(dto([WAY]));
			expect(screen.queryByRole("textbox")).toBeNull();
			expect(screen.getByTestId("ask-own-row")).toBeInTheDocument();
		});
	});

	describe("typing with nothing focused", () => {
		const atWindow = vi.fn();
		const atDocument = vi.fn();

		beforeEach(() => {
			atWindow.mockClear();
			atDocument.mockClear();
			// What the composer listens with: its shortcut is a window listener, and a
			// second keydown listener sits on the document. Both bubble.
			window.addEventListener("keydown", atWindow);
			document.addEventListener("keydown", atDocument);
		});

		afterEach(() => {
			window.removeEventListener("keydown", atWindow);
			document.removeEventListener("keydown", atDocument);
		});

		it("takes a printable key pressed with nothing focused into the own line, and only then", async () => {
			const { onAnswer } = await renderCard(dto([WAY]));
			expect(document.body).toHaveFocus();

			await fireEvent.keyDown(document.body, { key: "s" });

			// The line is open and focused, so the browser puts the character in it.
			const line = screen.getByRole("textbox", { name: "Other" });
			expect(line).toHaveFocus();
			expect(screen.queryByTestId("ask-own-row")).toBeNull();
			// The composer's listeners never saw the key.
			expect(atWindow).not.toHaveBeenCalled();
			expect(atDocument).not.toHaveBeenCalled();
			expect(onAnswer).not.toHaveBeenCalled();
		});

		it("does not take the key with preventDefault, so the character lands in the line", async () => {
			await renderCard(dto([WAY]));
			const event = new KeyboardEvent("keydown", {
				key: "s",
				bubbles: true,
				cancelable: true,
			});

			document.body.dispatchEvent(event);

			expect(event.defaultPrevented).toBe(false);
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		it.each([
			["Space", { key: " " }],
			["Enter", { key: "Enter" }],
			["Tab", { key: "Tab" }],
			["Escape", { key: "Escape" }],
			["an arrow", { key: "ArrowDown" }],
			["Backspace", { key: "Backspace" }],
			["Shift on its own", { key: "Shift" }],
			["a dead key", { key: "Dead" }],
			["Ctrl and a letter", { key: "s", ctrlKey: true }],
			["Cmd and a letter", { key: "s", metaKey: true }],
			["Alt and a letter", { key: "s", altKey: true }],
			["a letter while composing", { key: "s", isComposing: true }],
		])("does not take %s", async (_name, init) => {
			const { onAnswer } = await renderCard(dto([WAY]));

			await fireEvent.keyDown(document.body, init);

			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			expect(screen.getByTestId("ask-own-row")).toBeInTheDocument();
			expect(onAnswer).not.toHaveBeenCalled();
			// A key it does not take goes on to the page as it always did.
			expect(atWindow).toHaveBeenCalledTimes(1);
			expect(atDocument).toHaveBeenCalledTimes(1);

			// The control: the card was listening, and a plain letter is taken.
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
		});

		it("does not take a key a handler before it already took", async () => {
			await renderCard(dto([WAY]));
			const event = new KeyboardEvent("keydown", {
				key: "s",
				bubbles: true,
				cancelable: true,
			});
			event.preventDefault();

			document.body.dispatchEvent(event);

			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			// The control: a key nobody took is taken.
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
		});

		describe("while another field has focus", () => {
			const placed: HTMLElement[] = [];

			afterEach(() => {
				for (const element of placed.splice(0)) element.remove();
			});

			function placeElsewhere(
				tag: string,
				attributes: Record<string, string> = {},
			): HTMLElement {
				const element = document.createElement(tag);
				for (const [name, value] of Object.entries(attributes)) {
					element.setAttribute(name, value);
				}
				document.body.appendChild(element);
				placed.push(element);
				return element;
			}

			it.each([
				["an input (the search modal)", () => placeElsewhere("input")],
				["a textarea", () => placeElsewhere("textarea")],
				["a select", () => placeElsewhere("select")],
				[
					"a contenteditable (a Document in the side panel)",
					() =>
						placeElsewhere("div", { contenteditable: "true", tabindex: "0" }),
				],
				[
					"a part of an editable area",
					() => {
						const area = placeElsewhere("div", { contenteditable: "true" });
						const inner = document.createElement("span");
						inner.tabIndex = 0;
						area.appendChild(inner);
						return inner;
					},
				],
				[
					"a button inside a dialog",
					() => {
						const dialog = placeElsewhere("div", {
							role: "dialog",
							"aria-modal": "true",
						});
						const inner = document.createElement("button");
						dialog.appendChild(inner);
						return inner;
					},
				],
				// An ARIA widget that takes typing: a menu's type-ahead, a combobox's
				// filter, a custom text box. None is a native field, so the list above
				// does not cover them.
				...(
					[
						"combobox",
						"listbox",
						"menu",
						"menubar",
						"textbox",
						"searchbox",
					] as const
				).map((role): [string, () => HTMLElement] => [
					`a ${role} (an ARIA widget that takes typing)`,
					() => placeElsewhere("div", { role, tabindex: "0" }),
				]),
				...(
					[
						["an option inside a listbox", "listbox", "option"],
						["a menu item inside a menu", "menu", "menuitem"],
						["a menu item inside a menubar", "menubar", "menuitem"],
					] as const
				).map(([name, container, role]): [string, () => HTMLElement] => [
					name,
					() => {
						const widget = placeElsewhere("div", { role: container });
						const inner = document.createElement("div");
						inner.setAttribute("role", role);
						inner.tabIndex = 0;
						widget.appendChild(inner);
						return inner;
					},
				]),
			] satisfies Array<
				[string, () => HTMLElement]
			>)("takes nothing while %s has focus", async (_name, make) => {
				const { onAnswer } = await renderCard(dto([WAY]));
				const elsewhere = make();
				elsewhere.focus();
				expect(elsewhere).toHaveFocus();

				await fireEvent.keyDown(elsewhere, { key: "s" });
				// Also when the event is aimed at the page and the focus is elsewhere.
				await fireEvent.keyDown(document.body, { key: "s" });

				expect(screen.queryByTestId("ask-own-input")).toBeNull();
				expect(elsewhere).toHaveFocus();
				expect(onAnswer).not.toHaveBeenCalled();
				// Both keys went on to the page.
				expect(atWindow).toHaveBeenCalledTimes(2);

				// A key aimed at the field is the field's, whatever has the focus.
				elsewhere.blur();
				await fireEvent.keyDown(elsewhere, { key: "s" });
				expect(screen.queryByTestId("ask-own-input")).toBeNull();
				expect(atWindow).toHaveBeenCalledTimes(3);

				// The control: with that field out of the way, the same key is taken.
				await fireEvent.keyDown(document.body, { key: "s" });
				expect(screen.getByTestId("ask-own-input")).toHaveFocus();
			});

			it("takes nothing while another question's line has focus", async () => {
				await renderCard(dto([WHO, SPLIT]));
				await fireEvent.click(screen.getAllByTestId("ask-own-row")[1]);
				const second = screen.getByRole("textbox");
				expect(second).toHaveFocus();

				await fireEvent.keyDown(second, { key: "x" });

				// The first question's line stayed shut, and the focus stayed where it was.
				expect(screen.getAllByTestId("ask-own-row")).toHaveLength(1);
				expect(screen.getAllByRole("textbox")).toHaveLength(1);
				expect(second).toHaveFocus();
			});
		});

		it("takes a key while a button of the card has focus, which is where a pick leaves it", async () => {
			await renderCard(dto([WHO, SPLIT]));
			const adults = screen.getByRole("checkbox", { name: "Adults" });
			await fireEvent.click(adults);
			adults.focus();
			expect(adults).toHaveFocus();

			await fireEvent.keyDown(adults, { key: "s" });

			// The first question has an answer, so the keys go to the second one's line.
			const line = screen.getByRole("textbox");
			expect(line).toHaveFocus();
			expect(screen.getAllByTestId("ask-own-row")).toHaveLength(1);
			expect(
				within(screen.getAllByTestId("ask-question")[1]).getByRole("textbox"),
			).toBe(line);
		});

		it("sends the key to the first question without an answer on a larger card, and to none when each has one", async () => {
			await renderCard(dto([WHO, SPLIT]));

			await fireEvent.keyDown(document.body, { key: "a" });
			const first = screen.getByRole("textbox");
			expect(
				within(screen.getAllByTestId("ask-question")[0]).getByRole("textbox"),
			).toBe(first);
			expect(first).toHaveFocus();
			first.blur();

			// Words in the first line are its answer, so the second takes the next key.
			await fireEvent.input(first, { target: { value: "Adults and kids" } });
			first.blur();
			await fireEvent.keyDown(document.body, { key: "b" });
			expect(screen.getAllByRole("textbox")).toHaveLength(2);
			expect(screen.getAllByRole("textbox")[1]).toHaveFocus();
			screen.getAllByRole("textbox")[1].blur();

			// Both have an answer now: there is no line to give the key to.
			await fireEvent.input(screen.getAllByRole("textbox")[1], {
				target: { value: "Per room" },
			});
			screen.getAllByRole("textbox")[1].blur();
			atWindow.mockClear();
			await fireEvent.keyDown(document.body, { key: "c" });
			expect(screen.getAllByRole("textbox")).toHaveLength(2);
			expect(document.body).toHaveFocus();
			expect(atWindow).toHaveBeenCalledTimes(1);
		});

		it("takes the key into a line that is already open, and puts the caret after its words", async () => {
			await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const line = screen.getByRole("textbox") as HTMLInputElement;
			await fireEvent.input(line, { target: { value: "A picnic" } });
			// The caret was left at the start of the words.
			line.setSelectionRange(0, 0);
			line.blur();
			expect(line).not.toHaveFocus();

			await fireEvent.keyDown(document.body, { key: "s" });

			expect(line).toHaveFocus();
			expect(line.selectionStart).toBe("A picnic".length);
			expect(line.selectionEnd).toBe("A picnic".length);
		});

		it("takes nothing while the card is busy, not yet awake, or folded", async () => {
			// Not awake yet: the key goes on to the page, and the same key is taken once it is.
			const young = render(AskQuestionCard, {
				question: dto([WAY]),
				onAnswer: vi.fn(),
			});
			await vi.advanceTimersByTimeAsync(399);
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
			young.unmount();

			// Busy, and taken again when it is not.
			const busy = await renderCard(dto([WAY]), { busy: true });
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			await busy.rerender({ busy: false });
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
			busy.unmount();

			// Its segment is not saved, and taken once it is.
			const unsaved = render(AskQuestionCard, {
				question: dto([WAY], { assistantMessageId: null }),
				onAnswer: vi.fn(),
			});
			await vi.advanceTimersByTimeAsync(1000);
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			await unsaved.rerender({
				question: dto([WAY], { assistantMessageId: "msg-1" }),
			});
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
			unsaved.unmount();

			// Folded: no card, and no listener.
			const folded = await renderCard(
				dto([WAY], { status: "answered", answer: answered(pick(0)) }),
			);
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.queryByTestId("ask-own-input")).toBeNull();
			folded.unmount();

			// The four keys that were not taken went on to the page; the three that were did not.
			expect(atWindow).toHaveBeenCalledTimes(4);
		});

		it("listens only while the card waits, is awake and is not busy", async () => {
			const add = vi.spyOn(window, "addEventListener");
			const remove = vi.spyOn(window, "removeEventListener");
			const keydowns = (spy: typeof add) =>
				spy.mock.calls.filter(([type]) => type === "keydown");
			const answer = answered(pick(0));
			const view = render(AskQuestionCard, {
				question: dto([WAY]),
				onAnswer: vi.fn(),
			});

			await vi.advanceTimersByTimeAsync(399);
			expect(keydowns(add)).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(1);
			expect(keydowns(add)).toHaveLength(1);
			// In the capture phase, on the window.
			expect(keydowns(add)[0][2]).toBe(true);

			await view.rerender({ busy: true });
			expect(keydowns(remove)).toHaveLength(1);
			expect(keydowns(remove)[0][1]).toBe(keydowns(add)[0][1]);
			expect(keydowns(remove)[0][2]).toBe(true);

			await view.rerender({ busy: false });
			expect(keydowns(add)).toHaveLength(2);

			await view.rerender({
				question: dto([WAY], { status: "answering", answer }),
			});
			expect(keydowns(remove)).toHaveLength(2);

			// And a card that goes away takes its listener with it.
			await view.rerender({ question: dto([WAY], { answer }) });
			await vi.advanceTimersByTimeAsync(400);
			expect(keydowns(add)).toHaveLength(3);
			view.unmount();
			expect(keydowns(remove)).toHaveLength(3);
		});
	});

	describe("a busy card", () => {
		it("a busy card takes no second answer", async () => {
			const { onAnswer } = await renderPage(dto([WAY]));
			const first = button("A party at home, recommended");
			const second = button("Dinner out, just close family");

			// The page takes the answer by raising busy inside onAnswer. Two clicks, another
			// option, Decide for me and the X: the card is off from the first click.
			await fireEvent.click(first);
			await fireEvent.click(first);
			await fireEvent.click(second);
			await fireEvent.click(button("Decide for me"));
			await fireEvent.click(button("Close the question"));

			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(first).toBeDisabled();
			// The chosen answer is still shown.
			expect(first).toHaveAttribute("aria-pressed", "true");
			expect(second).toHaveAttribute("aria-pressed", "false");
		});

		it("takes one answer from two clicks made in the same task, before anything is drawn", async () => {
			const { onAnswer } = await renderPage(dto([WAY]));

			// Native clicks one after the other with no flush between: a double tap. The
			// card reads the page's busy live, so the second press finds it off.
			button("A party at home, recommended").click();
			button("A party at home, recommended").click();
			button("Dinner out, just close family").click();
			button("Decide for me").click();

			expect(onAnswer).toHaveBeenCalledTimes(1);
		});

		it("takes Enter in a line once, and not after a click on the line's send button", async () => {
			const { onAnswer } = await renderPage(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			const line = screen.getByRole("textbox");
			await fireEvent.input(line, { target: { value: "A picnic" } });

			await fireEvent.click(screen.getByTestId("ask-line-send"));
			await fireEvent.keyDown(line, { key: "Enter" });
			await fireEvent.keyDown(line, { key: "Enter" });
			await fireEvent.click(screen.getByTestId("ask-line-send"));

			expect(onAnswer).toHaveBeenCalledTimes(1);
			// The words stay in the line while it is sent.
			expect(line).toHaveValue("A picnic");
			expect(line).toBeDisabled();
		});

		it("takes no answer at all when the page says it is busy", async () => {
			const { onAnswer } = await renderCard(
				dto([WAY], { answer: answered(pick(1)) }),
				{ busy: true },
			);

			for (const control of [
				button("A party at home, recommended"),
				button("Decide for me"),
				button("Close the question"),
				screen.getByTestId("ask-own-row"),
			]) {
				expect(control).toBeDisabled();
				await fireEvent.click(control);
			}

			expect(onAnswer).not.toHaveBeenCalled();
			// The chosen answer is shown, and no error is shown while it is sent again.
			expect(button("Dinner out, just close family")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("stays answerable when the page does not take the answer", async () => {
			// A plain onAnswer raises nothing, as a page that refused the answer (a sealed
			// chat, an open edit) would.
			const { onAnswer } = await renderCard(dto([WAY]));

			await fireEvent.click(button("A party at home, recommended"));

			expect(onAnswer).toHaveBeenCalledTimes(1);
			// Nothing is going out, so the card is not off.
			expect(button("Dinner out, just close family")).toBeEnabled();
			expect(button("Decide for me")).toBeEnabled();
			await fireEvent.click(button("Dinner out, just close family"));
			expect(onAnswer).toHaveBeenCalledTimes(2);
			expect(onAnswer).toHaveBeenLastCalledWith("q-1", answered(pick(1)));
			// And typing still goes into the card.
			await fireEvent.keyDown(document.body, { key: "s" });
			expect(screen.getByTestId("ask-own-input")).toHaveFocus();
		});

		it("keeps the error line and stays answerable when the page refuses an answer to a card that had failed", async () => {
			// `failed` is already up and a refusal changes nothing: the card must neither stay
			// off nor lose its error line.
			const { onAnswer } = await renderCard(
				dto([WAY], { answer: answered(pick(1)) }),
				{ failed: true },
			);

			await fireEvent.click(button("A weekend away together"));

			expect(onAnswer).toHaveBeenCalledTimes(1);
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Couldn't send your answer. Try again.",
			);
			await fireEvent.click(button("A party at home, recommended"));
			expect(onAnswer).toHaveBeenCalledTimes(2);
		});

		it("is answerable again once the page says the answer did not go through", async () => {
			const { onAnswer, settle, rerender } = await renderPage(dto([WAY]));
			await fireEvent.click(button("A party at home, recommended"));
			expect(button("Decide for me")).toBeDisabled();

			// It did not go through: the question reads waiting again with its answer, and
			// the page stops being busy and says so.
			await rerender({ question: dto([WAY], { answer: answered(pick(0)) }) });
			await settle({ busy: false, failed: true });

			expect(button("A party at home, recommended")).toBeEnabled();
			expect(screen.getByRole("alert")).toBeInTheDocument();
			await fireEvent.click(button("Dinner out, just close family"));
			expect(onAnswer).toHaveBeenCalledTimes(2);
			expect(onAnswer).toHaveBeenLastCalledWith("q-1", answered(pick(1)));
		});

		it("is answerable again after a second failure that left failed as it was", async () => {
			const { onAnswer, settle } = await renderPage(dto([WAY]));
			await settle({ failed: true });

			await fireEvent.click(button("A party at home, recommended"));
			expect(button("Decide for me")).toBeDisabled();
			// Busy falls while failed stays up.
			await settle({ busy: false });
			await fireEvent.click(button("A party at home, recommended"));

			expect(onAnswer).toHaveBeenCalledTimes(2);
		});
	});

	describe("an answer that did not go through", () => {
		it("shows the line for an answer that did not go through and keeps the picks and own words", async () => {
			const picks = await renderCard(
				dto([WAY], { answer: answered(pick(1)) }),
				{
					failed: true,
				},
			);

			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent("Couldn't send your answer. Try again.");
			expect(alert).toHaveAttribute("data-testid", "ask-error");
			expect(button("Dinner out, just close family")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(button("A party at home, recommended")).toHaveAttribute(
				"aria-pressed",
				"false",
			);
			// The card stays answerable.
			await fireEvent.click(button("A weekend away together"));
			expect(picks.onAnswer).toHaveBeenCalledWith("q-1", answered(pick(2)));
			picks.unmount();

			// A waiting question that carries an answer is one that did not go through,
			// whether or not the page says so: here own words on a card of several.
			const words = await renderCard(
				dto([WHO, SPLIT], {
					answer: answered(
						pick(0, 1),
						own("One list, with a section for the kids' things"),
					),
				}),
			);
			expect(screen.getByRole("alert")).toBeInTheDocument();
			expect(screen.getByRole("checkbox", { name: "Adults" })).toBeChecked();
			expect(screen.getByRole("checkbox", { name: "Kids" })).toBeChecked();
			expect(screen.getByRole("textbox")).toHaveValue(
				"One list, with a section for the kids' things",
			);
			expect(button("Send")).toBeEnabled();
			await fireEvent.click(button("Send"));
			expect(words.onAnswer).toHaveBeenCalledWith(
				"q-1",
				answered(
					pick(0, 1),
					own("One list, with a section for the kids' things"),
				),
			);
		});

		it("shows the line under the questions, and no line when nothing failed", async () => {
			const view = await renderCard(dto([WAY]));
			expect(screen.queryByRole("alert")).toBeNull();
			view.unmount();

			await renderCard(dto([WAY]), { failed: true });
			const question = screen.getByTestId("ask-question");
			expect(
				question.compareDocumentPosition(screen.getByRole("alert")) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(screen.getByRole("alert").closest("footer")).toBeNull();
		});

		it("draws no picks for an answer that was Decide for me or the X, and still says it failed", async () => {
			await renderCard(dto([WAY], { answer: { kind: "left_to_alfy" } }));

			expect(screen.getByRole("alert")).toBeInTheDocument();
			for (const option of screen.getAllByTestId("ask-option")) {
				expect(option).toHaveAttribute("aria-pressed", "false");
			}
			expect(screen.queryByRole("textbox")).toBeNull();
		});

		it("ignores a pick of an answer that did not go through when the question has no such option", async () => {
			const { onAnswer } = await renderCard(
				dto([WHO], { answer: answered(pick(0, 7)) }),
			);

			expect(screen.getByRole("checkbox", { name: "Adults" })).toBeChecked();
			await fireEvent.click(button("Send"));

			expect(onAnswer).toHaveBeenCalledWith("q-1", answered(pick(0)));
		});

		it("prefers words typed since over the answer that did not go through", async () => {
			storeAskLineDrafts("q-1", { 0: "Typed after the failure" });

			await renderCard(dto([WAY], { answer: answered(pick(1)) }), {
				failed: true,
			});

			expect(screen.getByRole("textbox")).toHaveValue(
				"Typed after the failure",
			);
			expect(button("Dinner out, just close family")).toHaveAttribute(
				"aria-pressed",
				"false",
			);
		});

		it("brings a card back with its picks and the error line when a folded question turns out not to have gone through", async () => {
			const answer = answered(pick(0));
			const view = await renderCard(dto([WAY]));
			await fireEvent.click(button("A party at home, recommended"));

			// The page folds the card while the resume runs.
			await view.rerender({
				question: dto([WAY], { status: "answering", answer }),
				busy: false,
			});
			expect(screen.queryByTestId("ask-card")).toBeNull();
			expect(screen.getByTestId("ask-folded")).toBeInTheDocument();

			// The resume never started: the question reads as waiting again, with its answer.
			await view.rerender({ question: dto([WAY], { answer }), failed: true });
			expect(screen.getByRole("alert")).toBeInTheDocument();
			expect(button("A party at home, recommended")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await vi.advanceTimersByTimeAsync(400);
			await fireEvent.click(button("Dinner out, just close family"));
			expect(view.onAnswer).toHaveBeenCalledTimes(2);
		});
	});

	describe("a question that no longer waits", () => {
		it("folds once the question is answering, and forgets its own lines", async () => {
			const view = await renderCard(dto([WAY]));
			await fireEvent.click(screen.getByTestId("ask-own-row"));
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "A picnic" },
			});
			expect(readAskLineDrafts("q-1")).toEqual({ 0: "A picnic" });

			await view.rerender({
				question: dto([WAY], {
					status: "answering",
					answer: answered(own("A picnic")),
				}),
			});

			expect(screen.queryByTestId("ask-card")).toBeNull();
			expect(screen.queryByRole("textbox")).toBeNull();
			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("Which way should we take it?");
			expect(row).toHaveTextContent("“A picnic”");
			expect(readAskLineDrafts("q-1")).toEqual({});
			expect(sessionStorage.getItem("ask-line-draft:q-1")).toBeNull();
		});

		it("draws the folded line closed, and a press opens it to show the question and its answer", async () => {
			await renderCard(
				dto([WHO, SPLIT], {
					status: "answered",
					answer: answered(pick(0, 1), pick(1)),
				}),
			);

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("aria-expanded", "false");
			expect(row).toHaveTextContent("2 questions");
			expect(screen.queryByTestId("tool-activity-body")).toBeNull();

			await fireEvent.click(row);

			expect(screen.getByTestId("tool-activity-row")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
			const body = screen.getByTestId("tool-activity-body");
			expect(body).toHaveTextContent("Who's coming?");
			expect(body).toHaveTextContent("Adults, Kids");
			expect(body).toHaveTextContent("How should the list be split?");
			expect(body).toHaveTextContent("A list per person");

			await fireEvent.click(screen.getByTestId("tool-activity-row"));
			expect(screen.getByTestId("tool-activity-row")).toHaveAttribute(
				"aria-expanded",
				"false",
			);
		});

		it("draws a question the person closed as one line with nothing to open", async () => {
			await renderCard(
				dto([WAY], { status: "closed", answer: { kind: "closed" } }),
			);

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveAttribute("data-status", "closed");
			expect(row).toHaveTextContent("closed");
			expect(row.tagName.toLowerCase()).not.toBe("button");
		});

		it("draws a folded line in a Hungarian UI", async () => {
			uiLanguage.set("hu");
			await renderCard(
				dto([WAY_HU], { status: "answered", answer: { kind: "left_to_alfy" } }),
			);

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("Merre induljunk el?");
			expect(row).toHaveTextContent("Alfyra bízva");
		});

		it("drops the lines of a question that was already folded when it appeared", async () => {
			storeAskLineDrafts("q-1", { 0: "Left over" });

			await renderCard(
				dto([WAY], { status: "answered", answer: answered(pick(0)) }),
			);

			expect(readAskLineDrafts("q-1")).toEqual({});
		});

		it("starts over for another question: empty, and off for another 400 ms", async () => {
			const view = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(screen.getAllByTestId("ask-own-row")[1]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Per room" },
			});

			await view.rerender({ question: dto([WHO, SPLIT], { id: "q-2" }) });

			expect(button("Decide for me")).toBeDisabled();
			expect(
				screen.getByRole("checkbox", { name: "Adults" }),
			).not.toBeChecked();
			expect(screen.queryByRole("textbox")).toBeNull();
			await vi.advanceTimersByTimeAsync(400);
			expect(button("Decide for me")).toBeEnabled();
		});

		it("does not start over when the page reads the same waiting question again", async () => {
			const view = await renderCard(dto([WHO, SPLIT]));
			await fireEvent.click(screen.getByRole("checkbox", { name: "Adults" }));
			await fireEvent.click(screen.getAllByTestId("ask-own-row")[1]);
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Per room" },
			});

			// A new object for the same question, as every read of the questions makes.
			await view.rerender({ question: dto([WHO, SPLIT]) });
			await vi.advanceTimersByTimeAsync(1000);

			expect(screen.getByRole("checkbox", { name: "Adults" })).toBeChecked();
			expect(screen.getByRole("textbox")).toHaveValue("Per room");
			expect(button("Send")).toBeEnabled();
		});
	});

	describe("its stylesheet", () => {
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/chat/AskQuestionCard.svelte`,
			"utf-8",
		);
		const phone =
			source.match(/@media \(max-width: 767px\) \{([\s\S]*?)\n\t\}/)?.[1] ?? "";

		// The rule that starts at `selector`, not one whose list of selectors ends in it.
		function rule(css: string, selector: string): string {
			const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return (
				css.match(
					new RegExp(`(?<=(?:^|[{};/])\\s*)${escaped} \\{([^}]*)\\}`),
				)?.[1] ?? ""
			);
		}

		// jsdom applies no component CSS, so the stylesheet itself is the subject.
		it("wears ArtifactCard's shell", () => {
			const shell = rule(source, ".ask");
			expect(shell).toMatch(/border:\s*1px solid var\(--border-default\)/);
			expect(shell).toMatch(/border-radius:\s*var\(--radius-lg/);
			expect(shell).toMatch(/background:\s*var\(--surface-page\)/);
			expect(shell).toMatch(/box-shadow:\s*var\(--shadow-sm\)/);
		});

		it("gives a phone full-width answers at least 44 px tall, an X with a 44 px target and an own line at 16 px", () => {
			expect(phone).not.toBe("");
			expect(rule(phone, ".opt")).toMatch(/min-height:\s*44px/);
			const close = rule(phone, ".ask-x");
			expect(close).toMatch(/width:\s*44px/);
			expect(close).toMatch(/height:\s*44px/);
			expect(rule(phone, ".own-input")).toMatch(/font-size:\s*16px/);
			// Decide for me and Send are a thumb's size too.
			expect(rule(phone, ".quiet")).toMatch(/min-height:\s*44px/);
			expect(rule(phone, ".btn-send")).toMatch(/min-height:\s*44px/);
			expect(rule(source, ".opt")).toMatch(/width:\s*100%/);
			// And the X is 28 px above that.
			const desktopClose = rule(source, ".ask-x");
			expect(desktopClose).toMatch(/width:\s*28px/);
			expect(desktopClose).toMatch(/height:\s*28px/);
		});

		it("keeps the folded line 12 px below what is above it and 2 px above what is below", () => {
			expect(rule(source, ".ask-folded")).toMatch(/margin:\s*12px 0 2px/);
			expect(rule(source, ".ask")).toMatch(/margin:\s*16px 0 0/);
		});

		it("gives the row for own words and the open line one height, so opening the line moves nothing", () => {
			// The open line holds a send button (26 px, 32 px on a phone) and used to be taller
			// than the row it opens from, which pushed the card down. Both now take one height
			// as their minimum and carry no vertical padding of their own: what they hold is
			// centred in it, so the box is the same before and after. A real browser measures
			// the boxes (ask-me-first.spec.ts); jsdom lays nothing out, so the stylesheet is
			// the subject here.
			const heightIn = (css: string) =>
				Number(rule(css, ".ask").match(/--ask-own-height:\s*(\d+)px/)?.[1]);
			const sendIn = (css: string) =>
				Number(rule(css, ".mini-send").match(/height:\s*(\d+)px/)?.[1]);
			const BORDERS = 2;
			expect(heightIn(source)).toBeGreaterThanOrEqual(sendIn(source) + BORDERS);
			expect(heightIn(phone)).toBeGreaterThanOrEqual(sendIn(phone) + BORDERS);
			// And a phone's row stays the touch target it was.
			expect(heightIn(phone)).toBeGreaterThanOrEqual(44);
			for (const selector of [".opt.own", ".own-field"]) {
				expect(rule(source, selector), selector).toMatch(
					/min-height:\s*var\(--ask-own-height\)/,
				);
			}
			// The same border at rest and open (the row takes the answers', and does not
			// set one of its own): only its colour differs.
			expect(rule(source, ".opt")).toMatch(/border:\s*1px solid/);
			expect(rule(source, ".opt.own")).not.toMatch(/border/);
			expect(rule(source, ".own-field")).toMatch(/border:\s*1px solid/);
			expect(rule(source, ".opt.own")).toMatch(/padding-block:\s*0\s*;/);
			expect(rule(source, ".own-field")).toMatch(/padding:\s*0 10px 0 12px/);
			// Nothing in the phone block sets the line's height a second time.
			expect(rule(phone, ".own-field")).not.toMatch(/height/);
		});

		it("changes only colours and shadows on hover, focus and selection, never the box", () => {
			const style = source
				.slice(source.indexOf("<style>"))
				.replace(/\/\*[\s\S]*?\*\//g, "");
			const stateRules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
				.map(([, selector, body]) => ({ selector: selector.trim(), body }))
				.filter(({ selector }) =>
					/:hover|:focus|:active|\.sel\b/.test(selector),
				);
			// The states this guards are there to be read.
			expect(stateRules.length).toBeGreaterThanOrEqual(4);
			for (const { selector, body } of stateRules) {
				expect(body, selector).not.toMatch(
					/(^|[;\s])(border|border-width|padding|margin|width|height|min-height|font-size|line-height)\s*:/,
				);
			}
		});

		it("rises into place when it appears: one global transition, through the reduced-motion wrapper, on transform and opacity only", () => {
			// A local transition never plays here (measured in a real browser: no animation at
			// all): the card is created whole by its message, and a local one plays only when
			// its own block is toggled. `|global` plays it whenever a card is drawn after the
			// app is up: when Alfy asks during a reply, or the chat is opened from the sidebar.
			// A card the server drew (a reload) is left alone, or it would blink: that guard,
			// and the numbers (8 to 12 px, the emphasis duration and curve), are
			// ask-card-motion.test.ts's. `fly` moves transform and opacity and nothing else.
			const markup = source.slice(0, source.indexOf("<style>"));
			expect(markup).toMatch(
				/const cardRise = reducedMotionAware\(riseUnlessDrawnByTheServer\);/,
			);
			expect(markup).toMatch(/in:cardRise\|global=\{CARD_RISE\}/);
			// On the way in only: the folded line replaces the card at once, as it did.
			expect(markup).not.toMatch(/\b(out|transition):[a-zA-Z]+/);
		});

		it("adds no motion of its own in CSS: the card's size and margins never ease", () => {
			const style = source.slice(source.indexOf("<style>"));
			expect(style).not.toMatch(/@keyframes/);
			expect(style).not.toMatch(/\banimation\s*:/);
			// The shell eases nothing: only its entrance moves it, and that is transform and
			// opacity (the card-top scroll rule reads where it rests, `MessageArea`).
			expect(rule(source, ".ask")).not.toMatch(/transition|animation/);
		});

		it("gives every control on the card the answers' animated hover: one transition and one hover rule, on the standard duration", () => {
			// The answers eased their hover and the other controls snapped (owner, 2026-11-05:
			// "so it's consistent"). Now one rule eases the colours of all of them, and the
			// answers' own hover rule is the one the outline controls take: same properties,
			// tokens and timing, never a copy that can drift.
			const style = source
				.slice(source.indexOf("<style>"))
				.replace(/\/\*[\s\S]*?\*\//g, "");
			const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
				([, selector, body]) => ({
					selectors: selector.split(",").map((part) => part.trim()),
					body,
				}),
			);
			const easing = rules.filter(({ body }) => /transition\s*:/.test(body));
			expect(easing).toHaveLength(1);
			expect([...easing[0].selectors].sort()).toEqual([
				".ask-x",
				".btn-send",
				".mini-send",
				".opt",
				".quiet",
			]);
			for (const property of [
				"background-color",
				"border-color",
				"color",
				"opacity",
			]) {
				expect(easing[0].body).toContain(
					`${property} var(--duration-standard) var(--ease-out)`,
				);
			}
			// No duration of its own anywhere: the token is what reduced motion zeroes.
			expect(style).not.toMatch(/\b\d+(\.\d+)?m?s\b/);

			// The answers' hover, taken by the quiet button and the X.
			const answersHover = rules.find(({ selectors }) =>
				selectors.includes(".opt:not(.sel):hover:not(:disabled)"),
			);
			expect(answersHover?.selectors).toEqual([
				".opt:not(.sel):hover:not(:disabled)",
				".quiet:hover:not(:disabled)",
				".ask-x:hover:not(:disabled)",
			]);
			expect(answersHover?.body).toMatch(
				/background:\s*var\(--surface-elevated\)/,
			);
			expect(answersHover?.body).toMatch(/border-color:\s*color-mix\(/);
			// The filled Send buttons cannot go grey (their text is white): they shift their
			// fill toward the text colour, lighter or darker as the theme needs.
			const sendHover = rules.find(({ selectors }) =>
				selectors.includes(".btn-send:hover:not(:disabled)"),
			);
			expect(sendHover?.selectors).toEqual([
				".btn-send:hover:not(:disabled)",
				".mini-send:hover:not(:disabled)",
			]);
			expect(sendHover?.body).toMatch(
				/background:\s*color-mix\(in srgb, var\(--accent-fill\)[^;]*var\(--text-primary\)/,
			);
		});

		it("lets the global reduced-motion reset switch the hover off", () => {
			// The hover is a CSS transition on --duration-standard, so the reset in app.css
			// reaches it: it zeroes that token and every transition's duration.
			const css = readFileSync(`${process.cwd()}/src/app.css`, "utf-8");
			const reset = css.slice(
				css.indexOf("Prefers reduced motion - disables all animations"),
			);
			const block = reset.slice(0, reset.indexOf("\n\t.prose pre"));
			expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
			expect(block).toMatch(/--duration-standard:\s*0\.01ms/);
		});

		it("uses no colour that is not a token", () => {
			const style = source.slice(source.indexOf("<style>"));
			expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
			expect(style.match(/\brgba?\(/g)).toBeNull();
		});
	});
});
