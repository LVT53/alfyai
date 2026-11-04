/**
 * Pure helpers for a reply that paused to ask the person ("Ask me first").
 *
 * Such a reply is stored as segments: consecutive assistant rows, each an ordinary
 * turn, and every segment after the first names the row it continues
 * (`ChatMessage.continuesMessageId`). The page draws them as ONE reply: each segment
 * keeps its own thinking rail, words and cards; the question's card, or its folded
 * line, is drawn below the words and cards of the segment that asked; the reply's
 * buttons and follow-up chips appear once, after the last segment, and only when no
 * question waits. `MessageArea` works out each row's place with
 * {@link placeReplySegments} and `MessageBubble` draws what the place says; the page
 * reads a reply through the other helpers (Retry from any row aims at the reply's
 * first, the later-turn counts count a reply once, an answer resumes the person's
 * message).
 *
 * Side-effect free, so it can be unit-tested in isolation.
 */

import type { MessageUserIntent } from "$lib/message-user-intent";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { AskQuestionDto } from "$lib/shared/ask-user";

/** Where an assistant row sits in the reply it belongs to. */
export type ReplyPlace = {
	/** The id of the reply's first row; the row's own id when it starts the reply. */
	firstMessageId: string;
	/** The row carries on from the row right above it. */
	continuesAbove: boolean;
	/**
	 * The reply goes on below this row: the next row carries on from it, or its question
	 * waits for the person or is being answered (the resume's segment is on its way).
	 */
	continuedBelow: boolean;
	/** The question this row asked: a card while it waits, then its folded line. */
	question: AskQuestionDto | null;
	/**
	 * What Copy takes, on the last row of a reply of more than one row: every row's
	 * words, the empty ones left out, joined by a blank line. `null` elsewhere, where
	 * Copy takes the row's own words.
	 */
	copyText: string | null;
	/**
	 * What the person chose for the reply (a skill, a forced web search), taken from its
	 * FIRST row, on the last row of a reply of more than one row; `null` elsewhere, and
	 * when the first row records none. The resume turn runs without a prepared turn, so
	 * a continuation records no choices of its own, and a continued row draws no
	 * provenance line: without this, a reply that began with a chosen skill or `/web`
	 * would say so nowhere. The line under the last row takes these in place of its own
	 * row's record; its evidence and Atlas parts stay the row's own.
	 */
	userIntent: MessageUserIntent | null;
};

/**
 * The words Copy takes of a row: its content without the model's thinking text.
 * The one definition, for a row alone and for every row of a reply.
 */
export function getClipboardText(content: string): string {
	return content
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<\/?thinking>/gi, "")
		.trim();
}

/**
 * Whether the row at `index` carries on from the row right above it: both are
 * assistant rows and its `continuesMessageId` is that row's id. A link to a row that
 * is not loaded (a long chat shows only its last messages, a fork may drop it) or is
 * not the one above starts a reply of its own.
 */
export function continuesRowAbove(
	messages: readonly Pick<ChatMessage, "id" | "role" | "continuesMessageId">[],
	index: number,
): boolean {
	const row = messages[index];
	const above = messages[index - 1];
	return (
		row?.role === "assistant" &&
		above?.role === "assistant" &&
		row.continuesMessageId === above.id
	);
}

/** The index of the first row of the reply the row at `index` belongs to. */
function firstIndexOfReply(
	messages: readonly ChatMessage[],
	index: number,
): number {
	let first = index;
	while (continuesRowAbove(messages, first)) first -= 1;
	return first;
}

/**
 * The id of the first row of the reply `messageId` belongs to: the row itself when it
 * starts a reply, or is not in the list.
 */
export function replyFirstMessageId(
	messages: readonly ChatMessage[],
	messageId: string,
): string {
	const index = messages.findIndex((message) => message.id === messageId);
	if (index < 0) return messageId;
	return messages[firstIndexOfReply(messages, index)].id;
}

