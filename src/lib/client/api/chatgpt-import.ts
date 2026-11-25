import JSZip from "jszip";
import {
	exportedConversationId,
	writeExportedConversations,
} from "$lib/shared/chatgpt-export";
import { type FetchLike, requestJson } from "./http";

export interface ChatGPTImportResult {
	jobId: string;
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
}

/**
 * What the browser uploads for an import: the ticked conversations alone, in
 * the export's order, packed as a small export the server reads like any other
 * (`writeExportedConversations`). The export the person picked also carries
 * every attachment and its viewer page, which the import never reads: one of
 * 342 MB held 8 MB of chats, and the server refuses a request over 100 MB.
 */
export async function packChatGPTUpload(
	entries: readonly unknown[],
	conversationIds: readonly string[],
): Promise<File> {
	const wanted = new Set(conversationIds);
	const zip = new JSZip();
	writeExportedConversations(
		entries.filter((entry) => {
			const id = exportedConversationId(entry);
			return id !== null && wanted.has(id);
		}),
		zip,
	);
	// JSZip stores files uncompressed unless asked.
	const packed = await zip.generateAsync({
		type: "blob",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});
	return new File([packed], "chatgpt-export.zip", { type: "application/zip" });
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
