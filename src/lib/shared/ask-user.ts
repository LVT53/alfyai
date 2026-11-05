// The vocabulary of "Ask me first": the questions Alfy asks in the middle of a
// reply, the answer the person gives, and the checks both pass through. The
// model run, the tool, the store, the routes and the browser all import it, so
// each rule lives here once.
//
// A leaf on purpose, with no imports: it is reached from `$lib/server`, route
// handlers and Svelte components alike, and anything it pulled in would travel
// to all three (the chat page's bundle too) or close an import cycle.
//
// Ruling 79 (chat-turn/AGENTS.md): every text it hands back for a model to read
// is ASCII English. The questions, labels, notes and own words are data, in
// whatever language the person and the model write.

/** The name the tool goes by in the catalogue and in a stored tool call. */
export const ASK_USER_TOOL_NAME = "ask_user";

/** What the tool's result says when the reply stops to wait for the person. */
export const ASK_PAUSE_STATUS = "waiting_for_user";

/**
 * What a later turn's history reads of an ask call whose question was closed with
 * its reply, so it never reads a question that is not open: the reply was stopped
 * before the answer, or it ended without its pause (`stream-completion.ts`), or it
 * could never be carried on from the answer (`ask-resume.ts`). Model-facing, so
 * ASCII English (ruling 79).
 */
export const ASK_STOPPED_BEFORE_ANSWER =
	"The user stopped the reply before answering.";
export const ASK_ENDED_BEFORE_ANSWER =
	"The reply ended before the user answered.";

/**
 * How much Alfy may ask and the person may write, in counts and in characters
 * (UTF-16 units, as a string's `length` and an input's `maxlength` count them).
 * The check (`checkAskQuestions`) and the card read these, and the tool's input
 * schema shows them to the model as hints (`maxItems`, `maxLength`, the counts in its
 * descriptions); the check is the one place they are enforced.
 *
 * `maxOptions` is 4 (owner, 2026-11-05, after the real-model measurement; it was 3):
 * the production model wrote a fourth answer on three of the four cards the app
 * turned back. It is also the most picks an answer may hold, since a question that
 * takes several picks may be answered with every one of its answers.
 *
 * `maxQuestions` is 1 (owner, 2026-11-05, after his first live test: "I only want 1
 * ask card at a time"; a card of three questions looked like three cards). It is
 * what Alfy may ASK. `maxStoredQuestions` is what a stored row may HOLD, and is
 * read back: a card asked before that day holds up to 3 questions, and the page
 * still draws it and takes its answer.
 */
export const ASK_LIMITS = {
	minQuestions: 1,
	maxQuestions: 1,
	maxStoredQuestions: 3,
	minOptions: 2,
	maxOptions: 4,
	questionChars: 160,
	labelChars: 50,
	noteChars: 100,
	ownWordsChars: 500,
} as const;

export type AskOption = { label: string; note?: string; recommended?: boolean };

/** A question takes one pick unless `multiple` says it takes several. */
export type AskQuestion = {
	question: string;
	multiple?: boolean;
	options: AskOption[];
};

/**
 * The person's answer. In `answered` there is one entry per question, in order:
 * the options picked (indexes into that question's options), or, with `picked`
 * empty, the person's own words, which replace the picks.
 */
export type AskAnswer =
	| {
			kind: "answered";
			answers: Array<{ picked: number[]; ownWords: string | null }>;
	  }
	| { kind: "left_to_alfy" }
	| { kind: "closed" };

export type AskQuestionStatus = "waiting" | "answering" | "answered" | "closed";

/** A question as the browser reads it. */
export type AskQuestionDto = {
	id: string;
	conversationId: string;
	assistantMessageId: string | null;
	toolCallId: string;
	questions: AskQuestion[];
	status: AskQuestionStatus;
	/** waiting: the answer that did not go through, else null; otherwise the answer given. */
	answer: AskAnswer | null;
	createdAt: number; // ms
};

