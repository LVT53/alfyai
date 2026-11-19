/** Saved answers can contain project Memory with no explicit source links. */
export function isAutomaticEvidenceInConversation(
	artifact: { type: string; conversationId: string | null },
	conversationId: string,
): boolean {
	return (
		artifact.type !== "generated_output" ||
		(conversationId.length > 0 && artifact.conversationId === conversationId)
	);
}
