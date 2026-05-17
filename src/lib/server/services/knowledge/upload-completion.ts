import type { KnowledgeUploadResponse } from '$lib/types';
import {
	createNormalizedArtifact,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifactFromStoredFile,
} from './store';
import { syncArtifactToHoncho } from '$lib/server/services/honcho';
import { logAttachmentTrace } from '$lib/server/services/attachment-trace';

export async function completeStoredKnowledgeUpload(params: {
	userId: string;
	conversationId: string | null;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	binaryHash: string;
	tempPathAbsolute: string;
	traceId: string;
	startedAt: number;
	logPrefix: 'Raw' | 'Chunked';
}): Promise<KnowledgeUploadResponse> {
	const uploadResult = await saveUploadedArtifactFromStoredFile({
		userId: params.userId,
		conversationId: params.conversationId,
		fileName: params.fileName,
		mimeType: params.mimeType,
		sizeBytes: params.sizeBytes,
		binaryHash: params.binaryHash,
		tempPathAbsolute: params.tempPathAbsolute,
	});
	const artifact = uploadResult.artifact;
	console.info(`[KNOWLEDGE] ${params.logPrefix} source upload saved`, {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: artifact.id,
		fileName: artifact.name,
		fileSize: artifact.sizeBytes,
		durationMs: Date.now() - params.startedAt,
	});

	let normalizedArtifact = uploadResult.normalizedArtifact;
	if (!normalizedArtifact && artifact.storagePath) {
		normalizedArtifact = await createNormalizedArtifact({
			userId: params.userId,
			conversationId: params.conversationId,
			sourceArtifactId: artifact.id,
			sourceStoragePath: artifact.storagePath,
			sourceName: artifact.name,
			sourceMimeType: artifact.mimeType,
		});
	}
	console.info(`[KNOWLEDGE] ${params.logPrefix} upload extraction completed`, {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: artifact.id,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		normalizedTextLength: normalizedArtifact?.contentText?.length ?? 0,
		durationMs: Date.now() - params.startedAt,
	});

	let syncResult: Awaited<ReturnType<typeof syncArtifactToHoncho>> = {
		uploaded: false,
		mode: 'none',
	};
	syncResult = await syncArtifactToHoncho({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact,
	});

	if (!syncResult.uploaded) {
		syncResult = await syncArtifactToHoncho({
			userId: params.userId,
			conversationId: params.conversationId,
			artifact,
			fallbackTextArtifact: normalizedArtifact,
		});
	}
	console.info(`[KNOWLEDGE] ${params.logPrefix} upload Honcho sync completed`, {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: artifact.id,
		uploaded: syncResult.uploaded,
		mode: syncResult.mode,
		durationMs: Date.now() - params.startedAt,
	});

	const resolvedAttachment = await resolvePromptAttachmentArtifacts(params.userId, [artifact.id]);
	const resolvedItem = resolvedAttachment.items[0];
	const promptReady = resolvedItem?.promptReady ?? false;
	const readinessError = resolvedItem
		? resolvedItem.readinessError
		: 'This file could not be prepared for chat. Remove it or upload a supported text-readable document.';

	logAttachmentTrace('upload_result', {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		sourceArtifactId: artifact.id,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		promptReady,
		promptArtifactId: resolvedItem?.promptArtifact?.id ?? null,
		extractionTextLength: resolvedItem?.contentLength ?? 0,
		chunkCount: resolvedItem?.chunkCount ?? 0,
		contentHash: resolvedItem?.contentHash ?? null,
	});

	return {
		artifact,
		normalizedArtifact,
		reusedExistingArtifact: false,
		honcho: syncResult,
		promptReady,
		promptArtifactId: promptReady ? resolvedItem?.promptArtifact?.id ?? null : null,
		readinessError,
		renameInfo: uploadResult.renameInfo,
	};
}
