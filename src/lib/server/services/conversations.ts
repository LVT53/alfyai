import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	atlasJobs,
	conversations,
	messages,
	projects,
} from "$lib/server/db/schema";
import type { Conversation, ConversationListItem } from "$lib/types";
import { recordConversationAnalytics } from "./analytics";
import { getConversationForkSummaries } from "./conversation-forks";
import { convergeProjectFolderContinuityForConversation } from "./task-state/continuity";

type CreateConversationOptions = {
	projectId?: string | null;
};

function toConversation(row: typeof conversations.$inferSelect): Conversation {
	return {
		id: row.id,
		title: row.title,
		projectId: row.projectId ?? null,
		status: row.status as Conversation["status"],
		sealedAt: row.sealedAt ? row.sealedAt.getTime() / 1000 : null,
		sidebarPinned: row.sidebarPinned,
		sidebarSortOrder: row.sidebarSortOrder ?? null,
		memoryIncognito: row.memoryIncognito,
		createdAt: row.createdAt.getTime() / 1000,
		updatedAt: row.updatedAt.getTime() / 1000,
	};
}

function sortConversationList(
	items: ConversationListItem[],
): ConversationListItem[] {
	return items.sort((a, b) => {
		if (a.sidebarPinned !== b.sidebarPinned) {
			return a.sidebarPinned ? -1 : 1;
		}
		if (a.sidebarPinned) {
			return (
				(a.sidebarSortOrder ?? Number.MAX_SAFE_INTEGER) -
					(b.sidebarSortOrder ?? Number.MAX_SAFE_INTEGER) ||
				b.updatedAt - a.updatedAt
			);
		}
		return b.updatedAt - a.updatedAt;
	});
}

export async function createConversation(
	userId: string,
	title?: string,
	options: CreateConversationOptions = {},
): Promise<Conversation> {
	const id = randomUUID();
	const projectId = options.projectId ?? null;
	const [conversation] = await db
		.insert(conversations)
		.values({
			id,
			userId,
			title: title ?? "New Conversation",
			projectId,
		})
		.returning();
	// Opportunistically flush any pending idle judge runs for this user now that
	// they have started a new conversation (prior conversation is likely idle).
	void import("$lib/server/services/memory-judge/runner")
		.then(({ flushPendingJudgeRuns }) => flushPendingJudgeRuns(userId))
		.catch(() => {});
	if (projectId) {
		await convergeProjectFolderContinuityForConversation({
			userId,
			conversationId: conversation.id,
			projectId,
			previousProjectId: null,
		});
	}
	recordConversationAnalytics({
		conversationId: conversation.id,
		userId,
		title: conversation.title,
		createdAt: conversation.createdAt,
	}).catch(() => undefined);

	return toConversation(conversation);
}

export async function listConversations(
	userId: string,
): Promise<ConversationListItem[]> {
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
		.where(
			inArray(
				messages.conversationId,
				result.map((conversation) => conversation.id),
			),
		);

	const visibleConversationIds = new Set(
		conversationIdsWithMessages.map((row) => row.conversationId),
	);

	const visibleConversations = sortConversationList(
		result
			.filter((conv) => visibleConversationIds.has(conv.id))
			.map((conv) => toConversation(conv)),
	);
	const forkSummaries = await getConversationForkSummaries(
		userId,
		visibleConversations.map((conversation) => conversation.id),
	);
	const completedAtlasRows = await db
		.select({
			id: atlasJobs.id,
			conversationId: atlasJobs.conversationId,
			title: atlasJobs.title,
			completedAt: atlasJobs.completedAt,
			updatedAt: atlasJobs.updatedAt,
		})
		.from(atlasJobs)
		.where(
			and(
				eq(atlasJobs.userId, userId),
				eq(atlasJobs.status, "succeeded"),
				inArray(
					atlasJobs.conversationId,
					visibleConversations.map((conversation) => conversation.id),
				),
			),
		)
		.orderBy(desc(atlasJobs.updatedAt));
	const atlasBadgeByConversation = new Map<
		string,
		ConversationListItem["atlasBadge"]
	>();
	for (const row of completedAtlasRows) {
		if (!atlasBadgeByConversation.has(row.conversationId)) {
			atlasBadgeByConversation.set(row.conversationId, {
				jobId: row.id,
				status: "succeeded",
				label: row.title,
				completedAt: row.completedAt ? row.completedAt.getTime() / 1000 : null,
				updatedAt: row.updatedAt.getTime() / 1000,
			});
		}
	}

	return visibleConversations.map((conversation) => {
		const forkSummary = forkSummaries.get(conversation.id);
		const atlasBadge = atlasBadgeByConversation.get(conversation.id) ?? null;
		return {
			...conversation,
			...(forkSummary ? { forkSummary } : {}),
			...(atlasBadge ? { atlasBadge } : {}),
		};
	});
}

