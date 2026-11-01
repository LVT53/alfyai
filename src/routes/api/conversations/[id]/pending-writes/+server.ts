import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { listConnectionsForUser } from "$lib/server/services/connections/store";
import { toPendingWriteDto } from "$lib/server/services/connections/write-card";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// GET /api/conversations/[id]/pending-writes — Issue 7.5. Read side of the
// inline write-confirm card: mirrors listConversationFileProductionJobs +
// its embedding in the conversation-detail read model, but as its own
// dedicated, user+conversation-scoped endpoint (connection_pending_writes
// isn't part of ConversationDetail). Returns what the card shows and never
// the raw op/content payload the write tool built (write-card.ts reads those
// for it).
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const conversationId = event.params.id;

	const conversation = await getConversation(userId, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const records = await listPendingWritesForConversation(
		userId,
		conversationId,
	);
	// Which account a write lands in is the first thing worth knowing when a
	// person has two of a kind. A missing name costs the card one word.
	const connections =
		records.length > 0
			? await listConnectionsForUser(userId).catch(() => [])
			: [];
	const accounts = new Map(
		connections.map((connection) => [
			connection.id,
			connection.accountIdentifier,
		]),
	);

	return json({
		pendingWrites: records.map((record) => toPendingWriteDto(record, accounts)),
	});
};
