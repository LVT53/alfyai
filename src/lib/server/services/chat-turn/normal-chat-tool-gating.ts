import type { createNormalChatTools } from "$lib/server/services/normal-chat-tools";
import { isProduceFileRequest } from "$lib/server/services/normal-chat-tools";

type NormalChatToolSet = ReturnType<typeof createNormalChatTools>["tools"];

export function shouldExposeFileProductionTools(params: {
	message: string;
	forceProduceFileTool?: boolean;
}): boolean {
	if (params.forceProduceFileTool === true) return true;
	return isProduceFileRequest(params.message);
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
	},
): Partial<NormalChatToolSet> {
	const selected: Partial<NormalChatToolSet> = shouldExposeFileProductionTools(
		params,
	)
		? { ...tools }
		: (() => {
				const {
					produce_file: _produceFile,
					read_generated_file: _readGeneratedFile,
					...chatTools
				} = tools;
				return chatTools;
			})();
	if (params.memoryActive === false) {
		delete selected.memory_context;
	}
	return selected;
}
