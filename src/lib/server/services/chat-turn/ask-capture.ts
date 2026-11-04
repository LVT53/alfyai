import type { ModelMessage } from "ai";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { isAskToolName } from "$lib/shared/ask-user";
import type { AskCapturedResult, AskResumeCapture } from "./ask-questions";
import { buildHistoryToolDigest } from "./conversation-history";

/**
 * What a resume needs of a reply that paused on `ask_user` ("Ask me first",
 * docs/plans/ask-me-first, design 5.4 and 5.5), as `stampAskQuestion` keeps it.
 * Pure: it reads what the turn hands it and writes nothing.
 *
 * `messages` follows the person's message in the model input. It is what the run
 * was given after that message (`continuationGiven`: the page the server fetched
 * before the model ran and, on a later segment, the earlier segments and their
 * answers) and then what the run said and read (`responseMessages`, the SDK's
 * cumulative `response.messages`, tool results whole).
 *
 * `results` has one row for each tool result in `messages`, naming the tool it
 * came from and carrying its digest, so a resume can still gate the whole result
 * for each model attempt (a cloud model is never sent what a local one
 * summarised). A row is made once: the rows of an earlier capture (`priorResults`)
 * stand as they were and are not read again, because `toolCalls` holds this run's
 * calls alone. A result whose call left no record still gets a plain row, so no
 * result in `messages` is left without one to gate. An ask call has no row: its
 * result is the pause and then the person's answer, not data of a tool.
 */
export function buildAskResumeCapture(p: {
	continuationGiven: ModelMessage[];
	responseMessages: ModelMessage[];
	toolCalls: ToolCallEntry[];
	priorResults: AskCapturedResult[];
	askToolCallId: string;
}): AskResumeCapture {
	const messages = [...p.continuationGiven, ...p.responseMessages];

	const recorded = new Map<string, ToolCallEntry>();
	for (const entry of p.toolCalls) {
		if (entry.callId) recorded.set(entry.callId, entry);
	}

	const results = [...p.priorResults];
	const made = new Set(results.map((row) => row.toolCallId));
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			if (made.has(part.toolCallId)) continue;
			if (part.toolCallId === p.askToolCallId || isAskToolName(part.toolName)) {
				continue;
			}
			made.add(part.toolCallId);
			const entry = recorded.get(part.toolCallId);
			results.push({
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				localDistilled: entry?.metadata?.localDistilled === true,
				digest: buildHistoryToolDigest(entry ?? { status: "done" }),
			});
		}
	}

	return { v: 1, messages, results };
}

/**
 * Whether `messages` (what the run said and read, as of its last finished step)
 * hold a tool result for the ask call. A resume answers that result: it swaps
 * the person's answer in for whatever the result said, so a capture without it
 * cannot be answered. A run that ends with a `finish` has it, because the SDK
 * finishes the last step's callback first; a stream that closed without one can
 * end before the step that asked was captured. Such a turn is not paused.
 */
export function holdsAskResult(
	messages: ModelMessage[],
	askToolCallId: string,
): boolean {
	return messages.some(
		(message) =>
			message.role === "tool" &&
			message.content.some(
				(part) =>
					part.type === "tool-result" && part.toolCallId === askToolCallId,
			),
	);
}
