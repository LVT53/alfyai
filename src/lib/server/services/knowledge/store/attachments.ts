import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactChunks,
	artifactLinks,
	artifacts,
} from "$lib/server/db/schema";
import { getExtractionJobsForArtifacts } from "$lib/server/services/extraction";
import type {
	Artifact,
	ArtifactType,
} from "$lib/server/services/knowledge/types";
import type { ChatAttachment } from "$lib/server/services/messages-types";
import { parseJsonRecord } from "$lib/server/utils/json";
import type {
	AttachmentExtractionStatusItem,
	DocumentExtractionJobDTO,
} from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { getSupportedExtractionSummary } from "$lib/shared/file-types/model-facing";
import {
	hasMeaningfulAttachmentText,
	logAttachmentTrace,
	summarizeAttachmentTraceText,
} from "../../attachment-trace";
import {
	readStoredOutline,
	readStoredPageCount,
	readStoredPageCountKind,
	readStoredTokenEstimate,
} from "../outline";
import {
	createArtifact,
	createArtifactLink,
	fileExtension,
	findExistingArtifactByBinaryHash,
	getArtifactsForUser,
	getNormalizedArtifactForSource,
	hashBinaryBuffer,
	knowledgeUserDir,
	withAttachmentDisplayName,
} from "./core";

/**
 * Readiness error shown when an uploaded file produced no normalized artifact.
 *
 * Spec row 41: the format list is derived from the registry so it can never
 * advertise a format the upload endpoint refuses. The sentence around it stays
 * here — `getSupportedExtractionSummary` deliberately returns the list WITHOUT
 * a trailing full stop, so the caller owns the punctuation.
 *
 * This string is a RUNTIME error message; it is not part of any prompt, so it
 * does not sit in the model's cached prompt prefix. It still renders
 * byte-identically to the literal this replaced — asserted in
 * `attachments.test.ts` and `model-facing.test.ts`.
 */
export const NOT_PREPARED_READINESS_ERROR = `This file could not be prepared for chat. Supported extraction currently works best for ${getSupportedExtractionSummary(
	"en",
)}.`;

/**
 * Phase 3: extraction runs in the background, so "no normalized artifact yet"
 * is the NORMAL state of a freshly uploaded PDF rather than a verdict on it.
 * These two sentences are what keeps the send gate from calling a document
 * broken one second after the upload that will finish preparing it.
 */
export const STILL_PREPARING_READINESS_ERROR =
	"This file is still being prepared for chat. Wait a moment and send it again.";

export const EXTRACTION_RETRYABLE_READINESS_ERROR =
	"This file could not be prepared for chat. Try the Retry action on it, then send again.";

type PromptArtifactDiagnostics = {
	contentLength: number;
	contentPreview: string | null;
	contentHash: string | null;
	chunkCount: number;
};

type PromptAttachmentResolutionItem = {
	requestedArtifactId: string;
	displayArtifact: Artifact | null;
	promptArtifact: Artifact | null;
	promptReady: boolean;
	readinessError: string | null;
	contentLength: number;
	contentPreview: string | null;
	contentHash: string | null;
	chunkCount: number;
	/** The ledger row behind this attachment, when one is resolvable. */
	extraction: DocumentExtractionJobDTO | null;
};

/**
 * The three reasons a send can be refused. All three keep HTTP 422 (OQ2): both
 * client handlers and `isAttachmentReadinessError` key on that status today, and
 * a distinct `code` carries everything a new status would have.
 */
export const ATTACHMENT_READINESS_ERROR_CODES = [
	"attachment_not_ready",
	"attachment_extraction_pending",
	"attachment_extraction_failed",
] as const;
export type AttachmentReadinessErrorCode =
	(typeof ATTACHMENT_READINESS_ERROR_CODES)[number];

const ATTACHMENT_READINESS_ERROR_CODE_SET: ReadonlySet<string> =
	new Set<string>(ATTACHMENT_READINESS_ERROR_CODES);

/**
 * One row per refused attachment, for the client to render per file.
 *
 * Defined in the shared vocabulary, not here: `chat-turn/types.ts` carries the
 * same rows on `ChatTurnRequestError` and the composer renders them, and a
 * client module cannot import `$lib/server`. Re-exported so this module's
 * existing importers keep working.
 */
export type { AttachmentExtractionStatusItem };

