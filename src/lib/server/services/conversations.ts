import { db } from '$lib/server/db';
import { conversations, messages, projects } from '$lib/server/db/schema';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { Conversation, ConversationListItem } from '$lib/types';
import { isHonchoEnabled, getOrCreateSession } from './honcho';
import { recordConversationAnalytics } from './analytics';
import { convergeProjectFolderContinuityForConversation } from './task-state/continuity';
import { getConversationForkSummaries } from './conversation-forks';

type CreateConversationOptions = {
	projectId?: string | null;
};

export async function createConversation(
	userId: string,
	title?: string,
	options: CreateConversationOptions = {}
): Promise<Conversation> {
	const id = randomUUID();
	const projectId = options.projectId ?? null;
	const [conversation] = await db
		.insert(conversations)
		.values({
			id,
			userId,
			title: title ?? 'New Conversation',
			projectId,
		})
		.returning();
	if (projectId) {
		await convergeProjectFolderContinuityForConversation({
			userId,
			conversationId: conversation.id,
			projectId,
			previousProjectId: null,
		});
	}
	// Pre-create Honcho session for this conversation
	if (isHonchoEnabled()) {
		getOrCreateSession(userId, id).catch((err) =>
			console.error('[HONCHO] Create session failed:', err)
		);
	}
	recordConversationAnalytics({
		conversationId: conversation.id,
		userId,
		title: conversation.title,
		createdAt: conversation.createdAt,
	}).catch(() => undefined);

	return {
		id: conversation.id,
		title: conversation.title,
		projectId: conversation.projectId ?? null,
		createdAt: conversation.createdAt.getTime() / 1000,
		updatedAt: conversation.updatedAt.getTime() / 1000,
	};
}

export async function listConversations(userId: string): Promise<ConversationListItem[]> {
	const result = await db
		.select()
		.from(conversations)
		.where(eq(conversations.userId, userId))
		.orderBy(desc(conversations.updatedAt));

	if (result.length === 0) {
		return [];
	}

	const conversationIdsWithMessages = await db
		.selectDistinct({ conversationId: messages.conversationId })
		.from(messages)
		.where(inArray(messages.conversationId, result.map((conversation) => conversation.id)));

	const visibleConversationIds = new Set(
		conversationIdsWithMessages.map((row) => row.conversationId)
	);

	const visibleConversations = result
		.filter((conv) => visibleConversationIds.has(conv.id))
		.map(conv => ({
		id: conv.id,
		title: conv.title,
		projectId: conv.projectId ?? null,
		createdAt: conv.createdAt.getTime() / 1000,
		updatedAt: conv.updatedAt.getTime() / 1000,
	}));
	const forkSummaries = await getConversationForkSummaries(
		userId,
		visibleConversations.map((conversation) => conversation.id),
	);

	return visibleConversations.map((conversation) => {
		const forkSummary = forkSummaries.get(conversation.id);
		return forkSummary ? { ...conversation, forkSummary } : conversation;
	});
}

export async function getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
	if (!conversation) {
		return null;
	}
	return {
		id: conversation.id,
		title: conversation.title,
		projectId: conversation.projectId ?? null,
		createdAt: conversation.createdAt.getTime() / 1000,
		updatedAt: conversation.updatedAt.getTime() / 1000,
	};
}

export async function getConversationUserId(conversationId: string): Promise<string | null> {
	const [conversation] = await db
		.select({ userId: conversations.userId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	return conversation?.userId ?? null;
}

export async function updateConversationTitle(userId: string, conversationId: string, title: string): Promise<Conversation | null> {
	const [conversation] = await db
		.update(conversations)
		.set({ title, updatedAt: new Date() })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning();
	if (!conversation) {
		return null;
	}
	return {
		id: conversation.id,
		title: conversation.title,
		projectId: conversation.projectId ?? null,
		createdAt: conversation.createdAt.getTime() / 1000,
		updatedAt: conversation.updatedAt.getTime() / 1000,
	};
}

export async function deleteConversation(userId: string, conversationId: string): Promise<boolean> {
	const result = await db
		.delete(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning();
	return result.length > 0;
}

export async function touchConversation(userId: string, conversationId: string): Promise<Conversation | null> {
	const [conversation] = await db
		.update(conversations)
		.set({ updatedAt: new Date() })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning();
	if (!conversation) {
		return null;
	}
	return {
		id: conversation.id,
		title: conversation.title,
		projectId: conversation.projectId ?? null,
		createdAt: conversation.createdAt.getTime() / 1000,
		updatedAt: conversation.updatedAt.getTime() / 1000,
	};
}

export async function moveConversationToProject(
	userId: string,
	conversationId: string,
	projectId: string | null
): Promise<Conversation | null> {
	const [existingConversation] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.limit(1);
	if (!existingConversation) return null;

	if (projectId !== null) {
		const [project] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
			.limit(1);
		if (!project) return null;
	}

	const [conversation] = await db
		.update(conversations)
		.set({ projectId, updatedAt: new Date() })
		.where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
		.returning();
	if (!conversation) return null;
	await convergeProjectFolderContinuityForConversation({
		userId,
		conversationId,
		projectId,
		previousProjectId: existingConversation.projectId ?? null,
	});
	return {
		id: conversation.id,
		title: conversation.title,
		projectId: conversation.projectId ?? null,
		createdAt: conversation.createdAt.getTime() / 1000,
		updatedAt: conversation.updatedAt.getTime() / 1000,
	};
}
