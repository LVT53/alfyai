import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	conversations,
	messageAnalytics,
	messages,
	usageEvents,
} from "$lib/server/db/schema";
import type {
	ChatMessage,
	HonchoContextInfo,
	HonchoContextSnapshot,
	MessageEvidenceStatusState,
	MessageEvidenceSummary,
	MessageRole,
	SkillControlMessageMetadata,
	SkillDraftProposal,
	SkillDraftStatus,
	ThinkingSegment,
	WebCitationAudit,
} from "$lib/types";
import { listMessageAttachments } from "./knowledge";

type PersistedMessageMetadata = SkillControlMessageMetadata & {
	evidenceSummary?: MessageEvidenceSummary | null;
	evidenceStatus?: MessageEvidenceStatusState;
	deepResearchReportContext?: {
		action: "discuss_report" | "research_further";
		sourceJobId: string;
		sourceConversationId: string;
		reportArtifactId: string;
	};
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	modelDisplayName?: string | null;
	webCitationAudit?: WebCitationAudit | null;
};

export class SkillDraftTransitionError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 409,
	) {
		super(message);
		this.name = "SkillDraftTransitionError";
	}
}

function getModelDisplayName(modelId?: string | null): string | undefined {
	if (!modelId) return undefined;
	const config = getConfig();
	if (modelId === "model1") return config.model1.displayName;
	if (modelId === "model2") return config.model2.displayName;
	return undefined;
}

function mapRowToChatMessage(
	row: typeof messages.$inferSelect,
	modelId?: string | null,
	generationTimeMs?: number | null,
	costUsdMicros?: number | null,
): ChatMessage {
	// Restore full interleaved thinkingSegments from persisted JSON.
	// The column stores the complete segment array (text + tool_call entries in order)
	// so the expanded ThinkingBlock view is identical to what was shown during streaming.
	let thinkingSegments: ChatMessage["thinkingSegments"];
	if (row.toolCalls) {
		try {
			const parsed = JSON.parse(row.toolCalls) as ThinkingSegment[];
			if (Array.isArray(parsed) && parsed.length > 0) {
				thinkingSegments = parsed;
			}
		} catch {
			// Malformed JSON — silently ignore, fall back to flat thinking text
		}
	}

	const metadata = parseMetadata(row.metadataJson);
	const evidenceSummary =
		metadata?.evidenceSummary && Array.isArray(metadata.evidenceSummary.groups)
			? metadata.evidenceSummary
			: undefined;
	const evidencePending =
		metadata?.evidenceStatus === "pending" && !evidenceSummary;

	return {
		id: row.id,
		renderKey: row.id,
		role: row.role as MessageRole,
		content: row.content,
		thinking: row.thinking ?? undefined,
		thinkingSegments,
		timestamp: row.createdAt.getTime(),
		modelId: modelId as ChatMessage["modelId"],
		modelDisplayName:
			metadata?.modelDisplayName ?? getModelDisplayName(modelId),
		generationDurationMs: generationTimeMs ?? undefined,
		costUsd: costUsdMicros != null ? costUsdMicros / 1_000_000 : undefined,
		evidenceSummary,
		webCitationAudit: metadata?.webCitationAudit ?? undefined,
		evidencePending,
		honchoContext: metadata?.honchoContext ?? undefined,
		skillQuestion: metadata?.skillQuestion || undefined,
		pendingSkillNoteIntents: metadata?.pendingSkillNoteIntents,
		skillDrafts: Array.isArray(metadata?.skillDrafts)
			? metadata.skillDrafts
			: undefined,
		skillControl: metadata?.skillControl,
	};
}

function parseMetadata(value: string | null): PersistedMessageMetadata | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as PersistedMessageMetadata;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function compactSkillNoteOperationForMetadata(
	operation: NonNullable<
		SkillControlMessageMetadata["pendingSkillNoteIntents"]
	>[number],
): Record<string, unknown> {
	const bodyLength = operation.body.length;
	if (operation.action === "create") {
		return {
			operationId: operation.operationId,
			kind: operation.kind,
			action: operation.action,
			title: operation.title,
			bodyLength,
		};
	}
	return {
		operationId: operation.operationId,
		kind: operation.kind,
		action: operation.action,
		targetArtifactId: operation.targetArtifactId,
		bodyLength,
	};
}

function compactPersistedMessageMetadata(
	metadata: PersistedMessageMetadata,
): PersistedMessageMetadata {
	const next: Record<string, unknown> = { ...metadata };
	if (Array.isArray(metadata.pendingSkillNoteIntents)) {
		next.pendingSkillNoteIntents = metadata.pendingSkillNoteIntents.map(
			compactSkillNoteOperationForMetadata,
		);
	}
	if (metadata.skillControl?.operations) {
		next.skillControl = {
			...metadata.skillControl,
			operations: metadata.skillControl.operations.map((operation) =>
				operation.kind === "note_intent"
					? compactSkillNoteOperationForMetadata(operation)
					: operation,
			),
		};
	}
	return next as PersistedMessageMetadata;
}

