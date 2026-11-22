import type { MemoryOperation } from "$lib/memory-types";
import { type FetchLike, requestJson } from "./http";

interface LegacyMemoryNoteResult {
	id: string;
	statement: string;
}

export type MemoryNoteResult =
	| LegacyMemoryNoteResult
	| { operation: MemoryOperation };

/**
 * Saves a durable memory note straight from the composer's `/remember`
 * command. Server-owned: writes through the existing memory profile item
 * store (see `POST /api/memory/notes`) rather than inventing new storage.
 */
export async function addMemoryNote(
	text: string,
	context: { conversationId: string | null; requestId: string },
	fetchImpl: FetchLike = fetch,
): Promise<MemoryNoteResult> {
	return requestJson<MemoryNoteResult>(
		"/api/memory/notes",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, ...context }),
		},
		"Failed to save memory note.",
		fetchImpl,
	);
}
