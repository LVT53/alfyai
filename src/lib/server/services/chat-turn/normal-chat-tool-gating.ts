import type { createNormalChatTools } from "$lib/server/services/normal-chat-tools";

type NormalChatToolSet = ReturnType<typeof createNormalChatTools>["tools"];

// File-production tools are registered on every turn. They used to be gated
// by a message-pattern match, which made the tool set (and therefore the
// cached prompt prefix) change from turn to turn; the description now
// carries the "only when the user asks for a downloadable file" rule.
// `forceProduceFileTool` is kept for callers that force tool choice.
export function shouldExposeFileProductionTools(_params: {
	message: string;
	forceProduceFileTool?: boolean;
}): boolean {
	return true;
}

export function selectNormalChatToolsForRequest(
	tools: NormalChatToolSet,
	params: {
		message: string;
		forceProduceFileTool?: boolean;
		// Read-side memory master gate for this turn. Callers resolve
		// isMemoryActiveForConversation (the single source of truth: master
		// toggle AND non-incognito) and pass the result. Omitted/true keeps
		// today's behaviour; false withholds the memory_context recall tool so
		// an incognito or memory-disabled conversation is never offered memory
		// recall. Defaults to active when unspecified (fail open).
		memoryActive?: boolean;
		// Composer Command Registry master switch for this turn. The per-turn
		// skills catalogue (shared-normal-chat-model-run-helpers.ts) and the
		// explicit `$` selection (preflight.ts) are both gated on it, so the
		// `use_skill` tool has to be withheld with them — otherwise the model
		// keeps a live path into skill instructions for a feature the operator
		// switched off. Omitted/true keeps today's behaviour (fail open).
		skillsEnabled?: boolean;
	},
): Partial<NormalChatToolSet> {
	const selected: Partial<NormalChatToolSet> = { ...tools };
	if (params.memoryActive === false) {
		delete selected.memory_context;
	}
	if (params.skillsEnabled === false) {
		delete selected.use_skill;
	}
	return selected;
}
