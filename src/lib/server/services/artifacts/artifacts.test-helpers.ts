// Seeding for the artifacts service suites. Every suite runs against its own
// fully migrated in-memory database (`createInMemoryDatabase`), so the rows
// these write are real rows with real foreign keys, and the ownership scope
// the service takes is the real one.
import type { InMemoryDatabase } from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

export const NOW = new Date("2026-09-25T10:00:00.000Z");

export function seedUser(memory: InMemoryDatabase, id: string): void {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

export function seedConversation(
	memory: InMemoryDatabase,
	params: { id: string; userId: string; memoryIncognito?: boolean },
): void {
	memory.db
		.insert(schema.conversations)
		.values({
			id: params.id,
			userId: params.userId,
			title: params.id,
			memoryIncognito: params.memoryIncognito ?? false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/**
 * A produced file as the file-production pipeline leaves it: the
 * `chat_generated_files` row on an assistant message, and the
 * `generated_output` artifact whose metadata points at it. The artifact is
 * what the artifact family reads as kind `file`.
 */
export function seedProducedFile(
	memory: InMemoryDatabase,
	params: {
		userId: string;
		conversationId: string;
		artifactId: string;
		filename: string;
		updatedAt?: Date;
		withChatFile?: boolean;
	},
): { artifactId: string; chatFileId: string } {
	const chatFileId = `file-${params.artifactId}`;
	const messageId = `message-${params.artifactId}`;
	if (params.withChatFile !== false) {
		memory.db
			.insert(schema.messages)
			.values({
				id: messageId,
				conversationId: params.conversationId,
				role: "assistant",
				content: "Here it is.",
				createdAt: NOW,
			})
			.run();
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values({
				id: chatFileId,
				conversationId: params.conversationId,
				assistantMessageId: messageId,
				userId: params.userId,
				filename: params.filename,
				mimeType: "application/pdf",
				sizeBytes: 2048,
				storagePath: `${params.conversationId}/${params.filename}`,
				createdAt: NOW,
			})
			.run();
	}
	memory.db
		.insert(schema.artifacts)
		.values({
			id: params.artifactId,
			userId: params.userId,
			conversationId: params.conversationId,
			type: "generated_output",
			retrievalClass: "durable",
			name: params.filename,
			mimeType: "application/pdf",
			contentText: `Generated file: ${params.filename}`,
			metadataJson: JSON.stringify({
				generatedFile: true,
				originalChatFileId: chatFileId,
				generatedFilename: params.filename,
				documentLabel: params.filename,
				versionNumber: 1,
			}),
			createdAt: NOW,
			updatedAt: params.updatedAt ?? NOW,
		})
		.run();
	return { artifactId: params.artifactId, chatFileId };
}