export async function getConversation(
	userId: string,
	conversationId: string,
): Promise<Conversation | null> {
	const [conversation] = await db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		);
	if (!conversation) {
		return null;
	}
	return toConversation(conversation);
}

export async function getConversationUserId(
	conversationId: string,
): Promise<string | null> {
	const [conversation] = await db
		.select({ userId: conversations.userId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);

	return conversation?.userId ?? null;
}

export async function updateConversationTitle(
	userId: string,
	conversationId: string,
	title: string,
): Promise<Conversation | null> {
	const [conversation] = await db
		.update(conversations)
		.set({ title, updatedAt: new Date() })
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	if (!conversation) {
		return null;
	}
	return toConversation(conversation);
}

export async function deleteConversation(
	userId: string,
	conversationId: string,
): Promise<boolean> {
	const result = await db
		.delete(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	return result.length > 0;
}

export async function touchConversation(
	userId: string,
	conversationId: string,
): Promise<Conversation | null> {
	const [conversation] = await db
		.update(conversations)
		.set({ updatedAt: new Date() })
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	if (!conversation) {
		return null;
	}
	return toConversation(conversation);
}

export async function setConversationSidebarPinned(
	userId: string,
	conversationId: string,
	sidebarPinned: boolean,
): Promise<Conversation | null> {
	if (!sidebarPinned) {
		const [conversation] = await db
			.update(conversations)
			.set({ sidebarPinned: false, sidebarSortOrder: null })
			.where(
				and(
					eq(conversations.id, conversationId),
					eq(conversations.userId, userId),
				),
			)
			.returning();
		return conversation ? toConversation(conversation) : null;
	}

	const [currentTop] = await db
		.select({ sidebarSortOrder: conversations.sidebarSortOrder })
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, userId),
				eq(conversations.sidebarPinned, true),
			),
		)
		.orderBy(asc(conversations.sidebarSortOrder))
		.limit(1);
	const nextSortOrder = (currentTop?.sidebarSortOrder ?? 1) - 1;
	const [conversation] = await db
		.update(conversations)
		.set({ sidebarPinned: true, sidebarSortOrder: nextSortOrder })
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	return conversation ? toConversation(conversation) : null;
}

export async function setConversationMemoryIncognito(
	userId: string,
	conversationId: string,
	memoryIncognito: boolean,
): Promise<Conversation | null> {
	const [conversation] = await db
		.update(conversations)
		.set({ memoryIncognito })
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	return conversation ? toConversation(conversation) : null;
}

export async function savePinnedConversationSidebarOrder(
	userId: string,
	orderedIds: string[],
): Promise<void> {
	if (orderedIds.length === 0) return;
	if (new Set(orderedIds).size !== orderedIds.length) {
		throw new Error("orderedIds must not contain duplicates");
	}

	const rows = await db
		.select({
			id: conversations.id,
			sidebarPinned: conversations.sidebarPinned,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, userId),
				inArray(conversations.id, orderedIds),
			),
		);

	if (
		rows.length !== orderedIds.length ||
		rows.some((row) => !row.sidebarPinned)
	) {
		throw new Error("orderedIds must contain only owned pinned conversations");
	}

	db.transaction((tx) => {
		for (const [index, conversationId] of orderedIds.entries()) {
			tx.update(conversations)
				.set({ sidebarSortOrder: index })
				.where(
					and(
						eq(conversations.id, conversationId),
						eq(conversations.userId, userId),
						eq(conversations.sidebarPinned, true),
					),
				)
				.run();
		}
	});
}

export async function moveConversationToProject(
	userId: string,
	conversationId: string,
	projectId: string | null,
): Promise<Conversation | null> {
	const [existingConversation] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
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
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.returning();
	if (!conversation) return null;
	await convergeProjectFolderContinuityForConversation({
		userId,
		conversationId,
		projectId,
		previousProjectId: existingConversation.projectId ?? null,
	});
	return toConversation(conversation);
}
