import { randomUUID } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { artifactLinks, artifacts, conversations, messages } from '$lib/server/db/schema';
import type { Artifact, WorkCapsule } from '$lib/types';
import { parseJsonRecord } from '$lib/server/utils/json';
import {
	classifyGeneratedOutputArtifact,
} from '../evidence-family';
import {
	deriveConversationArtifactBaseName,
	isPlaceholderConversationTitle,
} from '../knowledge-labels';
import { messageOrderDesc } from '../message-ordering';
import { repairConversationMessageSequences } from '../message-sequences';
import { syncArtifactChunks } from '../task-state';
import {
	createArtifact,
	createArtifactLink,
	findRelevantArtifactsByTypes,
	guessSummary,
	listConversationSourceArtifactIds,
	mapArtifact,
	mapArtifactSummary,
	safeStem,
} from './store';

type WorkCapsuleMetadata = {
	taskSummary: string | null;
	workflowSummary: string | null;
	keyConclusions: string[];
	reusablePatterns: string[];
	sourceArtifactCount: number;
	outputArtifactCount: number;
};

type WorkCapsuleArtifactRow = Pick<
	typeof artifacts.$inferSelect,
	| 'id'
	| 'userId'
	| 'type'
	| 'retrievalClass'
	| 'name'
	| 'mimeType'
	| 'sizeBytes'
	| 'conversationId'
	| 'summary'
	| 'metadataJson'
	| 'createdAt'
	| 'updatedAt'
>;

function parseWorkCapsuleMetadata(metadata: Record<string, unknown> | null): WorkCapsuleMetadata {
	const legacySourceArtifactIds = Array.isArray(metadata?.sourceArtifactIds)
		? metadata.sourceArtifactIds.filter((item): item is string => typeof item === 'string')
		: [];
	const legacyOutputArtifactIds = Array.isArray(metadata?.outputArtifactIds)
		? metadata.outputArtifactIds.filter((item): item is string => typeof item === 'string')
		: [];

	return {
		taskSummary: typeof metadata?.taskSummary === 'string' ? metadata.taskSummary : null,
		workflowSummary: typeof metadata?.workflowSummary === 'string' ? metadata.workflowSummary : null,
		keyConclusions: Array.isArray(metadata?.keyConclusions)
			? metadata.keyConclusions.filter((item): item is string => typeof item === 'string')
			: [],
		reusablePatterns: Array.isArray(metadata?.reusablePatterns)
			? metadata.reusablePatterns.filter((item): item is string => typeof item === 'string')
			: [],
		sourceArtifactCount:
			typeof metadata?.sourceArtifactCount === 'number' && Number.isFinite(metadata.sourceArtifactCount)
				? Math.max(0, Math.trunc(metadata.sourceArtifactCount))
				: legacySourceArtifactIds.length,
		outputArtifactCount:
			typeof metadata?.outputArtifactCount === 'number' && Number.isFinite(metadata.outputArtifactCount)
				? Math.max(0, Math.trunc(metadata.outputArtifactCount))
				: legacyOutputArtifactIds.length,
	};
}

export function mapWorkCapsuleFromArtifactRow(row: WorkCapsuleArtifactRow): WorkCapsule {
	const metadata = parseWorkCapsuleMetadata(parseJsonRecord(row.metadataJson ?? null));
	return {
		artifact: mapArtifactSummary(row),
		conversationId: row.conversationId ?? null,
		...metadata,
	};
}

function mapWorkCapsuleFromArtifact(artifact: Artifact): WorkCapsule {
	const metadata = parseWorkCapsuleMetadata(artifact.metadata ?? null);
	return {
		artifact: {
			id: artifact.id,
			type: artifact.type,
			retrievalClass: artifact.retrievalClass,
			name: artifact.name,
			mimeType: artifact.mimeType,
			sizeBytes: artifact.sizeBytes,
			conversationId: artifact.conversationId,
			summary: artifact.summary,
			createdAt: artifact.createdAt,
			updatedAt: artifact.updatedAt,
		},
		conversationId: artifact.conversationId ?? null,
		...metadata,
	};
}