export class AttachmentReadinessError extends Error {
	code: AttachmentReadinessErrorCode;
	status = 422 as const;
	attachmentIds: string[];
	items: AttachmentExtractionStatusItem[];

	constructor(
		message: string,
		attachmentIds: string[],
		options?: {
			code?: AttachmentReadinessErrorCode;
			items?: AttachmentExtractionStatusItem[];
		},
	) {
		super(message);
		this.name = "AttachmentReadinessError";
		this.attachmentIds = attachmentIds;
		this.code = options?.code ?? "attachment_not_ready";
		this.items = options?.items ?? [];
	}
}

export function isAttachmentReadinessError(
	error: unknown,
): error is AttachmentReadinessError {
	return (
		error instanceof AttachmentReadinessError ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			typeof (error as { code?: unknown }).code === "string" &&
			ATTACHMENT_READINESS_ERROR_CODE_SET.has((error as { code: string }).code))
	);
}

function isPendingExtraction(job: DocumentExtractionJobDTO | null): boolean {
	return job !== null && !isTerminalExtractionStatus(job.status);
}

export function classifyAttachmentReadinessErrorCode(
	items: PromptAttachmentResolutionItem[],
): AttachmentReadinessErrorCode {
	if (items.some((item) => item.displayArtifact === null)) {
		return "attachment_not_ready";
	}
	if (items.some((item) => isPendingExtraction(item.extraction))) {
		return "attachment_extraction_pending";
	}
	if (items.some((item) => item.extraction?.status === "failed")) {
		return "attachment_extraction_failed";
	}
	return "attachment_not_ready";
}

function buildAttachmentReadinessErrorMessage(
	items: PromptAttachmentResolutionItem[],
	code: AttachmentReadinessErrorCode,
): string {
	if (items.some((item) => item.displayArtifact === null)) {
		return "One or more attached files are no longer available. Remove them and upload again.";
	}

	if (items.length === 1) {
		const item = items[0];
		if (item.displayArtifact?.name && item.readinessError) {
			return `${item.displayArtifact.name}: ${item.readinessError}`;
		}
	}

	if (code === "attachment_extraction_pending") {
		return "One or more attached files are still being prepared for chat. Wait a moment and send again.";
	}

	return "One or more attached files could not be prepared for chat. Remove the file or upload a supported text-readable document.";
}

function toAttachmentExtractionStatusItems(
	items: PromptAttachmentResolutionItem[],
): AttachmentExtractionStatusItem[] {
	return items.flatMap((item) =>
		item.extraction
			? [
					{
						artifactId: item.requestedArtifactId,
						name: item.displayArtifact?.name ?? null,
						status: item.extraction.status,
						errorCode: item.extraction.error?.code ?? null,
						retryable: item.extraction.retryable,
					},
				]
			: [],
	);
}

async function getPromptArtifactDiagnostics(
	userId: string,
	promptArtifact: Artifact | null,
): Promise<PromptArtifactDiagnostics> {
	if (!promptArtifact) {
		return {
			contentLength: 0,
			contentPreview: null,
			contentHash: null,
			chunkCount: 0,
		};
	}

	const [{ chunkCount = 0 } = { chunkCount: 0 }] = await db
		.select({
			chunkCount: sql<number>`count(*)`,
		})
		.from(artifactChunks)
		.where(
			and(
				eq(artifactChunks.userId, userId),
				eq(artifactChunks.artifactId, promptArtifact.id),
			),
		);

	return {
		...summarizeAttachmentTraceText(promptArtifact.contentText),
		chunkCount: Number(chunkCount ?? 0),
	};
}

async function buildPromptAttachmentResolutionItem(params: {
	userId: string;
	requestedArtifactId: string;
	displayArtifact: Artifact;
	promptArtifact: Artifact | null;
	readinessError: string;
}): Promise<PromptAttachmentResolutionItem> {
	const diagnostics = await getPromptArtifactDiagnostics(
		params.userId,
		params.promptArtifact,
	);
	const promptReady =
		Boolean(params.promptArtifact) &&
		hasMeaningfulAttachmentText(params.promptArtifact?.contentText) &&
		diagnostics.contentLength > 0;

	return {
		requestedArtifactId: params.requestedArtifactId,
		displayArtifact: params.displayArtifact,
		promptArtifact: params.promptArtifact,
		promptReady,
		readinessError: promptReady ? null : params.readinessError,
		contentLength: diagnostics.contentLength,
		contentPreview: diagnostics.contentPreview,
		contentHash: diagnostics.contentHash,
		chunkCount: diagnostics.chunkCount,
		extraction: null,
	};
}

