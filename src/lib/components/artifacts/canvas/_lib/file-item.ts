/**
 * What the panel needs to open the file a File block names, in the two shapes
 * the panel already opens: a produced file (a chat file, previewed and
 * downloaded through the chat-files routes, as the chat's own file cards open
 * it) and a file the reader attached (an artifact, opened by its own id, as an
 * attachment chip opens it). The block stores one id; `fileBlockSource` says
 * which it is. Null for an id that names no file.
 *
 * The item carries no `conversationId` on purpose: the block does not know which
 * conversation the file was made in, and the panel offers Delete only where an
 * item says it was made in its own conversation.
 */
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { fileBlockSource } from "$lib/shared/artifacts/chat-blocks";

type FileData = Extract<CanvasBlockData, { kind: "file" }>;

export function fileBlockWorkspaceItem(
	data: FileData,
): DocumentWorkspaceItem | null {
	const source = fileBlockSource(data.fileId);
	if (!source) return null;
	const named = {
		filename: data.name,
		title: data.name,
		mimeType: data.mime || null,
	};
	if (source.source === "attached") {
		return {
			id: data.fileId,
			source: "knowledge_artifact",
			artifactId: source.artifactId,
			...named,
		};
	}
	const id = encodeURIComponent(source.chatFileId);
	return {
		id: source.chatFileId,
		source: "chat_generated_file",
		sourceChatFileId: source.chatFileId,
		previewUrl: `/api/chat/files/${id}/preview`,
		downloadUrl: `/api/chat/files/${id}/download`,
		...named,
	};
}
