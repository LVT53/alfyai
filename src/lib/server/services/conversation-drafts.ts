import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversationDrafts } from "$lib/server/db/schema";
import { parseJsonStringArray } from "$lib/server/utils/json";
import type {
	Artifact,
	ArtifactSummary,
	AtlasProfile,
	ConversationDraft,
	LinkedContextSource,
	PendingAttachment,
	PendingSkillSelection,
} from "$lib/types";
import { resolvePromptAttachmentArtifacts } from "./knowledge";

function toArtifactSummary(artifact: Artifact): ArtifactSummary {
	return {
		id: artifact.id,
		type: artifact.type,
		retrievalClass: artifact.retrievalClass,
		name: artifact.name,
		mimeType: artifact.mimeType ?? null,
		sizeBytes: artifact.sizeBytes ?? null,
		conversationId: artifact.conversationId ?? null,
		summary: artifact.summary ?? null,
		createdAt: artifact.createdAt,
		updatedAt: artifact.updatedAt,
	};
}

function parseLinkedSourcesJson(value: string | null): LinkedContextSource[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(source): source is LinkedContextSource =>
				typeof source === "object" &&
				source !== null &&
				"displayArtifactId" in source &&
				typeof source.displayArtifactId === "string" &&
				"name" in source &&
				typeof source.name === "string" &&
				"type" in source &&
				source.type === "document",
		);
	} catch {
		return [];
	}
}

export function parsePendingSkillSelection(
	value: unknown,
): PendingSkillSelection | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		(record.ownership !== "user" && record.ownership !== "system") ||
		typeof record.displayName !== "string"
	) {
		return null;
	}
	const skillKind =
		record.skillKind === "user_skill" ||
		record.skillKind === "skill_pack" ||
		record.skillKind === "skill_variant"
			? record.skillKind
			: undefined;
	const selection: PendingSkillSelection = {
		id: record.id,
		ownership: record.ownership,
		displayName: record.displayName,
	};
	if (skillKind) selection.skillKind = skillKind;
	if ("baseSkillId" in record) {
		selection.baseSkillId =
			typeof record.baseSkillId === "string" ? record.baseSkillId : null;
	}
	if ("baseSkillDisplayName" in record) {
		selection.baseSkillDisplayName =
			typeof record.baseSkillDisplayName === "string"
				? record.baseSkillDisplayName
				: null;
	}
	if (record.unavailable === true) selection.unavailable = true;
	return selection;
}

function parsePendingSkillJson(
	value: string | null,
): PendingSkillSelection | null {
	if (!value) return null;
	try {
		return parsePendingSkillSelection(JSON.parse(value) as unknown);
	} catch {
		return null;
	}
}

function hasMeaningfulDraft(
	draftText: string,
	selectedAttachmentIds: string[],
	selectedLinkedSources: LinkedContextSource[],
	pendingSkill: PendingSkillSelection | null,
	atlasMode = false,
): boolean {
	return (
		draftText.trim().length > 0 ||
		selectedAttachmentIds.length > 0 ||
		selectedLinkedSources.length > 0 ||
		Boolean(pendingSkill) ||
		atlasMode
	);
}

function parseAtlasProfile(value: unknown): AtlasProfile | null {
	return value === "overview" || value === "in-depth" || value === "exhaustive"
		? value
		: null;
}

export async function getConversationDraft(
	userId: string,
	conversationId: string,
): Promise<ConversationDraft | null> {
	const [row] = await db
		.select()
		.from(conversationDrafts)
		.where(
			and(
				eq(conversationDrafts.userId, userId),
				eq(conversationDrafts.conversationId, conversationId),
			),
		)
		.limit(1);

	if (!row) return null;

	const selectedAttachmentIds = parseJsonStringArray(
		row.selectedAttachmentIdsJson,
	);
	const selectedLinkedSources = parseLinkedSourcesJson(
		row.selectedLinkedSourcesJson,
	);
	const pendingSkill = parsePendingSkillJson(row.pendingSkillJson);
	const resolved =
		selectedAttachmentIds.length > 0
			? await resolvePromptAttachmentArtifacts(
					userId,
					selectedAttachmentIds,
				).catch(() => null)
			: null;
	const pendingAttachments: PendingAttachment[] = (
		resolved?.items ?? []
	).flatMap((item) => {
		if (!item.displayArtifact) return [];
		return [
			{
				artifact: toArtifactSummary(item.displayArtifact),
				promptReady: item.promptReady,
				promptArtifactId: item.promptArtifact?.id ?? null,
				readinessError: item.readinessError ?? null,
			},
		];
	});

	return {
		conversationId: row.conversationId,
		draftText: row.draftText ?? "",
		selectedAttachmentIds,
		selectedAttachments: pendingAttachments,
		selectedLinkedSources,
		pendingSkill,
		atlasMode: Boolean(row.atlasMode),
		atlasProfile: parseAtlasProfile(row.atlasProfile),
		clientAtlasTurnId: row.clientAtlasTurnId ?? null,
		updatedAt: row.updatedAt.getTime(),
	};
}

export async function upsertConversationDraft(params: {
	userId: string;
	conversationId: string;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
}): Promise<ConversationDraft | null> {
	const selectedAttachmentIds = Array.from(
		new Set(params.selectedAttachmentIds),
	);
	const selectedLinkedSources = params.selectedLinkedSources ?? [];
	const pendingSkill = params.pendingSkill ?? null;
	const atlasMode = params.atlasMode === true;
	const atlasProfile = atlasMode ? (params.atlasProfile ?? "overview") : null;
	const clientAtlasTurnId = atlasMode
		? (params.clientAtlasTurnId ?? null)
		: null;
	const draftText = params.draftText;

	if (
		!hasMeaningfulDraft(
			draftText,
			selectedAttachmentIds,
			selectedLinkedSources,
			pendingSkill,
			atlasMode,
		)
	) {
		await clearConversationDraft(params.userId, params.conversationId);
		return null;
	}

	await db
		.insert(conversationDrafts)
		.values({
			conversationId: params.conversationId,
			userId: params.userId,
			draftText,
			selectedAttachmentIdsJson: JSON.stringify(selectedAttachmentIds),
			selectedLinkedSourcesJson: JSON.stringify(selectedLinkedSources),
			pendingSkillJson: JSON.stringify(pendingSkill),
			atlasMode,
			atlasProfile,
			clientAtlasTurnId,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: conversationDrafts.conversationId,
			set: {
				userId: params.userId,
				draftText,
				selectedAttachmentIdsJson: JSON.stringify(selectedAttachmentIds),
				selectedLinkedSourcesJson: JSON.stringify(selectedLinkedSources),
				pendingSkillJson: JSON.stringify(pendingSkill),
				atlasMode,
				atlasProfile,
				clientAtlasTurnId,
				updatedAt: new Date(),
			},
		});

	return getConversationDraft(params.userId, params.conversationId);
}

export async function clearConversationDraft(
	userId: string,
	conversationId: string,
): Promise<void> {
	await db
		.delete(conversationDrafts)
		.where(
			and(
				eq(conversationDrafts.userId, userId),
				eq(conversationDrafts.conversationId, conversationId),
			),
		);
}
