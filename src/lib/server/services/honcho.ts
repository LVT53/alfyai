import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, Peer } from '@honcho-ai/sdk';
import { Honcho } from '@honcho-ai/sdk';
import type { ConclusionScope } from '@honcho-ai/sdk/dist/conclusions';
import type { Session } from '@honcho-ai/sdk/dist/session';
import { eq } from 'drizzle-orm';
import {
	serializePeerContext,
	truncateToTokenBudget,
} from '$lib/server/utils/prompt-context';
import { clipText } from '$lib/server/utils/text';
import type {
	Artifact,
	ChatMessage,
	ForkCopyMetadata,
	HonchoContextInfo,
	HonchoContextSnapshot,
} from '$lib/types';
import { getConfig } from '../config-store';
import { db } from '../db';
import { users } from '../db/schema';
import { getSystemPrompt } from '../prompts';
import type { ContextCompressionSourceMessage } from './context-compression';
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
const HONCHO_NATIVE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const HONCHO_ID_HASH_LENGTH = 32;

// Authority note:
// - Honcho is a semantic mirror/integration layer for sessions, peers, conclusions, and overview text
// - local persona-memory, task-state, and document-resolution remain authoritative for freshness-sensitive
//   truth, task continuity, and working-document identity

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
	} catch (err: unknown) {
		const honchoError = err && typeof err === 'object' ? (err as { code?: unknown; status?: unknown }) : {};
		const is404 = honchoError.status === 404 || honchoError.code === 'not_found';
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

	const nativeUploadSize = params.file?.size ?? params.artifact.sizeBytes ?? null;
	if (nativeUploadSize !== null && nativeUploadSize > HONCHO_NATIVE_UPLOAD_MAX_BYTES) {
		console.info('[HONCHO] Skipped native artifact upload above Honcho size limit', {
			artifactId: params.artifact.id,
			fileName: params.file?.name ?? params.artifact.name,
			sizeBytes: nativeUploadSize,
			maxBytes: HONCHO_NATIVE_UPLOAD_MAX_BYTES,
		});
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

export type PromptContextMessage = {
	id?: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	messageSequence?: number;
	forkCopy?: ForkCopyMetadata;
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

function mapStoredMessagesToPromptContextWithSequences(
	messages: ChatMessage[],
	sourceMessages: ContextCompressionSourceMessage[]
): PromptContextMessage[] {
	const sequenceByMessageId = new Map(
		sourceMessages.map((message) => [message.id, message.messageSequence])
	);
	return messages
		.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			createdAt: message.timestamp,
			messageSequence: sequenceByMessageId.get(message.id),
			forkCopy: message.forkCopy,
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
}

async function loadFallbackPromptContextMessages(
	conversationId: string
): Promise<PromptContextMessage[]> {
	const [storedMessages, sourceMessages] = await Promise.all([
		listMessages(conversationId),
		import('./context-compression')
			.then(({ listContextCompressionSourceMessages }) =>
				listContextCompressionSourceMessages(conversationId)
			)
			.catch(() => [] as ContextCompressionSourceMessage[]),
	]);

	return mapStoredMessagesToPromptContextWithSequences(
		storedMessages,
		sourceMessages
	);
}

type TimedResolution<T> = {
	value: T | null;
	timedOut: boolean;
	error: unknown | null;
};

export type HonchoPromptContext = {
	sessionMessages: PromptContextMessage[];
	storedMessages: PromptContextMessage[];
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
			forkCopy: message.forkCopy,
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
			forkCopy: message.forkCopy,
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

export async function loadHonchoPromptContext(params: {
	userId: string;
	conversationId: string;
	message: string;
	liveContextTokens?: number;
}): Promise<HonchoPromptContext> {
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
			storedMessages: fallbackSessionMessages,
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
			storedMessages: fallbackSessionMessages,
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
	): Promise<HonchoPromptContext> => {
		const snapshot = latestHonchoMetadata.honchoSnapshot;
		const snapshotMessages = snapshot
			? mapSnapshotMessagesToPromptContext(snapshot.messages)
			: [];
		const sessionMessages =
			fallbackSessionMessages.length > 0
				? fallbackSessionMessages
				: snapshotMessages;
		const summary = snapshot?.summary ?? null;
		const peerContext = await loadPersonaContext(params);
		const waitedMs = Date.now() - startedAt;

		return {
			sessionMessages,
			storedMessages: fallbackSessionMessages,
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

	const liveSessionMessages = mapHonchoMessagesToPromptContext(
		liveContextResult.value.messages,
		params.userId
	);
	const sessionMessages =
		fallbackSessionMessages.length > 0
			? fallbackSessionMessages
			: liveSessionMessages;
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
		messages: liveSessionMessages,
	});

	return {
		sessionMessages,
		storedMessages: fallbackSessionMessages,
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
			Promise.all([getUserPeer(userId), getAssistantPeer(userId)]).then(
				async ([userPeer, assistantPeer]) =>
					assistantPeer.context({
						target: userPeer,
						includeMostFrequent: true,
					})
			),
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
		if (response.value) {
			const serialized = serializePeerContext(response.value).trim();
			result = serialized
				? sanitizePersonaMemoryText(serialized, userId, userDisplayName)
				: null;
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

export type HonchoPersonaRecallResult = {
	status: 'ok' | 'empty' | 'disabled' | 'error';
	source: 'honcho_peer_chat' | 'none';
	content: string | null;
	error?: string;
};

export async function recallPersonaMemory(params: {
	userId: string;
	query: string;
	userDisplayName?: string | null;
	timeoutMs?: number;
}): Promise<HonchoPersonaRecallResult> {
	if (!isHonchoEnabled()) {
		return { status: 'disabled', source: 'none', content: null };
	}

	const query = params.query.trim();
	if (!query) {
		return { status: 'empty', source: 'none', content: null };
	}

	try {
		const response = await resolveWithTimeout(
			Promise.all([getUserPeer(params.userId), getAssistantPeer(params.userId)]).then(
				async ([userPeer, assistantPeer]) =>
					assistantPeer.chat(query, {
						target: userPeer,
						reasoningLevel: 'medium',
					})
			),
			{
				timeoutMs: Math.max(
					1,
					params.timeoutMs ?? getConfig().honchoPersonaContextWaitMs,
				),
				label: 'Honcho persona recall',
				userId: params.userId,
			},
		);
		if (response.error) {
			console.error('[HONCHO] Persona recall failed:', response.error);
			return {
				status: 'error',
				source: 'none',
				content: null,
				error:
					response.error instanceof Error
						? response.error.message
						: 'Honcho persona recall failed',
			};
		}
		const content =
			typeof response.value === 'string' ? response.value.trim() : '';
		const sanitizedContent = content
			? sanitizePersonaMemoryText(content, params.userId, params.userDisplayName)
			: '';
		if (!sanitizedContent) {
			return { status: 'empty', source: 'honcho_peer_chat', content: null };
		}
		return {
			status: 'ok',
			source: 'honcho_peer_chat',
			content: sanitizedContent,
		};
	} catch (error) {
		console.error('[HONCHO] Persona recall failed:', error);
		return {
			status: 'error',
			source: 'none',
			content: null,
			error:
				error instanceof Error ? error.message : 'Honcho persona recall failed',
		};
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
		const honcho = await ensureClient();
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
