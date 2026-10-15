import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversationForks, messages, projects } from "$lib/server/db/schema";
import { createConversation } from "$lib/server/services/conversations";
import { generateImportEmbeddings } from "./embeddings";
import {
	completeImportRow,
	failImportRow,
	startImportRow,
	writeImportProgress,
} from "./import-row";
import {
	type BranchInfo,
	type ParseResult,
	parseConversationsJson,
} from "./parser";
import { summarizeAndStoreConversation } from "./summarizer";

interface ImportOptions {
	projectId?: string | null;
	onProgress?: (processed: number, total: number) => void;
}

export interface ImportResult {
	jobId: string;
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
}

export { ChatGptImportAlreadyRunningError } from "./import-row";

export class ChatGptImportProjectAccessError extends Error {
	constructor(projectId: string) {
		super(`Project "${projectId}" is not available for this user`);
		this.name = "ChatGptImportProjectAccessError";
	}
}

async function validateImportProjectId(
	userId: string,
	projectId: string | null | undefined,
): Promise<string | null> {
	const normalizedProjectId = projectId?.trim() || null;
	if (!normalizedProjectId) return null;

	const [project] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(
			and(eq(projects.id, normalizedProjectId), eq(projects.userId, userId)),
		)
		.limit(1);

	if (!project) {
		throw new ChatGptImportProjectAccessError(normalizedProjectId);
	}

	return normalizedProjectId;
}

async function importConversationBranches(
	userId: string,
	primaryConversationId: string,
	primaryTitle: string,
	primaryMessages: { role: string; content: string }[],
	branches: BranchInfo[],
	projectId: string | null,
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
			projectId,
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
	const projectId = await validateImportProjectId(userId, options.projectId);
	// Throws ChatGptImportAlreadyRunningError while the person's last import runs.
	const jobId = startImportRow(userId);

	try {
		return await importIntoRow(jobId, userId, zipBuffer, projectId, options);
	} catch (err) {
		// Whatever stopped the import, its row must not stay `processing`.
		try {
			failImportRow(
				jobId,
				`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
		} catch (settleErr) {
			console.error(
				"[CHATGPT_IMPORT] Could not mark the failed import's row:",
				settleErr,
			);
		}
		throw err;
	}
}

async function importIntoRow(
	jobId: string,
	userId: string,
	zipBuffer: Buffer,
	projectId: string | null,
	options: ImportOptions,
): Promise<ImportResult> {
	const conversationIds: string[] = [];
	const errors: { conversationTitle?: string; reason: string }[] = [];

	let parseResult: ParseResult;
	try {
		parseResult = await parseConversationsJson(zipBuffer);
	} catch (err) {
		console.error("[CHATGPT_IMPORT] Failed to parse ZIP:", err);
		failImportRow(
			jobId,
			`Parse error: ${err instanceof Error ? err.message : "Unknown error"}`,
		);
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

	for (let i = 0; i < totalConversations; i++) {
		// Before each conversation the row moves, which is how a running import
		// is told from a stopped one, and an import whose row was settled
		// meanwhile stops here, before it makes anything else.
		writeImportProgress(jobId, {
			totalConversations,
			processedConversations: i,
		});

		const conv = parseResult.conversations[i];
		try {
			const conversation = await createConversation(
				userId,
				conv.title || "Imported Conversation",
				{
					projectId,
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

				const branches: BranchInfo[] | undefined = conv.branches;
				if (branches && branches.length > 0) {
					await importConversationBranches(
						userId,
						conversation.id,
						conv.title,
						conv.messages,
						branches,
						projectId,
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

		options.onProgress?.(i + 1, totalConversations);
	}

	completeImportRow(jobId, {
		processedConversations: totalConversations,
		errors,
	});

	return { jobId, conversationIds, errors };
}
