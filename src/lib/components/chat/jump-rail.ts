/**
 * Pure helpers for the Chat Scroller (ADR-0043 Slice 17).
 *
 * Kept side-effect free so they can be unit-tested in isolation. The scroller
 * component (`ConversationJumpRail.svelte`) consumes {@link buildJumpRailTurns}
 * to derive the list of turns it shows from the raw message list.
 */

import type { ChatMessage } from "$lib/server/services/messages-types";
import { continuesRowAbove } from "./reply-segments";

/** How many characters of a question or reply a row's label keeps. */
const MAX_LABEL_LENGTH = 60;

/** The scroller only appears once the conversation has this many assistant turns. */
const MIN_TURNS_FOR_RAIL = 6;

/** A single navigable turn in the scroller's list. */
export interface JumpRailTurn {
	/** The assistant message id: choosing the row scrolls to it. */
	id: string;
	/** The one line the row shows; see {@link railTurnLabel}. */
	label: string;
}

/**
 * Build the turn list from a flat message list.
 *
 * A "turn" is an assistant reply. Each turn is paired with the user message
 * immediately before it (if any), which names the turn when no summary exists.
 * A reply that paused to ask the person is stored as segments, several assistant
 * rows each carrying on from the one above (`continuesRowAbove`); it is one turn
 * in the list, under its first row, and counts once. The scroller only helps in
 * long conversations, so this returns an empty array until there are at least
 * {@link MIN_TURNS_FOR_RAIL} turns, matching the component's mount gate so the
 * model and the gate never disagree.
 *
 * Pure: no DOM, no side effects, safe to call during SSR.
 */
export function buildJumpRailTurns(messages: ChatMessage[]): JumpRailTurn[] {
	const turns: JumpRailTurn[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "assistant" || continuesRowAbove(messages, i))
			continue;
		turns.push({
			id: message.id,
			label: railTurnLabel(message, messages[i - 1]),
		});
	}
	return turns.length < MIN_TURNS_FOR_RAIL ? [] : turns;
}

/**
 * What a turn's row says. In order of preference:
 *
 * 1. the durable, LLM-written `railSummary`, computed in the background once the
 *    turn finalizes (A1, owner idea). It is fire-and-forget and degrades
 *    silently, so until it lands, or when it was skipped or rejected,
 * 2. the question the person asked, trimmed and cut at about 60 characters, with
 *    no quotes around it: it is what they remember asking, and
 * 3. the start of the reply, cut the same way: the honest, coarser fallback for
 *    a turn with no question before it (ADR-0056 pattern).
 *
 * A missing, empty or whitespace-only summary or question falls through, so a
 * stray empty string can never surface as an empty row.
 */
export function railTurnLabel(
	message: Pick<ChatMessage, "railSummary" | "content">,
	preceding?: Pick<ChatMessage, "role" | "content">,
): string {
	const summary = message.railSummary?.trim();
	if (summary) return summary;
	if (preceding?.role === "user") {
		const question = oneLine(preceding.content);
		if (question) return truncate(question, MAX_LABEL_LENGTH);
	}
	return truncate(oneLine(message.content), MAX_LABEL_LENGTH);
}

/** Collapse every run of whitespace, newlines included, into one space. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Truncate `text` to `max` characters, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}…`;
}
