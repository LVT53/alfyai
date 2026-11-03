import {
	deleteConversationDraft,
	deletePreparedConversation,
	persistConversationDraft,
} from "$lib/client/api/conversations";
import { ApiError, type FetchLike } from "$lib/client/api/http";
import type { ComposerMarks } from "$lib/components/chat/composer-pictures";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import { parseReasoningDepth } from "$lib/reasoning-depth-types";
import type { AtlasProfile } from "$lib/server/services/atlas/public-types";
import type { ConversationDraft } from "$lib/server/services/conversations";
import type {
	ArtifactSummary,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import {
	type ImageMarksRequest,
	parseImageMarks,
} from "$lib/shared/artifacts/image-body";
import {
	SERVER_UPDATE_WATCH_MAX_MS,
	SERVER_UPDATE_WATCH_POLL_MS,
} from "./server-update-watch";

const PREVIOUS_CONVERSATION_KEY = "previous-conversation-id";
const LANDING_DRAFT_CONVERSATION_KEY = "landing-draft-conversation-id";
const PROJECT_COMPOSER_FOCUS_PREFIX = "project-composer-focus:";
const PENDING_MESSAGE_PREFIX = "pending-chat-message:";
const CONVERSATION_PERSONALITY_PREFIX = "conversation-personality:";
const CONVERSATION_MODEL_PREFIX = "conversation-model:";
const COMPOSER_MARKS_PREFIX = "composer-marks:";

export type PendingConversationMessage = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	/**
	 * The project the first message was typed in — set when the send started
	 * from a project page, null on the landing page. Carried with the rest of
	 * the message so the conversation's home survives the hand-off, and so a
	 * retry of the very first turn cannot put it somewhere else.
	 */
	projectId?: string | null;
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	modelId?: ModelId;
	personalityProfileId?: string | null;
	reasoningDepth?: ReasoningDepth;
	forceWebSearch?: boolean;
	// Issue 7.2 — the composer's per-conversation connection capability
	// selection, carried across the draft-persistence round trip the same
	// way forceWebSearch is.
	enabledConnectionCapabilities?: string[];
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	atlasAction?: "create";
	clientAtlasTurnId?: string | null;
	/** Boxes drawn on a photo before the chat existed. */
	imageMarks?: ImageMarksRequest | null;
	markedPicture?: {
		artifactId: string;
		name: string;
		addedRef: boolean;
		version: number | null;
	} | null;
};

/** The marks a stored value holds, or null for anything else. */
function toImageMarks(value: unknown): ImageMarksRequest | null {
	if (typeof value !== "object" || value === null) return null;
	const { imageFileId, uploadArtifactId, marks } = value as Record<
		string,
		unknown
	>;
	const parsed = parseImageMarks(marks);
	if (!parsed || parsed.length === 0) return null;
	if (typeof imageFileId === "string" && imageFileId) {
		return { imageFileId, marks: parsed };
	}
	return typeof uploadArtifactId === "string" && uploadArtifactId
		? { uploadArtifactId, marks: parsed }
		: null;
}

function toMarkedPicture(
	value: unknown,
): PendingConversationMessage["markedPicture"] {
	if (typeof value !== "object" || value === null) return null;
	const { artifactId, name, addedRef } = value as Record<string, unknown>;
	return typeof artifactId === "string" && typeof name === "string"
		? { artifactId, name, addedRef: addedRef === true, version: null }
		: null;
}

/** The boxes a chat's composer holds, kept through a reload of the tab. */
export function storeComposerMarks(
	conversationId: string,
	marks: ComposerMarks | null,
): void {
	const key = `${COMPOSER_MARKS_PREFIX}${conversationId}`;
	if (marks) getSessionStorage()?.setItem(key, JSON.stringify(marks));
	else getSessionStorage()?.removeItem(key);
}

export function readComposerMarks(
	conversationId: string,
): ComposerMarks | null {
	const raw =
		getSessionStorage()?.getItem(`${COMPOSER_MARKS_PREFIX}${conversationId}`) ??
		null;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const request = toImageMarks(parsed);
		if (
			!request ||
			typeof parsed.artifactId !== "string" ||
			typeof parsed.name !== "string"
		) {
			return null;
		}
		return {
			...request,
			artifactId: parsed.artifactId,
			name: parsed.name,
			version: typeof parsed.version === "number" ? parsed.version : null,
		};
	} catch {
		return null;
	}
}

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

