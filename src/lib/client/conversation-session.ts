import {
	deleteConversationDraft,
	deletePreparedConversation,
	persistConversationDraft,
} from "$lib/client/api/conversations";
import type { FetchLike } from "$lib/client/api/http";
import type {
	ArtifactSummary,
	ConversationDraft,
	DeepResearchDepth,
	LinkedContextSource,
	ModelId,
	PendingAttachment,
	PendingSkillSelection,
	ThinkingMode,
} from "$lib/types";

const PREVIOUS_CONVERSATION_KEY = "previous-conversation-id";
const LANDING_DRAFT_CONVERSATION_KEY = "landing-draft-conversation-id";
const PENDING_MESSAGE_PREFIX = "pending-chat-message:";
const CONVERSATION_PERSONALITY_PREFIX = "conversation-personality:";
const CONVERSATION_MODEL_PREFIX = "conversation-model:";

export type PendingConversationMessage = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	modelId?: ModelId;
	personalityProfileId?: string | null;
	deepResearchDepth?: DeepResearchDepth | null;
	thinkingMode?: ThinkingMode;
	forceWebSearch?: boolean;
};

function getSessionStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

function getPendingMessageKey(conversationId: string): string {
	return `${PENDING_MESSAGE_PREFIX}${conversationId}`;
}

function getConversationPersonalityKey(conversationId: string): string {
	return `${CONVERSATION_PERSONALITY_PREFIX}${conversationId}`;
}

function getConversationModelKey(conversationId: string): string {
	return `${CONVERSATION_MODEL_PREFIX}${conversationId}`;
}

function isModelId(value: unknown): value is ModelId {
	return (
		typeof value === "string" &&
		(value === "model1" || value === "model2" || value.startsWith("provider:"))
	);
}

function toArtifactSummaryList(value: unknown): ArtifactSummary[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(artifact): artifact is ArtifactSummary =>
			typeof artifact === "object" &&
			artifact !== null &&
			"id" in artifact &&
			typeof artifact.id === "string",
	);
}

function toLinkedContextSourceList(value: unknown): LinkedContextSource[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
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
}

function toPendingSkillSelection(value: unknown): PendingSkillSelection | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		(record.ownership !== "user" && record.ownership !== "system") ||
		typeof record.displayName !== "string"
	) {
		return null;
	}
	return {
		id: record.id,
		ownership: record.ownership,
		skillKind:
			record.skillKind === "user_skill" ||
			record.skillKind === "skill_pack" ||
			record.skillKind === "skill_variant"
				? record.skillKind
				: undefined,
		displayName: record.displayName,
		baseSkillId:
			typeof record.baseSkillId === "string" ? record.baseSkillId : null,
		baseSkillDisplayName:
			typeof record.baseSkillDisplayName === "string"
				? record.baseSkillDisplayName
				: null,
		unavailable: record.unavailable === true,
	};
}

export function markPreviousConversationId(
	conversationId: string | null,
): void {
	if (!conversationId) return;
	getSessionStorage()?.setItem(PREVIOUS_CONVERSATION_KEY, conversationId);
}

export function consumePreviousConversationId(): string | null {
	const storage = getSessionStorage();
	const previousConversationId =
		storage?.getItem(PREVIOUS_CONVERSATION_KEY) ?? null;
	if (previousConversationId) {
		storage?.removeItem(PREVIOUS_CONVERSATION_KEY);
	}
	return previousConversationId;
}

export function getLandingDraftConversationId(): string | null {
	return getSessionStorage()?.getItem(LANDING_DRAFT_CONVERSATION_KEY) ?? null;
}

export function setLandingDraftConversationId(
	conversationId: string | null,
): void {
	const storage = getSessionStorage();
	if (!storage) return;
	if (conversationId) {
		storage.setItem(LANDING_DRAFT_CONVERSATION_KEY, conversationId);
		return;
	}
	storage.removeItem(LANDING_DRAFT_CONVERSATION_KEY);
}

export function getConversationPersonalitySelection(
	conversationId: string,
	profileDefault: string | null,
): string | null {
	const storage = getSessionStorage();
	const key = getConversationPersonalityKey(conversationId);
	if (!storage || storage.getItem(key) === null) {
		return profileDefault;
	}

	try {
		const parsed = JSON.parse(storage.getItem(key) ?? "null") as unknown;
		return typeof parsed === "string" ? parsed : null;
	} catch {
		return profileDefault;
	}
}

export function setConversationPersonalitySelection(
	conversationId: string,
	personalityProfileId: string | null,
): void {
	getSessionStorage()?.setItem(
		getConversationPersonalityKey(conversationId),
		JSON.stringify(personalityProfileId),
	);
}

