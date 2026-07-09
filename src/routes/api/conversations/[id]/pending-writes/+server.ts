import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// GET /api/conversations/[id]/pending-writes — Issue 7.5. Read side of the
// inline write-confirm card: mirrors listConversationFileProductionJobs +
// its embedding in the conversation-detail read model, but as its own
// dedicated, user+conversation-scoped endpoint (connection_pending_writes
// isn't part of ConversationDetail). Returns only the fields already safe
// to show the user — the `preview` a write proposal already produced
// (write-guard, 4.1), never the raw op/content payload the write tool
// built (pending-writes.ts's `op`/`content` on PendingWriteRecord).
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

	return json({
		// PendingWriteRecord.createdAt is UNIX seconds (pending-writes.ts's
		// toRecord); every other client-facing timestamp (ChatMessage,
		// FileProductionJob) is epoch milliseconds — MessageArea's
		// getPendingWritesForMessage compares this against message.timestamp,
		// so it's converted to ms here at the API boundary rather than
		// leaking the seconds-vs-ms mismatch into client code.
		pendingWrites: records.map((record) => ({
			id: record.id,
			assistantMessageId: record.assistantMessageId,
			conversationId: record.conversationId,
			status: record.status,
			preview: record.preview,
			provider: record.provider,
			createdAt: record.createdAt * 1000,
		})),
	});
};
