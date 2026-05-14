import { readFile } from 'fs/promises';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Honcho } from '@honcho-ai/sdk';
import type { Message, Peer } from '@honcho-ai/sdk';
import type { ConclusionScope } from '@honcho-ai/sdk/dist/conclusions';
import type { Session } from '@honcho-ai/sdk/dist/session';
import { getConfig } from '../config-store';
import { db } from '../db';
import { users } from '../db/schema';
import { getSystemPrompt } from '../prompts';
import { estimateTokenCount } from '$lib/utils/tokens';
import { detectTopicShift, shouldSuppressCarryover } from '$lib/server/utils/topic-shift-detector';
import {
	dedupeById,
	extractSerializedAttachmentBody,
	rerankHistoricalSections,
	serializeBudgetedAttachments,
	serializeRoleMessages,
	serializeWorkingSetArtifacts,
	selectPromptSessionTurns,
	selectRecentRoleTurns,
	truncateToTokenBudget,
	type BudgetedAttachmentContext,
	type PromptContextSection,
} from '$lib/server/utils/prompt-context';
import {
	selectPromptContext,
	type ContextSelectionCandidate,
} from './chat-turn/context-selection';
import {
	deriveCurrentTurnAttachmentBudget,
	deriveExplicitSourceSetBudget,
	deriveModelContextBudget,
	deriveSessionHistoryBudget,
} from './chat-turn/context-budget';
import type {
	ContextTraceSource,
	LegacyContextTraceSectionInput,
} from './chat-turn/context-trace';
import {
	AttachmentReadinessError,
	findRelevantKnowledgeArtifacts,
	getCompactionUiThreshold,
	getMaxModelContext,
	getTargetConstructedContext,
	listConversationSourceArtifactIds,
	resolvePromptAttachmentArtifacts,
	selectWorkingSetArtifactsForPrompt,
	updateConversationContextStatus,
	WORKING_SET_DOCUMENT_TOKEN_BUDGET,
	WORKING_SET_OUTPUT_TOKEN_BUDGET,
	WORKING_SET_PROMPT_TOKEN_BUDGET,
} from './knowledge';
import { scoreMatch } from './working-set';
import { clipText } from '$lib/server/utils/text';
import type {
	Artifact,
	ChatMessage,
	HonchoContextInfo,
	HonchoContextSnapshot,
	ConversationContextStatus,
	ContextDebugState,
} from '$lib/types';
import {
	formatTaskStateForPrompt,
	getContextDebugState,
	getProjectFolderReferenceContext,
	getPromptArtifactSnippets,
	prepareTaskContext,
	selectProjectFolderSiblingPromotion,
	type ProjectFolderReferenceContext,
	type ProjectFolderSiblingPromotionContext,
} from './task-state';
import { getConversationProjectLabel } from './projects';
import { canUseTeiReranker, rerankItems } from './tei-reranker';
import { embedTexts } from './tei-embedder';
import {
	hasMeaningfulAttachmentText,
	logAttachmentTrace,
	summarizeAttachmentTraceText,
} from './attachment-trace';
import { buildActiveDocumentState } from './active-state';
import { getLatestHonchoMetadata, listMessages } from './messages';

let client: Honcho | null = null;

const peerCache = new Map<string, Peer>();
const sessionCache = new Map<string, Session>();
const sessionOwnerCache = new Map<string, string>();
const honchoPeerVersionCache = new Map<string, number>();
const peerContextCache = new Map<string, { value: string | null; expiresAt: number }>();
const PEER_CONTEXT_CACHE_TTL_MS = 30_000;
const HONCHO_PEER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const HONCHO_SAFE_ID_MAX_LENGTH = 48;
const HONCHO_LIVE_CONTEXT_TOKENS = 2_000;
const HONCHO_NATIVE_UPLOAD_ALLOWED_MIME_PREFIXES = ['text/'];
const HONCHO_NATIVE_UPLOAD_ALLOWED_MIME_TYPES = new Set(['application/pdf', 'application/json']);
const HONCHO_ID_HASH_LENGTH = 32;
const ATTACHMENT_PROMPT_TOKEN_BUDGET = 6_000;
const ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET = 2_400;
const ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET = 600;
const RECENT_TURN_COUNT = 3;
const UNMATCHED_RECENT_TURN_TOKEN_LIMIT = 480;
const MIN_RELEVANT_KNOWLEDGE_ARTIFACTS = 6;
const MAX_RELEVANT_KNOWLEDGE_ARTIFACTS = 64;
const RELEVANT_KNOWLEDGE_ARTIFACT_TARGET_TOKEN_STEP = 32_768;
const PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS = 160;

// Authority note:
// - Honcho is a semantic mirror/integration layer for sessions, peers, conclusions, and overview text
// - local persona-memory, task-state, and document-resolution remain authoritative for freshness-sensitive
//   truth, task continuity, and working-document identity

export function deriveRelevantKnowledgeArtifactLimit(targetConstructedContext: number): number {
	if (!Number.isFinite(targetConstructedContext) || targetConstructedContext <= 0) {
		return MIN_RELEVANT_KNOWLEDGE_ARTIFACTS;
	}
	return Math.max(
		MIN_RELEVANT_KNOWLEDGE_ARTIFACTS,
		Math.min(
			MAX_RELEVANT_KNOWLEDGE_ARTIFACTS,
			Math.ceil(targetConstructedContext / RELEVANT_KNOWLEDGE_ARTIFACT_TARGET_TOKEN_STEP)
		)
	);
}

function inferContextTraceSourceForSection(
	section: Pick<PromptContextSection, 'title' | 'layer'>
): ContextTraceSource {
	const normalizedTitle = section.title.toLowerCase();
	if (normalizedTitle.includes('attachment')) return 'attachment';
	if (normalizedTitle.includes('user memory')) return 'memory';
	if (normalizedTitle.includes('session')) return 'session';
	if (normalizedTitle.includes('task')) return 'task_state';
	if (normalizedTitle.includes('evidence') || section.layer === 'working_set') {
		return 'working_set';
	}
	if (section.layer === 'documents') return 'document';
	if (section.layer === 'task_state') return 'task_state';
	if (section.layer === 'session') return 'session';
	return 'session';
}

function buildContextSelectionCandidates(params: {
	sections: PromptContextSection[];
	attachmentContext?: BudgetedAttachmentContext | null;
	carriedForwardAttachmentContext?: BudgetedAttachmentContext | null;
	projectFolderSiblingPromotion?: ProjectFolderSiblingPromotionContext | null;
	evidenceItems?: Array<{
		id: string;
		title: string;
		pinned: boolean;
	}>;
}): ContextSelectionCandidate[] {
	return params.sections.map((section) => {
		const isAttachmentSection = section.title === 'Current Attachments';
		const isCarriedForwardAttachmentSection = section.title === 'Attached Sources';
		const isEvidenceSection = section.title === 'Retrieved Evidence';
		const isProjectFolderSiblingSection = section.title === 'Project Folder Sibling Context';
		const attachmentItems = isAttachmentSection
			? (params.attachmentContext?.items ?? [])
			: isCarriedForwardAttachmentSection
				? (params.carriedForwardAttachmentContext?.items ?? [])
			: [];
		const evidenceItems = isEvidenceSection ? (params.evidenceItems ?? []) : [];
		const promotedSibling = isProjectFolderSiblingSection
			? params.projectFolderSiblingPromotion
			: null;
		return {
			title: section.title,
			body: section.body,
			source: promotedSibling ? 'memory' : inferContextTraceSourceForSection(section),
			layer: section.layer,
			protected: section.protected,
			itemIds: isEvidenceSection
				? evidenceItems.map((item) => item.id)
				: promotedSibling
					? [`conversation:${promotedSibling.conversationId}`]
				: attachmentItems.map((item) => item.id),
			itemTitles: isEvidenceSection
				? evidenceItems.map((item) => item.title)
				: promotedSibling
					? [promotedSibling.title]
				: attachmentItems.map((item) => item.title),
			signalReasons:
				isAttachmentSection && params.attachmentContext
					? [`attachment_context:${params.attachmentContext.mode}`]
					: isCarriedForwardAttachmentSection &&
						  params.carriedForwardAttachmentContext
						? [
								`attachment_context:${params.carriedForwardAttachmentContext.mode}`,
								'attached_sources:carried_forward',
							]
					: isEvidenceSection && evidenceItems.some((item) => item.pinned)
						? ['pinned_evidence', 'working_set_context:budgeted']
					: section.title === 'Honcho Session Context'
						? ['recent_turn_context:budgeted']
					: promotedSibling
						? [
								'project_folder_sibling:query_match',
								`project_folder_sibling_score:${promotedSibling.score}`,
							]
					: [],
		};
	});
}

