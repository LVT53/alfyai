/**
 * How a ChatGPT export names one of its conversations.
 *
 * The browser reads the export's ZIP to draw the list the person ticks from,
 * and the server reads the same file again to import what was ticked, so both
 * must name a conversation the same way or a tick would point at nothing: by the
 * `conversation_id` the entry carries, else by its `id`. An entry that carries
 * neither has no name, and a selection cannot refer to it.
 */
export function exportedConversationId(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return null;
	}
	const { conversation_id: conversationId, id } = entry as Record<
		string,
		unknown
	>;
	for (const candidate of [conversationId, id]) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return null;
}