export async function createGeneratedOutputArtifact(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	content: string;
	sourceArtifactIds: string[];
	nameOverride?: string;
	metadata?: Record<string, unknown> | null;
}): Promise<Artifact | null> {
	const trimmed = params.content.trim();
	if (!trimmed) return null;

	repairConversationMessageSequences(params.conversationId);

	const [conversationTitle, latestUserMessage] = await Promise.all([
		db
			.select({ title: conversations.title })
			.from(conversations)
			.where(and(eq(conversations.id, params.conversationId), eq(conversations.userId, params.userId))),
		db
			.select({ content: messages.content })
			.from(messages)
			.where(and(eq(messages.conversationId, params.conversationId), eq(messages.role, 'user')))
			.orderBy(...messageOrderDesc())
			.limit(1),
	]);
	const artifactBaseName = deriveConversationArtifactBaseName({
		conversationTitle: conversationTitle[0]?.title,
		fallbackText: latestUserMessage[0]?.content,
		defaultLabel: 'Conversation',
	});

	const artifact = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		type: 'generated_output',
		name: params.nameOverride?.trim() || `${artifactBaseName} result`,
		mimeType: 'text/markdown',
		extension: 'md',
		sizeBytes: Buffer.byteLength(trimmed, 'utf8'),
		contentText: trimmed,
		summary: guessSummary(trimmed, trimmed),
		metadata: {
			messageId: params.messageId,
			...(params.metadata ?? {}),
		},
	});

	for (const sourceArtifactId of params.sourceArtifactIds) {
		await createArtifactLink({
			userId: params.userId,
			artifactId: artifact.id,
			relatedArtifactId: sourceArtifactId,
			conversationId: params.conversationId,
			messageId: params.messageId,
			linkType: 'used_in_output',
		});
	}

	const retrievalClass = await classifyGeneratedOutputArtifact({
		userId: params.userId,
		artifact,
	});
	if (retrievalClass !== artifact.retrievalClass) {
		const [updated] = await db
			.update(artifacts)
			.set({
				retrievalClass,
				updatedAt: new Date(),
			})
			.where(eq(artifacts.id, artifact.id))
			.returning();
		return updated ? mapArtifact(updated) : { ...artifact, retrievalClass };
	}

	return artifact;
}