function buildCurrentAttachmentSnippetMap(params: {
	artifacts: Artifact[];
	snippets: Map<string, string>;
}): Map<string, string> {
	const next = new Map(params.snippets);
	for (const artifact of params.artifacts) {
		if (artifact.contentText?.trim()) {
			next.delete(artifact.id);
		}
	}
	return next;
}

function buildProjectFolderPromptSection(label: string | null): PromptContextSection | null {
	const trimmed = label?.trim();
	if (!trimmed) return null;

	const boundedLabel =
		trimmed.length > PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS
			? `${trimmed.slice(0, PROJECT_FOLDER_PROMPT_LABEL_MAX_CHARS).trimEnd()}...`
			: trimmed;

	return {
		title: 'Project Folder',
		body: `Project Folder label: ${JSON.stringify(boundedLabel)}`,
		layer: 'session',
		protected: true,
	};
}

function buildProjectFolderAwarenessPromptSection(
	context: ProjectFolderReferenceContext | null
): PromptContextSection | null {
	if (!context || context.entries.length === 0) return null;

	const entryBlocks = context.entries.map((entry) =>
		[
			`- Title: ${JSON.stringify(entry.title)}`,
			entry.objective
				? `  Objective: ${JSON.stringify(entry.objective)}`
				: '  Objective: unavailable from existing task summaries.',
			entry.summary
				? `  Summary/Checkpoint: ${JSON.stringify(entry.summary)}`
				: '  Summary/Checkpoint: unavailable from existing task summaries.',
		].join('\n')
	);
	const omittedLine =
		context.omittedSiblingCount > 0
			? `Omitted: ${context.omittedSiblingCount} more sibling conversation${
					context.omittedSiblingCount === 1 ? '' : 's'
				} due to the folder awareness cap.`
			: null;

	return {
		title: 'Project Folder Awareness',
		body: [
			'Other conversations in this Project Folder, excluding the current conversation. Use as lightweight orientation, not source evidence.',
			...entryBlocks,
			omittedLine,
		]
			.filter((value): value is string => Boolean(value))
			.join('\n\n'),
		layer: 'task_state',
		protected: false,
		llmCompactible: true,
	};
}

function buildProjectFolderSiblingPromptSection(
	promotion: ProjectFolderSiblingPromotionContext | null
): PromptContextSection | null {
	if (!promotion) return null;

	const messageLines = promotion.messages.map((message) => {
		const role = message.role === 'assistant' ? 'assistant' : 'user';
		return `${role}: ${clipText(message.content, 900)}`;
	});
	const omittedLine =
		promotion.omittedMessageCount > 0
			? `Omitted recent turns: ${promotion.omittedMessageCount}`
			: null;

	return {
		title: 'Project Folder Sibling Context',
		body: [
			'Promoted sibling conversation from the same Project Folder because the current query matched that sibling work.',
			`Project Folder: ${JSON.stringify(promotion.projectName)}`,
			`Title: ${JSON.stringify(promotion.title)}`,
			promotion.objective
				? `Objective: ${JSON.stringify(promotion.objective)}`
				: null,
			promotion.summary
				? `Summary/Checkpoint: ${JSON.stringify(promotion.summary)}`
				: null,
			`Match score: ${promotion.score}`,
			promotion.matchedTerms.length > 0
				? `Matched terms: ${promotion.matchedTerms.join(', ')}`
				: null,
			messageLines.length > 0
				? ['Recent bounded turns:', ...messageLines].join('\n')
				: null,
			omittedLine,
		]
			.filter((value): value is string => Boolean(value))
			.join('\n\n'),
		layer: 'task_state',
		protected: false,
		llmCompactible: true,
	};
}

function normalizePeerIdFragment(rawId: string): string {
	const trimmed = rawId.trim();
	if (
		trimmed &&
		trimmed.length <= HONCHO_SAFE_ID_MAX_LENGTH &&
		HONCHO_PEER_ID_PATTERN.test(trimmed)
	) {
		return trimmed;
	}

	const digest = createHash('sha256').update(rawId).digest('hex').slice(0, 32);
	return `h_${digest}`;
}

function buildHonchoPeerSeed(userId: string, version: number): string {
	return version > 0 ? `${userId}_v${version}` : userId;
}

function buildNamespacedHonchoId(prefix: 'u' | 'a' | 's', parts: string[]): string {
	const config = getConfig();
	const digest = createHash('sha256')
		.update([config.honchoIdentityNamespace, ...parts].join('\0'))
		.digest('hex')
		.slice(0, HONCHO_ID_HASH_LENGTH);
	return `${prefix}_${digest}`;
}

function getLegacyHonchoUserPeerId(userId: string, version: number): string {
	return normalizePeerIdFragment(buildHonchoPeerSeed(userId, version));
}

function getLegacyHonchoAssistantPeerId(userId: string, version: number): string {
	return `assistant_${normalizePeerIdFragment(buildHonchoPeerSeed(userId, version))}`;
}

function getCachedHonchoPeerVersion(userId: string): number {
	return honchoPeerVersionCache.get(userId) ?? 0;
}

async function getHonchoPeerVersion(userId: string): Promise<number> {
	const cached = honchoPeerVersionCache.get(userId);
	if (typeof cached === 'number') {
		return cached;
	}

	const [row] = await db
		.select({ honchoPeerVersion: users.honchoPeerVersion })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const version = row?.honchoPeerVersion ?? 0;
	honchoPeerVersionCache.set(userId, version);
	return version;
}

function deletePeerCacheEntries(userId: string, version: number): void {
	peerCache.delete(getHonchoUserPeerId(userId, version));
	peerCache.delete(getHonchoAssistantPeerId(userId, version));
	peerCache.delete(getLegacyHonchoUserPeerId(userId, version));
	peerCache.delete(getLegacyHonchoAssistantPeerId(userId, version));
}

export function getHonchoUserPeerId(userId: string, version = getCachedHonchoPeerVersion(userId)): string {
	return buildNamespacedHonchoId('u', ['user', userId, String(version)]);
}

export function getHonchoAssistantPeerId(
	userId: string,
	version = getCachedHonchoPeerVersion(userId)
): string {
	return buildNamespacedHonchoId('a', ['assistant', userId, String(version)]);
}

export function getHonchoSessionId(
	userId: string,
	conversationId: string,
	version = getCachedHonchoPeerVersion(userId)
): string {
	return buildNamespacedHonchoId('s', ['session', userId, String(version), conversationId]);
}

function roleForMessage(message: Message, userId: string): 'user' | 'assistant' {
	const metadataRole =
		typeof message.metadata?.role === 'string' ? message.metadata.role : null;
	if (metadataRole === 'assistant' || metadataRole === 'user') {
		return metadataRole;
	}
	const version = getCachedHonchoPeerVersion(userId);
	const assistantPeerIds = new Set([
		getHonchoAssistantPeerId(userId, version),
		getLegacyHonchoAssistantPeerId(userId, version),
		getLegacyHonchoAssistantPeerId(userId, 0),
	]);
	return assistantPeerIds.has(message.peerId) ? 'assistant' : 'user';
}

export function isHonchoEnabled(): boolean {
	return getConfig().honchoEnabled;
}

async function ensureClient(): Promise<Honcho> {
	if (client) return client;

	const config = getConfig();
  client = new Honcho({
		apiKey: config.honchoApiKey || 'no-auth',
		baseURL: config.honchoBaseUrl,
		workspaceId: config.honchoWorkspace,
	});

  return client;
}

