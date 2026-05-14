import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { getConfig } from '$lib/server/config-store';
import {
	addConversationLinkedContextSources,
	isLinkedContextSourceError,
} from '$lib/server/services/linked-context-sources';
import type { LinkedContextSource } from '$lib/types';

function parseLinkedSources(value: unknown): LinkedContextSource[] | null {
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

function parseStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((item): item is string => typeof item === 'string');
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return json(
			{
				error: 'Composer Command Registry is disabled.',
				errorKey: 'composerCommandRegistry.disabled',
			},
			{ status: 404 }
		);
	}

	const body = await event.request.json().catch(() => null);
	if (!body || typeof body !== 'object') {
		return json({ error: 'Invalid linked source payload' }, { status: 400 });
	}

	const linkedSources = parseLinkedSources((body as Record<string, unknown>).linkedSources);
	if (!linkedSources) {
		return json({ error: 'linkedSources must be an array of linked documents' }, { status: 400 });
	}
	const attachmentIds = parseStringArray((body as Record<string, unknown>).attachmentIds) ?? [];

	try {
		const resolved = await addConversationLinkedContextSources({
			userId: event.locals.user!.id,
			conversationId: event.params.id,
			linkedSources,
			attachmentIds,
		});
		return json({ linkedSources: resolved });
	} catch (error) {
		if (isLinkedContextSourceError(error)) {
			return json({ error: error.message, code: error.code }, { status: error.status });
		}
		throw error;
	}
};
