import type { PendingWrite } from "$lib/types";
import { type FetchLike, requestJson } from "./http";

// Issue 7.5 — client wrappers for the explicit-confirm write flow (4.3):
// a connection write tool (files/calendar/email/photos) proposes a write
// which sits PENDING until the user explicitly confirms or cancels it here.
// Mirrors $lib/client/api/skills.ts's requestJson pattern.

export interface ConfirmWriteResult {
	ok: true;
	alreadyExecuted: boolean;
	etag: string | null;
}

export interface CancelWriteResult {
	ok: true;
	status: "cancelled";
}

export async function confirmWrite(
	id: string,
	fetchImpl?: FetchLike,
): Promise<ConfirmWriteResult> {
	return requestJson<ConfirmWriteResult>(
		`/api/connections/writes/${encodeURIComponent(id)}/confirm`,
		{ method: "POST" },
		"Failed to confirm the write",
		fetchImpl,
	);
}

export async function cancelWrite(
	id: string,
	fetchImpl?: FetchLike,
): Promise<CancelWriteResult> {
	return requestJson<CancelWriteResult>(
		`/api/connections/writes/${encodeURIComponent(id)}/cancel`,
		{ method: "POST" },
		"Failed to cancel the write",
		fetchImpl,
	);
}

export async function fetchConversationPendingWrites(
	conversationId: string,
	fetchImpl?: FetchLike,
): Promise<PendingWrite[]> {
	const data = await requestJson<{ pendingWrites?: PendingWrite[] }>(
		`/api/conversations/${encodeURIComponent(conversationId)}/pending-writes`,
		undefined,
		"Failed to load pending writes",
		fetchImpl,
	);
	return Array.isArray(data.pendingWrites) ? data.pendingWrites : [];
}