async function getPeerById(peerId: string): Promise<Peer> {
	const cached = peerCache.get(peerId);
	if (cached) return cached;

	const honcho = await ensureClient();
	const peer = await honcho.peer(peerId);
	peerCache.set(peerId, peer);
	return peer;
}

export async function getUserPeer(userId: string): Promise<Peer> {
	return getPeerById(getHonchoUserPeerId(userId, await getHonchoPeerVersion(userId)));
}

export async function getAssistantPeer(userId: string): Promise<Peer> {
	return getPeerById(getHonchoAssistantPeerId(userId, await getHonchoPeerVersion(userId)));
}

export async function rotateHonchoPeerIdentity(userId: string): Promise<number> {
	const currentVersion = await getHonchoPeerVersion(userId);
	const nextVersion = currentVersion + 1;

	await db
		.update(users)
		.set({
			honchoPeerVersion: nextVersion,
			updatedAt: new Date(),
		})
		.where(eq(users.id, userId));

	deletePeerCacheEntries(userId, currentVersion);
	deletePeerCacheEntries(userId, nextVersion);
	honchoPeerVersionCache.set(userId, nextVersion);
	clearHonchoCaches({ userId });
	return nextVersion;
}

async function getSession(userId: string, conversationId: string): Promise<Session> {
	const version = await getHonchoPeerVersion(userId);
	const honchoSessionId = getHonchoSessionId(userId, conversationId, version);
	const cached = sessionCache.get(honchoSessionId);
	if (cached) {
		const cachedOwner = sessionOwnerCache.get(honchoSessionId);
		if (!cachedOwner || cachedOwner === userId) {
			if (!cachedOwner) {
				sessionOwnerCache.set(honchoSessionId, userId);
			}
			return cached;
		}

		sessionCache.delete(honchoSessionId);
		sessionOwnerCache.delete(honchoSessionId);
	}

	const honcho = await ensureClient();
	const session = await honcho.session(honchoSessionId);
	const userPeer = await getUserPeer(userId);
	const assistantPeer = await getAssistantPeer(userId);

	try {
		await session.setMetadata({
			alfyaiConversationId: conversationId,
			alfyaiUserId: userId,
			alfyaiHonchoIdentityNamespace: getConfig().honchoIdentityNamespace,
			alfyaiHonchoPeerVersion: version,
		});
		await session.setPeers([
			[userPeer.id, { observeMe: true, observeOthers: false }],
			[assistantPeer.id, { observeMe: false, observeOthers: true }],
		]);
	} catch (err: any) {
		const is404 = err?.status === 404 || err?.code === 'not_found';
		if (is404) {
			console.warn(`[HONCHO] Session ${honchoSessionId} not yet created — will be initialized on first message`);
		} else {
			console.error('[HONCHO] Failed to attach peers to session:', err);
		}
	}

	sessionCache.set(honchoSessionId, session);
	sessionOwnerCache.set(honchoSessionId, userId);
	return session;
}

export async function getOrCreateSession(userId: string, conversationId: string): Promise<string> {
	const session = await getSession(userId, conversationId);
	return session.id;
}

export async function mirrorMessage(
	userId: string,
	conversationId: string,
	role: 'user' | 'assistant',
	content: string
): Promise<void> {
	if (!isHonchoEnabled() || !content.trim()) return;

	const session = await getSession(userId, conversationId);
	const peer = role === 'assistant'
		? await getAssistantPeer(userId)
		: await getUserPeer(userId);

	await session.addMessages(
		peer.message(content, {
			metadata: {
				role,
				alfyaiConversationId: conversationId,
				alfyaiUserId: userId,
				alfyaiHonchoIdentityNamespace: getConfig().honchoIdentityNamespace,
			},
		})
	);
}

export async function syncArtifactToHoncho(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	file?: File;
	fallbackTextArtifact?: Artifact | null;
}): Promise<{ uploaded: boolean; mode: 'native' | 'normalized' | 'none' }> {
	if (!isHonchoEnabled()) {
		return { uploaded: false, mode: 'none' };
	}

	// Skip Honcho sync if no conversation is attached.
	if (params.conversationId == null || params.conversationId.trim() === '') {
		return { uploaded: false, mode: 'none' };
	}

	const session = await getSession(params.userId, params.conversationId);
	const userPeer = await getUserPeer(params.userId);

	// When extracted text (fallbackTextArtifact) is available, prefer it for Honcho sync
	// instead of attempting native upload of potentially large binary files.
	// Honcho has a ~5MB file size limit, and extracted text is more useful for memory.
	const fallbackArtifact = params.fallbackTextArtifact;
	if (fallbackArtifact?.contentText?.trim()) {
		try {
			const clipped = clipText(fallbackArtifact.contentText, 50_000);
			await session.addMessages(
				userPeer.message(clipped, {
					metadata: {
						role: 'user',
						artifactId: fallbackArtifact.id,
						artifactType: fallbackArtifact.type,
						sourceArtifactId: params.artifact.id,
						alfyaiConversationId: params.conversationId,
						alfyaiUserId: params.userId,
						alfyaiHonchoIdentityNamespace: getConfig().honchoIdentityNamespace,
					},
				})
			);
			return { uploaded: true, mode: 'normalized' };
		} catch (error) {
			console.error('[HONCHO] Fallback text sync failed:', error);
		}
	}

	const nativeMimeType = (params.file?.type || params.artifact.mimeType || 'application/octet-stream')
		.trim()
		.toLowerCase();
	const nativeUploadSupported =
		HONCHO_NATIVE_UPLOAD_ALLOWED_MIME_TYPES.has(nativeMimeType) ||
		HONCHO_NATIVE_UPLOAD_ALLOWED_MIME_PREFIXES.some((prefix) => nativeMimeType.startsWith(prefix));

	if (!nativeUploadSupported) {
		return { uploaded: false, mode: 'none' };
	}

	try {
		if (params.file) {
			await session.uploadFile(params.file, userPeer, {
				metadata: {
					role: 'user',
					artifactId: params.artifact.id,
					artifactType: params.artifact.type,
					alfyaiConversationId: params.conversationId,
					alfyaiUserId: params.userId,
					alfyaiHonchoIdentityNamespace: getConfig().honchoIdentityNamespace,
				},
			});
			return { uploaded: true, mode: 'native' };
		}
		if (params.artifact.storagePath) {
			const buffer = await readFile(join(process.cwd(), params.artifact.storagePath));
			await session.uploadFile(
				{
					filename: params.artifact.name,
					content: buffer,
					content_type: nativeMimeType,
				},
				userPeer,
				{
					metadata: {
						role: 'user',
						artifactId: params.artifact.id,
						artifactType: params.artifact.type,
						alfyaiConversationId: params.conversationId,
						alfyaiUserId: params.userId,
						alfyaiHonchoIdentityNamespace: getConfig().honchoIdentityNamespace,
					},
				}
			);
			return { uploaded: true, mode: 'native' };
		}
	} catch (error) {
		console.error('[HONCHO] Native artifact upload failed:', error);
	}

	return { uploaded: false, mode: 'none' };
}

export async function mirrorWorkCapsuleConclusion(params: {
	userId: string;
	conversationId: string;
	content: string;
}): Promise<void> {
	if (!isHonchoEnabled() || !params.content.trim()) return;
	try {
		const peer = await getUserPeer(params.userId);
		const version = await getHonchoPeerVersion(params.userId);
		await peer.conclusions.create({
			content: truncateToTokenBudget(params.content, 800),
			sessionId: getHonchoSessionId(params.userId, params.conversationId, version),
		});
	} catch (error) {
		if (isHonchoMissingError(error)) {
			console.warn('[HONCHO] Skipped mirroring work capsule — session not found (may have been cleaned up during retry)');
			return;
		}
		console.error('[HONCHO] Failed to mirror work capsule conclusion:', error);
	}
}

function isHonchoMissingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(message);
}

async function listPeerSessions(peer: Peer): Promise<Session[]> {
	try {
		const page = await peer.sessions();
		return await page.toArray();
	} catch (error) {
		if (isHonchoMissingError(error)) return [];
		throw error;
	}
}

