import { eq, inArray } from "drizzle-orm";
import type { RuntimeConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { hasLocalDistillEnabled } from "$lib/server/services/connections/locality";
import { messageOrderAsc } from "$lib/server/services/message-ordering";
import { updateAssistantToolCallResult } from "$lib/server/services/messages";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { buildAskAnswerRecord } from "$lib/server/services/normal-chat-tools/ask-user";
import {
	ASK_ENDED_BEFORE_ANSWER,
	ASK_USER_TOOL_NAME,
	type AskAnswer,
	parseAskAnswer,
	parseAskQuestions,
} from "$lib/shared/ask-user";
import {
	type AskResumeInput,
	buildAskResumeContinuation,
	holdsAskResult,
} from "./ask-capture";
import {
	type AskQuestionRow,
	discardClaimedAskQuestion,
	hasWaitingAskQuestion,
	listConversationAskQuestions,
	readAskCapture,
} from "./ask-questions";
import {
	preflightStoredTurn,
	type RetryPreparationError,
	resolveStoredTurnChoices,
} from "./retry";
import type { StreamOrchestratorOptions } from "./stream-orchestrator";
import type { ChatTurnRequestError } from "./types";

// The resume of a reply that asked the person ("Ask me first", docs/plans/ask-me-first,
// design 5.5): from a question the answer route has claimed, a turn on the person's
// own message that carries the same reply on, which the stream orchestrator runs.
//
// The turn is a retry's in the way it is built (the message is stored and is not
// saved again; what the person chose for it is read from what it left), and unlike a
// retry it deletes nothing and has no regeneration appendix: the model's input is the
// history before the person's message, the message, and then the reply so far with
// the answer as the ask's result. A reply that has paused more than once is several
// consecutive rows (segments), each naming the row it continues; the one that asked
// last is the question's row, and the person's message is the user row right before
// the first of them.
//
// Nothing here releases the claim. The caller (the answer route) ends every path
// after a won claim in one release or one settle: a refusal from here is its release,
// and from the moment the orchestrator starts, the orchestrator's. One refusal is the
// exception: a reply that can never be resumed (`closeForGood`) has its question
// closed here, with the claim, because giving that claim back would leave a card
// whose answer fails the same way every time in a chat that refuses new messages.

type ResumePreparationResult =
	| {
			ok: true;
			value: {
				orchestratorInput: Pick<
					StreamOrchestratorOptions,
					| "turn"
					| "upstreamMessage"
					| "isReconnect"
					| "pendingSkillInstructions"
					| "resume"
				>;
			};
	  }
	| { ok: false; error: RetryPreparationError };

/**
 * A question that cannot be carried on although the claim was won: the reply it
 * belongs to no longer has the shape a resume starts from (the person's message is
 * gone, the capture is unreadable or holds no result of the ask). A conflict, with
 * the code `QUESTION_NOT_WAITING`, in the style of the answer route's own codes and
 * not to be mistaken for the route's `QUESTION_ALREADY_ANSWERED` (the claim was
 * lost): this claim was won, and the question is closed for good (`closeForGood`),
 * so the page, which reads the questions after a refusal, finds nothing waiting.
 * The caller's give-back after it is a no-op, the claim being spent.
 */
function notWaiting(): { ok: false; error: RetryPreparationError } {
	return {
		ok: false,
		error: {
			status: 409,
			error: "The question can no longer be answered",
			code: "QUESTION_NOT_WAITING",
			responseShape: "json",
		},
	};
}

/**
 * Closes for good a question whose reply can never be resumed (Ruling 46), then
 * refuses the answer (`notWaiting`). Every cause that gets here is permanent for
 * the question's row: an unreadable capture, a capture without the ask's result, a
 * chain of segments that no longer leads to the person's message. A try that cannot
 * pass is not given back: the card would fail the same way for the answer and for
 * the X, while the chat refuses new messages, Retry and edits for as long as a
 * question waits.
 *
 * The question is discarded with the won claim's token and its capture dropped
 * (`discardClaimedAskQuestion`), and the call that asked, in the row that asked, is
 * rewritten to say the reply ended before an answer: the sentence a reply saved
 * without its pause gets (`stream-completion.ts`), so a later turn never reads a
 * question that is not open. The call is rewritten only after the discard took,
 * and neither step can change the refusal: a failure is logged, and the caller's
 * give-back then puts the question back where it was.
 */
async function closeForGood(p: {
	userId: string;
	conversationId: string;
	claimed: AskQuestionRow;
	claim: string;
}): Promise<{ ok: false; error: RetryPreparationError }> {
	const { userId, conversationId, claimed, claim } = p;
	try {
		const discarded = await discardClaimedAskQuestion({
			userId,
			questionId: claimed.id,
			claim,
		});
		if (!discarded) {
			console.warn(
				"[CHAT_ASK_RESUME] The unresumable question was not closed: its claim is no longer live",
				{ conversationId, questionId: claimed.id },
			);
		} else if (claimed.assistantMessageId !== null) {
			const written = await updateAssistantToolCallResult({
				conversationId,
				messageId: claimed.assistantMessageId,
				callId: claimed.toolCallId,
				toolName: ASK_USER_TOOL_NAME,
				questionId: claimed.id,
				outputSummary: ASK_ENDED_BEFORE_ANSWER,
				resultDigest: "",
			});
			if (!written) {
				console.warn(
					"[CHAT_ASK_RESUME] The ask call of an unresumable question was not rewritten: the row or the call is gone",
					{
						conversationId,
						messageId: claimed.assistantMessageId,
						callId: claimed.toolCallId,
					},
				);
			}
		}
	} catch (error) {
		console.error("[CHAT_ASK_RESUME] Could not close an unresumable question", {
			conversationId,
			questionId: claimed.id,
			error,
		});
	}
	return notWaiting();
}

type ReplyRow = {
	id: string;
	role: string;
	content: string;
	metadataJson: string | null;
};

/** The row a continuation segment names as the one it carries on, or null for a reply's first row. */
function continuesMessageIdOf(metadataJson: string | null): string | null {
	if (!metadataJson) return null;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		const link =
			typeof parsed === "object" && parsed !== null
				? (parsed as { continuesMessageId?: unknown }).continuesMessageId
				: undefined;
		return typeof link === "string" && link.length > 0 ? link : null;
	} catch {
		return null;
	}
}