export function getConversationModelSelection(
	conversationId: string,
	profileDefault: ModelId,
): ModelId {
	const storage = getSessionStorage();
	const key = getConversationModelKey(conversationId);
	if (!storage || storage.getItem(key) === null) {
		return profileDefault;
	}

	try {
		const parsed = JSON.parse(storage.getItem(key) ?? "null") as unknown;
		return isModelId(parsed) ? parsed : profileDefault;
	} catch {
		return profileDefault;
	}
}

export function setConversationModelSelection(
	conversationId: string,
	modelId: ModelId,
): void {
	getSessionStorage()?.setItem(
		getConversationModelKey(conversationId),
		JSON.stringify(modelId),
	);
}

export function storePendingConversationMessage(
	conversationId: string,
	payload: PendingConversationMessage,
): void {
	getSessionStorage()?.setItem(
		getPendingMessageKey(conversationId),
		JSON.stringify({
			message: payload.message.trim(),
			attachmentIds: payload.attachmentIds,
			attachments: payload.attachments,
			linkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.pendingSkill ?? null,
			modelId: payload.modelId,
			personalityProfileId: payload.personalityProfileId,
			deepResearchDepth: payload.deepResearchDepth,
			thinkingMode: payload.thinkingMode,
			forceWebSearch: payload.forceWebSearch === true,
		}),
	);
}

export function hasPendingConversationMessage(conversationId: string): boolean {
	return Boolean(
		getSessionStorage()?.getItem(getPendingMessageKey(conversationId)),
	);
}

export function consumePendingConversationMessage(
	conversationId: string,
): PendingConversationMessage | null {
	const storage = getSessionStorage();
	const key = getPendingMessageKey(conversationId);
	const rawValue = storage?.getItem(key) ?? null;
	if (!rawValue) {
		return null;
	}

	storage?.removeItem(key);

	try {
		const parsed = JSON.parse(rawValue) as Record<string, unknown>;
		return {
			message: typeof parsed.message === "string" ? parsed.message : "",
			attachmentIds: Array.isArray(parsed.attachmentIds)
				? parsed.attachmentIds.filter(
						(value): value is string => typeof value === "string",
					)
				: [],
			attachments: toArtifactSummaryList(parsed.attachments),
			linkedSources: toLinkedContextSourceList(parsed.linkedSources),
			pendingSkill: toPendingSkillSelection(parsed.pendingSkill),
			modelId: isModelId(parsed.modelId) ? parsed.modelId : undefined,
			personalityProfileId:
				typeof parsed.personalityProfileId === "string"
					? parsed.personalityProfileId
					: null,
			deepResearchDepth:
				parsed.deepResearchDepth === "focused" ||
				parsed.deepResearchDepth === "standard" ||
				parsed.deepResearchDepth === "max"
					? parsed.deepResearchDepth
					: null,
			thinkingMode:
				parsed.thinkingMode === "auto" ||
				parsed.thinkingMode === "on" ||
				parsed.thinkingMode === "off"
					? parsed.thinkingMode
					: "auto",
			forceWebSearch: parsed.forceWebSearch === true,
		};
	} catch {
		return {
			message: rawValue,
			attachmentIds: [],
			attachments: [],
			linkedSources: [],
			pendingSkill: null,
			deepResearchDepth: null,
			thinkingMode: "auto",
			forceWebSearch: false,
		};
	}
}

export function hasMeaningfulDraft(
	draftText: string,
	selectedAttachmentIds: string[],
	selectedLinkedSources: LinkedContextSource[] = [],
	pendingSkill: PendingSkillSelection | null = null,
): boolean {
	return (
		draftText.trim().length > 0 ||
		selectedAttachmentIds.length > 0 ||
		selectedLinkedSources.length > 0 ||
		Boolean(pendingSkill)
	);
}

export function createConversationDraftRecord(params: {
	conversationId: string | null;
	fallbackConversationId?: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	updatedAt?: number;
}): ConversationDraft | null {
	const selectedLinkedSources = params.selectedLinkedSources ?? [];
	const pendingSkill = params.pendingSkill ?? null;
	if (
		!hasMeaningfulDraft(
			params.draftText,
			params.selectedAttachmentIds,
			selectedLinkedSources,
			pendingSkill,
		)
	) {
		return null;
	}

	return {
		conversationId:
			params.conversationId ?? params.fallbackConversationId ?? "draft",
		draftText: params.draftText,
		selectedAttachmentIds: params.selectedAttachmentIds,
		selectedAttachments: params.selectedAttachments,
		selectedLinkedSources,
		pendingSkill,
		updatedAt: params.updatedAt ?? Date.now(),
	};
}