export async function upsertWorkCapsule(params: {
	userId: string;
	conversationId: string;
}): Promise<WorkCapsule | null> {
	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, params.conversationId), eq(conversations.userId, params.userId)));

	if (!conversation) return null;

	repairConversationMessageSequences(params.conversationId);

	const recentMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, params.conversationId))
		.orderBy(...messageOrderDesc())
		.limit(8);

	const sourceArtifactIds = await listConversationSourceArtifactIds(params.userId, params.conversationId);
	const outputArtifacts = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.conversationId),
				eq(artifacts.type, 'generated_output')
			)
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(6);

	const taskSummary = recentMessages
		.filter((message) => message.role === 'user')
		.slice(0, 2)
		.map((message) => message.content.trim())
		.filter(Boolean)
		.join(' ');
	const conversationBaseName = deriveConversationArtifactBaseName({
		conversationTitle: conversation.title,
		fallbackText: taskSummary,
		defaultLabel: 'Conversation',
	});
	const meaningfulConversationTitle = isPlaceholderConversationTitle(conversation.title)
		? null
		: conversation.title.trim();
	const workflowSummary = [
		sourceArtifactIds.length > 0 ? `Used ${sourceArtifactIds.length} source document(s).` : null,
		outputArtifacts.length > 0 ? `Produced ${outputArtifacts.length} saved result(s).` : null,
	].filter(Boolean).join(' ');
	const keyConclusions = [
		meaningfulConversationTitle ? `Project theme: ${meaningfulConversationTitle}` : null,
		sourceArtifactIds.length > 0 ? 'The workflow depends on attached source documents.' : null,
		outputArtifacts.length > 0 ? 'The conversation produced reusable written outputs.' : null,
	].filter((item): item is string => Boolean(item));
	const reusablePatterns = [
		sourceArtifactIds.length > 0 ? 'Start from the existing source set and update with fresh material.' : null,
		outputArtifacts.length > 0 ? 'Reuse prior output structure as a template before rewriting details.' : null,
	].filter((item): item is string => Boolean(item));

	const metadata = {
		taskSummary: taskSummary || meaningfulConversationTitle || conversationBaseName,
		workflowSummary: workflowSummary || 'Conversation generated reusable knowledge.',
		keyConclusions,
		reusablePatterns,
		sourceArtifactCount: sourceArtifactIds.length,
		outputArtifactCount: outputArtifacts.length,
	};
	const contentText = [
		`Task: ${metadata.taskSummary}`,
		`Workflow: ${metadata.workflowSummary}`,
		keyConclusions.length > 0 ? `Key conclusions: ${keyConclusions.join(' ')}` : null,
		reusablePatterns.length > 0 ? `Reusable patterns: ${reusablePatterns.join(' ')}` : null,
	].filter(Boolean).join('\n');

	const existing = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.conversationId),
				eq(artifacts.type, 'work_capsule')
			)
		)
		.limit(1);

	let row: typeof artifacts.$inferSelect;
	if (existing[0]) {
		const updated = await db
			.update(artifacts)
			.set({
				name: `${safeStem(conversationBaseName)} workflow capsule`,
				contentText,
				summary: guessSummary(contentText, conversationBaseName),
				metadataJson: JSON.stringify(metadata),
				updatedAt: new Date(),
			})
			.where(eq(artifacts.id, existing[0].id))
			.returning();
		row = updated[0];
		await syncArtifactChunks({
			artifactId: row.id,
			userId: row.userId,
			conversationId: row.conversationId ?? null,
			contentText: row.contentText ?? null,
		});
	} else {
		row = (
			await db
				.insert(artifacts)
				.values({
					id: randomUUID(),
					userId: params.userId,
					conversationId: params.conversationId,
					type: 'work_capsule',
					name: `${safeStem(conversationBaseName)} workflow capsule`,
					mimeType: 'text/plain',
					extension: 'txt',
					contentText,
					summary: guessSummary(contentText, conversationBaseName),
					metadataJson: JSON.stringify(metadata),
					updatedAt: new Date(),
				})
				.returning()
		)[0];
	}

	for (const sourceArtifactId of sourceArtifactIds) {
		await createArtifactLink({
			userId: params.userId,
			artifactId: row.id,
			relatedArtifactId: sourceArtifactId,
			conversationId: params.conversationId,
			linkType: 'captured_by_capsule',
		});
	}
	for (const outputArtifact of outputArtifacts) {
		await createArtifactLink({
			userId: params.userId,
			artifactId: row.id,
			relatedArtifactId: outputArtifact.id,
			conversationId: params.conversationId,
			linkType: 'captured_by_capsule',
		});
	}

	return mapWorkCapsuleFromArtifactRow(row);
}

export async function getConversationWorkCapsule(
	userId: string,
	conversationId: string
): Promise<WorkCapsule | null> {
	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.type, 'work_capsule')
			)
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(1);
	return row ? mapWorkCapsuleFromArtifactRow(row) : null;
}

export async function findRelevantWorkCapsules(
	userId: string,
	query: string,
	excludeConversationId?: string,
	limit = 3
): Promise<WorkCapsule[]> {
	const artifactsFound = await findRelevantArtifactsByTypes({
		userId,
		query,
		types: ['work_capsule'],
		limit,
		excludeConversationId,
	});
	return artifactsFound.map(mapWorkCapsuleFromArtifact);
}
