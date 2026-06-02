import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversationForks, importJobs, messages } from "$lib/server/db/schema";
import { createConversation } from "$lib/server/services/conversations";
import {
	parseConversationsJson,
	type ParseResult,
} from "./parser";
import { summarizeAndStoreConversation } from "./summarizer";
import { generateImportEmbeddings } from "./embeddings";

interface ImportOptions {
	projectId?: string | null;
	onProgress?: (processed: number, total: number) => void;
}

export interface ImportResult {
	jobId: string;
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
}

async function importConversationBranches(
	userId: string,
	primaryConversationId: string,
	primaryTitle: string,
	primaryMessages: { role: string; content: string }[],
	branches: BranchInfo[],
	options: ImportOptions,
): Promise<void> {
	for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
		const branch = branches[branchIndex];

		let forkPointPrimarySeq = 0;
		const minLen = Math.min(primaryMessages.length, branch.messages.length);
		for (let j = 0; j < minLen; j++) {
			if (
				primaryMessages[j].role === branch.messages[j].role &&
				primaryMessages[j].content === branch.messages[j].content
			) {
				forkPointPrimarySeq = j + 1;
			} else {
				break;
			}
		}

		const forkTitle = `${primaryTitle || "Imported Conversation"} (imported fork ${branchIndex + 1})`;
		const forkConversation = await createConversation(userId, forkTitle, {
			projectId: options.projectId ?? null,
		});

		const forkMessageRows = branch.messages.map((msg, seq) => ({
			id: randomUUID(),
			conversationId: forkConversation.id,
			messageSequence: seq + 1,
			role: msg.role,
			content: msg.content,
			importSource: "chatgpt" as const,
			createdAt: msg.createdAt ?? new Date(),
		}));

		await db.insert(messages).values(forkMessageRows);

		const copiedForkPointMessage =
			forkPointPrimarySeq > 0 && forkPointPrimarySeq <= forkMessageRows.length
				? forkMessageRows[forkPointPrimarySeq - 1]
				: forkMessageRows[0];

		const now = new Date();
		await db.insert(conversationForks).values({
			id: randomUUID(),
			forkConversationId: forkConversation.id,
			userId,
			sourceConversationId: primaryConversationId,
			sourceConversationIdSnapshot: primaryConversationId,
			sourceAssistantMessageId: null,
			sourceAssistantMessageIdSnapshot: `chatgpt:${branch.divergenceNodeId}`,
			copiedForkPointMessageId: copiedForkPointMessage.id,
			sourceTitle: primaryTitle || "Imported Conversation",
			forkSequence: branchIndex + 1,
			createdAt: now,
		});
	}
}

export async function importConversations(
	userId: string,
	zipBuffer: Buffer,
	options: ImportOptions = {},
): Promise<ImportResult> {
	const jobId = randomUUID();
	const conversationIds: string[] = [];
	const errors: { conversationTitle?: string; reason: string }[] = [];
	const now = new Date();

	await db.insert(importJobs).values({
		id: jobId,
		userId,
		status: "processing",
		totalConversations: 0,
		processedConversations: 0,
		createdAt: now,
		updatedAt: now,
	});

	let parseResult: ParseResult;
	try {
		parseResult = await parseConversationsJson(zipBuffer);
	} catch (err) {
		console.error("[CHATGPT_IMPORT] Failed to parse ZIP:", err);
		await db
			.update(importJobs)
			.set({
				status: "failed",
				errorLog: `Parse error: ${err instanceof Error ? err.message : "Unknown error"}`,
				updatedAt: new Date(),
			})
			.where(eq(importJobs.id, jobId));
		return {
			jobId,
			conversationIds,
			errors: [
				{
					reason: `Failed to parse ZIP: ${err instanceof Error ? err.message : "Unknown error"}`,
				},
			],
		};
	}

	for (const parseErr of parseResult.errors) {
		errors.push({
			conversationTitle: parseErr.rawTitle,
			reason: parseErr.reason,
		});
	}

	const totalConversations = parseResult.conversations.length;

	await db
		.update(importJobs)
		.set({ totalConversations, updatedAt: new Date() })
		.where(eq(importJobs.id, jobId));

	if (totalConversations === 0) {
		await db
			.update(importJobs)
			.set({
				status: "completed",
				errorLog: errors.length > 0 ? JSON.stringify(errors) : null,
				updatedAt: new Date(),
			})
			.where(eq(importJobs.id, jobId));
		return { jobId, conversationIds, errors };
	}

	for (let i = 0; i < totalConversations; i++) {
		const conv = parseResult.conversations[i];
		try {
			const conversation = await createConversation(
				userId,
				conv.title || "Imported Conversation",
				{
					projectId: options.projectId ?? null,
				},
			);

			conversationIds.push(conversation.id);

			if (conv.messages.length > 0) {
				const messageRows = conv.messages.map((msg, seq) => ({
					id: randomUUID(),
					conversationId: conversation.id,
					messageSequence: seq + 1,
					role: msg.role,
					content: msg.content,
					importSource: "chatgpt" as const,
					createdAt: msg.createdAt ?? new Date(),
				}));

				await db.insert(messages).values(messageRows);

				const branches = conv.branches;
				if (branches && branches.length > 0) {
					await importConversationBranches(
						userId,
						conversation.id,
						conv.title,
						conv.messages,
						branches,
						options,
					);
				}

				generateImportEmbeddings(
					conversation.id,
					userId,
					conv.title || "Imported Conversation",
					conv.messages,
				).catch((err) => {
					console.error(
						"[CHATGPT_IMPORT] Background embedding generation failed:",
						err instanceof Error ? err.message : String(err),
					);
				});

				summarizeAndStoreConversation(
					userId,
					conversation.id,
					conv.messages,
					conv.title || "Imported Conversation",
				).catch((summarizeErr) => {
					console.error(
						"[CHATGPT_IMPORT] Summarization failed for conversation",
						conversation.id,
						summarizeErr,
					);
				});
			}
		} catch (err) {
			errors.push({
				conversationTitle: conv.title,
				reason: `Failed to create conversation: ${err instanceof Error ? err.message : "Unknown error"}`,
			});
		}

		await db
			.update(importJobs)
			.set({ processedConversations: i + 1, updatedAt: new Date() })
			.where(eq(importJobs.id, jobId));

		options.onProgress?.(i + 1, totalConversations);
	}

	await db
		.update(importJobs)
		.set({
			status: "completed",
			errorLog: errors.length > 0 ? JSON.stringify(errors) : null,
			updatedAt: new Date(),
		})
		.where(eq(importJobs.id, jobId));

	return { jobId, conversationIds, errors };
}
