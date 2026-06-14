import { generateText } from "ai";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { conversationSummaries } from "$lib/server/db/schema";
import {
	createOpenAICompatibleProviderForNormalChatModelRun,
	type NormalChatModelRunRuntimeConfig,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import {
	SUMMARIZER_MAX_RETRIES,
	SUMMARIZER_MAX_TOKENS,
	SUMMARIZER_TEMPERATURE,
} from "$lib/server/services/normal-chat-model-config";

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS_BEFORE_CHUNKING = 200_000;
const MAX_CHARS_BEFORE_CHUNKING = MAX_TOKENS_BEFORE_CHUNKING * CHARS_PER_TOKEN;
const CHUNK_CHARS = 150_000;
type SummaryOpenAICompatibleProvider = ReturnType<
	typeof createOpenAICompatibleProviderForNormalChatModelRun
>;
type SummaryLanguageModel = ReturnType<SummaryOpenAICompatibleProvider>;

export function estimateChars(
	messages: { role: string; content: string }[],
): number {
	let total = 0;
	for (const msg of messages) {
		total += msg.role.length + msg.content.length + 4;
	}
	return total;
}

export function estimateTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function chunkMessages(
	messages: { role: string; content: string }[],
): { role: string; content: string }[][] {
	const chunks: { role: string; content: string }[][] = [];
	let currentChunk: { role: string; content: string }[] = [];
	let currentChars = 0;

	for (const msg of messages) {
		const msgChars = msg.role.length + msg.content.length + 4;

		if (currentChars + msgChars > CHUNK_CHARS && currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentChars = 0;
		}

		currentChunk.push(msg);
		currentChars += msgChars;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}

export function formatMessagesForPrompt(
	messages: { role: string; content: string }[],
): string {
	return messages.map((msg) => `${msg.role}: ${msg.content}`).join("\n\n");
}

const SUMMARY_SYSTEM_PROMPT = [
	"You are a conversation summarizer.",
	"Summarize the following conversation, preserving key facts, decisions, conclusions, and the overall narrative.",
	"Be concise but thorough.",
	"Focus on what was discussed, any decisions made, knowledge shared, and the user's preferences or characteristics that emerge.",
].join(" ");

async function createSummaryModelProvider(): Promise<{
	provider: SummaryOpenAICompatibleProvider;
	modelName: string;
}> {
	const config = getConfig();
	const modelProvider = await resolveNormalChatModelRunProvider(
		"model1",
		config as unknown as NormalChatModelRunRuntimeConfig,
	);

	const openaiCompatible = createOpenAICompatibleProviderForNormalChatModelRun({
		provider: modelProvider,
		includeUsage: true,
		normalizeStreaming: false,
	});

	return {
		provider: openaiCompatible,
		modelName: modelProvider.modelName,
	};
}

/**
 * Summarize a conversation's messages using the local model.
 *
 * Conversations exceeding 200K estimated tokens are split into chunks,
 * summarized independently, and the chunk summaries are merged.
 */
export async function summarizeConversation(
	messages: { role: string; content: string }[],
	title: string,
): Promise<string> {
	if (messages.length === 0) {
		throw new Error("Cannot summarize empty conversation");
	}

	const { provider, modelName } = await createSummaryModelProvider();
	const model = provider(modelName);

	const totalChars = estimateChars(messages);
	const needsChunking = totalChars > MAX_CHARS_BEFORE_CHUNKING;

	if (needsChunking) {
		return summarizeWithChunking(messages, title, model);
	}

	return summarizeDirect(messages, title, model);
}

async function summarizeDirect(
	messages: { role: string; content: string }[],
	title: string,
	model: SummaryLanguageModel,
): Promise<string> {
	const formatted = formatMessagesForPrompt(messages);

	const result = await generateText({
		model,
		system: SUMMARY_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: `These are messages from a conversation titled "${title}":\n\n${formatted}`,
			},
		],
		temperature: SUMMARIZER_TEMPERATURE,
		maxOutputTokens: SUMMARIZER_MAX_TOKENS,
		maxRetries: SUMMARIZER_MAX_RETRIES,
	});

	return result.text.trim();
}