export function createDraftPersistence(
	fetchImpl: FetchLike = fetch,
	delayMs = 400,
) {
	let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPersistKey = "";
	let pendingRequest: {
		conversationId: string;
		draftText: string;
		selectedAttachmentIds: string[];
		selectedLinkedSources?: LinkedContextSource[];
		pendingSkill?: PendingSkillSelection | null;
	} | null = null;

	async function runPersist(request: {
		conversationId: string;
		draftText: string;
		selectedAttachmentIds: string[];
		selectedLinkedSources?: LinkedContextSource[];
		pendingSkill?: PendingSkillSelection | null;
	}): Promise<void> {
		try {
			const selectedLinkedSources = request.selectedLinkedSources ?? [];
			const pendingSkill = request.pendingSkill ?? null;
			if (
				!hasMeaningfulDraft(
					request.draftText,
					request.selectedAttachmentIds,
					selectedLinkedSources,
					pendingSkill,
				)
			) {
				await deleteConversationDraft(request.conversationId, fetchImpl);
				return;
			}

			await persistConversationDraft(
				request.conversationId,
				{
					draftText: request.draftText,
					selectedAttachmentIds: request.selectedAttachmentIds,
					selectedLinkedSources,
					pendingSkill,
				},
				fetchImpl,
			);
		} catch {
			// Ignore transient persistence failures in the composer.
		}
	}

	async function doFlush(): Promise<void> {
		if (draftPersistTimer) {
			clearTimeout(draftPersistTimer);
			draftPersistTimer = null;
		}

		const nextRequest = pendingRequest;
		pendingRequest = null;
		if (nextRequest) {
			await runPersist(nextRequest);
		}
	}

	return {
		async persist(
			request: {
				conversationId: string;
				draftText: string;
				selectedAttachmentIds: string[];
				selectedLinkedSources?: LinkedContextSource[];
				pendingSkill?: PendingSkillSelection | null;
			},
			immediate = false,
		): Promise<void> {
			const key = `${request.conversationId}:${JSON.stringify({
				draftText: request.draftText,
				selectedAttachmentIds: request.selectedAttachmentIds,
				selectedLinkedSources: request.selectedLinkedSources ?? [],
				pendingSkill: request.pendingSkill ?? null,
			})}`;
			if (!immediate && key === lastPersistKey) {
				return;
			}

			lastPersistKey = key;
			pendingRequest = request;
			const shouldPersistImmediately =
				immediate ||
				!hasMeaningfulDraft(
					request.draftText,
					request.selectedAttachmentIds,
					request.selectedLinkedSources ?? [],
					request.pendingSkill ?? null,
				);

			if (draftPersistTimer) {
				clearTimeout(draftPersistTimer);
				draftPersistTimer = null;
			}

			if (shouldPersistImmediately) {
				const nextRequest = pendingRequest;
				pendingRequest = null;
				if (nextRequest) {
					await runPersist(nextRequest);
				}
				return;
			}

			draftPersistTimer = setTimeout(() => {
				const nextRequest = pendingRequest;
				pendingRequest = null;
				draftPersistTimer = null;
				if (nextRequest) {
					void runPersist(nextRequest);
				}
			}, delayMs);
		},

		async flush(): Promise<void> {
			await doFlush();
		},

		clear(): void {
			// Cancel any pending timer and discard the pending request.
			// Do NOT flush — a pending persist of an old draft would race
			// with the explicit delete callers (e.g. after sending a message).
			if (draftPersistTimer) {
				clearTimeout(draftPersistTimer);
				draftPersistTimer = null;
			}
			pendingRequest = null;
			lastPersistKey = "";
		},
	};
}

export function cleanupPreparedConversation(params: {
	conversationId: string;
	removeLocal?: (conversationId: string) => void;
	fetchImpl?: FetchLike;
}): void {
	if (hasPendingConversationMessage(params.conversationId)) {
		return;
	}

	void deletePreparedConversation(params.conversationId, {
		fetchImpl: params.fetchImpl,
		keepalive: true,
	})
		.then(() => {
			params.removeLocal?.(params.conversationId);
		})
		.catch(() => {
			// Ignore cleanup failures; draft conversations are filtered from the sidebar anyway.
		});
}

export function clearConversationSessionState(): void {
	const storage = getSessionStorage();
	if (!storage) return;

	const keysToRemove: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (!key) continue;
		if (key.startsWith(PENDING_MESSAGE_PREFIX)) {
			keysToRemove.push(key);
		}
	}

	keysToRemove.push(PREVIOUS_CONVERSATION_KEY, LANDING_DRAFT_CONVERSATION_KEY);
	for (const key of keysToRemove) {
		storage.removeItem(key);
	}
}
