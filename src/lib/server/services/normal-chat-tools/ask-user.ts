/**
 * `ask_user` — Alfy stops a reply to ask the person 1 to 3 questions, each with
 * answers to click ("Ask me first", docs/plans/ask-me-first, design 5.2).
 *
 * The call checks the questions, records them and returns the pause marker. It
 * never waits for the person: the envelope's timeout and the turn's caps would
 * end the wait. What stops the run after the marker, and what carries the reply
 * on from the answer, belong to the model run and the resume (chat-turn/).
 *
 * Like `suggest_instruction.ts`, this module stays free of the tool registry:
 * registration lives in `index.ts`, and the description and error prefix come in
 * as text. Everything the model reads from here is ASCII English (ruling 79,
 * chat-turn/AGENTS.md); the questions and labels are the model's own data.
 */
import { type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";
import { recordAskQuestion } from "$lib/server/services/chat-turn/ask-questions";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	ASK_LIMITS,
	ASK_PAUSE_STATUS,
	ASK_USER_TOOL_NAME,
	type AskAnswer,
	type AskQuestion,
	checkAskQuestions,
} from "$lib/shared/ask-user";
import {
	asExecutableTool,
	compactToolInputSchema,
	executeToolWithEnvelope,
	modelSafeToolError,
	type RequiredExecuteTool,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";
import { deriveToolResultDigest } from "./tool-result-digest";

// The input's shape, written once and drawn twice.
//
// What `execute` accepts has no caps: a card that breaks a count, a length or the
// Recommended rule must still reach `checkAskQuestions`, which names every problem of
// the card in one refusal, in short English that names each question and option by its
// number (owner, 2026-11-05). A schema that checked them refused a card on the first
// thing it found, in the SDK's own wording (a JSON list of zod issues, with the whole
// input echoed back), and the rest only on the next try: measured on the production
// model, a card that broke a count and a mark was refused twice, and the Hungarian
// holiday card was still refused after its retry. Zod does run a refinement after a
// failed count check, so one validation error could name both, but it is the SDK that
// words that error: the refusal the model reads could not be ours, and a later turn
// would replay the call as a bare failure, not as what the model was told.
//
// What the model is shown has every cap (`maxItems`, `maxLength`) and the counts in the
// field descriptions: that is how it learns them before it writes. It is rendered to
// JSON schema and never used to validate (`compactToolInputSchema`, which shows one
// schema and validates with another, as `edit_artifact` does for its patches). Both
// copies and the check read `ASK_LIMITS`, so each cap is one number.
function askUserSchema(caps: boolean) {
	const text = (max: number) => (caps ? z.string().max(max) : z.string());
	const list = <T extends z.ZodType>(item: T, min: number, max: number) =>
		caps ? z.array(item).min(min).max(max) : z.array(item);

	const option = z.object({
		label: text(ASK_LIMITS.labelChars).describe("The option, a few words."),
		note: text(ASK_LIMITS.noteChars)
			.optional()
			.describe("Optional one-line note on what this option means."),
		recommended: z.boolean().optional().describe("Your recommendation."),
	});
	const question = z.object({
		question: text(ASK_LIMITS.questionChars).describe(
			"The question itself, one short sentence.",
		),
		multiple: z
			.boolean()
			.optional()
			.describe("true when the user may pick several options."),
		options: list(
			option,
			ASK_LIMITS.minOptions,
			ASK_LIMITS.maxOptions,
		).describe(
			`${ASK_LIMITS.minOptions}-${ASK_LIMITS.maxOptions} options, in the order to show them.`,
		),
	});
	return z.object({
		questions: list(
			question,
			ASK_LIMITS.minQuestions,
			ASK_LIMITS.maxQuestions,
		).describe(
			`${ASK_LIMITS.minQuestions}-${ASK_LIMITS.maxQuestions} questions, in the order to ask them.`,
		),
	});
}

/** What `execute` accepts: the shape of a card, whatever its counts and lengths. */
export const askUserInputSchema = askUserSchema(false);

/** What the model is shown of it, and what the tool validates with: see `askUserSchema`. */
const askUserToolSchema = compactToolInputSchema(
	askUserInputSchema,
	askUserSchema(true),
);

type AskUserInput = z.infer<typeof askUserInputSchema>;

/** What a turn that asked holds: the question's row, the call that made it and what was asked. */
export type TurnAsk = {
	questionId: string;
	toolCallId: string;
	questions: AskQuestion[];
};

type AskUserPausePayload = { status: typeof ASK_PAUSE_STATUS; note: string };
type AskUserNotAvailablePayload = { status: "not_available"; note: string };
type AskUserErrorPayload = {
	ok: false;
	errorCode: "invalid_questions" | "already_asked" | "ask_user_failed";
	message: string;
};

/** What the model reads back. A call that asked nothing says so and the model goes on. */
export type AskUserModelPayload =
	| AskUserPausePayload
	| AskUserNotAvailablePayload
	| AskUserErrorPayload;

const PAUSE_NOTE = "Asked. The reply pauses here until the user chooses.";
const NOT_AVAILABLE_NOTE =
	"Asking is not available in this reply. Go on with your best judgment.";
const ALREADY_ASKED_MESSAGE =
	"One card per pause: put every question into a single ask_user call.";
const PAUSED_SUMMARY = "Asked the user; the reply paused for the answer.";

/** The ways a call ends without a question being asked, for the recorded entry. */
type NothingAskedReason =
	| "not_available"
	| "invalid_questions"
	| "already_asked"
	| "ask_user_failed";

export function createAskUserTool(ctx: {
	userId: string;
	conversationId: string;
	/** Whether this run can stop to wait for the person (the streaming run only). */
	canPause: boolean;
	recorder: ToolCallRecorder;
	text: { description: string; errorPrefix: string };
}): {
	tool: RequiredExecuteTool<AskUserInput, AskUserModelPayload>;
	getTurnAsk: () => TurnAsk | null;
} {
	// Whether this turn has taken its one ask (one card per pause).
	let asked = false;
	// What that ask made, once its question is recorded.
	let turnAsk: TurnAsk | null = null;

	// A call that asked nothing is still a recorded call, done and not evidence,
	// the way suggest_instruction records a refusal: a later turn replays what the
	// model was told.
	const entryForNothingAsked = (
		options: ToolExecutionOptions,
		questions: AskQuestion[],
		reason: NothingAskedReason,
		outputSummary: string,
	): ToolCallEntry => ({
		callId: options.toolCallId,
		name: ASK_USER_TOOL_NAME,
		input: { questions },
		status: "done",
		outputSummary,
		sourceType: "tool",
		metadata: { ok: false, evidenceReady: false, reason },
	});

	async function execute(
		input: AskUserInput,
		options: ToolExecutionOptions,
	): Promise<AskUserModelPayload> {
		const { questions } = input;
		const recordNothingAsked = (
			reason: NothingAskedReason,
			outputSummary: string,
		) =>
			ctx.recorder.record(
				entryForNothingAsked(options, questions, reason, outputSummary),
			);

		if (!ctx.canPause) {
			recordNothingAsked("not_available", NOT_AVAILABLE_NOTE);
			return { status: "not_available", note: NOT_AVAILABLE_NOTE };
		}
		if (asked) {
			recordNothingAsked("already_asked", ALREADY_ASKED_MESSAGE);
			return {
				ok: false,
				errorCode: "already_asked",
				message: ALREADY_ASKED_MESSAGE,
			};
		}
		const checked = checkAskQuestions(questions);
		if (!checked.ok) {
			// Not an ask: the model fixes the card and calls again in the same run.
			recordNothingAsked("invalid_questions", checked.message);
			return {
				ok: false,
				errorCode: "invalid_questions",
				message: checked.message,
			};
		}
		// No await between the checks above and this line, so two calls in one
		// step cannot both get past `asked` and both record a question.
		asked = true;

		return executeToolWithEnvelope<AskUserPausePayload, AskUserErrorPayload>({
			toolName: ASK_USER_TOOL_NAME,
			timeoutMs: TOOL_TIMEOUTS_MS.ask_user,
			options,
			recorder: ctx.recorder,
			run: async () => {
				const { id } = await recordAskQuestion({
					userId: ctx.userId,
					conversationId: ctx.conversationId,
					toolCallId: options.toolCallId,
					questions,
				});
				turnAsk = { questionId: id, toolCallId: options.toolCallId, questions };
				return {
					modelPayload: { status: ASK_PAUSE_STATUS, note: PAUSE_NOTE },
					entry: {
						callId: options.toolCallId,
						name: ASK_USER_TOOL_NAME,
						input: { questions },
						status: "done",
						outputSummary: PAUSED_SUMMARY,
						sourceType: "tool",
						// No `ok`/`evidenceReady` flags: nothing here is refused.
						metadata: { paused: true, questionId: id },
					},
				};
			},
			onError: (error) => {
				// A store that failed asked nobody: the model may try the card
				// again, which is not a second card.
				if (turnAsk === null) asked = false;
				const message = modelSafeToolError(error, ctx.text.errorPrefix);
				return {
					modelPayload: { ok: false, errorCode: "ask_user_failed", message },
					entry: entryForNothingAsked(
						options,
						questions,
						"ask_user_failed",
						message,
					),
				};
			},
		});
	}

	return {
		tool: asExecutableTool(
			tool({
				description: ctx.text.description,
				inputSchema: askUserToolSchema,
				execute,
			}),
		),
		getTurnAsk: () => turnAsk,
	};
}

// --- the answer ---------------------------------------------------------------

/**
 * What the model is handed as the ask call's result once the person has answered:
 * the resume (chat-turn/ask-resume.ts) swaps it in for the pause marker. The
 * statuses, keys and notes are the app's own words, fixed English whatever the
 * person writes (ruling 79); the questions, the labels and the person's own words
 * in them are data.
 */
export type AskAnswerResult =
	| {
			status: "answered";
			answers: Array<{
				question: string;
				picked?: string[];
				ownWords?: string;
			}>;
			note: string;
	  }
	| {
			status: "left_to_you";
			answers: Array<{ question: string; recommended?: string[] }>;
			note: string;
	  }
	| { status: "closed"; note: string };

const ANSWERED_NOTE =
	"The user answered. Go on with the same reply from where it paused; do not repeat what is already written.";
const LEFT_TO_YOU_NOTE =
	"The user left these choices to you: take your recommended option where you marked one, else your best judgment, and go on with the same reply.";
const CLOSED_NOTE =
	"The user closed the question without answering. It may have been off. Go on with your best judgment or ask differently, and never ask the same thing again.";

type GivenAnswer = Extract<
	AskAnswerResult,
	{ status: "answered" }
>["answers"][number];

/**
 * The result the model reads for the person's answer, and what the asking row's
 * call keeps of it for later turns: the one-line summary and the digest history
 * replays as the call's result (`updateAssistantToolCallResult`).
 *
 * Total on purpose: the answer was checked against the questions before the claim
 * that brought it here, so an entry with no question and a pick with no option are
 * left out rather than thrown on.
 *
 * The digest says each question with its answer where the summary cannot carry it
 * (the person's own words, several questions), through the shared digest builder,
 * which keeps it short. `deriveToolResultDigest` describes an array of items by a
 * label, and an answer has none, so each question and its answer go in as one
 * label. A choice left to Alfy and the X have nothing more to say: the summary
 * does, and the digest is empty.
 */
export function buildAskAnswerRecord(
	questions: readonly AskQuestion[],
	answer: AskAnswer,
): { result: AskAnswerResult; outputSummary: string; resultDigest: string } {
	switch (answer.kind) {
		case "closed":
			return {
				result: { status: "closed", note: CLOSED_NOTE },
				outputSummary: "The user closed the question",
				resultDigest: "",
			};
		case "left_to_alfy":
			return {
				result: {
					status: "left_to_you",
					answers: questions.map(({ question, options }) => {
						const recommended = options
							.filter((option) => option.recommended === true)
							.map((option) => option.label);
						return recommended.length > 0
							? { question, recommended }
							: { question };
					}),
					note: LEFT_TO_YOU_NOTE,
				},
				outputSummary: "The user left it to Alfy",
				resultDigest: "",
			};
		case "answered": {
			const answers = answer.answers.flatMap((given, index): GivenAnswer[] => {
				const asked = questions[index];
				if (!asked) return [];
				if (given.ownWords !== null) {
					return [{ question: asked.question, ownWords: given.ownWords }];
				}
				return [
					{
						question: asked.question,
						picked: given.picked.flatMap((pick) => {
							const option = asked.options[pick];
							return option ? [option.label] : [];
						}),
					},
				];
			});
			return {
				result: { status: "answered", answers, note: ANSWERED_NOTE },
				outputSummary: answeredSummary(answers),
				resultDigest:
					deriveToolResultDigest({
						answers: answers.map((one) => ({
							label: `${one.question}: ${answerText(one)}`,
						})),
					}) ?? "",
			};
		}
	}
}

function answeredSummary(answers: readonly GivenAnswer[]): string {
	const [only, ...more] = answers;
	if (!only) return "The user answered";
	if (more.length > 0) return `The user answered ${answers.length} questions`;
	if (only.ownWords !== undefined)
		return "The user answered in their own words";
	// no option left to name means an answer that did not fit the question
	return only.picked?.length
		? `The user picked: ${only.picked.join(", ")}`
		: "The user answered";
}

/** An answer as the end of a digest line: the labels picked, or the person's words in quotes. */
function answerText(one: GivenAnswer): string {
	return one.ownWords !== undefined
		? `"${one.ownWords.replace(/\s+/g, " ")}"`
		: (one.picked ?? []).join(", ");
}
