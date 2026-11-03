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
 * How much Alfy may ask and the person may write, in counts and in characters
 * (UTF-16 units, as a string's `length` and an input's `maxlength` count them).
 * The checks, the tool's input schema and the card all read these.
 */
export const ASK_LIMITS = {
	minQuestions: 1,
	maxQuestions: 3,
	minOptions: 2,
	maxOptions: 3,
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

/** Whether a tool's result is the pause marker; any other result is not one. */
export function isAskPauseOutput(output: unknown): boolean {
	return isRecord(output) && output.status === ASK_PAUSE_STATUS;
}

// --- the questions ------------------------------------------------------------

/** The first count or length the questions break (an empty text is too short), as a message, else null. */
function limitsProblem(questions: readonly AskQuestion[]): string | null {
	const limits = ASK_LIMITS;
	if (
		questions.length < limits.minQuestions ||
		questions.length > limits.maxQuestions
	) {
		return `Ask ${limits.minQuestions} to ${limits.maxQuestions} questions.`;
	}
	for (const [q, { question, options }] of questions.entries()) {
		const name = `Question ${q + 1}`;
		if (isBlank(question)) return `${name} has no text.`;
		if (question.length > limits.questionChars) {
			return `${name} is longer than ${limits.questionChars} characters.`;
		}
		if (
			options.length < limits.minOptions ||
			options.length > limits.maxOptions
		) {
			return `${name} needs ${limits.minOptions} to ${limits.maxOptions} options.`;
		}
		for (const [o, { label, note }] of options.entries()) {
			const option = `Option ${o + 1} of question ${q + 1}`;
			if (isBlank(label)) return `${option} has no label.`;
			if (label.length > limits.labelChars) {
				return `${option} has a label longer than ${limits.labelChars} characters.`;
			}
			if (note !== undefined && note.length > limits.noteChars) {
				return `${option} has a note longer than ${limits.noteChars} characters.`;
			}
		}
	}
	return null;
}

/** The first one-pick question without exactly one Recommended option, as a message, else null. */
function recommendedProblem(questions: readonly AskQuestion[]): string | null {
	for (const [q, { multiple, options }] of questions.entries()) {
		if (multiple === true) continue;
		const recommended = options.filter((o) => o.recommended === true).length;
		if (recommended !== 1) {
			return `Question ${q + 1} takes one pick: mark exactly one of its options recommended.`;
		}
	}
	return null;
}

/**
 * Whether Alfy may ask these questions: the counts and lengths in `ASK_LIMITS`,
 * and, on a question that takes one pick, exactly one Recommended option (a
 * question that takes several may mark any number, none included). The message
 * names the question by its number from 1 and is meant for the model to read.
 */
export function checkAskQuestions(
	questions: readonly AskQuestion[],
): { ok: true } | { ok: false; message: string } {
	const message = limitsProblem(questions) ?? recommendedProblem(questions);
	return message === null ? { ok: true } : { ok: false, message };
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
	return limitsProblem(questions) === null ? questions : null;
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
	// one entry per question, and no more questions than may be asked
	const count = value.answers.length;
	if (count < ASK_LIMITS.minQuestions || count > ASK_LIMITS.maxQuestions) {
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