function isAtlasProfile(value: unknown): value is AtlasProfile {
	return value === "overview" || value === "in-depth" || value === "exhaustive";
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

/**
 * "Start typing here", carried across one navigation. The sidebar's project
 * "New chat" item sets it; the project page consumes it and lands the caret in
 * the composer. It lives in the session rather than in the address so the page
 * keeps the project's own URL, and it is *consumed*, not read: a reload of the
 * project page must not steal focus a second time.
 */
export function markProjectComposerFocus(projectId: string): void {
	getSessionStorage()?.setItem(
		`${PROJECT_COMPOSER_FOCUS_PREFIX}${projectId}`,
		"1",
	);
}

export function consumeProjectComposerFocus(projectId: string): boolean {
	const storage = getSessionStorage();
	const key = `${PROJECT_COMPOSER_FOCUS_PREFIX}${projectId}`;
	if (!storage?.getItem(key)) return false;
	storage.removeItem(key);
	return true;
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
			projectId: payload.projectId ?? null,
			linkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.pendingSkill ?? null,
			modelId: payload.modelId,
			personalityProfileId: payload.personalityProfileId,
			reasoningDepth: payload.reasoningDepth,
			forceWebSearch: payload.forceWebSearch === true,
			enabledConnectionCapabilities: payload.enabledConnectionCapabilities,
			atlasMode: payload.atlasMode === true,
			atlasProfile: payload.atlasProfile ?? null,
			atlasAction: payload.atlasAction ?? "create",
			clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
			imageMarks: payload.imageMarks ?? null,
			markedPicture: payload.markedPicture ?? null,
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
		const marks = toImageMarks(parsed.imageMarks);
		const markedPicture = toMarkedPicture(parsed.markedPicture);
		return {
			message: typeof parsed.message === "string" ? parsed.message : "",
			attachmentIds: Array.isArray(parsed.attachmentIds)
				? parsed.attachmentIds.filter(
						(value): value is string => typeof value === "string",
					)
				: [],
			attachments: toArtifactSummaryList(parsed.attachments),
			projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
			linkedSources: toLinkedContextSourceList(parsed.linkedSources),
			pendingSkill: toPendingSkillSelection(parsed.pendingSkill),
			modelId: isModelId(parsed.modelId) ? parsed.modelId : undefined,
			personalityProfileId:
				typeof parsed.personalityProfileId === "string"
					? parsed.personalityProfileId
					: null,
			reasoningDepth: parsePendingReasoningDepth(parsed),
			forceWebSearch: parsed.forceWebSearch === true,
			enabledConnectionCapabilities: parseEnabledConnectionCapabilities(
				parsed.enabledConnectionCapabilities,
			),
			atlasMode: parsed.atlasMode === true,
			atlasProfile: isAtlasProfile(parsed.atlasProfile)
				? parsed.atlasProfile
				: null,
			atlasAction: "create",
			clientAtlasTurnId:
				typeof parsed.clientAtlasTurnId === "string"
					? parsed.clientAtlasTurnId
					: null,
			...(marks ? { imageMarks: marks, markedPicture } : {}),
		};
	} catch {
		return {
			message: rawValue,
			attachmentIds: [],
			attachments: [],
			projectId: null,
			linkedSources: [],
			pendingSkill: null,
			reasoningDepth: "thorough",
			forceWebSearch: false,
			enabledConnectionCapabilities: undefined,
			atlasMode: false,
			atlasProfile: null,
			atlasAction: "create",
			clientAtlasTurnId: null,
		};
	}
}

function parsePendingReasoningDepth(
	parsed: Record<string, unknown>,
): ReasoningDepth {
	return parseReasoningDepth(parsed.reasoningDepth, parsed.thinkingMode);
}

function parseEnabledConnectionCapabilities(
	value: unknown,
): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(candidate): candidate is string => typeof candidate === "string",
	);
}