/**
 * Second pass over the attachments that are not prompt-ready.
 *
 * The ledger is only consulted for those — a conversation whose attachments are
 * all long since extracted must not pay a batch query per turn just so the
 * unhappy path can be worded better. For the ones that are not ready, the row
 * is the difference between "wait a second" and "this file is broken", which is
 * the single biggest behavioural risk of moving extraction off the request.
 */
async function annotateWithExtractionStatus(
	userId: string,
	items: PromptAttachmentResolutionItem[],
): Promise<PromptAttachmentResolutionItem[]> {
	const pendingIds = items.flatMap((item) =>
		!item.promptReady && item.displayArtifact?.type === "source_document"
			? [item.requestedArtifactId]
			: [],
	);
	if (pendingIds.length === 0) return items;

	let jobs: DocumentExtractionJobDTO[] = [];
	try {
		jobs = await getExtractionJobsForArtifacts({
			userId,
			artifactIds: pendingIds,
		});
	} catch (error) {
		// A read-model failure must not turn a send into a 500. Without the row
		// the caller falls back to the pre-Phase-3 wording, which is what it
		// would have said anyway.
		console.warn("[ATTACHMENTS] Extraction status lookup failed", { error });
		return items;
	}

	const jobsByArtifactId = new Map(
		jobs.flatMap((job) =>
			job.sourceArtifactId ? [[job.sourceArtifactId, job] as const] : [],
		),
	);

	return items.map((item) => {
		const job = jobsByArtifactId.get(item.requestedArtifactId);
		if (!job || item.promptReady) return item;
		return {
			...item,
			extraction: job,
			readinessError: extractionReadinessError(job, item.readinessError),
		};
	});
}

function extractionReadinessError(
	job: DocumentExtractionJobDTO,
	fallback: string | null,
): string | null {
	if (!isTerminalExtractionStatus(job.status)) {
		return STILL_PREPARING_READINESS_ERROR;
	}
	if (job.status === "failed") {
		if (job.retryable) return EXTRACTION_RETRYABLE_READINESS_ERROR;
		return job.error?.message || fallback;
	}
	return fallback;
}

export async function resolvePromptAttachmentArtifacts(
	userId: string,
	attachmentIds: string[],
): Promise<{
	displayArtifacts: Artifact[];
	promptArtifacts: Artifact[];
	items: PromptAttachmentResolutionItem[];
	unresolvedItems: PromptAttachmentResolutionItem[];
}> {
	const displayArtifacts = await getArtifactsForUser(userId, attachmentIds);
	if (displayArtifacts.length === 0) {
		const items = attachmentIds.map((attachmentId) => ({
			requestedArtifactId: attachmentId,
			displayArtifact: null,
			promptArtifact: null,
			promptReady: false,
			readinessError: "Attached file is no longer available.",
			contentLength: 0,
			contentPreview: null,
			contentHash: null,
			chunkCount: 0,
			extraction: null,
		}));
		return {
			displayArtifacts: [],
			promptArtifacts: [],
			items,
			unresolvedItems: items,
		};
	}

	const displayArtifactsById = new Map(
		displayArtifacts.map((artifact) => [artifact.id, artifact]),
	);
	const resolvedItems = await Promise.all(
		attachmentIds.map(async (attachmentId) => {
			const displayArtifact = displayArtifactsById.get(attachmentId) ?? null;
			if (!displayArtifact) {
				return {
					requestedArtifactId: attachmentId,
					displayArtifact: null,
					promptArtifact: null,
					promptReady: false,
					readinessError: "Attached file is no longer available.",
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
					extraction: null,
				};
			}

			if (displayArtifact.type !== "source_document") {
				return buildPromptAttachmentResolutionItem({
					userId,
					requestedArtifactId: attachmentId,
					displayArtifact,
					promptArtifact: withAttachmentDisplayName(
						displayArtifact,
						displayArtifact,
					),
					readinessError:
						"This attachment does not contain enough readable text to use in chat. Remove it or upload a supported text-readable document.",
				});
			}

			const normalized = await getNormalizedArtifactForSource(
				userId,
				displayArtifact.id,
			);
			if (!normalized) {
				return {
					requestedArtifactId: attachmentId,
					displayArtifact,
					promptArtifact: null,
					promptReady: false,
					readinessError: NOT_PREPARED_READINESS_ERROR,
					contentLength: 0,
					contentPreview: null,
					contentHash: null,
					chunkCount: 0,
					extraction: null,
				};
			}

			return buildPromptAttachmentResolutionItem({
				userId,
				requestedArtifactId: attachmentId,
				displayArtifact,
				promptArtifact: withAttachmentDisplayName(normalized, displayArtifact),
				readinessError:
					"This file was uploaded, but no usable readable text could be prepared for chat from it.",
			});
		}),
	);
	const items = await annotateWithExtractionStatus(userId, resolvedItems);
	const unresolvedItems = items.filter((item) => !item.promptReady);

	return {
		displayArtifacts,
		promptArtifacts: Array.from(
			new Map(
				items.flatMap((item) =>
					item.promptReady && item.promptArtifact
						? [[item.promptArtifact.id, item.promptArtifact] as const]
						: [],
				),
			).values(),
		),
		items,
		unresolvedItems,
	};
}

