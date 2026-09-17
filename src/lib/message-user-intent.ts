// What the USER chose for one turn, recorded with the assistant message that
// answered it.
//
// The composer's chips are destroyed on send, and nothing else on a message
// distinguishes "the user asked for this" from "the model decided to": a
// `use_skill` or `research_web` tool call looks the same whichever of them
// wanted it. The assistant turn's provenance line (see
// components/chat/message-provenance.ts) shows only the user's own choices,
// so those have to be written down at the moment they are still known.
//
// The record is minimal and additive. It rides `messages.metadataJson.userIntent`
// on the ASSISTANT message (no migration — metadataJson is already a JSON
// column), and the terminal `data-stream-metadata` frame for the live
// session. A key is present only when the user made that choice; a turn where
// they chose nothing has no record at all. A message persisted before this
// existed has no record either, and reads as "chose nothing".
//
// Shared by server and client, so it lives outside `$lib/server` and imports
// nothing.

export interface MessageUserIntentSkill {
	id: string;
	displayName: string;
}

export interface MessageUserIntent {
	// The skill the user applied to this message from the composer — picked
	// from the plus menu or force-applied with `$name` (request field
	// `pendingSkill`). Never a skill the model loaded on its own.
	skill?: MessageUserIntentSkill;
	// The user forced web search for this message with `/web` (request field
	// `forceWebSearch`). Never a search the model ran on its own.
	webSearch?: true;
}

/**
 * Build the record for a turn, or `undefined` when the user chose nothing —
 * callers spread it conditionally so an empty `{}` is never persisted.
 */
export function buildMessageUserIntent(params: {
	skill?: { id: string; displayName: string } | null | undefined;
	forceWebSearch?: boolean | undefined;
}): MessageUserIntent | undefined {
	const intent: MessageUserIntent = {};
	const id = params.skill?.id.trim();
	const displayName = params.skill?.displayName.trim();
	if (id && displayName) {
		intent.skill = { id, displayName };
	}
	if (params.forceWebSearch === true) {
		intent.webSearch = true;
	}
	return intent.skill || intent.webSearch ? intent : undefined;
}

/**
 * Read the record back from untrusted JSON (persisted metadata, or a stream
 * frame). Anything malformed degrades to "chose nothing" for that key, and a
 * record with no valid key is `undefined` — never `{}`.
 */
export function parseMessageUserIntent(
	value: unknown,
): MessageUserIntent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as { skill?: unknown; webSearch?: unknown };
	const skill =
		candidate.skill && typeof candidate.skill === "object"
			? (candidate.skill as { id?: unknown; displayName?: unknown })
			: null;
	return buildMessageUserIntent({
		skill:
			skill &&
			typeof skill.id === "string" &&
			typeof skill.displayName === "string"
				? { id: skill.id, displayName: skill.displayName }
				: null,
		forceWebSearch: candidate.webSearch === true,
	});
}