async function listScopeConclusions(
	scope: ConclusionScope,
	sessionId?: string
): Promise<Array<{ id: string; content: string; sessionId: string | null; createdAt: string }>> {
	try {
		const page = await scope.list(sessionId ? { session: sessionId } : undefined);
		return await page.toArray();
	} catch (error) {
		if (isHonchoMissingError(error)) return [];
		throw error;
	}
}

async function deleteScopeConclusions(
	scope: ConclusionScope,
	conclusionIds: string[]
): Promise<void> {
	for (const conclusionId of conclusionIds) {
		try {
			await scope.delete(conclusionId);
		} catch (error) {
			if (isHonchoMissingError(error)) continue;
			throw error;
		}
	}
}

async function clearPeerCard(peer: Peer, target?: string | Peer): Promise<void> {
	try {
		await peer.setCard([], target);
	} catch (error) {
		if (isHonchoMissingError(error)) return;
		throw error;
	}
}

async function clearAllPeerCards(userPeer: Peer, assistantPeer: Peer): Promise<void> {
	await Promise.all([
		clearPeerCard(userPeer),
		clearPeerCard(assistantPeer),
		clearPeerCard(userPeer, assistantPeer),
		clearPeerCard(assistantPeer, userPeer),
	]);
}

async function deleteHonchoSession(sessionId: string): Promise<void> {
	try {
		const honcho = await ensureClient();
		const session = await honcho.session(sessionId);
		await session.delete();
	} catch (error) {
		if (!isHonchoMissingError(error)) {
			throw error;
		}
	} finally {
		sessionCache.delete(sessionId);
		sessionOwnerCache.delete(sessionId);
	}
}

function clearPeerContextCacheForUser(userId: string): void {
	for (const cacheKey of peerContextCache.keys()) {
		if (cacheKey === userId || cacheKey.startsWith(`${userId}:`)) {
			peerContextCache.delete(cacheKey);
		}
	}
}

export function clearHonchoCaches(params: { userId?: string; conversationId?: string }): void {
	if (params.userId) {
		const cachedVersion = honchoPeerVersionCache.get(params.userId);
		deletePeerCacheEntries(params.userId, 0);
		clearPeerContextCacheForUser(params.userId);
		if (typeof cachedVersion === 'number' && cachedVersion !== 0) {
			deletePeerCacheEntries(params.userId, cachedVersion);
		}
		for (const [sessionId, ownerUserId] of sessionOwnerCache.entries()) {
			if (ownerUserId !== params.userId) continue;
			sessionOwnerCache.delete(sessionId);
			sessionCache.delete(sessionId);
		}
	}

	if (params.conversationId) {
		sessionCache.delete(params.conversationId);
		sessionOwnerCache.delete(params.conversationId);
		if (params.userId) {
			const cachedVersion = honchoPeerVersionCache.get(params.userId);
			const versions = new Set([0, cachedVersion].filter((value): value is number => typeof value === 'number'));
			for (const version of versions) {
				const honchoSessionId = getHonchoSessionId(params.userId, params.conversationId, version);
				sessionCache.delete(honchoSessionId);
				sessionOwnerCache.delete(honchoSessionId);
			}
		}
	}
}

function normalizeConclusionTimestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

export type HonchoPersonaMemoryRecord = {
	id: string;
	content: string;
	scope: 'self' | 'assistant_about_user';
	sessionId: string | null;
	createdAt: number;
};

async function listVisiblePersonaMemoryRecords(userId: string): Promise<HonchoPersonaMemoryRecord[]> {
	if (!isHonchoEnabled()) return [];

	const [userPeer, assistantPeer] = await Promise.all([
		getUserPeer(userId),
		getAssistantPeer(userId),
	]);
	const assistantAboutUserScope = assistantPeer.conclusionsOf(userPeer);

	const [selfConclusions, assistantAboutUserConclusions] = await Promise.all([
		listScopeConclusions(userPeer.conclusions),
		listScopeConclusions(assistantAboutUserScope),
	]);

	return [
		...selfConclusions.map((item) => ({
			id: item.id,
			content: item.content,
			scope: 'self' as const,
			sessionId: item.sessionId,
			createdAt: normalizeConclusionTimestamp(item.createdAt),
		})),
		...assistantAboutUserConclusions.map((item) => ({
			id: item.id,
			content: item.content,
			scope: 'assistant_about_user' as const,
			sessionId: item.sessionId,
			createdAt: normalizeConclusionTimestamp(item.createdAt),
		})),
	].sort((a, b) => b.createdAt - a.createdAt);
}

export async function listPersonaMemories(userId: string): Promise<HonchoPersonaMemoryRecord[]> {
	return listVisiblePersonaMemoryRecords(userId);
}

function sanitizePersonaMemoryText(text: string, userId: string, userDisplayName?: string | null): string {
	const replacement = userDisplayName?.trim() || 'the user';
	let sanitized = text.trim();
	const candidateIds = new Set<string>([
		userId,
		getHonchoUserPeerId(userId),
		getHonchoAssistantPeerId(userId),
		getLegacyHonchoUserPeerId(userId, 0),
		getLegacyHonchoAssistantPeerId(userId, 0),
	]);

	for (const candidateId of candidateIds) {
		if (!candidateId) continue;
		sanitized = sanitized.split(candidateId).join(replacement);
	}

	return sanitized.replace(/\s+/g, ' ').trim();
}