export function hasMeaningfulDraft(
	draftText: string,
	selectedAttachmentIds: string[],
	selectedLinkedSources: LinkedContextSource[] = [],
	pendingSkill: PendingSkillSelection | null = null,
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

export function createConversationDraftRecord(params: {
	conversationId: string | null;
	fallbackConversationId?: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
	updatedAt?: number;
}): ConversationDraft | null {
	const selectedLinkedSources = params.selectedLinkedSources ?? [];
	const pendingSkill = params.pendingSkill ?? null;
	const atlasMode = params.atlasMode === true;
	if (
		!hasMeaningfulDraft(
			params.draftText,
			params.selectedAttachmentIds,
			selectedLinkedSources,
			pendingSkill,
			atlasMode,
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
		...(atlasMode
			? {
					atlasMode,
					atlasProfile: params.atlasProfile ?? "overview",
					clientAtlasTurnId: params.clientAtlasTurnId ?? null,
				}
			: {}),
		updatedAt: params.updatedAt ?? Date.now(),
	};
}

/**
 * The newest save or delete of each chat's draft that anything in this tab has
 * made. A save that is tried again after its request failed (`persistUntilSaved`)
 * holds the number it started under and stops when the chat's has moved: an older
 * save must never land on top of newer words. Module-level, not per persistence:
 * the chat page is rebuilt when the person leaves a chat and comes back, and the
 * save its earlier page left trying is still going.
 */
const newestDraftChange = new Map<string, number>();

function noteDraftChange(conversationId: string): number {
	const next = (newestDraftChange.get(conversationId) ?? 0) + 1;
	newestDraftChange.set(conversationId, next);
	return next;
}

/** How often a draft save that failed is tried again, and for how long (a message waits for an update the same). */
const DRAFT_SAVE_RETRY_MS = SERVER_UPDATE_WATCH_POLL_MS;
const DRAFT_SAVE_RETRY_MAX_MS = SERVER_UPDATE_WATCH_MAX_MS;

/**
 * Whether a failed save may land if it is sent again: the request did not reach
 * the app or the app failed (the network, the proxy's page during a restart, a 5xx).
 * An answer that refuses the request (a deleted chat, an expired session) never will.
 */
function mayLandWhenSentAgain(failure: unknown): boolean {
	if (failure instanceof ApiError) {
		return (
			failure.status >= 500 || failure.status === 408 || failure.status === 429
		);
	}
	return true;
}

export function createDraftPersistence(
	fetchImpl: FetchLike = fetch,
	delayMs = 400,
) {
	let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPersistKey = "";
	let pendingRequest: DraftSaveRequest | null = null;
	// The saves sent and not yet answered, and the last one each chat sent.
	const saving = new Set<Promise<void>>();
	const lastSave = new Map<string, Promise<void>>();

	function onItsWay(conversationId: string, save: Promise<void>) {
		const answered = save
			.catch(() => {
				// Ignore transient persistence failures in the composer.
			})
			.finally(() => {
				saving.delete(answered);
			});
		saving.add(answered);
		lastSave.set(conversationId, answered);
		return answered;
	}

	async function deleteQuietly(conversationId: string): Promise<void> {
		try {
			await deleteConversationDraft(conversationId, fetchImpl);
		} catch {
			// Ignore transient persistence failures in the composer.
		}
	}

	/**
	 * Deletes a chat's saved draft now, and again once the saves already on their way
	 * have been answered: one that landed behind the first delete would bring back
	 * words the person sent, and the turn's own clear catches only the exact text it
	 * sent, not an earlier version of it. The first delete never waits: the landing
	 * page navigates straight after it, and the chat page's read must find the draft
	 * gone. A save this chat sends meanwhile holds words typed since, so it stands.
	 */
	async function deleteDraft(conversationId: string): Promise<void> {
		noteDraftChange(conversationId);
		const last = lastSave.get(conversationId);
		const onTheirWay = [...saving];
		await deleteQuietly(conversationId);
		if (onTheirWay.length === 0) return;
		await Promise.all(onTheirWay);
		if (lastSave.get(conversationId) === last) {
			await deleteQuietly(conversationId);
		}
	}

	function isMeaningful(request: DraftSaveRequest): boolean {
		return hasMeaningfulDraft(
			request.draftText,
			request.selectedAttachmentIds,
			request.selectedLinkedSources ?? [],
			request.pendingSkill ?? null,
			request.atlasMode === true,
		);
	}

	/**
	 * One save, sent. Resolves with why it failed, or undefined when it landed; a
	 * failure is swallowed here as it always was, and the caller that wants to try
	 * again reads it.
	 */
	async function saveOnce(request: DraftSaveRequest): Promise<unknown> {
		const payload = {
			draftText: request.draftText,
			selectedAttachmentIds: request.selectedAttachmentIds,
			selectedLinkedSources: request.selectedLinkedSources ?? [],
			pendingSkill: request.pendingSkill ?? null,
			...(request.atlasMode === true
				? {
						atlasMode: true,
						atlasProfile: request.atlasProfile ?? null,
						clientAtlasTurnId: request.clientAtlasTurnId ?? null,
					}
				: {}),
		};
		let failure: unknown;
		await onItsWay(
			request.conversationId,
			persistConversationDraft(
				request.conversationId,
				payload,
				fetchImpl,
			).catch((error: unknown) => {
				failure = error ?? new Error("The draft was not saved");
			}),
		);
		return failure;
	}

	async function runPersist(request: DraftSaveRequest): Promise<void> {
		if (!isMeaningful(request)) {
			await deleteDraft(request.conversationId);
			return;
		}
		await saveOnce(request);
	}

	/**
	 * Words that exist nowhere else (a message that waited for an update when the
	 * person left its chat) must not be lost to a request that failed: a restart
	 * answers a save with the proxy's page. So a failed save is sent again every few
	 * seconds, for as long as a message waits for an update, until it lands. It stops
	 * at once when anything has saved or deleted this chat's draft since (that is
	 * newer; nothing older may land on top of it) or when the answer refuses the
	 * save for good. It holds no page: it goes on after the chat page is gone.
	 */
	async function runPersistUntilSaved(
		request: DraftSaveRequest,
	): Promise<void> {
		if (!isMeaningful(request)) {
			await deleteDraft(request.conversationId);
			return;
		}
		const generation = newestDraftChange.get(request.conversationId);
		const startedAt = Date.now();
		for (;;) {
			const failure = await saveOnce(request);
			if (failure === undefined || !mayLandWhenSentAgain(failure)) return;
			await new Promise<void>((resolve) =>
				setTimeout(resolve, DRAFT_SAVE_RETRY_MS),
			);
			if (newestDraftChange.get(request.conversationId) !== generation) return;
			if (Date.now() - startedAt >= DRAFT_SAVE_RETRY_MAX_MS) return;
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

	async function submit(
		request: DraftSaveRequest,
		immediate: boolean,
		untilSaved: boolean,
	): Promise<void> {
		const key = `${request.conversationId}:${JSON.stringify({
			draftText: request.draftText,
			selectedAttachmentIds: request.selectedAttachmentIds,
			selectedLinkedSources: request.selectedLinkedSources ?? [],
			pendingSkill: request.pendingSkill ?? null,
			atlasMode: request.atlasMode === true,
			atlasProfile: request.atlasProfile ?? null,
			clientAtlasTurnId: request.clientAtlasTurnId ?? null,
		})}`;
		if (!immediate && key === lastPersistKey) {
			return;
		}

		lastPersistKey = key;
		noteDraftChange(request.conversationId);
		pendingRequest = request;
		const shouldPersistImmediately = immediate || !isMeaningful(request);

		if (draftPersistTimer) {
			clearTimeout(draftPersistTimer);
			draftPersistTimer = null;
		}

		if (shouldPersistImmediately) {
			const nextRequest = pendingRequest;
			pendingRequest = null;
			if (nextRequest) {
				await (untilSaved
					? runPersistUntilSaved(nextRequest)
					: runPersist(nextRequest));
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
	}

	return {
		persist(request: DraftSaveRequest, immediate = false): Promise<void> {
			return submit(request, immediate, false);
		},

		/**
		 * `persist(request, true)` for words that must not be lost to a failed request
		 * (`runPersistUntilSaved`). The promise settles when the save has landed or
		 * has been given up, which can be minutes away; callers do not wait for it.
		 */
		persistUntilSaved(request: DraftSaveRequest): Promise<void> {
			return submit(request, true, true);
		},

		async flush(): Promise<void> {
			await doFlush();
		},

		deleteDraft,

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

/** One save of a chat's draft, as the composer and the chat page ask for it. */
type DraftSaveRequest = {
	conversationId: string;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
};

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
		if (
			key.startsWith(PENDING_MESSAGE_PREFIX) ||
			key.startsWith(COMPOSER_MARKS_PREFIX)
		) {
			keysToRemove.push(key);
		}
	}

	keysToRemove.push(PREVIOUS_CONVERSATION_KEY, LANDING_DRAFT_CONVERSATION_KEY);
	for (const key of keysToRemove) {
		storage.removeItem(key);
	}
}
