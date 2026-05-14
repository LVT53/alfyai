import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { artifactLinks } from '$lib/server/db/schema';
import { getConversation } from '$lib/server/services/conversations';
import { createArtifactLink } from '$lib/server/services/knowledge';
import { listKnowledgeArtifacts } from '$lib/server/services/knowledge';
import type { KnowledgeDocumentItem, LinkedContextSource } from '$lib/types';

export class LinkedContextSourceError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string
	) {
		super(message);
		this.name = 'LinkedContextSourceError';
	}
}

function toLinkedContextSource(document: KnowledgeDocumentItem): LinkedContextSource {
	return {
		displayArtifactId: document.displayArtifactId,
		promptArtifactId: document.promptArtifactId,
		familyArtifactIds: document.familyArtifactIds,
		name: document.name,
		type: 'document',
		mimeType: document.mimeType,
		documentOrigin: document.documentOrigin,
	};
}

function documentMatchesSource(
	document: KnowledgeDocumentItem,
	source: LinkedContextSource
): boolean {
	const ids = new Set([
		document.displayArtifactId,
		document.promptArtifactId,
		...document.familyArtifactIds,
	].filter((id): id is string => typeof id === 'string' && id.length > 0));
	return ids.has(source.displayArtifactId) || Boolean(source.promptArtifactId && ids.has(source.promptArtifactId));
}

function overlapsAttachments(source: LinkedContextSource, attachmentIds: Set<string>): boolean {
	if (attachmentIds.size === 0) return false;
	const ids = [
		source.displayArtifactId,
		source.promptArtifactId,
		...source.familyArtifactIds,
	].filter((id): id is string => typeof id === 'string' && id.length > 0);
	return ids.some((id) => attachmentIds.has(id));
}

export async function resolveLinkedContextSourcesForConversation(params: {
	userId: string;
	conversationId: string;
	linkedSources: LinkedContextSource[];
	attachmentIds: string[];
}): Promise<LinkedContextSource[]> {
	const conversation = await getConversation(params.userId, params.conversationId);
	if (!conversation) {
		throw new LinkedContextSourceError(
			'Conversation not found',
			404,
			'conversation_not_found'
		);
	}

	if (params.linkedSources.length === 0) return [];

	const { documents } = await listKnowledgeArtifacts(params.userId);
	const attachments = new Set(params.attachmentIds);
	const byDisplayId = new Map<string, LinkedContextSource>();

	for (const source of params.linkedSources) {
		const document = documents.find((entry) => documentMatchesSource(entry, source));
		if (!document) {
			throw new LinkedContextSourceError(
				'Linked source is no longer available',
				404,
				'linked_source_not_found'
			);
		}
		const canonical = toLinkedContextSource(document);
		if (overlapsAttachments(canonical, attachments)) continue;
		byDisplayId.set(canonical.displayArtifactId, canonical);
	}

	return Array.from(byDisplayId.values());
}

export async function addConversationLinkedContextSources(params: {
	userId: string;
	conversationId: string;
	linkedSources: LinkedContextSource[];
	attachmentIds: string[];
}): Promise<LinkedContextSource[]> {
	const resolved = await resolveLinkedContextSourcesForConversation(params);
	if (resolved.length === 0) return [];

	const existingRows = await db
		.select({ artifactId: artifactLinks.artifactId })
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, params.userId),
				eq(artifactLinks.conversationId, params.conversationId),
				eq(artifactLinks.linkType, 'linked_context_source'),
				isNull(artifactLinks.messageId)
			)
		);
	const existing = new Set(existingRows.map((row) => row.artifactId));

	for (const source of resolved) {
		if (existing.has(source.displayArtifactId)) continue;
		await createArtifactLink({
			userId: params.userId,
			artifactId: source.displayArtifactId,
			relatedArtifactId: source.promptArtifactId,
			conversationId: params.conversationId,
			linkType: 'linked_context_source',
		});
	}

	return resolved;
}

export function isLinkedContextSourceError(
	error: unknown
): error is LinkedContextSourceError {
	return error instanceof LinkedContextSourceError;
}