export async function assertPromptReadyAttachments(params: {
	userId: string;
	conversationId: string;
	attachmentIds: string[];
	traceId?: string;
}): Promise<{
	displayArtifacts: Artifact[];
	promptArtifacts: Artifact[];
}> {
	const resolved = await resolvePromptAttachmentArtifacts(
		params.userId,
		params.attachmentIds,
	);

	if (params.attachmentIds.length > 0) {
		console.info("[ATTACHMENTS] Prompt readiness preflight", {
			conversationId: params.conversationId,
			requestedAttachmentIds: params.attachmentIds,
			displayArtifactCount: resolved.displayArtifacts.length,
			promptArtifactCount: resolved.promptArtifacts.length,
			unresolvedAttachmentIds: resolved.unresolvedItems.map(
				(item) => item.requestedArtifactId,
			),
		});
		logAttachmentTrace("preflight", {
			traceId: params.traceId ?? null,
			conversationId: params.conversationId,
			requestedAttachmentIds: params.attachmentIds,
			displayArtifactIds: resolved.displayArtifacts.map(
				(artifact) => artifact.id,
			),
			promptArtifactIds: resolved.promptArtifacts.map(
				(artifact) => artifact.id,
			),
			unresolvedAttachments: resolved.unresolvedItems.map((item) => ({
				artifactId: item.requestedArtifactId,
				name: item.displayArtifact?.name ?? null,
				readinessError: item.readinessError,
				contentLength: item.contentLength,
				chunkCount: item.chunkCount,
				contentHash: item.contentHash,
				extractionStatus: item.extraction?.status ?? null,
			})),
		});
	}

	if (resolved.unresolvedItems.length > 0) {
		const code = classifyAttachmentReadinessErrorCode(resolved.unresolvedItems);
		throw new AttachmentReadinessError(
			buildAttachmentReadinessErrorMessage(resolved.unresolvedItems, code),
			resolved.unresolvedItems.map((item) => item.requestedArtifactId),
			{
				code,
				items: toAttachmentExtractionStatusItems(resolved.unresolvedItems),
			},
		);
	}

	return {
		displayArtifacts: resolved.displayArtifacts,
		promptArtifacts: resolved.promptArtifacts,
	};
}

type QueryRows<T> = T[] | PromiseLike<T[]>;

type LimitableQueryRows<T> = {
	limit: (limit: number) => QueryRows<T>;
};

async function executeQuery<T>(query: QueryRows<T>): Promise<T[]> {
	const executed = await query;
	return Array.isArray(executed) ? executed : [];
}

async function executeLimitedQuery<T>(
	query: QueryRows<T> | LimitableQueryRows<T>,
	limit = 1,
): Promise<T[]> {
	const limitedQuery =
		typeof (query as { limit?: unknown }).limit === "function"
			? (query as LimitableQueryRows<T>).limit(limit)
			: (query as QueryRows<T>);
	return executeQuery(limitedQuery);
}

