import { requestJson } from "./http";

export interface ChatGPTImportResult {
	jobId: string;
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
}

export async function importChatGPTData(
	file: File,
	projectId?: string | null,
): Promise<ChatGPTImportResult> {
	const formData = new FormData();
	formData.append("file", file);
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
	);
}