/** The index of the last row of the reply the row at `index` belongs to. */
export function replyEndIndex(
	messages: readonly ChatMessage[],
	index: number,
): number {
	let end = index;
	while (continuesRowAbove(messages, end + 1)) end += 1;
	return end;
}

/**
 * The person's message a reply answers: the user row right before its first row.
 * `null` when the reply opens the chat, follows another reply, or is not in the list.
 */
export function personMessageOfReply(
	messages: readonly ChatMessage[],
	messageId: string,
): ChatMessage | null {
	const index = messages.findIndex((message) => message.id === messageId);
	if (index < 0) return null;
	const before = messages[firstIndexOfReply(messages, index) - 1];
	return before?.role === "user" ? before : null;
}

/**
 * How far before a streaming row's own time an unstamped question may have been made
 * and still be its: the clocks of the server and the browser differ a little. The
 * pending-write rule's window (`getPendingWritesForMessage`), the same slack.
 */
const UNSTAMPED_QUESTION_WINDOW_MS = 1000;

/**
 * The question each row asked, by the row's id. A question belongs to the row named by
 * its `assistantMessageId`; one not stamped yet (the stream that asked is still
 * running) belongs to the streaming row, when it was made no earlier than a second
 * before that row, unless a question is stamped on that row already. A row asks once
 * per segment.
 */
function questionsByRow(
	messages: readonly ChatMessage[],
	questions: readonly AskQuestionDto[],
	streamingMessageId: string | null,
): Map<string, AskQuestionDto> {
	const byRow = new Map<string, AskQuestionDto>();
	for (const question of questions) {
		if (question.assistantMessageId !== null) {
			byRow.set(question.assistantMessageId, question);
		}
	}
	const streaming = messages.find(
		(message) => message.id === streamingMessageId,
	);
	if (streaming && !byRow.has(streaming.id)) {
		const unstamped = questions.find(
			(question) =>
				question.assistantMessageId === null &&
				question.createdAt >=
					streaming.timestamp - UNSTAMPED_QUESTION_WINDOW_MS,
		);
		if (unstamped) byRow.set(streaming.id, unstamped);
	}
	return byRow;
}

/** A question that holds the reply open: it waits for the person, or its answer is out. */
function holdsTheReplyOpen(question: AskQuestionDto | null): boolean {
	return question?.status === "waiting" || question?.status === "answering";
}

/**
 * Where each assistant row of the list sits in its reply, by the row's id; the
 * person's rows have no place. A reply of one row and no question gets the plain place.
 *
 * `streamingMessageId` is the assistant row being streamed now, if any: the only row
 * a question that is not stamped yet can belong to.
 */
export function placeReplySegments(
	messages: readonly ChatMessage[],
	questions: readonly AskQuestionDto[],
	streamingMessageId: string | null,
): Map<string, ReplyPlace> {
	const places = new Map<string, ReplyPlace>();
	const questionOf = questionsByRow(messages, questions, streamingMessageId);

	// The rows of the reply being read: the first, then each that carries on.
	let reply: ChatMessage[] = [];
	const closeReply = () => {
		const last = reply.length - 1;
		const copyText =
			reply.length > 1
				? reply
						.map((row) => getClipboardText(row.content))
						.filter((words) => words !== "")
						.join("\n\n")
				: null;
		const userIntent = reply.length > 1 ? (reply[0].userIntent ?? null) : null;
		for (const [position, row] of reply.entries()) {
			const question = questionOf.get(row.id) ?? null;
			places.set(row.id, {
				firstMessageId: reply[0].id,
				continuesAbove: position > 0,
				continuedBelow: position < last || holdsTheReplyOpen(question),
				question,
				copyText: position === last ? copyText : null,
				userIntent: position === last ? userIntent : null,
			});
		}
		reply = [];
	};

	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") continue;
		if (!continuesRowAbove(messages, index)) closeReply();
		reply.push(message);
	}
	closeReply();
	return places;
}