async function ensureConversationAttachmentLink(params: {
	userId: string;
	artifactId: string;
	conversationId: string;
}): Promise<void> {
	const existing = db
		.select({ id: artifactLinks.id })
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, params.userId),
				eq(artifactLinks.artifactId, params.artifactId),
				eq(artifactLinks.conversationId, params.conversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				isNull(artifactLinks.messageId),
			),
		);
	const existingRows = await executeLimitedQuery(existing);

	if (existingRows[0]) return;

	await createArtifactLink({
		userId: params.userId,
		artifactId: params.artifactId,
		linkType: "attached_to_conversation",
		conversationId: params.conversationId,
	});
}

async function findExistingArtifactByName(params: {
	userId: string;
	name: string;
}): Promise<boolean> {
	const rows = db
		.select()
		.from(artifacts)
		.where(
			and(eq(artifacts.userId, params.userId), eq(artifacts.name, params.name)),
		);
	const existing = await executeLimitedQuery(rows);

	return Boolean(existing[0]);
}

function generateUniqueFilename(
	originalName: string,
	existingNames: Set<string>,
): string {
	if (!existingNames.has(originalName)) {
		return originalName;
	}

	const extension = fileExtension(originalName);
	const baseName = extension
		? originalName.slice(0, -(extension.length + 1))
		: originalName;

	let counter = 1;
	let newName: string;

	do {
		const suffix = `_${counter}`;
		newName = extension
			? `${baseName}${suffix}.${extension}`
			: `${baseName}${suffix}`;
		counter++;
	} while (existingNames.has(newName));

	return newName;
}

/**
 * Escapes the three characters SQLite's LIKE treats specially, so a file
 * literally named `report_1.pdf` cannot be matched by `_` as a wildcard.
 * Underscores are common in uploaded file names, which is exactly why this
 * cannot be skipped.
 */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Bug B4. This used to load EVERY artifact name the user owns on each name
 * collision, which on a large library is a full table scan per upload. The
 * candidates that can possibly matter are the ones sharing the base name, so
 * ask for those: `<base>%<.ext>` against `artifacts_user_name_idx`
 * (`artifacts(user_id, name)`), added in the Phase 3 migration.
 *
 * LIKE is ASCII-case-insensitive in SQLite, so the result is a SUPERSET of the
 * names that could collide — and a superset is exactly what
 * `generateUniqueFilename`'s case-sensitive `Set.has` needs to stay correct.
 */
export function buildArtifactNamePrefixPattern(originalName: string): string {
	const extension = fileExtension(originalName);
	const baseName = extension
		? originalName.slice(0, -(extension.length + 1))
		: originalName;
	return `${escapeLikePattern(baseName)}%${
		extension ? `.${escapeLikePattern(extension)}` : ""
	}`;
}

async function getArtifactNamesWithBasePrefix(params: {
	userId: string;
	originalName: string;
}): Promise<Set<string>> {
	const pattern = buildArtifactNamePrefixPattern(params.originalName);

	const rows = db
		.select({ name: artifacts.name })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				sql`${artifacts.name} LIKE ${pattern} ESCAPE '\\'`,
			),
		);
	const names = await executeQuery<{ name: string | null }>(rows);

	return new Set(names.flatMap((row) => (row.name ? [row.name] : [])));
}

async function resolveArtifactNameWithAutoRename(params: {
	userId: string;
	originalName: string;
}): Promise<{
	finalName: string;
	wasRenamed: boolean;
	originalName: string;
}> {
	const existing = await findExistingArtifactByName({
		userId: params.userId,
		name: params.originalName,
	});

	if (!existing) {
		return {
			finalName: params.originalName,
			wasRenamed: false,
			originalName: params.originalName,
		};
	}

	// Conflict detected — fetch only the names that could collide, then pick the
	// first free suffix.
	const candidateNames = await getArtifactNamesWithBasePrefix({
		userId: params.userId,
		originalName: params.originalName,
	});
	const uniqueName = generateUniqueFilename(
		params.originalName,
		candidateNames,
	);

	return {
		finalName: uniqueName,
		wasRenamed: true,
		originalName: params.originalName,
	};
}

