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
		// Read-side incognito: withhold the memory-recall tool so an incognito
		// conversation cannot pull persona/project/history memory via tool calls.
		memoryIncognito?: boolean;
	},
): Partial<NormalChatToolSet> {
	const { memory_context: _memoryContext, ...withoutMemory } = tools;
	const base: Partial<NormalChatToolSet> = params.memoryIncognito
		? withoutMemory
		: tools;
	if (shouldExposeFileProductionTools(params)) return base;
	const {
		produce_file: _produceFile,
		read_generated_file: _readGeneratedFile,
		...chatTools
	} = base;
	return chatTools;
}
