import { isProduceFileRequest } from "$lib/server/services/normal-chat-tools";
import type { createNormalChatTools } from "$lib/server/services/normal-chat-tools";

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
	},
): Partial<NormalChatToolSet> {
	if (shouldExposeFileProductionTools(params)) return tools;
	const {
		produce_file: _produceFile,
		read_generated_file: _readGeneratedFile,
		...chatTools
	} = tools;
	return chatTools;
}