export async function saveUploadedArtifact(params: {
	userId: string;
	conversationId?: string | null;
	file: File;
	metadata?: Record<string, unknown> | null;
}): Promise<{
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	reusedExistingArtifact: boolean;
	renameInfo?: {
		originalName: string;
		wasRenamed: boolean;
	};
}> {
	const extension = fileExtension(params.file.name);
	const buffer = Buffer.from(await params.file.arrayBuffer());
	const binaryHash = hashBinaryBuffer(buffer);

	const existingArtifact = await findExistingArtifactByBinaryHash({
		userId: params.userId,
		binaryHash,
	});

	if (existingArtifact) {
		if (params.conversationId) {
			await ensureConversationAttachmentLink({
				userId: params.userId,
				artifactId: existingArtifact.id,
				conversationId: params.conversationId,
			});
		}

		// Bug B1. This branch used to hardcode `normalizedArtifact: null`, so the
		// caller saw "deduped artifact, no extracted text" and extracted the very
		// same bytes again — minting a second `normalized_document` every time a
		// user re-dropped a file. The already-extracted text is right there.
		return {
			artifact: existingArtifact,
			normalizedArtifact: await getNormalizedArtifactForSource(
				params.userId,
				existingArtifact.id,
			),
			reusedExistingArtifact: true,
		};
	}

	const userDir = knowledgeUserDir(params.userId);

	const nameResolution = await resolveArtifactNameWithAutoRename({
		userId: params.userId,
		originalName: params.file.name,
	});

	const finalArtifactId = randomUUID();
	await mkdir(userDir, { recursive: true });

	const fileName = extension
		? `${finalArtifactId}.${extension}`
		: finalArtifactId;
	const storagePath = join("data", "knowledge", params.userId, fileName);
	const absolutePath = join(process.cwd(), storagePath);
	await writeFile(absolutePath, buffer);

	const artifact = await createArtifact({
		id: finalArtifactId,
		userId: params.userId,
		conversationId: params.conversationId,
		type: "source_document",
		name: nameResolution.finalName,
		mimeType: params.file.type || null,
		extension,
		sizeBytes: params.file.size,
		binaryHash,
		storagePath,
		summary: nameResolution.finalName,
		metadata: {
			uploadSource: "chat",
			...(params.metadata ?? {}),
			...(nameResolution.wasRenamed
				? { originalName: nameResolution.originalName, renamed: true }
				: {}),
		},
	});

	if (params.conversationId) {
		await ensureConversationAttachmentLink({
			userId: params.userId,
			artifactId: artifact.id,
			conversationId: params.conversationId,
		});
	}

	return {
		artifact,
		normalizedArtifact: null,
		reusedExistingArtifact: false,
		...(nameResolution.wasRenamed
			? {
					renameInfo: {
						originalName: nameResolution.originalName,
						wasRenamed: true,
					},
				}
			: {}),
	};
}

export async function saveUploadedArtifactFromStoredFile(params: {
	userId: string;
	conversationId?: string | null;
	fileName: string;
	mimeType?: string | null;
	sizeBytes: number;
	binaryHash: string;
	tempPathAbsolute: string;
	metadata?: Record<string, unknown> | null;
}): Promise<{
	artifact: Artifact;
	normalizedArtifact: Artifact | null;
	reusedExistingArtifact: boolean;
	renameInfo?: {
		originalName: string;
		wasRenamed: boolean;
	};
}> {
	const extension = fileExtension(params.fileName);

	const existingArtifact = await findExistingArtifactByBinaryHash({
		userId: params.userId,
		binaryHash: params.binaryHash,
	});

	if (existingArtifact) {
		await unlink(params.tempPathAbsolute).catch(() => undefined);

		if (params.conversationId) {
			await ensureConversationAttachmentLink({
				userId: params.userId,
				artifactId: existingArtifact.id,
				conversationId: params.conversationId,
			});
		}

		// Bug B1, the raw/chunk half of it. Same fix, same reason as the browser
		// File path above: a re-upload of identical bytes must reuse the text that
		// was already extracted from them.
		return {
			artifact: existingArtifact,
			normalizedArtifact: await getNormalizedArtifactForSource(
				params.userId,
				existingArtifact.id,
			),
			reusedExistingArtifact: true,
		};
	}

	const userDir = knowledgeUserDir(params.userId);

	const nameResolution = await resolveArtifactNameWithAutoRename({
		userId: params.userId,
		originalName: params.fileName,
	});

	const finalArtifactId = randomUUID();
	await mkdir(userDir, { recursive: true });

	const fileName = extension
		? `${finalArtifactId}.${extension}`
		: finalArtifactId;
	const storagePath = join("data", "knowledge", params.userId, fileName);
	const absolutePath = join(process.cwd(), storagePath);
	await rename(params.tempPathAbsolute, absolutePath);

	let artifact: Artifact;
	try {
		artifact = await createArtifact({
			id: finalArtifactId,
			userId: params.userId,
			conversationId: params.conversationId,
			type: "source_document",
			name: nameResolution.finalName,
			mimeType: params.mimeType || null,
			extension,
			sizeBytes: params.sizeBytes,
			binaryHash: params.binaryHash,
			storagePath,
			summary: nameResolution.finalName,
			metadata: {
				uploadSource: "chat",
				...(params.metadata ?? {}),
				...(nameResolution.wasRenamed
					? { originalName: nameResolution.originalName, renamed: true }
					: {}),
			},
		});
	} catch (error) {
		await unlink(absolutePath).catch(() => undefined);
		throw error;
	}

	if (params.conversationId) {
		await ensureConversationAttachmentLink({
			userId: params.userId,
			artifactId: artifact.id,
			conversationId: params.conversationId,
		});
	}

	return {
		artifact,
		normalizedArtifact: null,
		reusedExistingArtifact: false,
		...(nameResolution.wasRenamed
			? {
					renameInfo: {
						originalName: nameResolution.originalName,
						wasRenamed: true,
					},
				}
			: {}),
	};
}

