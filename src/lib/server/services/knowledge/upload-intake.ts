import { getConfig } from "$lib/server/config-store";
import { getAdapterBodySizeLimitBytes } from "$lib/server/env";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { getConversation } from "$lib/server/services/conversations";
import type { Artifact, KnowledgeUploadResponse } from "$lib/types";
import {
	createNormalizedArtifact,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
} from "./store";

const DEFAULT_READINESS_ERROR =
	"This file could not be prepared for chat. Remove it or upload a supported text-readable document.";
const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 1024 * 1024;
const CHUNK_BODY_LIMIT_BYTES = 1024 * 1024;

export class KnowledgeUploadConversationError extends Error {
	code = "invalid_conversation" as const;
	status = 400 as const;

	constructor() {
		super("Conversation not found or access denied");
		this.name = "KnowledgeUploadConversationError";
	}
}

export function isKnowledgeUploadConversationError(
	error: unknown,
): error is KnowledgeUploadConversationError {
	return (
		error instanceof KnowledgeUploadConversationError ||
		(typeof error === "object" &&
			error !== null &&
			"name" in error &&
			(error as { name?: unknown }).name === "KnowledgeUploadConversationError")
	);
}

function finiteLimit(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

function effectiveLimit(
	appLimit: number,
	adapterBodySizeLimit: number,
): number {
	const adapterLimit = finiteLimit(adapterBodySizeLimit);
	return adapterLimit === null ? appLimit : Math.min(appLimit, adapterLimit);
}

export function resolveKnowledgeUploadLimits(): {
	maxFileUploadSize: number;
	adapterBodySizeLimit: number;
	multipartBodyLimit: number;
	storedFileLimit: number;
	chunkFileLimit: number;
	chunkBodyLimit: number;
	multipartOverheadAllowance: number;
} {
	const { maxFileUploadSize } = getConfig();
	const adapterBodySizeLimit = getAdapterBodySizeLimitBytes();
	const multipartAppLimit =
		maxFileUploadSize + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
	const storedFileLimit = effectiveLimit(
		maxFileUploadSize,
		adapterBodySizeLimit,
	);

	return {
		maxFileUploadSize,
		adapterBodySizeLimit,
		multipartBodyLimit: effectiveLimit(multipartAppLimit, adapterBodySizeLimit),
		storedFileLimit,
		chunkFileLimit: maxFileUploadSize,
		chunkBodyLimit: effectiveLimit(
			CHUNK_BODY_LIMIT_BYTES,
			adapterBodySizeLimit,
		),
		multipartOverheadAllowance: MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
	};
}

type UploadLogPrefix = string | null | undefined;

type UploadRenameInfo = {
	originalName: string;
	wasRenamed: boolean;
};

function normalizeConversationId(
	conversationId: string | null | undefined,
): string | null {
	if (typeof conversationId !== "string") return null;
	const trimmed = conversationId.trim();
	return trimmed ? trimmed : null;
}

function knowledgeLogMessage(
	logPrefix: UploadLogPrefix,
	message: string,
): string {
	return logPrefix
		? `[KNOWLEDGE] ${logPrefix} ${message}`
		: `[KNOWLEDGE] ${message}`;
}

export async function validateKnowledgeUploadConversation(params: {
	userId: string;
	conversationId: string | null | undefined;
}): Promise<string | null> {
	const conversationId = normalizeConversationId(params.conversationId);
	if (!conversationId) return null;

	const conversation = await getConversation(params.userId, conversationId);
	if (!conversation) {
		throw new KnowledgeUploadConversationError();
	}
	return conversationId;
}

async function createNormalizedArtifactForUpload(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
}): Promise<Artifact | null> {
	if (params.normalizedArtifact || !params.artifact.storagePath) {
		return params.normalizedArtifact;
	}

	return await createNormalizedArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		sourceArtifactId: params.artifact.id,
		sourceStoragePath: params.artifact.storagePath,
		sourceName: params.artifact.name,
		sourceMimeType: params.artifact.mimeType,
	});
}