function serializePersonaMemoryRecordsForPrompt(
	records: HonchoPersonaMemoryRecord[],
	userId: string,
	userDisplayName?: string | null
): string | null {
	const seen = new Set<string>();
	const lines = records
		.map((record) => sanitizePersonaMemoryText(record.content, userId, userDisplayName))
		.filter((content) => {
			const key = content.toLowerCase();
			if (!content || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 12)
		.map((content) => `- ${content}`);

	if (lines.length === 0) return null;

	return truncateToTokenBudget(
		['Scoped user memory from Honcho conclusions:', ...lines].join('\n'),
		1400
	);
}

export async function forgetPersonaMemory(userId: string, conclusionId: string): Promise<boolean> {
	if (!isHonchoEnabled()) return false;

	const [userPeer, assistantPeer] = await Promise.all([
		getUserPeer(userId),
		getAssistantPeer(userId),
	]);
	const assistantAboutUserScope = assistantPeer.conclusionsOf(userPeer);
	const records = await listVisiblePersonaMemoryRecords(userId);
	const record = records.find((item) => item.id === conclusionId);
	if (!record) return false;

	if (record.scope === 'self') {
		await deleteScopeConclusions(userPeer.conclusions, [conclusionId]);
	} else {
		await deleteScopeConclusions(assistantAboutUserScope, [conclusionId]);
	}
	return true;
}

export async function forgetAllPersonaMemories(userId: string): Promise<number> {
	if (!isHonchoEnabled()) return 0;

	const [userPeer, assistantPeer] = await Promise.all([
		getUserPeer(userId),
		getAssistantPeer(userId),
	]);
	const assistantAboutUserScope = assistantPeer.conclusionsOf(userPeer);
	const records = await listVisiblePersonaMemoryRecords(userId);
	const selfIds = records.filter((item) => item.scope === 'self').map((item) => item.id);
	const assistantIds = records
		.filter((item) => item.scope === 'assistant_about_user')
		.map((item) => item.id);

	await Promise.all([
		deleteScopeConclusions(userPeer.conclusions, selfIds),
		deleteScopeConclusions(assistantAboutUserScope, assistantIds),
	]);
	await clearAllPeerCards(userPeer, assistantPeer);

	return records.length;
}

export async function deleteConversationHonchoState(userId: string, conversationId: string): Promise<void> {
	if (!isHonchoEnabled()) {
		clearHonchoCaches({ conversationId, userId });
		return;
	}

	const version = await getHonchoPeerVersion(userId);
	const honchoSessionId = getHonchoSessionId(userId, conversationId, version);
	const [userPeer, assistantPeer] = await Promise.all([
		getUserPeer(userId),
		getAssistantPeer(userId),
	]);
	const scopes = [
		userPeer.conclusions,
		assistantPeer.conclusions,
		userPeer.conclusionsOf(assistantPeer),
		assistantPeer.conclusionsOf(userPeer),
	];

	for (const scope of scopes) {
		const conclusions = [
			...(await listScopeConclusions(scope, honchoSessionId)),
			...(await listScopeConclusions(scope, conversationId)),
		];
		await deleteScopeConclusions(
			scope,
			Array.from(new Set(conclusions.map((item) => item.id)))
		);
	}

	await deleteHonchoSession(honchoSessionId);
	await deleteHonchoSession(conversationId);
	clearHonchoCaches({ conversationId, userId });
}

export async function deleteAllHonchoStateForUser(userId: string): Promise<void> {
	if (!isHonchoEnabled()) {
		clearHonchoCaches({ userId });
		return;
	}

	const [userPeer, assistantPeer] = await Promise.all([
		getUserPeer(userId),
		getAssistantPeer(userId),
	]);
	const crossScopes = [
		userPeer.conclusions,
		assistantPeer.conclusions,
		userPeer.conclusionsOf(assistantPeer),
		assistantPeer.conclusionsOf(userPeer),
	];

	for (const scope of crossScopes) {
		const conclusions = await listScopeConclusions(scope);
		await deleteScopeConclusions(
			scope,
			conclusions.map((item) => item.id)
		);
	}

	const sessions = new Map<string, Session>();
	for (const session of await listPeerSessions(userPeer)) {
		sessions.set(session.id, session);
	}
	for (const session of await listPeerSessions(assistantPeer)) {
		sessions.set(session.id, session);
	}

	for (const sessionId of sessions.keys()) {
		await deleteHonchoSession(sessionId);
	}

	await clearAllPeerCards(userPeer, assistantPeer);
	clearHonchoCaches({ userId });
}

type PromptContextMessage = {
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
};

function mapHonchoMessagesToPromptContext(
	messages: Message[],
	userId: string
): PromptContextMessage[] {
	return messages
		.map((message) => ({
			role: roleForMessage(message, userId),
			content: message.content,
			createdAt: Date.parse(message.createdAt),
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
}

function mapStoredMessagesToPromptContext(messages: ChatMessage[]): PromptContextMessage[] {
	return messages
		.map((message) => ({
			role: message.role,
			content: message.content,
			createdAt: message.timestamp,
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
}

async function loadFallbackPromptContextMessages(
	conversationId: string
): Promise<PromptContextMessage[]> {
	return mapStoredMessagesToPromptContext(await listMessages(conversationId));
}

type TimedResolution<T> = {
	value: T | null;
	timedOut: boolean;
	error: unknown | null;
};

type LoadedSessionPromptContext = {
	sessionMessages: PromptContextMessage[];
	summary: string | null;
	peerContext: string;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
};

function mapSnapshotMessagesToPromptContext(
	messages: HonchoContextSnapshot['messages']
): PromptContextMessage[] {
	return messages
		.map((message) => ({
			role: message.role,
			content: message.content,
			createdAt: message.createdAt,
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
}

function createHonchoSnapshot(params: {
	summary: string | null;
	messages: PromptContextMessage[];
}): HonchoContextSnapshot | null {
	const normalizedMessages = params.messages
		.filter((message) => message.content.trim())
		.map((message) => ({
			role: message.role,
			content: message.content,
			createdAt: message.createdAt,
		}));
	const summary = params.summary?.trim() ? params.summary.trim() : null;

	if (normalizedMessages.length === 0 && !summary) {
		return null;
	}

	return {
		createdAt: Date.now(),
		summary,
		messages: normalizedMessages,
	};
}

async function resolveWithTimeout<T>(
	promise: Promise<T>,
	params: {
		timeoutMs?: number;
		label: string;
		conversationId?: string;
		userId?: string;
	}
): Promise<TimedResolution<T>> {
	const timeoutMs = Math.max(1, params.timeoutMs ?? getConfig().honchoContextWaitMs);
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	try {
		const outcome = await Promise.race([
			promise
				.then((value) => ({ kind: 'value' as const, value }))
				.catch((error) => ({ kind: 'error' as const, error })),
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
			}),
		]);

		if (outcome.kind === 'value') {
			return { value: outcome.value, timedOut: false, error: null };
		}

		if (outcome.kind === 'error') {
			return { value: null, timedOut: false, error: outcome.error };
		}

		console.warn('[CONTEXT] Timed out waiting for Honcho context', {
			label: params.label,
			conversationId: params.conversationId,
			userId: params.userId,
			timeoutMs,
		});
		return { value: null, timedOut: true, error: null };
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

async function loadPersonaContext(params: {
	userId: string;
	conversationId: string;
	message: string;
}): Promise<string> {
	const personaTimeoutMs = Math.max(0, getConfig().honchoPersonaContextWaitMs);
	const result = await resolveWithTimeout(
		getPeerContext(params.userId, undefined, { timeoutMs: personaTimeoutMs }),
		{
			timeoutMs: personaTimeoutMs,
			label: 'persona prompt context',
			conversationId: params.conversationId,
			userId: params.userId,
		}
	);

	return typeof result.value === 'string' ? result.value : '';
}

async function loadSessionPromptContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	liveContextTokens?: number;
}): Promise<LoadedSessionPromptContext> {
	const [fallbackSessionMessages, latestHonchoMetadata] = await Promise.all([
		loadFallbackPromptContextMessages(params.conversationId).catch(() => []),
		getLatestHonchoMetadata(params.conversationId).catch(() => ({
			honchoContext: null,
			honchoSnapshot: null,
		})),
	]);

	if (!isHonchoEnabled()) {
		return {
			sessionMessages: fallbackSessionMessages,
			summary: null,
			peerContext: '',
			honchoContext: null,
			honchoSnapshot: latestHonchoMetadata.honchoSnapshot,
		};
	}

	const hasStoredSessionContext =
		fallbackSessionMessages.length > 0 ||
		Boolean(latestHonchoMetadata.honchoSnapshot?.summary?.trim()) ||
		Boolean(latestHonchoMetadata.honchoSnapshot?.messages?.length);
	if (!hasStoredSessionContext) {
		return {
			sessionMessages: [],
			summary: null,
			peerContext: await loadPersonaContext(params),
			honchoContext: {
				source: 'persisted_fallback',
				waitedMs: 0,
				queuePendingWorkUnits: 0,
				queueInProgressWorkUnits: 0,
				fallbackReason: 'empty_live_context',
				snapshotCreatedAt: null,
			},
			honchoSnapshot: latestHonchoMetadata.honchoSnapshot,
		};
	}

	const startedAt = Date.now();
	const fallbackToStoredContext = async (
		source: HonchoContextInfo['source'],
		fallbackReason: HonchoContextInfo['fallbackReason']
	): Promise<LoadedSessionPromptContext> => {
		const snapshot = latestHonchoMetadata.honchoSnapshot;
		const sessionMessages = snapshot
			? mapSnapshotMessagesToPromptContext(snapshot.messages)
			: fallbackSessionMessages;
		const summary = snapshot?.summary ?? null;
		const peerContext = await loadPersonaContext(params);
		const waitedMs = Date.now() - startedAt;

		return {
			sessionMessages,
			summary,
			peerContext,
			honchoContext: {
				source,
				waitedMs,
				queuePendingWorkUnits: 0,
				queueInProgressWorkUnits: 0,
				fallbackReason,
				snapshotCreatedAt: snapshot?.createdAt ?? null,
			},
			honchoSnapshot: snapshot,
		};
	};

	const sessionResult = await resolveWithTimeout(
		getSession(params.userId, params.conversationId),
		{
			label: 'Honcho session bootstrap',
			conversationId: params.conversationId,
			userId: params.userId,
		}
	);

	if (!sessionResult.value) {
		return fallbackToStoredContext(
			latestHonchoMetadata.honchoSnapshot ? 'snapshot' : 'persisted_fallback',
			sessionResult.timedOut ? 'timeout' : 'context_error'
		);
	}

	const peersResult = await resolveWithTimeout(
		Promise.all([getUserPeer(params.userId), getAssistantPeer(params.userId)]),
		{
			label: 'Honcho peer bootstrap',
			conversationId: params.conversationId,
			userId: params.userId,
		}
	);

	if (!peersResult.value) {
		return fallbackToStoredContext(
			latestHonchoMetadata.honchoSnapshot ? 'snapshot' : 'persisted_fallback',
			peersResult.timedOut ? 'timeout' : 'context_error'
		);
	}

	const [userPeer, assistantPeer] = peersResult.value;
	const liveContextResult = await resolveWithTimeout(
		sessionResult.value.context({
			summary: true,
			tokens: Math.max(
				HONCHO_LIVE_CONTEXT_TOKENS,
				Math.floor(params.liveContextTokens ?? HONCHO_LIVE_CONTEXT_TOKENS),
			),
			peerTarget: userPeer,
			peerPerspective: assistantPeer,
			limitToSession: true,
		}),
		{
			label: 'Honcho session context',
			conversationId: params.conversationId,
			userId: params.userId,
		}
	);

	if (!liveContextResult.value) {
		return fallbackToStoredContext(
			latestHonchoMetadata.honchoSnapshot ? 'snapshot' : 'persisted_fallback',
			liveContextResult.timedOut ? 'timeout' : 'context_error'
		);
	}

	const sessionMessages = mapHonchoMessagesToPromptContext(
		liveContextResult.value.messages,
		params.userId
	);
	const summary = liveContextResult.value.summary?.content?.trim()
		? liveContextResult.value.summary.content.trim()
		: null;

	if (sessionMessages.length === 0 && !summary) {
		return fallbackToStoredContext(
			latestHonchoMetadata.honchoSnapshot ? 'snapshot' : 'persisted_fallback',
			'empty_live_context'
		);
	}

	const peerContext = await loadPersonaContext(params);
	const honchoSnapshot = createHonchoSnapshot({
		summary,
		messages: sessionMessages,
	});

	return {
		sessionMessages,
		summary,
		peerContext,
		honchoContext: {
			source: 'live',
			waitedMs: Date.now() - startedAt,
			queuePendingWorkUnits: 0,
			queueInProgressWorkUnits: 0,
			fallbackReason: null,
			snapshotCreatedAt: honchoSnapshot?.createdAt ?? null,
		},
		honchoSnapshot,
	};
}


export async function buildConstructedContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	modelId?: string;
	contextLimits?: {
		maxModelContext: number;
		compactionUiThreshold: number;
		targetConstructedContext: number;
	};
}): Promise<{
	inputValue: string;
	contextStatus: ConversationContextStatus;
	taskState: import('$lib/types').TaskState | null;
	contextDebug: ContextDebugState | null;
	honchoContext: HonchoContextInfo | null;
	honchoSnapshot: HonchoContextSnapshot | null;
	contextTraceSections: LegacyContextTraceSectionInput[];
}> {
	const attachmentIds = params.attachmentIds ?? [];
	const targetBudget =
		params.contextLimits?.targetConstructedContext ??
		getTargetConstructedContext(params.modelId);
	const compactionThreshold =
		params.contextLimits?.compactionUiThreshold ??
		getCompactionUiThreshold(params.modelId);
	const maxModelContext =
		params.contextLimits?.maxModelContext ?? getMaxModelContext(params.modelId);
	const modelContextBudget = deriveModelContextBudget({
		maxModelContext,
		targetConstructedContext: targetBudget,
		compactionUiThreshold: compactionThreshold,
	});
	const sessionHistoryBudget = deriveSessionHistoryBudget({
		contextBudget: modelContextBudget,
		minTotalBudget: HONCHO_LIVE_CONTEXT_TOKENS,
		minRecentTurnCount: RECENT_TURN_COUNT,
		minUnmatchedRecentTurnTokens: UNMATCHED_RECENT_TURN_TOKEN_LIMIT,
	});
	const [
		sessionContext,
		resolvedAttachments,
		conversationSourceArtifactIds,
		workingSetArtifacts,
		projectFolderLabel,
		projectFolderReferenceContext,
		projectFolderSiblingPromotion,
	] =
		await Promise.all([
			loadSessionPromptContext({
				userId: params.userId,
				conversationId: params.conversationId,
				message: params.message,
				liveContextTokens: sessionHistoryBudget.totalBudget,
			}),
			resolvePromptAttachmentArtifacts(params.userId, attachmentIds),
			listConversationSourceArtifactIds(params.userId, params.conversationId).catch(
				() => []
			),
			selectWorkingSetArtifactsForPrompt(
				params.userId,
				params.conversationId,
				params.message,
				attachmentIds,
				params.activeDocumentArtifactId
			).catch(() => []),
			getConversationProjectLabel(params.userId, params.conversationId).catch(() => null),
			getProjectFolderReferenceContext({
				userId: params.userId,
				conversationId: params.conversationId,
			}).catch(() => null),
			selectProjectFolderSiblingPromotion({
				userId: params.userId,
				conversationId: params.conversationId,
				query: params.message,
			}).catch(() => null),
		]);
	const {
		sessionMessages,
		summary: sessionSummary,
		peerContext,
		honchoContext,
		honchoSnapshot,
	} = sessionContext;
	const currentAttachments = resolvedAttachments.promptArtifacts;
	const currentAttachmentIds = new Set(currentAttachments.map((artifact) => artifact.id));
	const requestedAttachmentIds = new Set(attachmentIds);
	const carriedForwardSourceIds = conversationSourceArtifactIds.filter(
		(artifactId) =>
			!requestedAttachmentIds.has(artifactId) && !currentAttachmentIds.has(artifactId)
	);
	const carriedForwardResolution =
		carriedForwardSourceIds.length > 0
			? await resolvePromptAttachmentArtifacts(
					params.userId,
					carriedForwardSourceIds
				).catch(() => ({
					displayArtifacts: [],
					promptArtifacts: [],
					items: [],
					unresolvedItems: [],
				}))
			: null;
	const resolvedCarriedForwardAttachments = (carriedForwardResolution?.promptArtifacts ?? [])
		.filter((artifact) => !currentAttachmentIds.has(artifact.id));
	if (attachmentIds.length > 0 && getConfig().contextDiagnosticsDebug) {
		console.info('[CONTEXT] Attachment resolution', {
			conversationId: params.conversationId,
			requestedAttachmentIds: attachmentIds,
			displayArtifactCount: resolvedAttachments.displayArtifacts.length,
			promptArtifactCount: currentAttachments.length,
			unresolvedAttachmentIds: resolvedAttachments.unresolvedItems.map(
				(item) => item.requestedArtifactId
			),
		});
	}
	if (resolvedAttachments.unresolvedItems.length > 0) {
		throw new AttachmentReadinessError(
			'One or more attached files could not be prepared for chat. Remove the file or upload a supported text-readable document.',
			resolvedAttachments.unresolvedItems.map((item) => item.requestedArtifactId)
		);
	}
	const retrievalActiveDocumentState = buildActiveDocumentState({
		artifacts: dedupeById([...currentAttachments, ...workingSetArtifacts]),
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		currentConversationId: params.conversationId,
	});

	let currentMessageEmbedding: number[] = [];
	let previousMessageEmbedding: number[] = [];
	const previousUserMessage = sessionMessages
		.slice()
		.reverse()
		.find((m) => m.role === 'user')?.content;

	if (previousUserMessage && params.message) {
		try {
			const embeddingsPromise = embedTexts([params.message, previousUserMessage]);
			const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
			const embeddingsResult = await Promise.race([embeddingsPromise, timeoutPromise]);
			if (embeddingsResult && embeddingsResult.length >= 2) {
				currentMessageEmbedding = embeddingsResult[0] ?? [];
				previousMessageEmbedding = embeddingsResult[1] ?? [];
			}
		} catch (error) {
			console.warn('[CONTEXT] Failed to generate topic shift embeddings:', error);
		}
	}

	const topicShift = detectTopicShift({
		currentMessageEmbedding,
		previousMessageEmbedding,
	});

	const suppressCarryover = shouldSuppressCarryover({
		isShift: topicShift.isShift,
		hasExplicitResetSignal: retrievalActiveDocumentState.hasContextResetSignal,
		turnsSinceLastShift: 0,
	});
	const carriedForwardAttachments = suppressCarryover
		? []
		: resolvedCarriedForwardAttachments;
	const allAttachmentContextIds = new Set([
		...attachmentIds,
		...currentAttachments.map((artifact) => artifact.id),
		...(suppressCarryover ? [] : carriedForwardSourceIds),
		...carriedForwardAttachments.map((artifact) => artifact.id),
	]);

	const relevantArtifacts = await findRelevantKnowledgeArtifacts({
		userId: params.userId,
		query: params.message,
		excludeConversationId: params.conversationId,
		currentConversationId: params.conversationId,
		limit: deriveRelevantKnowledgeArtifactLimit(targetBudget),
		preferredArtifactId:
			retrievalActiveDocumentState.currentGeneratedArtifactId ??
			params.activeDocumentArtifactId,
		preferredGeneratedFamilyId:
			retrievalActiveDocumentState.recentlyRefinedFamilyId ?? null,
		suppressGeneratedCarryover: suppressCarryover,
	}).catch(() => []);
	const activeDocumentState = buildActiveDocumentState({
		artifacts: dedupeById([...currentAttachments, ...workingSetArtifacts, ...relevantArtifacts]),
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		currentConversationId: params.conversationId,
	});
	const documentFocused = activeDocumentState.documentFocused;

	const preparedContext = await prepareTaskContext({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		targetConstructedContext: targetBudget,
		currentAttachments,
		workingSetArtifacts,
		relevantArtifacts,
	}).catch(() => ({
		taskState: null,
		routingStage: 'deterministic' as const,
		routingConfidence: 0,
		verificationStatus: 'fallback' as const,
		selectedArtifacts: dedupeById([...currentAttachments, ...workingSetArtifacts]),
		pinnedArtifactIds: [],
		excludedArtifactIds: [],
	}));
	const taskState = preparedContext.taskState;
	const selectedEvidence = preparedContext.selectedArtifacts.filter(
		(artifact) => !allAttachmentContextIds.has(artifact.id)
	);
	const pinnedArtifactIds = new Set(preparedContext.pinnedArtifactIds);

	const promptArtifacts = new Map<string, Artifact>();
	for (const artifact of [
		...currentAttachments,
		...carriedForwardAttachments,
		...selectedEvidence,
	]) {
		promptArtifacts.set(artifact.id, artifact);
	}
	const artifactSnippets = await getPromptArtifactSnippets({
		userId: params.userId,
		artifacts: Array.from(promptArtifacts.values()),
		query: params.message,
		perArtifactLimit: documentFocused ? 8 : 2,
		perArtifactCharBudget: documentFocused ? 12000 : 1400,
		useFullContent: true,
	}).catch(() => new Map<string, string>());

	const allTurns = selectRecentRoleTurns(
		sessionMessages,
		(message) => message.role,
		sessionMessages.length
	);

	const filteredTurns = selectPromptSessionTurns({
		turns: allTurns,
		message: params.message,
		resolveContent: (turn) => turn.messages.map((m) => m.content).join(' '),
		scoreTurn: (message, turnContent) => scoreMatch(message, turnContent),
		recentTurnCount: sessionHistoryBudget.recentTurnCount,
		maxUnmatchedRecentTurnTokens:
			sessionHistoryBudget.maxUnmatchedRecentTurnTokens,
	});

	const recentTurnCount = filteredTurns.length;
	const sessionContextMessages = filteredTurns.flatMap((turn) => turn.messages);
	const sections: PromptContextSection[] = [];
	const projectFolderSection = buildProjectFolderPromptSection(projectFolderLabel);
	const projectFolderAwarenessSection = buildProjectFolderAwarenessPromptSection(
		projectFolderReferenceContext
	);
	const projectFolderSiblingSection = buildProjectFolderSiblingPromptSection(
		projectFolderSiblingPromotion
	);

	if (projectFolderSection) {
		sections.push(projectFolderSection);
	}
	if (projectFolderAwarenessSection) {
		sections.push(projectFolderAwarenessSection);
	}
	if (projectFolderSiblingSection) {
		sections.push(projectFolderSiblingSection);
	}

	if (taskState) {
		sections.push({
			title: 'Task State',
			body: formatTaskStateForPrompt(taskState),
			layer: 'task_state',
			protected: true,
		});
	}

	const attachmentContext =
		currentAttachments.length > 0
			? serializeBudgetedAttachments({
					artifacts: currentAttachments,
					snippets: buildCurrentAttachmentSnippetMap({
						artifacts: currentAttachments,
						snippets: artifactSnippets,
					}),
					message: params.message,
					...deriveCurrentTurnAttachmentBudget({
						contextBudget: modelContextBudget,
						attachmentCount: currentAttachments.length,
						minTotalBudget: ATTACHMENT_PROMPT_TOKEN_BUDGET,
						minPerAttachmentBudget:
							documentFocused
								? ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET
								: ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET,
					}),
				})
			: null;
	const serializedCurrentAttachments = attachmentContext?.body ?? '';
	const serializedAttachmentBody = extractSerializedAttachmentBody(serializedCurrentAttachments);

	if (currentAttachments.length > 0) {
		logAttachmentTrace('constructed_context', {
			traceId: params.attachmentTraceId ?? null,
			conversationId: params.conversationId,
			emitted: true,
			promptArtifactIds: currentAttachments.map((artifact) => artifact.id),
			promptArtifactNames: currentAttachments.map((artifact) => artifact.name),
			sectionTokenEstimate: estimateTokenCount(serializedCurrentAttachments),
			...summarizeAttachmentTraceText(serializedAttachmentBody, 420),
		});
		if (!hasMeaningfulAttachmentText(serializedAttachmentBody)) {
			throw new AttachmentReadinessError(
				'Attached file content was missing from the constructed context. Remove the file and upload it again before sending.',
				attachmentIds
			);
		}
		sections.push({
			title: 'Current Attachments',
			body: serializedCurrentAttachments,
			layer: 'documents',
			protected: true,
		});
	}
	if (attachmentIds.length > 0) {
		if (getConfig().contextDiagnosticsDebug) {
			console.info('[CONTEXT] Attachment section emitted', {
				conversationId: params.conversationId,
				emitted: currentAttachments.length > 0,
				promptArtifactCount: currentAttachments.length,
			});
		}
		if (currentAttachments.length === 0) {
			logAttachmentTrace('constructed_context', {
				traceId: params.attachmentTraceId ?? null,
				conversationId: params.conversationId,
				emitted: false,
				promptArtifactIds: [],
				promptArtifactNames: [],
				sectionTokenEstimate: 0,
				contentLength: 0,
				contentPreview: null,
				contentHash: null,
			});
		}
	}

	const carriedForwardAttachmentContext =
		carriedForwardAttachments.length > 0
			? serializeBudgetedAttachments({
					artifacts: carriedForwardAttachments,
					snippets: buildCurrentAttachmentSnippetMap({
						artifacts: carriedForwardAttachments,
						snippets: artifactSnippets,
					}),
					message: params.message,
					...deriveExplicitSourceSetBudget({
						contextBudget: modelContextBudget,
						sourceCount: carriedForwardAttachments.length,
						minTotalBudget: ATTACHMENT_PROMPT_TOKEN_BUDGET,
						minPerSourceBudget:
							documentFocused
								? ATTACHMENT_TASK_PER_ATTACHMENT_TOKEN_BUDGET
								: ATTACHMENT_EXCERPT_PER_ATTACHMENT_TOKEN_BUDGET,
					}),
				})
			: null;
	if (carriedForwardAttachmentContext?.body) {
		sections.push({
			title: 'Attached Sources',
			body: carriedForwardAttachmentContext.body,
			layer: 'documents',
			protected: true,
		});
	}

	if (selectedEvidence.length > 0) {
		const evidenceBudget = deriveExplicitSourceSetBudget({
			contextBudget: modelContextBudget,
			sourceCount: selectedEvidence.length,
			minTotalBudget: WORKING_SET_PROMPT_TOKEN_BUDGET,
			minPerSourceBudget: Math.min(
				WORKING_SET_DOCUMENT_TOKEN_BUDGET,
				WORKING_SET_OUTPUT_TOKEN_BUDGET
			),
		});
		sections.push({
			title: 'Retrieved Evidence',
			body: serializeWorkingSetArtifacts({
				artifacts: selectedEvidence,
				snippets: artifactSnippets,
				totalBudget: evidenceBudget.totalBudget,
				documentBudget: evidenceBudget.perSourceBudget,
				outputBudget: evidenceBudget.perSourceBudget,
			}),
			layer: 'working_set',
			protected: selectedEvidence.some((artifact) => pinnedArtifactIds.has(artifact.id)),
		});
	}

	if (sessionSummary?.trim()) {
		sections.push({
			title: 'Session Summary',
			body: truncateToTokenBudget(sessionSummary, 1600),
			layer: 'session',
			llmCompactible: true,
		});
	}

	if (sessionContextMessages.length > 0) {
		sections.push({
			title: 'Honcho Session Context',
			body: truncateToTokenBudget(
				serializeRoleMessages(
					sessionContextMessages,
					(message) => message.role,
					(message) => message.content,
					sessionContextMessages.length
				),
				sessionHistoryBudget.totalBudget
			),
			layer: 'session',
			protected: true,
			llmCompactible: true,
		});
	}

	if (peerContext.trim()) {
		sections.push({
			title: 'User Memory',
			body: truncateToTokenBudget(peerContext, 1400),
			layer: 'session',
			llmCompactible: true,
		});
	}

	let effectiveSections = [
		...(await rerankHistoricalSections({
			enabled: canUseTeiReranker(),
			message: params.message,
			taskObjective: taskState?.objective ?? null,
			sections,
			rerankSections: async ({ query, candidates }) => {
				const reranked = await rerankItems({
					query,
					items: candidates,
					getText: (section) =>
						[
							section.title,
							section.layer ? `Layer: ${section.layer}` : null,
							truncateToTokenBudget(section.body, 240),
						]
							.filter((value): value is string => Boolean(value))
							.join('\n\n'),
					maxTexts: Math.min(6, candidates.length),
				});
				if (!reranked || reranked.items.length === 0) {
					return null;
				}

				const keepCount = Math.max(2, Math.min(4, Math.ceil(candidates.length / 2)));
				return {
					selectedTitles: reranked.items
						.slice(0, keepCount)
						.map(({ item }) => item.title),
					confidence: reranked.confidence,
				};
			},
			logPrefix: '[HONCHO]',
		}).catch(() => sections)),
	];

	const intro = suppressCarryover
		? 'You are receiving a compacted conversation context bundle. Use it as the working context for this turn.'
		: 'Context from your conversation history:';

	const selectedPromptContext = selectPromptContext({
		intro,
		message: params.message,
		candidates: buildContextSelectionCandidates({
			sections: effectiveSections,
			attachmentContext,
			carriedForwardAttachmentContext,
			projectFolderSiblingPromotion,
			evidenceItems: selectedEvidence.map((artifact) => ({
				id: artifact.id,
				title: artifact.name,
				pinned: pinnedArtifactIds.has(artifact.id),
			})),
		}),
		targetTokens: targetBudget,
		initialCompactionMode: 'none',
	});

	const status = await updateConversationContextStatus({
		conversationId: params.conversationId,
		userId: params.userId,
		estimatedTokens: selectedPromptContext.estimatedTokens,
		compactionApplied:
			selectedPromptContext.compactionApplied ||
			selectedPromptContext.compactionMode !== 'none',
		contextLimits: {
			maxModelContext,
			compactionUiThreshold: compactionThreshold,
			targetConstructedContext: targetBudget,
		},
		compactionMode: selectedPromptContext.compactionMode,
		routingStage: preparedContext.routingStage,
		routingConfidence: preparedContext.routingConfidence,
		verificationStatus: preparedContext.verificationStatus,
		layersUsed: selectedPromptContext.layersUsed,
		workingSetCount: selectedEvidence.length,
		workingSetArtifactIds: selectedEvidence.map((artifact) => artifact.id),
		workingSetApplied: selectedEvidence.length > 0,
		taskStateApplied: Boolean(taskState),
		promptArtifactCount: promptArtifacts.size,
		recentTurnCount,
		summary: sessionSummary || null,
	});

	return {
		inputValue: selectedPromptContext.inputValue,
		contextStatus: status,
		taskState,
		contextDebug: await getContextDebugState(params.userId, params.conversationId).catch(() => null),
		honchoContext,
		honchoSnapshot,
		contextTraceSections: selectedPromptContext.contextTraceSections,
	};
}

export async function getPeerContext(
	userId: string,
	userDisplayName?: string | null,
	options?: { timeoutMs?: number }
): Promise<string | null> {
	if (!isHonchoEnabled()) return null;

	const cacheKey = `${userId}:${userDisplayName ?? ''}`;
	const cached = peerContextCache.get(cacheKey);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.value;
	}

	try {
		const response = await resolveWithTimeout(
			listVisiblePersonaMemoryRecords(userId),
			{
				timeoutMs: Math.max(
					1,
					options?.timeoutMs ?? getConfig().honchoPersonaContextWaitMs
				),
				label: 'Honcho scoped persona conclusions',
				userId,
			}
		);

		let result: string | null = null;
		if (Array.isArray(response.value)) {
			result = serializePersonaMemoryRecordsForPrompt(response.value, userId, userDisplayName);
		} else if (response.error) {
			console.error('[HONCHO] getPeerContext failed:', response.error);
		}

		peerContextCache.set(cacheKey, { value: result, expiresAt: Date.now() + PEER_CONTEXT_CACHE_TTL_MS });
		return result;
	} catch (err) {
		console.error('[HONCHO] getPeerContext failed:', err);
		return null;
	}
}

export async function buildEnhancedSystemPrompt(
	promptName: string | undefined,
	params: {
		userId: string;
		displayName?: string | null;
		email?: string | null;
	}
): Promise<string> {
	const basePrompt = getSystemPrompt(promptName);
	const normalizedDisplayName = params.displayName?.trim() || null;
	const normalizedEmail = params.email?.trim() || null;
	const sections = [
		basePrompt,
		basePrompt ? '' : null,
		normalizedDisplayName || normalizedEmail
			? [
					'## User Profile',
					'The following account-level profile fields belong to the current human user.',
					normalizedDisplayName ? `Display Name: ${normalizedDisplayName}` : null,
					normalizedEmail ? `Email: ${normalizedEmail}` : null,
					'Use them for respectful personalization and direct address when helpful, especially early in a conversation before other memory exists.',
					'Do not infer extra biography, preferences, or private facts beyond these explicit fields.',
				]
						.filter((value): value is string => value !== null)
						.join('\n')
			: null,
		'## Retrieved Context Discipline',
		'Use any retrieved task state, recalled session details, documents, workflows, or evidence as supporting context only.',
		'User profile and persona memory describe the human user, not you.',
		'Never adopt the user\'s biography, preferences, education, profession, or life circumstances as your own identity.',
		'You remain AlfyAI, the assistant, even when memory says the user is a student, designer, applicant, or has other personal traits.',
		'Do not restate user-memory facts in first person unless the user is directly quoting themselves.',
		'Do not let stale or weakly related retrieved material steer the conversation.',
		'Do not proactively pivot to old recalled documents, recipes, files, or workflows unless the latest user turn clearly asks for them or they are directly relevant to the active task.',
		'If retrieved context conflicts with the current user intent, follow the current user intent and ignore the irrelevant retrieved material.',
		'When prior evidence is relevant, use it naturally without over-explaining that it was retrieved.',
	];

	return sections.filter((value): value is string => value !== null).join('\n');
}

export async function checkHealth(): Promise<{
	enabled: boolean;
	connected: boolean;
	workspace: string | null;
}> {
	if (!isHonchoEnabled()) {
		return { enabled: false, connected: false, workspace: null };
	}

	try {
		await ensureClient();
		const honcho = client!;
		await honcho.getMetadata();
		return {
			enabled: true,
			connected: true,
			workspace: getConfig().honchoWorkspace,
		};
	} catch {
		return {
			enabled: true,
			connected: false,
			workspace: getConfig().honchoWorkspace,
		};
	}
}
