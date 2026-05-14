import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { getConfig } from '$lib/server/config-store';
import {
	clearConversationDraft,
	upsertConversationDraft,
} from '$lib/server/services/conversation-drafts';
import { getConversation } from '$lib/server/services/conversations';
import type { LinkedContextSource, PendingSkillSelection } from '$lib/types';

function parseAttachmentIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((item): item is string => typeof item === 'string');
}

function parseLinkedSources(value: unknown): LinkedContextSource[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const sources: LinkedContextSource[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) return null;
		const record = item as Record<string, unknown>;
		if (
			typeof record.displayArtifactId !== 'string' ||
			(record.promptArtifactId !== null && typeof record.promptArtifactId !== 'string') ||
			!Array.isArray(record.familyArtifactIds) ||
			typeof record.name !== 'string' ||
			record.type !== 'document'
		) {
			return null;
		}
		sources.push({
			displayArtifactId: record.displayArtifactId,
			promptArtifactId: record.promptArtifactId,
			familyArtifactIds: record.familyArtifactIds.filter(
				(value): value is string => typeof value === 'string'
			),
			name: record.name,
			type: 'document',
			mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
			documentOrigin:
				record.documentOrigin === 'uploaded' || record.documentOrigin === 'generated'
					? record.documentOrigin
					: undefined,
		});
	}
	return sources;
}

function parsePendingSkill(value: unknown): PendingSkillSelection | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== 'string' ||
		(record.ownership !== 'user' && record.ownership !== 'system') ||
		typeof record.displayName !== 'string'
	) {
		return undefined;
	}
	return {
		id: record.id,
		ownership: record.ownership,
		displayName: record.displayName,
	};
}

export const PUT: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const { id } = event.params;

	const conversation = await getConversation(user.id, id);
	if (!conversation) {
		return json({ error: 'Conversation not found' }, { status: 404 });
	}

	const body = await event.request.json().catch(() => null);
	if (!body || typeof body !== 'object') {
		return json({ error: 'Invalid draft payload' }, { status: 400 });
	}

	const draftText =
		typeof (body as Record<string, unknown>).draftText === 'string'
			? (body as Record<string, unknown>).draftText
			: '';
	const selectedAttachmentIds = parseAttachmentIds(
		(body as Record<string, unknown>).selectedAttachmentIds
	);
	if (!selectedAttachmentIds) {
		return json({ error: 'selectedAttachmentIds must be an array of strings' }, { status: 400 });
	}
	const selectedLinkedSources = parseLinkedSources(
		(body as Record<string, unknown>).selectedLinkedSources
	);
	if (!selectedLinkedSources) {
		return json({ error: 'selectedLinkedSources must be an array of linked documents' }, { status: 400 });
	}
	const pendingSkill = parsePendingSkill((body as Record<string, unknown>).pendingSkill);
	if (pendingSkill === undefined) {
		return json({ error: 'pendingSkill must be a selected skill summary or null' }, { status: 400 });
	}
	if (pendingSkill && !getConfig().composerCommandRegistryEnabled) {
		return json(
			{
				error: 'Composer Command Registry is disabled.',
				code: 'composer_commands_disabled',
			},
			{ status: 403 }
		);
	}

	const draft = await upsertConversationDraft({
		userId: user.id,
		conversationId: id,
		draftText,
		selectedAttachmentIds,
		selectedLinkedSources,
		pendingSkill,
	});

	return json({ draft });
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const { id } = event.params;

	await clearConversationDraft(user.id, id);
	return json({ success: true });
};
