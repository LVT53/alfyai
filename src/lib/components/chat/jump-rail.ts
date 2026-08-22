/**
 * Pure helpers for the conversation jump-rail (ADR-0043 Slice 17).
 *
 * Kept side-effect free so they can be unit-tested in isolation. The rail
 * component (`ConversationJumpRail.svelte`) consumes {@link buildJumpRailTurns}
 * to derive its per-turn mark model from the raw message list.
 */

import type { ChatMessage } from "$lib/server/services/messages-types";

/** Maximum number of characters kept from an assistant reply for the hover snippet. */
export const MAX_SNIPPET_LENGTH = 120;

/**
 * Maximum number of characters kept from a user question for the eyebrow line
 * shown above the snippet. Kept short so the hover card stays compact.
 */
const MAX_EYEBROW_LENGTH = 60;

/** The rail only appears once the conversation has this many assistant turns. */
export const MIN_TURNS_FOR_RAIL = 6;

/** A single navigable turn on the jump-rail. */
export interface JumpRailTurn {
	/** The assistant message id — clicking the mark scrolls to it. */
	id: string;
	/** Truncated assistant reply text shown in the serif hover snippet. */
	snippet: string;
	/**
	 * The user question that prompted this turn, quoted + truncated, used as the
	 * muted eyebrow above the snippet. `null` when there is no preceding user
	 * message (e.g. an opening assistant message).
	 */
	questionEyebrow: string | null;
	/** Length of the full (untruncated) assistant content — encodes mark height. */
	contentLength: number;
}

/**
 * Build the jump-rail turn model from a flat message list.
 *
 * A "turn" is an assistant message. Each turn is paired with the user message
 * immediately preceding it (if any) for the hover eyebrow. The rail only
 * becomes useful in long conversations, so this returns an empty array until
 * there are at least {@link MIN_TURNS_FOR_RAIL} assistant messages — matching
 * the component's mount gate so the model and the gate never disagree.
 *
 * Pure: no DOM, no side effects, safe to call during SSR.
 */
export function buildJumpRailTurns(messages: ChatMessage[]): JumpRailTurn[] {
	const assistantCount = messages.reduce(
		(count, message) => (message.role === "assistant" ? count + 1 : count),
		0,
	);
	if (assistantCount < MIN_TURNS_FOR_RAIL) return [];

	const turns: JumpRailTurn[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "assistant") continue;

		const preceding = messages[i - 1];
		const questionEyebrow =
			preceding && preceding.role === "user"
				? quoteTruncate(preceding.content, MAX_EYEBROW_LENGTH)
				: null;

		turns.push({
			id: message.id,
			snippet: railEntryText(message),
			questionEyebrow,
			contentLength: message.content.length,
		});
	}
	return turns;
}

/**
 * The text shown for a turn on the rail (hover snippet / accessible name).
 *
 * A1 (owner idea) — prefer the durable, LLM-summarized `railSummary` computed
 * in the background after the turn finalizes. Until that summary lands (it is
 * fire-and-forget and degrades silently), or if it was skipped/rejected, fall
 * back to the deterministic verbatim truncation of the reply start — the
 * honest, coarser-but-never-wrong fallback (ADR-0056 pattern). The projection
 * guarantees `railSummary` is `undefined` (never `""`) when absent, but this
 * fallback stays independent of that upstream invariant: a missing OR
 * blank/whitespace summary falls through to the truncation, so a stray empty
 * string can never surface as an empty rail snippet.
 */
export function railEntryText(
	message: Pick<ChatMessage, "railSummary" | "content">,
): string {
	return message.railSummary?.trim()
		? message.railSummary
		: truncate(message.content, MAX_SNIPPET_LENGTH);
}

/** Truncate `text` to `max` characters, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

/** Like {@link truncate} but wraps the (possibly shortened) text in quotes. */
function quoteTruncate(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return `"${trimmed}"`;
	return `"${trimmed.slice(0, max)}…"`;
}