async function summarizeWithChunking(
	messages: { role: string; content: string }[],
	title: string,
	model: SummaryLanguageModel,
): Promise<string> {
	const chunks = chunkMessages(messages);

	const chunkSummaries: string[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const formatted = formatMessagesForPrompt(chunks[i]);
		const chunkLabel =
			chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : "";

		const result = await generateText({
			model,
			system: SUMMARY_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `These are messages from a conversation titled "${title}"${chunkLabel}:\n\n${formatted}`,
				},
			],
			temperature: SUMMARIZER_TEMPERATURE,
			maxOutputTokens: SUMMARIZER_MAX_TOKENS,
			maxRetries: SUMMARIZER_MAX_RETRIES,
		});

		chunkSummaries.push(result.text.trim());
	}

	if (chunkSummaries.length === 1) {
		return chunkSummaries[0];
	}

	return combineChunkSummaries(chunkSummaries, title, model);
}

const COMBINE_SYSTEM_PROMPT = [
	"You are a conversation summarizer.",
	"Combine these partial summaries into one cohesive, concise summary.",
	"Preserve all key facts, decisions, conclusions, and important details.",
	"Remove redundancy between parts.",
	"The result should read as a single flowing narrative.",
].join(" ");

async function combineChunkSummaries(
	chunkSummaries: string[],
	title: string,
	model: SummaryLanguageModel,
): Promise<string> {
	const combined = chunkSummaries
		.map((summary, i) => `Summary part ${i + 1}:\n${summary}`)
		.join("\n\n---\n\n");

	const result = await generateText({
		model,
		system: COMBINE_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: `Combine these summaries of the conversation "${title}" into one cohesive summary:\n\n${combined}`,
			},
		],
		temperature: SUMMARIZER_TEMPERATURE,
		maxOutputTokens: SUMMARIZER_MAX_TOKENS,
		maxRetries: SUMMARIZER_MAX_RETRIES,
	});

	return result.text.trim();
}

export async function storeConversationSummary(
	userId: string,
	conversationId: string,
	summary: string,
): Promise<void> {
	try {
		const now = new Date();
		await db
			.insert(conversationSummaries)
			.values({
				conversationId,
				userId,
				summary,
				source: "chatgpt-import",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [conversationSummaries.conversationId],
				set: {
					summary,
					source: "chatgpt-import",
					updatedAt: new Date(),
				},
			});
	} catch (err) {
		console.error(
			"[CHATGPT_IMPORT] Failed to store conversation summary:",
			err,
		);
		throw err;
	}
}

export async function syncSummaryToHoncho(
	userId: string,
	conversationId: string,
	summary: string,
	title: string,
): Promise<void> {
	try {
		const { mirrorMessage } = await import("$lib/server/services/honcho");

		const content = `[Conversation Summary: "${title}"]\n\n${summary}`;
		await mirrorMessage(userId, conversationId, "assistant", content);
	} catch (err) {
		console.error("[CHATGPT_IMPORT] Failed to sync summary to Honcho:", err);
	}
}

/**
 * Full summarization pipeline: summarize, store in DB, sync to Honcho.
 * Designed for fire-and-forget usage during import. All failures are logged,
 * never propagated.
 */
export async function summarizeAndStoreConversation(
	userId: string,
	conversationId: string,
	messages: { role: string; content: string }[],
	title: string,
): Promise<void> {
	try {
		const summary = await summarizeConversation(messages, title);
		await storeConversationSummary(userId, conversationId, summary);

		syncSummaryToHoncho(userId, conversationId, summary, title).catch((err) => {
			console.error(
				"[CHATGPT_IMPORT] Honcho sync failed for conversation",
				conversationId,
				err,
			);
		});
	} catch (err) {
		console.error(
			"[CHATGPT_IMPORT] Summarization failed for conversation",
			conversationId,
			err,
		);
	}
}
