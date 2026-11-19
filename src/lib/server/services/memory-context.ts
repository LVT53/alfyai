import { getMemoryForTurn } from "./memory-context/read";
import type {
	GetMemoryContextParams,
	MemoryContextResult,
} from "./memory-context/types";
import { isMemoryActiveForConversation } from "./memory-controls";
import { withReasonCode } from "./normal-chat-tools/shared";

export { tokenizeQuery } from "./memory-context/query";

export { resolveProjectMemoryContextMode } from "./memory-context/read";
export type {
	GetMemoryContextParams,
	HistoryMemoryContextConversation,
	HistoryMemoryContextMessage,
	HistoryMemoryContextResult,
	HistoryMemoryContextSelectedConversation,
	MemoryContextMode,
	MemoryContextResult,
	PersonaMemoryContextResult,
	ProjectMemoryContextResult,
} from "./memory-context/types";

/**
 * Public entry point for the memory_context tool. Thin caller over the shared
 * memory-read seam (`getMemoryForTurn`), which owns persona + history + project
 * retrieval, projection-policy screening and uniform sanitisation.
 *
 * Read-side master gate: the tool is normally withheld from the model when
 * memory is inactive (see selectNormalChatToolsForRequest), but the seam
 * enforces the same single source of truth (isMemoryActiveForConversation:
 * master toggle AND non-incognito) as a backstop so any caller that reaches
 * this entry point on an inactive conversation gets an inert empty result
 * instead of leaking recalled memory. Fails closed on a controls-lookup
 * error so unavailable authorization cannot disclose remembered content.
 *
 * Tag the inert result beside the payload so the tool row can distinguish
 * a confirmed pause from an unavailable controls lookup.
 */
export async function getMemoryContext(
	params: GetMemoryContextParams,
): Promise<MemoryContextResult> {
	const memoryActive = await isMemoryActiveForConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => null);
	if (!memoryActive) {
		return withReasonCode(
			{
				success: true,
				mode: "persona",
				status: "empty",
				source: "active_memory_profile",
				content: null,
				evidenceCandidates: [],
				audit: {
					conversationId: params.conversationId,
					query: params.query?.trim() || "",
				},
			} satisfies MemoryContextResult,
			memoryActive === null ? "memory_unavailable" : "memory_off",
		);
	}
	return getMemoryForTurn(params);
}
