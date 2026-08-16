import { and, eq, isNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactLinks } from "$lib/server/db/schema";
import { getConversation } from "$lib/server/services/conversations";
import {
	createArtifactLink,
	listKnowledgeArtifacts,
} from "$lib/server/services/knowledge";
import {
	isPromptReadyWorkingDocument,
	linkedContextSourceArtifactIds,
	toCanonicalLinkedContextSource,
	workingDocumentMatchesLinkedContextSource,
} from "$lib/server/services/knowledge/store/working-document-identity";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";

export class LinkedContextSourceError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string,
	) {
		super(message);
		this.name = "LinkedContextSourceError";
	}
}

function toLinkedContextSource(
	document: KnowledgeDocumentItem,
): LinkedContextSource {
	return toCanonicalLinkedContextSource(document);
}

function isPromptReadyDocument(document: KnowledgeDocumentItem): boolean {
	return isPromptReadyWorkingDocument(document);
}

function documentMatchesSource(
	document: KnowledgeDocumentItem,
	source: LinkedContextSource,
): boolean {
	return workingDocumentMatchesLinkedContextSource(document, source);
}

function overlapsAttachments(
	source: LinkedContextSource,
	attachmentIds: Set<string>,
): boolean {
	if (attachmentIds.size === 0) return false;
	return linkedContextSourceArtifactIds(source).some((id) =>
		attachmentIds.has(id),
	);
}

export async function resolveLinkedContextSourcesForConversation(params: {
	userId: string;
	conversationId: string;
	linkedSources: LinkedContextSource[];
	attachmentIds: string[];
}): Promise<LinkedContextSource[]> {
	const conversation = await getConversation(
		params.userId,
		params.conversationId,
	);
	if (!conversation) {
		throw new LinkedContextSourceError(
			"Conversation not found",
			404,
			"conversation_not_found",
		);
	}

	if (params.linkedSources.length === 0) return [];

	const { documents } = await listKnowledgeArtifacts(params.userId);
	const attachments = new Set(params.attachmentIds);
	const byDisplayId = new Map<string, LinkedContextSource>();

	for (const source of params.linkedSources) {
		const document = documents.find((entry) =>
			documentMatchesSource(entry, source),
		);
		if (!document) {
			throw new LinkedContextSourceError(
				"Linked source is no longer available",
				404,
				"linked_source_not_found",
			);
		}
		if (!isPromptReadyDocument(document)) {
			throw new LinkedContextSourceError(
				"Linked source is not ready for prompt context",
				409,
				"linked_source_not_prompt_ready",
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
				eq(artifactLinks.linkType, "linked_context_source"),
				isNull(artifactLinks.messageId),
			),
		);
	const existing = new Set(existingRows.map((row) => row.artifactId));

	for (const source of resolved) {
		if (existing.has(source.displayArtifactId)) continue;
		await createArtifactLink({
			userId: params.userId,
			artifactId: source.displayArtifactId,
			relatedArtifactId: source.promptArtifactId,
			conversationId: params.conversationId,
			linkType: "linked_context_source",
		});
	}

	return resolved;
}

export async function listConversationLinkedContextSources(params: {
	userId: string;
	conversationId: string;
}): Promise<LinkedContextSource[]> {
	const rows = await db
		.select({
			artifactId: artifactLinks.artifactId,
			relatedArtifactId: artifactLinks.relatedArtifactId,
		})
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, params.userId),
				eq(artifactLinks.conversationId, params.conversationId),
				eq(artifactLinks.linkType, "linked_context_source"),
				isNull(artifactLinks.messageId),
			),
		);
	if (rows.length === 0) return [];

	const { documents } = await listKnowledgeArtifacts(params.userId);
	const byDisplayId = new Map<string, LinkedContextSource>();

	for (const row of rows) {
		const sourceProbe: LinkedContextSource = {
			displayArtifactId: row.artifactId,
			promptArtifactId: row.relatedArtifactId,
			familyArtifactIds: [row.artifactId, row.relatedArtifactId].filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			),
			name: "",
			type: "document",
		};
		const document = documents.find((entry) =>
			documentMatchesSource(entry, sourceProbe),
		);
		if (!document || !isPromptReadyDocument(document)) continue;
		byDisplayId.set(
			document.displayArtifactId,
			toLinkedContextSource(document),
		);
	}

	return Array.from(byDisplayId.values());
}

export function isLinkedContextSourceError(
	error: unknown,
): error is LinkedContextSourceError {
	return error instanceof LinkedContextSourceError;
}

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); this type carries no behavior change, only
// a new home next to the linked-context-sources service that owns it.
export interface LinkedContextSource {
	displayArtifactId: string;
	promptArtifactId: string | null;
	familyArtifactIds: string[];
	name: string;
	type: "document";
	mimeType?: string | null;
	documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
}