/**
 * The reply the asking row belongs to, from its first segment to the row that
 * asked, and the person's message right before it. Null when the chain does not
 * lead to one: a row it continues that is gone or is not an assistant's, a loop,
 * or no user row right before the first segment. Reading the chain by the rows'
 * own links, not by their order, is what lets a reply of several segments be told
 * from rows that merely follow one another.
 */
async function findReply(
	conversationId: string,
	askedMessageId: string,
): Promise<{
	segments: ReplyRow[];
	userMessage: ReplyRow;
} | null> {
	const rows: ReplyRow[] = await db
		.select({
			id: messages.id,
			role: messages.role,
			content: messages.content,
			metadataJson: messages.metadataJson,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderAsc());
	const byId = new Map(rows.map((row) => [row.id, row]));

	const segments: ReplyRow[] = [];
	const seen = new Set<string>();
	let row = byId.get(askedMessageId);
	for (;;) {
		if (!row || row.role !== "assistant" || seen.has(row.id)) return null;
		seen.add(row.id);
		segments.unshift(row);
		const link = continuesMessageIdOf(row.metadataJson);
		if (link === null) break;
		row = byId.get(link);
	}

	const firstId = segments[0].id;
	const at = rows.findIndex((candidate) => candidate.id === firstId);
	const userMessage = at > 0 ? rows[at - 1] : undefined;
	if (!userMessage || userMessage.role !== "user") return null;
	return { segments, userMessage };
}

/** The tool calls stored on the rows, in the order of the rows and of the calls on each. */
async function readStoredToolCalls(
	segments: readonly ReplyRow[],
): Promise<ToolCallEntry[]> {
	const stored = await db
		.select({ id: messages.id, toolCalls: messages.toolCalls })
		.from(messages)
		.where(
			inArray(
				messages.id,
				segments.map((segment) => segment.id),
			),
		);
	const timelineById = new Map(stored.map((row) => [row.id, row.toolCalls]));
	return segments.flatMap((segment) =>
		toolCallsOfTimeline(timelineById.get(segment.id) ?? null),
	);
}

/** The calls of a stored timeline (reasoning text, status rows and calls), as the entries the turn recorded them as. */
function toolCallsOfTimeline(toolCallsJson: string | null): ToolCallEntry[] {
	if (!toolCallsJson) return [];
	try {
		const timeline: unknown = JSON.parse(toolCallsJson);
		if (!Array.isArray(timeline)) return [];
		return timeline.flatMap((segment) => {
			if (
				typeof segment !== "object" ||
				segment === null ||
				(segment as { type?: unknown }).type !== "tool_call" ||
				typeof (segment as { name?: unknown }).name !== "string"
			) {
				return [];
			}
			const { type: _type, ...entry } = segment as {
				type: string;
			} & ToolCallEntry;
			return [entry];
		});
	} catch {
		return [];
	}
}

/** What the person typed into an answer, trimmed: their own words, never an option they picked. */
function ownWordsOf(answer: AskAnswer | null): string[] {
	return answer?.kind === "answered"
		? answer.answers.flatMap(({ ownWords }) =>
				ownWords === null ? [] : [ownWords],
			)
		: [];
}

/** The question's questions and the answer that claimed it, as stored; null when either cannot be read. */
function readClaimedAnswer(claimed: AskQuestionRow) {
	try {
		const questions = parseAskQuestions(JSON.parse(claimed.questionsJson));
		const answer =
			claimed.answerJson === null
				? null
				: parseAskAnswer(JSON.parse(claimed.answerJson));
		return questions !== null && answer !== null
			? { answer, record: buildAskAnswerRecord(questions, answer) }
			: null;
	} catch {
		return null;
	}
}

/**
 * Prepares the turn that carries a reply on from the person's answer to the
 * question `claimed`, which the caller has just claimed (`claim` is the token the
 * claim handed back; it goes to the orchestrator unchanged, which gives the question
 * back when the turn ends unsaved and settles it when the segment is saved).
 *
 * The person's message is found by the rows' own links (`findReply`), and the turn
 * is rebuilt on it as a regenerate rebuilds one (`resolveStoredTurnChoices` and
 * `preflightStoredTurn`, retry.ts): the skill and web search the reply's first
 * segment recorded, the message's uploads and pictures, and, from the answer's body,
 * the model, depth and personality the composer has selected now. It refuses (409
 * `QUESTION_NOT_WAITING`) when the reply no longer has the shape a resume starts
 * from, and closes the question for good first (`closeForGood`): nothing a later
 * try could change. Any other refusal (the retry preflight's) can pass, and leaves
 * the claim with the caller to give back.
 *
 * `userTexts` are the words the person typed into the answers of the whole reply,
 * this one's included, so the new turn's address check counts them as theirs (an
 * option's label is the model's, and is never one of them).
 */
export async function prepareAskResumeTurn(p: {
	userId: string;
	runtimeConfig: RuntimeConfig;
	conversationId: string;
	claimed: AskQuestionRow;
	claim: string;
	body: Record<string, unknown>;
}): Promise<ResumePreparationResult> {
	const { userId, runtimeConfig, conversationId, claimed, claim, body } = p;

	// A question that is not this person's, in this chat, is not this resume's to end.
	if (claimed.userId !== userId || claimed.conversationId !== conversationId) {
		return notWaiting();
	}
	const close = () => closeForGood({ userId, conversationId, claimed, claim });

	const askedMessageId = claimed.assistantMessageId;
	const capture = readAskCapture(claimed);
	const answered = readClaimedAnswer(claimed);
	if (
		askedMessageId === null ||
		capture === null ||
		answered === null ||
		!holdsAskResult(capture.messages, claimed.toolCallId)
	) {
		return close();
	}
	const reply = await findReply(conversationId, askedMessageId);
	if (reply === null) return close();
	const { segments, userMessage } = reply;

	// What the person chose for the turn that began the reply, read off its first
	// row; the message's uploads and pictures off the message. The answer's body
	// cannot say either (a resume is not the browser's own memory of a turn).
	const choices = await resolveStoredTurnChoices({
		userId,
		conversationId,
		userMessage,
		replyMetadataJson: segments[0].metadataJson,
		body: { activeDocumentArtifactId: body.activeDocumentArtifactId },
	});
	const preflight = await preflightStoredTurn({
		userId,
		runtimeConfig,
		conversationId,
		message: userMessage.content,
		choices,
		body: {
			activeDocumentArtifactId: body.activeDocumentArtifactId,
			streamId: body.streamId,
			model: body.model,
			reasoningDepth: body.reasoningDepth,
			personalityProfileId: body.personalityProfileId,
			enabledConnectionCapabilities: body.enabledConnectionCapabilities,
		},
	});
	if (!preflight.ok) return preflight;

	// Stamped here, after parsing, like a retry's origin: no client body can claim it.
	const turn = { ...preflight.turn, turnOrigin: "ask_resume" as const };

	// The words typed into the earlier answers of this reply, in the order they were
	// asked, then this answer's.
	const segmentIds = new Set(segments.map((segment) => segment.id));
	const earlier = (
		await listConversationAskQuestions({ userId, conversationId })
	).filter(
		(question) =>
			question.id !== claimed.id &&
			question.assistantMessageId !== null &&
			segmentIds.has(question.assistantMessageId),
	);
	const userTexts = [
		...earlier.flatMap((question) => ownWordsOf(question.answer)),
		...ownWordsOf(answered.answer),
	];

	const resume: AskResumeInput = {
		questionId: claimed.id,
		claim,
		askedMessageId,
		askToolCallId: claimed.toolCallId,
		userMessageId: userMessage.id,
		continuation: buildAskResumeContinuation(
			capture,
			claimed.toolCallId,
			answered.record.result,
		),
		capturedResults: capture.results,
		userTexts,
		priorSegmentToolCalls: await readStoredToolCalls(segments),
		keepConnectorDataLocal: await hasLocalDistillEnabled(userId),
		answerDigest: {
			outputSummary: answered.record.outputSummary,
			resultDigest: answered.record.resultDigest,
		},
	};

	return {
		ok: true,
		value: {
			orchestratorInput: {
				turn,
				upstreamMessage: turn.normalizedMessage,
				isReconnect: false,
				pendingSkillInstructions:
					turn.appliedSkill?.instructionsEnvelope ?? undefined,
				resume,
			},
		},
	};
}

/**
 * The refusal a new message gets while a question waits in its chat: the page
 * reads the questions and the chat again, shows the card and puts the person's
 * words back in the draft. Null when nothing waits. Counts a question that is
 * answering as well (its reply is on the way, or its card is back).
 */
export async function findWaitingQuestionRefusal(p: {
	userId: string;
	conversationId: string;
}): Promise<ChatTurnRequestError | null> {
	return (await hasWaitingAskQuestion(p))
		? {
				status: 409,
				error: "Answer the question Alfy asked before sending a new message",
				code: "QUESTION_WAITING",
			}
		: null;
}
