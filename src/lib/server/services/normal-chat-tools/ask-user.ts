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
	type AskQuestion,
	checkAskQuestions,
} from "$lib/shared/ask-user";
import {
	asExecutableTool,
	executeToolWithEnvelope,
	modelSafeToolError,
	type RequiredExecuteTool,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";

// The compact schema the model sees keeps the item counts and the length caps
// (compactToolInputSchema), and `execute` runs `checkAskQuestions` on top for
// what a schema cannot say: the Recommended rule, and a text that is only space.
const askOptionSchema = z.object({
	label: z
		.string()
		.min(1)
		.max(ASK_LIMITS.labelChars)
		.describe("The option, a few words."),
	note: z
		.string()
		.min(1)
		.max(ASK_LIMITS.noteChars)
		.optional()
		.describe("Optional one-line note on what this option means."),
	recommended: z.boolean().optional().describe("Your recommendation."),
});

const askQuestionSchema = z.object({
	question: z
		.string()
		.min(1)
		.max(ASK_LIMITS.questionChars)
		.describe("The question itself, one short sentence."),
	multiple: z
		.boolean()
		.optional()
		.describe("true when the user may pick several options."),
	options: z
		.array(askOptionSchema)
		.min(ASK_LIMITS.minOptions)
		.max(ASK_LIMITS.maxOptions)
		.describe("2-3 options, in the order to show them."),
});

export const askUserInputSchema = z.object({
	questions: z
		.array(askQuestionSchema)
		.min(ASK_LIMITS.minQuestions)
		.max(ASK_LIMITS.maxQuestions)
		.describe("1-3 questions, in the order to ask them."),
});

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
				inputSchema: askUserInputSchema,
				execute,
			}),
		),
		getTurnAsk: () => turnAsk,
	};
}
