// What the folded line of a question says, worked out from the question row. Pure,
// like tool-activity.ts and write-card-view.ts, with the translator passed in.
//
// A question Alfy asked that no longer waits (answered, left to Alfy, or closed with
// the X) is not a card any more: it is one line, drawn as the `ToolActivityRow` every
// finished step is drawn as, with each question and its answer one press away. The
// card (AskQuestionCard) draws this item for a question that is not waiting.
import type {
	AskAnswer,
	AskQuestion,
	AskQuestionDto,
} from "$lib/shared/ask-user";
import type { ToolActivityItem } from "$lib/utils/tool-activity";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

/** Between the answers to the questions of one card, in the line. */
const ANSWER_SEPARATOR = " · ";

/** Stands for the person's words while the marks they go between are read off the dictionary. */
const WORDS_MARK = "\u0000";

/**
 * The person's own words in the reader's quote marks (“…” in English, „…” in
 * Hungarian). The marks are `chat.ask.ownAnswerQuote`'s, and the words go between
 * them here and not through `t`: `t` fills `{text}` with `String.replaceAll`, which
 * reads `$&` and `$$` in the text it inserts as patterns, and a person's own words
 * are quoted exactly as typed.
 */
function quoted(words: string, t: Translate): string {
	const [before = "", after = ""] = t("chat.ask.ownAnswerQuote", {
		text: WORDS_MARK,
	}).split(WORDS_MARK);
	return `${before}${words}${after}`;
}

/** The labels of the options picked, in the order they were picked; a pick that names no option is skipped, as the server skips it when it words the answer for the model. */
function pickedLabels(
	question: AskQuestion,
	picked: readonly number[],
): string {
	const labels: string[] = [];
	for (const index of picked) {
		const option = question.options[index];
		if (option) labels.push(option.label);
	}
	return labels.join(", ");
}

/** The labels of the options Alfy marked Recommended, in the order it gave them; empty when it marked none. */
function recommendedLabels(question: AskQuestion): string {
	return question.options
		.filter((option) => option.recommended === true)
		.map((option) => option.label)
		.join(", ");
}

/**
 * What the answer says to one question, as the folded line has it: the options
 * picked, joined by commas; or the person's own words in quotes, which replace the
 * picks; or, for "Up to you", the options Alfy marked Recommended. Empty when there
 * is nothing to name: the X, a question the answer has no entry for, and a choice
 * left to Alfy on a question with no Recommended option (the open line says that
 * one in words: `buildAskFoldedItem`).
 */
export function askAnswerText(
	question: AskQuestion,
	answer: AskAnswer,
	index: number,
	t: Translate,
): string {
	switch (answer.kind) {
		case "closed":
			return "";
		case "left_to_alfy":
			return recommendedLabels(question);
		case "answered": {
			const given = answer.answers[index];
			if (!given) return "";
			const words = given.ownWords?.trim();
			return words ? quoted(words, t) : pickedLabels(question, given.picked);
		}
	}
}

/**
 * A question that no longer waits as the row every tool call draws: a tick, the
 * question (muted) and its answer, or a muted X and "· closed" for a card the person
 * shut. Several questions fold into a count, their answers joined by " · ". "Up to
 * you" shows what Alfy was left to take, with "· left to Alfy" after it. A press
 * opens each question with its answer; a closed card has nothing to open.
 *
 * It keys on the answer's kind, never on `status`: while the resume runs the
 * question is `answering` with its answer already set, and only later `answered` or
 * `closed`. An answer that is unexpectedly missing draws a plain done line with the
 * question and nothing after it, never a throw.
 */
export function buildAskFoldedItem(
	question: AskQuestionDto,
	t: Translate,
): ToolActivityItem {
	const { questions, answer } = question;
	const verb =
		questions.length === 1
			? questions[0].question
			: t("chat.ask.questionCount", { count: questions.length });
	const closed = answer?.kind === "closed";
	const leftToAlfy = answer?.kind === "left_to_alfy";

	const answers =
		answer === null
			? []
			: questions.map((asked, index) => askAnswerText(asked, answer, index, t));
	const object = answers.filter((text) => text !== "").join(ANSWER_SEPARATOR);
	const suffix = leftToAlfy
		? `· ${t("chat.ask.leftToAlfy")}`
		: closed
			? `· ${t("chat.ask.closed")}`
			: undefined;

	// Nothing to open on a closed card, and nothing to show when the answer is missing.
	let body: ToolActivityItem["body"] = null;
	if (answer !== null && !closed) {
		body = {
			kind: "ask",
			pairs: questions.map((asked, index) => ({
				question: asked.question,
				// A choice left to Alfy on a question with no Recommended option has no
				// answer to name; the open line says so in words and not with an empty one
				// (Ruling 17). The line's object above stays empty for it.
				answer: answers[index] || (leftToAlfy ? t("chat.ask.leftToAlfy") : ""),
			})),
		};
	}

	return {
		key: `ask-${question.id}`,
		status: closed ? "closed" : "done",
		iconType: "ask",
		verb,
		object,
		...(suffix === undefined ? {} : { objectSuffix: suffix }),
		meta: "",
		summaryLabel: verb,
		pinned: true,
		alwaysOpen: false,
		body,
		title: [verb, object, suffix].filter(Boolean).join(" "),
	};
}