async function buildKnowledgeUploadResponse(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	traceId: string;
	reusedExistingArtifact: boolean;
	renameInfo?: UploadRenameInfo;
}): Promise<KnowledgeUploadResponse> {
	const resolvedAttachment = await resolvePromptAttachmentArtifacts(
		params.userId,
		[params.artifact.id],
	);
	const resolvedItem = resolvedAttachment.items[0];
	const promptReady = resolvedItem?.promptReady ?? false;
	const readinessError = resolvedItem
		? resolvedItem.readinessError
		: DEFAULT_READINESS_ERROR;

	logAttachmentTrace("upload_result", {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		sourceArtifactId: params.artifact.id,
		normalizedArtifactId: params.normalizedArtifact?.id ?? null,
		promptReady,
		promptArtifactId: resolvedItem?.promptArtifact?.id ?? null,
		extractionTextLength: resolvedItem?.contentLength ?? 0,
		chunkCount: resolvedItem?.chunkCount ?? 0,
		contentHash: resolvedItem?.contentHash ?? null,
	});

	return {
		artifact: params.artifact,
		normalizedArtifact: params.normalizedArtifact,
		reusedExistingArtifact: params.reusedExistingArtifact,
		promptReady,
		promptArtifactId: promptReady
			? (resolvedItem?.promptArtifact?.id ?? null)
			: null,
		readinessError,
		...(params.renameInfo ? { renameInfo: params.renameInfo } : {}),
	};
}

async function finishKnowledgeUpload(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	reusedExistingArtifact: boolean;
	renameInfo?: UploadRenameInfo;
	traceId: string;
	startedAt: number;
	logPrefix?: UploadLogPrefix;
	file?: File;
}): Promise<KnowledgeUploadResponse> {
	const sourceSavedMessage = params.logPrefix
		? "source upload saved"
		: "Source upload saved";
	const extractionMessage = params.logPrefix
		? "upload extraction completed"
		: "Upload extraction completed";

	console.info(knowledgeLogMessage(params.logPrefix, sourceSavedMessage), {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.artifact.id,
		fileName: params.artifact.name,
		fileSize: params.artifact.sizeBytes,
		durationMs: Date.now() - params.startedAt,
	});

	const normalizedArtifact = await createNormalizedArtifactForUpload({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact: params.artifact,
		normalizedArtifact: params.normalizedArtifact,
	});
	console.info(knowledgeLogMessage(params.logPrefix, extractionMessage), {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.artifact.id,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		normalizedTextLength: normalizedArtifact?.contentText?.length ?? 0,
		durationMs: Date.now() - params.startedAt,
	});

	return await buildKnowledgeUploadResponse({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact: params.artifact,
		normalizedArtifact,
		traceId: params.traceId,
		reusedExistingArtifact: params.reusedExistingArtifact,
		renameInfo: params.renameInfo,
	});
}

export async function completeKnowledgeUploadFromFile(params: {
	userId: string;
	conversationId: string | null;
	file: File;
	traceId: string;
	startedAt: number;
	logPrefix?: string | null;
}): Promise<KnowledgeUploadResponse> {
	const conversationId = await validateKnowledgeUploadConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	const uploadResult = await saveUploadedArtifact({
		userId: params.userId,
		conversationId,
		file: params.file,
	});

	return await finishKnowledgeUpload({
		userId: params.userId,
		conversationId,
		artifact: uploadResult.artifact,
		normalizedArtifact: uploadResult.normalizedArtifact,
		reusedExistingArtifact: uploadResult.reusedExistingArtifact,
		renameInfo: uploadResult.renameInfo,
		traceId: params.traceId,
		startedAt: params.startedAt,
		logPrefix: params.logPrefix,
		file: params.file,
	});
}

export async function completeKnowledgeUploadFromStoredFile(params: {
	userId: string;
	conversationId: string | null;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	binaryHash: string;
	tempPathAbsolute: string;
	traceId: string;
	startedAt: number;
	logPrefix: "Raw" | "Chunked";
}): Promise<KnowledgeUploadResponse> {
	const conversationId = await validateKnowledgeUploadConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	const uploadResult = await saveUploadedArtifactFromStoredFile({
		userId: params.userId,
		conversationId,
		fileName: params.fileName,
		mimeType: params.mimeType,
		sizeBytes: params.sizeBytes,
		binaryHash: params.binaryHash,
		tempPathAbsolute: params.tempPathAbsolute,
	});

	return await finishKnowledgeUpload({
		userId: params.userId,
		conversationId,
		artifact: uploadResult.artifact,
		normalizedArtifact: uploadResult.normalizedArtifact,
		reusedExistingArtifact: uploadResult.reusedExistingArtifact,
		renameInfo: uploadResult.renameInfo,
		traceId: params.traceId,
		startedAt: params.startedAt,
		logPrefix: params.logPrefix,
	});
}
