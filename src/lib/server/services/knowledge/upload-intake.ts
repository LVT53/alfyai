import { getConfig } from "$lib/server/config-store";
import { getAdapterBodySizeLimitBytes } from "$lib/server/env";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { getConversation } from "$lib/server/services/conversations";
import {
	getExtractionConfig,
	getExtractionJobForArtifact,
	startUploadExtraction,
	waitForExtractionJobVerdict,
} from "$lib/server/services/extraction";
import type {
	Artifact,
	KnowledgeUploadResponse,
} from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import {
	getArtifactForUser,
	resolvePromptAttachmentArtifacts,
	saveUploadedArtifact,
	saveUploadedArtifactFromStoredFile,
} from "./store";
import {
	assertUploadSignatureForFile,
	assertUploadSignatureForStoredFile,
} from "./upload-signature";

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

const EXTRACTION_WAIT_POLL_INTERVAL_MS = 100;

/**
 * Registers the upload with the extraction ledger.
 *
 * This is the whole point of Phase 3 on the intake side: the request no longer
 * waits on a backend to read the document. A `.txt` still settles inside the
 * call — `startUploadExtraction` runs direct text inline within its own bounded
 * budget — and everything else comes back `queued` with a job the client can
 * poll. A dedupe hit whose text already exists short-circuits to `succeeded`
 * without ever reaching the worker (bug B1).
 *
 * A dedupe hit whose extraction ENDED BADLY is the opposite case and is
 * handled in `startUploadExtraction`, for all three upload routes at once: a
 * re-upload of the same bytes is read as the user's Retry, so the response can
 * come back `queued` on a job that was `failed` or `canceled` a moment ago.
 */
async function registerUploadExtraction(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	signal?: AbortSignal;
}): Promise<DocumentExtractionJobDTO> {
	return await startUploadExtraction({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact: params.artifact,
		existingNormalizedArtifactId: params.normalizedArtifact?.id ?? null,
		signal: params.signal,
	});
}

/**
 * The bounded wait the deprecated multipart route needs (B3/D9).
 *
 * The off-repo on-box verify scripts POST to that route and read the old
 * `promptReady` / `normalizedArtifact` fields, so it gets a short grace period
 * in which a small document can still finish and answer the way it always did.
 * When the budget runs out the response is returned anyway, with the pending
 * state and every old field still present — never an error.
 */
async function awaitExtractionVerdict(params: {
	userId: string;
	artifactId: string;
	extraction: DocumentExtractionJobDTO;
	waitMs: number;
	signal?: AbortSignal;
}): Promise<DocumentExtractionJobDTO> {
	if (
		params.waitMs <= 0 ||
		isTerminalExtractionStatus(params.extraction.status)
	) {
		return params.extraction;
	}

	const verdict = await waitForExtractionJobVerdict({
		getJob: () =>
			getExtractionJobForArtifact({
				userId: params.userId,
				artifactId: params.artifactId,
			}),
		timeoutMs: params.waitMs,
		pollIntervalMs: EXTRACTION_WAIT_POLL_INTERVAL_MS,
		signal: params.signal,
	});

	return verdict.job ?? params.extraction;
}

async function resolveNormalizedArtifact(params: {
	userId: string;
	normalizedArtifact: Artifact | null;
	extraction: DocumentExtractionJobDTO;
}): Promise<Artifact | null> {
	if (params.normalizedArtifact) return params.normalizedArtifact;
	if (!params.extraction.normalizedArtifactId) return null;
	return await getArtifactForUser(
		params.userId,
		params.extraction.normalizedArtifactId,
	);
}

async function buildKnowledgeUploadResponse(params: {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	extraction: DocumentExtractionJobDTO;
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
		extractionJobId: params.extraction.id,
		extractionStatus: params.extraction.status,
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
		extraction: params.extraction,
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
	/** Bounded grace period before answering. Only the legacy route sets it. */
	waitForExtractionMs?: number;
	signal?: AbortSignal;
}): Promise<KnowledgeUploadResponse> {
	const sourceSavedMessage = params.logPrefix
		? "source upload saved"
		: "Source upload saved";
	const extractionMessage = params.logPrefix
		? "upload extraction registered"
		: "Upload extraction registered";

	console.info(knowledgeLogMessage(params.logPrefix, sourceSavedMessage), {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.artifact.id,
		fileName: params.artifact.name,
		fileSize: params.artifact.sizeBytes,
		durationMs: Date.now() - params.startedAt,
	});

	const enqueued = await registerUploadExtraction({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact: params.artifact,
		normalizedArtifact: params.normalizedArtifact,
		signal: params.signal,
	});
	const extraction = await awaitExtractionVerdict({
		userId: params.userId,
		artifactId: params.artifact.id,
		extraction: enqueued,
		waitMs: params.waitForExtractionMs ?? 0,
		signal: params.signal,
	});
	const normalizedArtifact = await resolveNormalizedArtifact({
		userId: params.userId,
		normalizedArtifact: params.normalizedArtifact,
		extraction,
	});

	console.info(knowledgeLogMessage(params.logPrefix, extractionMessage), {
		traceId: params.traceId,
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.artifact.id,
		extractionJobId: extraction.id,
		extractionStatus: extraction.status,
		intakeRoute: extraction.intakeRoute,
		normalizedArtifactId: normalizedArtifact?.id ?? null,
		normalizedTextLength: normalizedArtifact?.contentText?.length ?? 0,
		durationMs: Date.now() - params.startedAt,
	});

	return await buildKnowledgeUploadResponse({
		userId: params.userId,
		conversationId: params.conversationId,
		artifact: params.artifact,
		normalizedArtifact,
		extraction,
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
	/**
	 * Legacy multipart route only (B3/D9): wait up to the configured inline
	 * budget for a verdict before answering, so a small document still comes
	 * back the way the off-repo verify scripts expect. Omitted everywhere else.
	 */
	waitForExtraction?: boolean;
	signal?: AbortSignal;
}): Promise<KnowledgeUploadResponse> {
	const conversationId = await validateKnowledgeUploadConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	// Content check before anything is stored (spec section 4.2).
	await assertUploadSignatureForFile(params.file);
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
		waitForExtractionMs: params.waitForExtraction
			? getExtractionConfig().inlineBudgetMs
			: 0,
		signal: params.signal,
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
	// Content check before the bytes become an artifact. On a mismatch this
	// unlinks the temp file and throws (spec section 4.2).
	await assertUploadSignatureForStoredFile({
		fileName: params.fileName,
		mimeType: params.mimeType,
		tempPathAbsolute: params.tempPathAbsolute,
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
