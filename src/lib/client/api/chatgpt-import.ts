import { type FetchLike, requestJson } from "./http";

export interface ChatGPTImportResult {
	jobId: string;
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
}

/**
 * Import the conversations of a ChatGPT export. `conversationIds` are the ones
 * the person ticked, named as the export names them (`exportedConversationId`);
 * the server imports those and no others, and refuses an empty list.
 */
export async function importChatGPTData(
	file: File,
	conversationIds: readonly string[],
	projectId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ChatGPTImportResult> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("conversationIds", JSON.stringify(conversationIds));
	if (projectId !== undefined && projectId !== null) {
		formData.append("projectId", projectId);
	}

	return requestJson<ChatGPTImportResult>(
		"/api/chat/import",
		{
			method: "POST",
			body: formData,
		},
		"Failed to import ChatGPT conversations",
		fetchImpl,
	);
}