export async function listMessages(
	conversationId: string,
): Promise<ChatMessage[]> {
	const [result, attachmentMap] = await Promise.all([
		db
			.select({
				message: messages,
				model: usageEvents.modelId,
				legacyModel: messageAnalytics.model,
				modelDisplayName: usageEvents.modelDisplayName,
				generationTimeMs: usageEvents.generationTimeMs,
				costUsdMicros: usageEvents.costUsdMicros,
				legacyGenerationTimeMs: messageAnalytics.generationTimeMs,
			})
			.from(messages)
			.leftJoin(usageEvents, eq(messages.id, usageEvents.messageId))
			.leftJoin(messageAnalytics, eq(messages.id, messageAnalytics.messageId))
			.where(eq(messages.conversationId, conversationId))
			.orderBy(asc(messages.createdAt)),
		listMessageAttachments(conversationId),
	]);

	const uniqueRows = new Map<string, (typeof result)[number]>();
	for (const row of result) {
		if (!uniqueRows.has(row.message.id)) {
			uniqueRows.set(row.message.id, row);
		}
	}

	return Array.from(uniqueRows.values()).map((row) => {
		const mapped = mapRowToChatMessage(
			row.message,
			row.model ?? row.legacyModel,
			row.generationTimeMs ?? row.legacyGenerationTimeMs,
			row.costUsdMicros,
		);
		return {
			...mapped,
			modelDisplayName: row.modelDisplayName ?? mapped.modelDisplayName,
			attachments: attachmentMap.get(row.message.id) ?? [],
		};
	});
}

export async function deleteMessages(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await db.delete(messages).where(inArray(messages.id, ids));
}

export async function createMessage(
	conversationId: string,
	role: MessageRole,
	content: string,
	thinking?: string,
	thinkingSegments?: ThinkingSegment[],
	metadata?: PersistedMessageMetadata,
): Promise<ChatMessage> {
	const [message] = await db
		.insert(messages)
		.values({
			id: randomUUID(),
			conversationId,
			role,
			content,
			thinking: thinking ?? null,
			toolCalls:
				thinkingSegments && thinkingSegments.length > 0
					? JSON.stringify(thinkingSegments)
					: null,
			metadataJson: metadata
				? JSON.stringify(compactPersistedMessageMetadata(metadata))
				: null,
		})
		.returning();

	return mapRowToChatMessage(message);
}

export async function getMessageEvidenceState(
	conversationId: string,
	messageId: string,
): Promise<{
	status: MessageEvidenceStatusState;
	evidenceSummary: MessageEvidenceSummary | null;
} | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.conversationId, conversationId),
			),
		)
		.limit(1);

	if (!row) return null;

	const metadata = parseMetadata(row.metadataJson);
	const evidenceSummary =
		metadata?.evidenceSummary && Array.isArray(metadata.evidenceSummary.groups)
			? metadata.evidenceSummary
			: null;

	return {
		status: metadata?.evidenceStatus ?? (evidenceSummary ? "ready" : "none"),
		evidenceSummary,
	};
}

export async function updateMessageEvidence(
	messageId: string,
	params: {
		evidenceSummary?: MessageEvidenceSummary | null;
		evidenceStatus: MessageEvidenceStatusState;
	},
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const existing = parseMetadata(row.metadataJson) ?? {};
	const next: PersistedMessageMetadata = {
		...existing,
		evidenceStatus: params.evidenceStatus,
	};

	if (params.evidenceSummary && params.evidenceSummary.groups.length > 0) {
		next.evidenceSummary = params.evidenceSummary;
		next.evidenceStatus = "ready";
	} else if (params.evidenceStatus !== "ready") {
		delete next.evidenceSummary;
	}

	await db
		.update(messages)
		.set({
			metadataJson: JSON.stringify(next),
		})
		.where(eq(messages.id, messageId));
}

export async function updateMessageWebCitationAudit(
	messageId: string,
	webCitationAudit: WebCitationAudit | null,
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const next: PersistedMessageMetadata = {
		...(parseMetadata(row.metadataJson) ?? {}),
	};
	if (webCitationAudit && webCitationAudit.status !== "none") {
		next.webCitationAudit = webCitationAudit;
	} else {
		delete next.webCitationAudit;
	}

	await db
		.update(messages)
		.set({
			metadataJson: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
		})
		.where(eq(messages.id, messageId));
}

