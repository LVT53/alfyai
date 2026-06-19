import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactLinks, artifacts, messages } from "$lib/server/db/schema";
import { selectWorkingSetArtifactsForPrompt } from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/types";
import type { AtlasLifecycleSeed } from "./types";

export type AtlasLocalSourceAuthority =
	| "explicit"
	| "working_document"
	| "auto";

export interface AtlasLocalSource {
	id: string;
	title: string;
	authority: AtlasLocalSourceAuthority;
	text: string;
}

export interface ResolveAtlasSourcesInput {
	explicitSources?: AtlasLocalSource[];
	autoSources?: AtlasLocalSource[];
}

export interface ResolveAtlasSourcesResult {
	localSources: AtlasLocalSource[];
}

export async function resolveAtlasSources(
	input: ResolveAtlasSourcesInput = {},
): Promise<ResolveAtlasSourcesResult> {
	const explicit = input.explicitSources ?? [];
	for (const source of explicit) {
		if (!source.text.trim()) {
			throw new Error(`Atlas explicit source is not readable: ${source.title}`);
		}
	}
	return {
		localSources: [...explicit, ...(input.autoSources ?? [])],
	};
}

export interface ResolveAtlasSourcesForJobInput {
	userId: string;
	conversationId: string;
	assistantMessageId: string | null;
	lifecycleSeed?: AtlasLifecycleSeed | null;
}

export async function resolveAtlasSourcesForJob(
	input: ResolveAtlasSourcesForJobInput,
): Promise<ResolveAtlasSourcesResult> {
	const userMessage = await findUserMessageForAtlasAssistant(input);
	const explicitSources = userMessage
		? await listExplicitArtifactSources({
				userId: input.userId,
				conversationId: input.conversationId,
				userMessageId: userMessage.id,
			})
		: [];
	const explicitSourceIds = new Set(explicitSources.map((source) => source.id));
	const workingDocumentSources = userMessage
		? await listAutoWorkingDocumentSources({
				userId: input.userId,
				conversationId: input.conversationId,
				query: userMessage.content,
				excludeArtifactIds: Array.from(explicitSourceIds),
			})
		: [];
	return resolveAtlasSources({
		explicitSources,
		autoSources: [
			...workingDocumentSources,
			...extractSeededLocalSources(input.lifecycleSeed),
		],
	});
}

function extractSeededLocalSources(
	seed: AtlasLifecycleSeed | null | undefined,
): AtlasLocalSource[] {
	const pool = seed?.curatedSourcePool;
	if (!pool || typeof pool !== "object") return [];
	const local = "local" in pool ? (pool as { local?: unknown }).local : null;
	if (!Array.isArray(local)) return [];
	return local
		.map((source): AtlasLocalSource | null => {
			if (!source || typeof source !== "object") return null;
			const record = source as Record<string, unknown>;
			const id =
				typeof record.id === "string"
					? `parent:${seed.parentAtlasJobId}:${record.id}`
					: null;
			const title = typeof record.title === "string" ? record.title : null;
			const text = typeof record.text === "string" ? record.text.trim() : "";
			if (!id || !title || !text) return null;
			return {
				id,
				title,
				authority: "auto",
				text,
			};
		})
		.filter((source): source is AtlasLocalSource => source !== null);
}

async function findUserMessageForAtlasAssistant(input: {
	conversationId: string;
	assistantMessageId: string | null;
}): Promise<typeof messages.$inferSelect | null> {
	if (!input.assistantMessageId) return null;
	const [assistantMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, input.assistantMessageId))
		.limit(1);
	if (!assistantMessage) return null;
	const sequence = assistantMessage.messageSequence;
	const [userMessage] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, input.conversationId),
				eq(messages.role, "user"),
				sequence === null
					? sql`${messages.createdAt} <= ${assistantMessage.createdAt}`
					: lt(messages.messageSequence, sequence),
			),
		)
		.orderBy(desc(messages.messageSequence), desc(messages.createdAt))
		.limit(1);
	return userMessage ?? null;
}

async function listExplicitArtifactSources(input: {
	userId: string;
	conversationId: string;
	userMessageId: string;
}): Promise<AtlasLocalSource[]> {
	const messageLinks = await db
		.select({ artifactId: artifactLinks.artifactId })
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, input.userId),
				eq(artifactLinks.conversationId, input.conversationId),
				eq(artifactLinks.messageId, input.userMessageId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
			),
		);
	const conversationLinks = await db
		.select({
			artifactId: artifactLinks.artifactId,
			relatedArtifactId: artifactLinks.relatedArtifactId,
		})
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, input.userId),
				eq(artifactLinks.conversationId, input.conversationId),
				eq(artifactLinks.linkType, "linked_context_source"),
				eq(artifactLinks.messageId, input.userMessageId),
			),
		);
	const artifactIds = Array.from(
		new Set([
			...messageLinks.map((row) => row.artifactId),
			...conversationLinks.flatMap((row) =>
				[row.artifactId, row.relatedArtifactId].filter(
					(value): value is string => Boolean(value),
				),
			),
		]),
	);
	if (artifactIds.length === 0) return [];
	const rows = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, input.userId),
				inArray(artifacts.id, artifactIds),
				or(
					eq(artifacts.retrievalClass, "durable"),
					eq(artifacts.retrievalClass, "prompt"),
				),
			),
		);
	return rows
		.map((artifact): AtlasLocalSource | null => {
			const text = (artifact.contentText ?? artifact.summary ?? "").trim();
			if (!text) return null;
			return {
				id: artifact.id,
				title: artifact.name,
				authority: "explicit",
				text,
			};
		})
		.filter((source): source is AtlasLocalSource => source !== null);
}

async function listAutoWorkingDocumentSources(input: {
	userId: string;
	conversationId: string;
	query: string;
	excludeArtifactIds: string[];
}): Promise<AtlasLocalSource[]> {
	const artifacts = await selectWorkingSetArtifactsForPrompt(
		input.userId,
		input.conversationId,
		input.query,
		input.excludeArtifactIds,
	);
	return artifacts
		.map((artifact) =>
			mapArtifactToAtlasLocalSource(artifact, "working_document"),
		)
		.filter((source): source is AtlasLocalSource => source !== null);
}

function mapArtifactToAtlasLocalSource(
	artifact: Artifact,
	authority: AtlasLocalSourceAuthority,
): AtlasLocalSource | null {
	const text = (artifact.contentText ?? artifact.summary ?? "").trim();
	if (!text) return null;
	return {
		id: artifact.id,
		title: artifact.name,
		authority,
		text,
	};
}