type OneAnswer = { picked: number[]; ownWords: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(text: string): boolean {
	return text.trim() === "";
}

export function isAskToolName(name: string): boolean {
	return name === ASK_USER_TOOL_NAME;
}

/**
 * Whether a recorded tool call is an ask that paused its reply: an `ask_user`
 * call that finished (`status` "done") and that the tool marked
 * `metadata.paused`, which it does only when its question was recorded. A card
 * the tool refused (not available in this run, a second card, bad questions, a
 * store that failed) is a finished `ask_user` call too, marked `ok: false`, and
 * asked nobody; nor did one that never finished.
 *
 * It stays true once the question is answered or the reply was stopped: settling
 * a call rewrites its summary and digest and leaves its marks. It records that
 * the reply asked, not that a question still waits.
 */
export function askCallPausedTheReply(call: {
	name: string;
	status?: string | null;
	metadata?: Record<string, unknown> | null;
}): boolean {
	return (
		isAskToolName(call.name) &&
		call.status === "done" &&
		call.metadata?.paused === true
	);
}

/** Whether a tool's result is the pause marker; any other result is not one. */
export function isAskPauseOutput(output: unknown): boolean {
	return isRecord(output) && output.status === ASK_PAUSE_STATUS;
}

// --- the questions ------------------------------------------------------------

/**
 * How many problems one refusal lists before it says how many more there are: far
 * above any card the model writes by mistake, and only a bound on one that is nothing
 * but problems, so that a refusal stays short.
 */
const PROBLEMS_LISTED = 30;

/**
 * Every rule the questions break, one message each, in the order of the card: the
 * count of questions, then each question in turn (its text, its number of options,
 * its mark, then its options' texts). Empty when nothing is broken.
 *
 * The counts and lengths in `ASK_LIMITS` are always held (an empty text is too
 * short). The Recommended mark is held only `asking`: it is a rule for what Alfy may
 * ask, which a row already written is not held to again when it is read back.
 */
function problemsOf(
	questions: readonly AskQuestion[],
	{ asking }: { asking: boolean },
): string[] {
	const limits = ASK_LIMITS;
	const problems: string[] = [];
	if (
		questions.length < limits.minQuestions ||
		questions.length >
			(asking ? limits.maxQuestions : limits.maxStoredQuestions)
	) {
		problems.push(
			limits.minQuestions === limits.maxQuestions
				? `A card holds exactly ${limits.maxQuestions} question: ask the one that matters most, and the next after the answer.`
				: `Ask ${limits.minQuestions} to ${limits.maxQuestions} questions.`,
		);
	}
	for (const [q, { question, multiple, options }] of questions.entries()) {
		const name = `Question ${q + 1}`;
		if (isBlank(question)) {
			problems.push(`${name} has no text.`);
		} else if (question.length > limits.questionChars) {
			problems.push(
				`${name} is longer than ${limits.questionChars} characters.`,
			);
		}
		if (
			options.length < limits.minOptions ||
			options.length > limits.maxOptions
		) {
			problems.push(
				`${name} needs ${limits.minOptions} to ${limits.maxOptions} options.`,
			);
		}
		if (asking && multiple !== true) {
			const recommended = options.filter((o) => o.recommended === true).length;
			if (recommended !== 1) {
				problems.push(
					`${name} takes one pick: mark exactly one of its options recommended.`,
				);
			}
		}
		for (const [o, { label, note }] of options.entries()) {
			const option = `Option ${o + 1} of question ${q + 1}`;
			if (isBlank(label)) {
				problems.push(`${option} has no label.`);
			} else if (label.length > limits.labelChars) {
				problems.push(
					`${option} has a label longer than ${limits.labelChars} characters.`,
				);
			}
			if (note === "") {
				problems.push(`${option} has an empty note.`);
			} else if (note !== undefined && note.length > limits.noteChars) {
				problems.push(
					`${option} has a note longer than ${limits.noteChars} characters.`,
				);
			}
		}
	}
	return problems;
}

/**
 * Whether Alfy may ask these questions: the counts and lengths in `ASK_LIMITS`,
 * and, on a question that takes one pick, exactly one Recommended option (a
 * question that takes several may mark any number, none included).
 *
 * A card that breaks several rules is told all of them at once, one line each, so
 * that the model fixes the whole card in a single retry (owner, 2026-11-05: a card
 * that broke a count and a mark was refused twice, and the second refusal cost a
 * model step of 4 to 7 seconds). The lines name each question and option by its
 * number from 1, are printable ASCII English, and never repeat the model's own
 * words: they are for the model to read. A list longer than `PROBLEMS_LISTED` stops
 * there and says how many more there are.
 */
export function checkAskQuestions(
	questions: readonly AskQuestion[],
): { ok: true } | { ok: false; message: string } {
	const problems = problemsOf(questions, { asking: true });
	if (problems.length === 0) return { ok: true };
	const listed = problems.slice(0, PROBLEMS_LISTED);
	if (problems.length > listed.length) {
		listed.push(`And ${problems.length - listed.length} more.`);
	}
	return { ok: false, message: listed.join("\n") };
}

function parseOption(value: unknown): AskOption | null {
	if (!isRecord(value)) return null;
	const { label, note, recommended } = value;
	if (typeof label !== "string") return null;
	if (note !== undefined && typeof note !== "string") return null;
	if (recommended !== undefined && typeof recommended !== "boolean") {
		return null;
	}
	const option: AskOption = { label };
	if (note !== undefined) option.note = note;
	if (recommended !== undefined) option.recommended = recommended;
	return option;
}

function parseQuestion(value: unknown): AskQuestion | null {
	if (!isRecord(value)) return null;
	const { question, multiple, options } = value;
	if (typeof question !== "string" || !Array.isArray(options)) return null;
	if (multiple !== undefined && typeof multiple !== "boolean") return null;
	const parsed: AskOption[] = [];
	for (const entry of options) {
		const option = parseOption(entry);
		if (option === null) return null;
		parsed.push(option);
	}
	return multiple === undefined
		? { question, options: parsed }
		: { question, multiple, options: parsed };
}

/**
 * Reads questions that were stored as JSON back: the shape of `AskQuestion[]`
 * within the limits, else null. A copy with only the keys the type has. It does
 * not ask for the Recommended mark: that is a rule for what Alfy may ask, which
 * `checkAskQuestions` held when the row was written, and a row already written
 * is only read.
 */
export function parseAskQuestions(value: unknown): AskQuestion[] | null {
	if (!Array.isArray(value)) return null;
	const questions: AskQuestion[] = [];
	for (const entry of value) {
		const question = parseQuestion(entry);
		if (question === null) return null;
		questions.push(question);
	}
	return problemsOf(questions, { asking: false }).length === 0
		? questions
		: null;
}

// --- the answer ---------------------------------------------------------------

function parseOneAnswer(value: unknown): OneAnswer | null {
	if (!isRecord(value) || !Array.isArray(value.picked)) return null;
	const picked: unknown[] = value.picked;
	const { ownWords } = value;
	if (picked.length > ASK_LIMITS.maxOptions) return null;
	if (!picked.every((i) => Number.isInteger(i) && (i as number) >= 0)) {
		return null;
	}
	if (ownWords !== null && typeof ownWords !== "string") return null;
	// trimmed before the cap, and words that are blank after it are no words
	const words = ownWords === null ? "" : ownWords.trim();
	if (words.length > ASK_LIMITS.ownWordsChars) return null;
	return {
		picked: [...(picked as number[])],
		ownWords: words === "" ? null : words,
	};
}

/**
 * Reads an answer, from a request body or from a stored row: one of the three
 * kinds in `AskAnswer`, else null. Own words come back trimmed, and own words
 * that are empty after trimming come back as null. It does not know the
 * questions: whether the answer fits them is `checkAskAnswer`'s.
 */
export function parseAskAnswer(value: unknown): AskAnswer | null {
	if (!isRecord(value)) return null;
	if (value.kind === "left_to_alfy") return { kind: "left_to_alfy" };
	if (value.kind === "closed") return { kind: "closed" };
	if (value.kind !== "answered" || !Array.isArray(value.answers)) return null;
	// one entry per question, and no more than a stored card may hold
	const count = value.answers.length;
	if (
		count < ASK_LIMITS.minQuestions ||
		count > ASK_LIMITS.maxStoredQuestions
	) {
		return null;
	}
	const answers: OneAnswer[] = [];
	for (const entry of value.answers) {
		const answer = parseOneAnswer(entry);
		if (answer === null) return null;
		answers.push(answer);
	}
	return { kind: "answered", answers };
}

/** Whether one answer fits its question: picks or own words, one of the two, and picks that are possible. */
function answerFits(
	{ multiple, options }: AskQuestion,
	{ picked, ownWords }: OneAnswer,
): boolean {
	const hasPicks = picked.length > 0;
	const hasWords = ownWords !== null;
	if (hasPicks === hasWords) return false; // one of the two, never both or neither
	if (hasWords) return true;
	if (new Set(picked).size !== picked.length) return false;
	if (!picked.every((i) => i < options.length)) return false;
	return multiple === true || picked.length === 1;
}

/**
 * Whether a body is an answer to these questions, and the answer it is. The
 * left-to-Alfy and closed answers fit any questions. An answered answer has one
 * entry per question; in each, either picks (each option at most once, and only
 * one pick on a question that takes one) or own words, never both and never
 * neither. The answer handed back is the one `parseAskAnswer` read: the body's
 * own words trimmed, and nothing the body carried beyond the shape.
 */
export function checkAskAnswer(
	questions: readonly AskQuestion[],
	value: unknown,
): { ok: true; answer: AskAnswer } | { ok: false } {
	const answer = parseAskAnswer(value);
	if (answer === null) return { ok: false };
	if (answer.kind !== "answered") return { ok: true, answer };
	if (answer.answers.length !== questions.length) return { ok: false };
	for (const [q, question] of questions.entries()) {
		if (!answerFits(question, answer.answers[q])) return { ok: false };
	}
	return { ok: true, answer };
}