export async function updateMessageHonchoMetadata(
	messageId: string,
	params: {
		honchoContext?: HonchoContextInfo | null;
		honchoSnapshot?: HonchoContextSnapshot | null;
	},
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const next = { ...(parseMetadata(row.metadataJson) ?? {}) };

	if (params.honchoContext === undefined) {
		// Leave existing value untouched.
	} else if (params.honchoContext) {
		next.honchoContext = params.honchoContext;
	} else {
		delete next.honchoContext;
	}

	if (params.honchoSnapshot === undefined) {
		// Leave existing value untouched.
	} else if (params.honchoSnapshot) {
		next.honchoSnapshot = params.honchoSnapshot;
	} else {
		delete next.honchoSnapshot;
	}

	await db
		.update(messages)
		.set({
			metadataJson: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
		})
		.where(eq(messages.id, messageId));
}

export async function getAssistantMessageSkillDraft(params: {
	conversationId: string;
	messageId: string;
	draftId: string;
}): Promise<SkillDraftProposal | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson, role: messages.role })
		.from(messages)
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.limit(1);

	if (!row || row.role !== "assistant") return null;
	const metadata = parseMetadata(row.metadataJson);
	const drafts = Array.isArray(metadata?.skillDrafts)
		? metadata.skillDrafts
		: [];
	return drafts.find((draft) => draft.id === params.draftId) ?? null;
}

export async function updateAssistantMessageSkillDraftStatus(params: {
	conversationId: string;
	messageId: string;
	draftId: string;
	status: SkillDraftStatus;
	savedSkillId?: string;
	publishedSystemSkillId?: string;
}): Promise<SkillDraftProposal | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson, role: messages.role })
		.from(messages)
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.limit(1);

	if (!row || row.role !== "assistant") return null;

	const metadata = parseMetadata(row.metadataJson) ?? {};
	const drafts = Array.isArray(metadata.skillDrafts)
		? metadata.skillDrafts
		: [];
	const draftIndex = drafts.findIndex((draft) => draft.id === params.draftId);
	if (draftIndex === -1) return null;
	const currentDraft = drafts[draftIndex];

	if (
		params.status === "saved" &&
		currentDraft.status === "saved" &&
		currentDraft.savedSkillId
	) {
		return currentDraft;
	}

	if (currentDraft.status !== "proposed") {
		throw new SkillDraftTransitionError(
			"skill_draft_transition_conflict",
			"Skill draft is already in a final state.",
			409,
		);
	}

	if (
		(params.status === "saved" && !params.savedSkillId) ||
		params.status === "published"
	) {
		throw new SkillDraftTransitionError(
			"skill_draft_transition_conflict",
			"Skill draft transition is not allowed.",
			409,
		);
	}

	const nextDraft: SkillDraftProposal = {
		...currentDraft,
		status: params.status,
		updatedAt: Date.now(),
	};
	if (params.savedSkillId) {
		nextDraft.savedSkillId = params.savedSkillId;
	}
	if (params.publishedSystemSkillId) {
		nextDraft.publishedSystemSkillId = params.publishedSystemSkillId;
	}

	const nextDrafts = drafts.slice();
	nextDrafts[draftIndex] = nextDraft;
	const next: PersistedMessageMetadata = {
		...metadata,
		skillDrafts: nextDrafts,
	};

	await db
		.update(messages)
		.set({
			metadataJson: JSON.stringify(next),
		})
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		);

	return nextDraft;
}

export async function getLatestHonchoMetadata(conversationId: string): Promise<{
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
}> {
	const rows = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.orderBy(desc(messages.createdAt));

	let honchoContext: HonchoContextInfo | null = null;
	let honchoSnapshot: HonchoContextSnapshot | null = null;

	for (const row of rows) {
		const metadata = parseMetadata(row.metadataJson);
		if (!metadata) continue;

		if (!honchoContext && metadata.honchoContext) {
			honchoContext = metadata.honchoContext;
		}
		if (!honchoSnapshot && metadata.honchoSnapshot) {
			honchoSnapshot = metadata.honchoSnapshot;
		}

		if (honchoContext && honchoSnapshot) {
			break;
		}
	}

	return { honchoContext, honchoSnapshot };
}

export async function clearMessageEvidenceForUser(
	userId: string,
): Promise<void> {
	const conversationRows = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.userId, userId));
	const conversationIds = conversationRows.map((row) => row.id);
	if (conversationIds.length === 0) return;

	const rows = await db
		.select({ id: messages.id, metadataJson: messages.metadataJson })
		.from(messages)
		.where(inArray(messages.conversationId, conversationIds));

	for (const row of rows) {
		const metadata = parseMetadata(row.metadataJson);
		if (
			!metadata ||
			(!("evidenceSummary" in metadata) &&
				!("evidenceStatus" in metadata) &&
				!("webCitationAudit" in metadata))
		) {
			continue;
		}

		const next = { ...metadata };
		delete next.evidenceSummary;
		delete next.evidenceStatus;
		delete next.webCitationAudit;

		await db
			.update(messages)
			.set({
				metadataJson:
					Object.keys(next).length > 0 ? JSON.stringify(next) : null,
			})
			.where(eq(messages.id, row.id));
	}
}