export async function listMessageAttachments(
	conversationId: string,
): Promise<Map<string, ChatAttachment[]>> {
	const rows = await db
		.select({
			link: artifactLinks,
			artifact: artifacts,
		})
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.conversationId, conversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				sql`${artifactLinks.messageId} IS NOT NULL`,
			),
		)
		.orderBy(desc(artifactLinks.createdAt));

	const result = new Map<string, ChatAttachment[]>();
	for (const row of rows) {
		if (!row.link.messageId) continue;
		const metadata = parseJsonRecord(row.artifact.metadataJson ?? null);
		const tokenEstimate = readStoredTokenEstimate(metadata?.tokenEstimate);
		const pageCount = readStoredPageCount(metadata?.pageCount);
		const pageCountKind = readStoredPageCountKind(metadata?.pageCountKind);
		const outline = readStoredOutline(metadata?.outline);
		const attachments = result.get(row.link.messageId) ?? [];
		attachments.push({
			id: row.link.id,
			artifactId: row.artifact.id,
			name: row.artifact.name,
			type: row.artifact.type as ArtifactType,
			mimeType: row.artifact.mimeType ?? null,
			sizeBytes: row.artifact.sizeBytes ?? null,
			conversationId: row.artifact.conversationId ?? null,
			messageId: row.link.messageId,
			createdAt: row.link.createdAt.getTime(),
			...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
			...(pageCount !== undefined ? { pageCount } : {}),
			...(pageCountKind !== undefined ? { pageCountKind } : {}),
			...(outline.length > 0 ? { outline } : {}),
		});
		result.set(row.link.messageId, attachments);
	}

	return result;
}

export async function attachArtifactsToMessage(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	artifactIds: string[];
}): Promise<void> {
	const uniqueArtifactIds = Array.from(new Set(params.artifactIds));
	if (uniqueArtifactIds.length === 0) return;

	const ownedArtifacts = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, params.userId),
				inArray(artifacts.id, uniqueArtifactIds),
			),
		);

	for (const artifact of ownedArtifacts) {
		await createArtifactLink({
			userId: params.userId,
			artifactId: artifact.id,
			conversationId: params.conversationId,
			messageId: params.messageId,
			linkType: "attached_to_conversation",
		});
	}
}

export async function listConversationSourceArtifactIds(
	userId: string,
	conversationId: string,
): Promise<string[]> {
	const rows = await db
		.select({ artifactId: artifactLinks.artifactId })
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.conversationId, conversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				eq(artifacts.type, "source_document"),
			),
		);
	return Array.from(new Set(rows.map((row) => row.artifactId)));
}

export async function listConversationSourceArtifactNames(
	userId: string,
	conversationId: string,
): Promise<{ id: string; name: string }[]> {
	const rows = await db
		.select({ id: artifacts.id, name: artifacts.name })
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				eq(artifactLinks.conversationId, conversationId),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				eq(artifacts.type, "source_document"),
			),
		);
	const seen = new Map<string, { id: string; name: string }>();
	for (const row of rows) {
		if (!seen.has(row.id)) seen.set(row.id, row);
	}
	return Array.from(seen.values());
}
