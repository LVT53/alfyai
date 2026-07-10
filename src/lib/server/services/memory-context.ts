import { getMemoryForTurn } from "./memory-context/read";
import type {
	GetMemoryContextParams,
	MemoryContextResult,
} from "./memory-context/types";

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
 */
export async function getMemoryContext(
	params: GetMemoryContextParams,
): Promise<MemoryContextResult> {
	return getMemoryForTurn(params);
}
