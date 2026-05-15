import type { FileProductionJob } from '$lib/types';
import {
	getChatFiles,
	syncGeneratedFilesToMemory as syncChatGeneratedFilesToMemory,
	storeGeneratedFile as storeChatGeneratedFile,
	type FileInput,
} from '$lib/server/services/chat-files';
import { db } from '$lib/server/db';
import {
	chatGeneratedFiles,
	fileProductionJobAttempts,
	fileProductionJobFiles,
	fileProductionJobs,
	messages,
} from '$lib/server/db/schema';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { ChatFile } from '$lib/server/services/chat-files';
import { randomUUID } from 'node:crypto';
import { executeCode as executeSandboxCode } from '$lib/server/services/sandbox-execution';
import {
	getFileProductionLimits,
	validateFileProductionOutputLimits,
	type FileProductionLimits,
} from './limits';
import {
	renderStandardReportPdf,
	StandardReportPdfRenderError,
} from './renderers/standard-report-pdf';
import { renderStandardReportDocx } from './renderers/standard-report-docx';
import { renderStandardReportHtml } from './renderers/standard-report-html';
import { createDefaultGeneratedDocumentImageLoader } from './image-loader';
import {
	validateGeneratedDocumentSource,
	type GeneratedDocumentSource,
} from './source-schema';

export interface CreateFileProductionJobInput {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	origin: string;
	idempotencyKey?: string | null;
	requestJson?: unknown;
	sourceMode?: string | null;
	documentIntent?: string | null;
	now?: Date;
}

export interface CreateOrReuseFileProductionJobInput extends CreateFileProductionJobInput {
	idempotencyKey: string;
	requestJson: unknown;
	sourceMode: string;
}

export interface CreateOrReuseFileProductionJobResult {
	job: FileProductionJob;
	reused: boolean;
}

export interface CreateFailedFileProductionJobInput extends CreateFileProductionJobInput {
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
}

export interface FileProductionJobAttempt {
	id: string;
	jobId: string;
	attemptNumber: number;
	status: string;
	stage: string | null;
	workerId: string | null;
	claimedAt: number | null;
	heartbeatAt: number | null;
	startedAt: number | null;
	finishedAt: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	retryable: boolean;
}

export interface ClaimFileProductionJobInput {
	workerId: string;
	now?: Date;
}

export interface OwnedFileProductionAttemptInput {
	jobId: string;
	attemptId: string;
	workerId: string;
	now?: Date;
}

export interface FailFileProductionAttemptInput extends OwnedFileProductionAttemptInput {
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
	diagnostics?: unknown;
}

export interface RecoverStaleFileProductionAttemptsInput {
	staleBefore: Date;
	now?: Date;
}

export interface ReconcileStaleFileProductionJobsInput {
	userId: string;
	conversationId: string;
	assistantMessageIds?: string[];
	staleBefore?: Date;
	now?: Date;
}

export interface RetryFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface CancelFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface ClaimedFileProductionJob {
	job: FileProductionJob;
	attempt: FileProductionJobAttempt;
}

interface ProgramExecutionFile {
	filename: string;
	mimeType?: string;
	content: Buffer | Uint8Array;
	sizeBytes?: number;
}

interface ProgramExecutionResult {
	files: ProgramExecutionFile[];
	stdout: string;
	stderr: string;
	error?: string | null;
}

export interface ExecuteNextFileProductionJobInput {
	workerId: string;
	now?: Date;
	executeCode?: (sourceCode: string, language: 'python' | 'javascript') => Promise<ProgramExecutionResult>;
	storeGeneratedFile?: (
		conversationId: string,
		userId: string,
		file: FileInput
	) => Promise<ChatFile>;
	syncGeneratedFilesToMemory?: typeof syncChatGeneratedFilesToMemory;
	limits?: Partial<FileProductionLimits>;
}

export interface ExecuteNextFileProductionJobResult {
	job: FileProductionJob;
	files: FileProductionJob['files'];
}

export interface DrainFileProductionWorkerInput
	extends Omit<ExecuteNextFileProductionJobInput, 'workerId'> {
	workerId?: string;
}

interface ExecuteNextFileProductionJobStepResult {
	processed: boolean;
	result: ExecuteNextFileProductionJobResult | null;
}

const DEFAULT_WORKER_ID = `file-production:${process.pid}:${randomUUID()}`;
const DEFAULT_STALE_ATTEMPT_MS = 10 * 60 * 1000;
let workerInitialized = false;
let drainPromise: Promise<void> | null = null;

function legacyJobId(fileId: string): string {
	return `legacy-file:${fileId}`;
}

function legacyJobFileLinkId(fileId: string): string {
	return `legacy-file-link:${fileId}`;
}

async function ensureLegacyJobs(files: ChatFile[]): Promise<void> {
	if (files.length === 0) {
		return;
	}

	const fileIds = files.map((file) => file.id);
	const existingLinks = await db
		.select({ chatGeneratedFileId: fileProductionJobFiles.chatGeneratedFileId })
		.from(fileProductionJobFiles)
		.where(inArray(fileProductionJobFiles.chatGeneratedFileId, fileIds));
	const linkedFileIds = new Set(existingLinks.map((link) => link.chatGeneratedFileId));
	const missingFiles = files.filter((file) => !linkedFileIds.has(file.id));

	for (const file of missingFiles) {
		const createdAt = new Date(file.createdAt);
		await db
			.insert(fileProductionJobs)
			.values({
				id: legacyJobId(file.id),
				conversationId: file.conversationId,
				assistantMessageId: file.assistantMessageId,
				userId: file.userId,
				title: file.documentLabel ?? file.filename,
				status: 'succeeded',
				stage: null,
				origin: 'legacy_generated_file',
				createdAt,
				updatedAt: createdAt,
			})
			.onConflictDoNothing({ target: fileProductionJobs.id });

		await db
			.insert(fileProductionJobFiles)
			.values({
				id: legacyJobFileLinkId(file.id),
				jobId: legacyJobId(file.id),
				chatGeneratedFileId: file.id,
				sortOrder: 0,
				createdAt,
			})
			.onConflictDoNothing({ target: fileProductionJobFiles.chatGeneratedFileId });
	}
}

function mapChatFileToProducedFile(file: ChatFile): FileProductionJob['files'][number] {
	return {
		id: file.id,
		filename: file.filename,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		downloadUrl: `/api/chat/files/${file.id}/download`,
		previewUrl: `/api/chat/files/${file.id}/preview`,
		artifactId: file.artifactId,
		documentFamilyId: file.documentFamilyId,
		documentFamilyStatus: file.documentFamilyStatus,
		documentLabel: file.documentLabel,
		documentRole: file.documentRole,
		versionNumber: file.versionNumber,
		originConversationId: file.originConversationId,
		originAssistantMessageId: file.originAssistantMessageId,
		sourceChatFileId: file.sourceChatFileId,
	};
}

export async function createFileProductionJob(
	input: CreateFileProductionJobInput
): Promise<FileProductionJob> {
	const now = input.now ?? new Date();
	const id = randomUUID();
	await db.insert(fileProductionJobs).values({
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		userId: input.userId,
		title: input.title,
		status: 'queued',
		stage: null,
		origin: input.origin,
		currentAttemptId: null,
		retryable: false,
		errorCode: null,
		errorMessage: null,
		completedAt: null,
		cancelRequestedAt: null,
		idempotencyKey: input.idempotencyKey ?? null,
		requestJson: input.requestJson === undefined ? null : JSON.stringify(input.requestJson),
		sourceMode: input.sourceMode ?? null,
		documentIntent: input.documentIntent ?? null,
		createdAt: now,
		updatedAt: now,
	});

	return {
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		title: input.title,
		status: 'queued',
		stage: null,
		createdAt: now.getTime(),
		updatedAt: now.getTime(),
		files: [],
		warnings: [],
		error: null,
	};
}

export async function createOrReuseFileProductionJob(
	input: CreateOrReuseFileProductionJobInput
): Promise<CreateOrReuseFileProductionJobResult> {
	const existingJobs = await db
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, input.userId),
				eq(fileProductionJobs.conversationId, input.conversationId),
				eq(fileProductionJobs.idempotencyKey, input.idempotencyKey)
			)
		)
		.limit(1);

	if (existingJobs[0]) {
		return {
			job: mapJobRow(existingJobs[0], []),
			reused: true,
		};
	}

	const job = await createFileProductionJob(input);
	return { job, reused: false };
}

export async function createFailedFileProductionJob(
	input: CreateFailedFileProductionJobInput
): Promise<FileProductionJob> {
	if (input.idempotencyKey) {
		const existingJobs = await db
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.conversationId, input.conversationId),
					eq(fileProductionJobs.idempotencyKey, input.idempotencyKey)
				)
			)
			.limit(1);

		if (existingJobs[0]) {
			return mapJobRow(existingJobs[0], []);
		}
	}

	const now = input.now ?? new Date();
	const id = randomUUID();
	await db.insert(fileProductionJobs).values({
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		userId: input.userId,
		title: input.title,
		status: 'failed',
		stage: null,
		origin: input.origin,
		currentAttemptId: null,
		retryable: input.retryable,
		errorCode: input.errorCode,
		errorMessage: input.errorMessage,
		completedAt: now,
		cancelRequestedAt: null,
		idempotencyKey: input.idempotencyKey ?? null,
		requestJson: input.requestJson === undefined ? null : JSON.stringify(input.requestJson),
		sourceMode: input.sourceMode ?? null,
		documentIntent: input.documentIntent ?? null,
		createdAt: now,
		updatedAt: now,
	});

	return {
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		title: input.title,
		status: 'failed',
		stage: null,
		createdAt: now.getTime(),
		updatedAt: now.getTime(),
		files: [],
		warnings: [],
		error: {
			code: input.errorCode,
			message: input.errorMessage,
			retryable: input.retryable,
		},
	};
}

function mapError(job: typeof fileProductionJobs.$inferSelect): FileProductionJob['error'] {
	if (!job.errorCode && !job.errorMessage) {
		return null;
	}

	return {
		code: job.errorCode ?? 'file_production_error',
		message: job.errorMessage ?? 'File production failed.',
		retryable: Boolean(job.retryable),
	};
}

function mapJobRow(
	job: typeof fileProductionJobs.$inferSelect,
	files: FileProductionJob['files']
): FileProductionJob {
	return {
		id: job.id,
		conversationId: job.conversationId,
		assistantMessageId: job.assistantMessageId,
		title: job.title,
		status: job.status as FileProductionJob['status'],
		stage: job.stage,
		createdAt: job.createdAt.getTime(),
		updatedAt: job.updatedAt.getTime(),
		files,
		warnings: [],
		error: mapError(job),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

type ParsedFileProductionJobRequest =
	| {
			sourceMode: 'program';
			language: 'python' | 'javascript';
			sourceCode: string;
			filename?: string;
	  }
	| {
			sourceMode: 'document_source';
			documentSource: GeneratedDocumentSource;
			outputs: Array<'pdf' | 'docx' | 'html'>;
	  };

function normalizeOutputTypes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((output): output is Record<string, unknown> => isRecord(output))
		.map((output) => (typeof output.type === 'string' ? output.type.trim().toLowerCase() : ''))
		.filter(Boolean);
}

function normalizeDocumentOutput(type: string): 'pdf' | 'docx' | 'html' | null {
	switch (type) {
		case 'pdf':
		case 'application/pdf':
			return 'pdf';
		case 'docx':
		case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
			return 'docx';
		case 'html':
		case 'text/html':
			return 'html';
		default:
			return null;
	}
}

function selectDocumentOutputs(outputs: string[]): Array<'pdf' | 'docx' | 'html'> | null {
	if (outputs.length === 0) return ['pdf'];
	const normalized = outputs.map(normalizeDocumentOutput);
	if (normalized.some((output) => output === null)) return null;
	return Array.from(new Set(normalized)) as Array<'pdf' | 'docx' | 'html'>;
}

function parseFileProductionJobRequest(requestJson: string | null): {
	ok: true;
	value: ParsedFileProductionJobRequest;
} | {
	ok: false;
	errorCode: string;
	errorMessage: string;
} {
	if (!requestJson) {
		return {
			ok: false,
			errorCode: 'missing_file_production_request',
			errorMessage: 'File production request details are missing.',
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(requestJson) as unknown;
	} catch {
		return {
			ok: false,
			errorCode: 'invalid_file_production_request',
			errorMessage: 'File production request details are invalid.',
		};
	}

	if (!isRecord(parsed)) {
		return {
			ok: false,
			errorCode: 'unsupported_file_production_request',
			errorMessage: 'File production request mode is not supported.',
		};
	}

	if (parsed.sourceMode === 'document_source') {
		const documentValidation = validateGeneratedDocumentSource(parsed.documentSource);
		if (!documentValidation.ok) {
			return {
				ok: false,
				errorCode: documentValidation.code,
				errorMessage: documentValidation.message,
			};
		}
		const outputs = normalizeOutputTypes(parsed.outputs);
		const documentOutputs = selectDocumentOutputs(outputs);
		if (!documentOutputs) {
			return {
				ok: false,
				errorCode: 'unsupported_output_type',
				errorMessage: 'AlfyAI Standard Report rendering supports PDF, DOCX, and HTML outputs.',
			};
		}

		return {
			ok: true,
			value: {
				sourceMode: 'document_source',
				documentSource: documentValidation.source,
				outputs: documentOutputs,
			},
		};
	}

	if (parsed.sourceMode !== 'program' || !isRecord(parsed.program)) {
		return {
			ok: false,
			errorCode: 'unsupported_file_production_request',
			errorMessage: 'File production request mode is not supported.',
		};
	}

	const language = parsed.program.language;
	const sourceCode = parsed.program.sourceCode;
	if ((language !== 'python' && language !== 'javascript') || typeof sourceCode !== 'string') {
		return {
			ok: false,
			errorCode: 'invalid_file_production_request',
			errorMessage: 'Program file production request details are invalid.',
		};
	}

	return {
		ok: true,
		value: {
			sourceMode: 'program',
			language,
			sourceCode,
			filename:
				typeof parsed.program.filename === 'string' && parsed.program.filename.trim()
					? parsed.program.filename.trim()
					: undefined,
		},
	};
}

export async function claimNextFileProductionJob(
	input: ClaimFileProductionJobInput
): Promise<ClaimedFileProductionJob | null> {
	const now = input.now ?? new Date();
	const claimed = db.transaction((tx) => {
		const activeRunningJob = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.status, 'running'))
			.limit(1)
			.all();

		if (activeRunningJob.length > 0) {
			return null;
		}

		const [queuedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.status, 'queued'))
			.orderBy(asc(fileProductionJobs.createdAt))
			.limit(1)
			.all();

		if (!queuedJob) {
			return null;
		}

		const [attemptStats] = tx
			.select({
				maxAttemptNumber: sql<number>`coalesce(max(${fileProductionJobAttempts.attemptNumber}), 0)`,
			})
			.from(fileProductionJobAttempts)
			.where(eq(fileProductionJobAttempts.jobId, queuedJob.id))
			.all();
		const attemptNumber = Number(attemptStats?.maxAttemptNumber ?? 0) + 1;
		const attemptId = randomUUID();
		tx.insert(fileProductionJobAttempts)
			.values({
				id: attemptId,
				jobId: queuedJob.id,
				attemptNumber,
				status: 'running',
				stage: queuedJob.stage,
				workerId: input.workerId,
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				finishedAt: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		tx.update(fileProductionJobs)
			.set({
				status: 'running',
				currentAttemptId: attemptId,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				updatedAt: now,
			})
			.where(and(eq(fileProductionJobs.id, queuedJob.id), eq(fileProductionJobs.status, 'queued')))
			.run();
		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, queuedJob.id))
			.limit(1)
			.all();

		if (!updatedJob || updatedJob.currentAttemptId !== attemptId || updatedJob.status !== 'running') {
			return null;
		}

		return {
			job: updatedJob,
			attempt: {
				id: attemptId,
				jobId: queuedJob.id,
				attemptNumber,
				status: 'running',
				stage: queuedJob.stage,
				workerId: input.workerId,
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				finishedAt: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
			},
		};
	});

	if (!claimed) {
		return null;
	}

	return {
		job: mapJobRow(claimed.job, []),
		attempt: {
			...claimed.attempt,
			claimedAt: claimed.attempt.claimedAt.getTime(),
			heartbeatAt: claimed.attempt.heartbeatAt.getTime(),
			startedAt: claimed.attempt.startedAt.getTime(),
			finishedAt: null,
		},
	};
}

export async function heartbeatFileProductionJobAttempt(
	input: OwnedFileProductionAttemptInput
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const [job] = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, input.attemptId)
				)
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const result = tx
			.update(fileProductionJobAttempts)
			.set({
				heartbeatAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, 'running')
				)
			)
			.run();

		return result.changes > 0;
	});
}

export async function failFileProductionJobAttempt(
	input: FailFileProductionAttemptInput
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const [job] = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, input.attemptId)
				)
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const attemptResult = tx
			.update(fileProductionJobAttempts)
			.set({
				status: 'failed',
				finishedAt: now,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage,
				retryable: input.retryable,
				diagnosticsJson: input.diagnostics === undefined ? null : JSON.stringify(input.diagnostics),
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, 'running')
				)
			)
			.run();

		if (attemptResult.changes === 0) {
			return false;
		}

		tx.update(fileProductionJobs)
			.set({
				status: 'failed',
				stage: null,
				retryable: input.retryable,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage,
				updatedAt: now,
				completedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, input.attemptId)
				)
			)
			.run();

		return true;
	});
}

export async function recoverStaleFileProductionAttempts(
	input: RecoverStaleFileProductionAttemptsInput
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const recovered = db.transaction((tx) => {
		const staleAttempts = tx
			.select({
				attemptId: fileProductionJobAttempts.id,
				jobId: fileProductionJobAttempts.jobId,
			})
			.from(fileProductionJobAttempts)
			.innerJoin(fileProductionJobs, eq(fileProductionJobs.id, fileProductionJobAttempts.jobId))
			.where(
				and(
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, fileProductionJobAttempts.id),
					eq(fileProductionJobAttempts.status, 'running'),
					lt(fileProductionJobAttempts.heartbeatAt, input.staleBefore)
				)
			)
			.all();
		let recoveredCount = 0;

		for (const attempt of staleAttempts) {
			const attemptResult = tx
				.update(fileProductionJobAttempts)
				.set({
					status: 'failed',
					finishedAt: now,
					errorCode: 'worker_heartbeat_timeout',
					errorMessage: 'File production worker stopped before finishing.',
					retryable: true,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, attempt.attemptId),
						eq(fileProductionJobAttempts.jobId, attempt.jobId),
						eq(fileProductionJobAttempts.status, 'running')
					)
				)
				.run();

			if (attemptResult.changes === 0) {
				continue;
			}

			tx.update(fileProductionJobs)
				.set({
					status: 'failed',
					stage: null,
					retryable: true,
					errorCode: 'worker_heartbeat_timeout',
					errorMessage: 'File production worker stopped before finishing.',
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, attempt.jobId),
						eq(fileProductionJobs.status, 'running'),
						eq(fileProductionJobs.currentAttemptId, attempt.attemptId)
					)
				)
				.run();
			recoveredCount += 1;
		}

		return recoveredCount;
	});

	return { recovered };
}

export async function reconcileStaleFileProductionJobs(
	input: ReconcileStaleFileProductionJobsInput
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const staleBefore =
		input.staleBefore ?? new Date(now.getTime() - DEFAULT_STALE_ATTEMPT_MS);
	const assistantMessageIds = input.assistantMessageIds
		? Array.from(new Set(input.assistantMessageIds.filter(Boolean)))
		: null;
	if (assistantMessageIds && assistantMessageIds.length === 0) {
		return { recovered: 0 };
	}
	const scopedJobWhere = (...conditions: Parameters<typeof and>) =>
		assistantMessageIds
			? and(
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.conversationId, input.conversationId),
					inArray(fileProductionJobs.assistantMessageId, assistantMessageIds),
					...conditions
				)
			: and(
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.conversationId, input.conversationId),
					...conditions
				);

	const recovered = db.transaction((tx) => {
		let recoveredCount = 0;
		const staleQueuedJobs = tx
			.select({ jobId: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, 'queued'),
					lt(fileProductionJobs.updatedAt, staleBefore)
				)
			)
			.all();

		for (const job of staleQueuedJobs) {
			const result = tx
				.update(fileProductionJobs)
				.set({
					status: 'failed',
					stage: null,
					retryable: true,
					errorCode: 'worker_queue_timeout',
					errorMessage: 'File production worker did not start before the queue timeout.',
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, job.jobId),
						eq(fileProductionJobs.status, 'queued')
					)
				)
				.run();
			if (result.changes > 0) {
				recoveredCount += 1;
			}
		}

		const staleRunningJobs = tx
			.select({
				job: fileProductionJobs,
				attempt: fileProductionJobAttempts,
			})
			.from(fileProductionJobs)
			.leftJoin(
				fileProductionJobAttempts,
				eq(fileProductionJobAttempts.id, fileProductionJobs.currentAttemptId)
			)
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, 'running'),
					lt(fileProductionJobs.updatedAt, staleBefore)
				)
			)
			.all();

		for (const row of staleRunningJobs) {
			const hasLostAttemptState =
				!row.job.currentAttemptId ||
				!row.attempt ||
				row.attempt.status !== 'running' ||
				row.attempt.heartbeatAt === null;
			if (!hasLostAttemptState) {
				continue;
			}

			if (row.attempt?.status === 'running') {
				tx.update(fileProductionJobAttempts)
					.set({
						status: 'failed',
						finishedAt: now,
						errorCode: 'worker_state_lost',
						errorMessage: 'File production worker state was lost before finishing.',
						retryable: true,
						updatedAt: now,
					})
					.where(
						and(
							eq(fileProductionJobAttempts.id, row.attempt.id),
							eq(fileProductionJobAttempts.jobId, row.job.id),
							eq(fileProductionJobAttempts.status, 'running')
						)
					)
					.run();
			}

			const result = tx
				.update(fileProductionJobs)
				.set({
					status: 'failed',
					stage: null,
					retryable: true,
					errorCode: 'worker_state_lost',
					errorMessage: 'File production worker state was lost before finishing.',
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, row.job.id),
						eq(fileProductionJobs.status, 'running')
					)
				)
				.run();
			if (result.changes > 0) {
				recoveredCount += 1;
			}
		}

		const staleAttempts = tx
			.select({
				attemptId: fileProductionJobAttempts.id,
				jobId: fileProductionJobAttempts.jobId,
			})
			.from(fileProductionJobAttempts)
			.innerJoin(fileProductionJobs, eq(fileProductionJobs.id, fileProductionJobAttempts.jobId))
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, fileProductionJobAttempts.id),
					eq(fileProductionJobAttempts.status, 'running'),
					lt(fileProductionJobAttempts.heartbeatAt, staleBefore)
				)
			)
			.all();

		for (const attempt of staleAttempts) {
			const attemptResult = tx
				.update(fileProductionJobAttempts)
				.set({
					status: 'failed',
					finishedAt: now,
					errorCode: 'worker_heartbeat_timeout',
					errorMessage: 'File production worker stopped before finishing.',
					retryable: true,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, attempt.attemptId),
						eq(fileProductionJobAttempts.jobId, attempt.jobId),
						eq(fileProductionJobAttempts.status, 'running')
					)
				)
				.run();

			if (attemptResult.changes === 0) {
				continue;
			}

			tx.update(fileProductionJobs)
				.set({
					status: 'failed',
					stage: null,
					retryable: true,
					errorCode: 'worker_heartbeat_timeout',
					errorMessage: 'File production worker stopped before finishing.',
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, attempt.jobId),
						eq(fileProductionJobs.status, 'running'),
						eq(fileProductionJobs.currentAttemptId, attempt.attemptId)
					)
				)
				.run();
			recoveredCount += 1;
		}

		return recoveredCount;
	});

	return { recovered };
}

export async function retryFileProductionJob(
	input: RetryFileProductionJobInput
): Promise<FileProductionJob | null> {
	const now = input.now ?? new Date();
	const retried = db.transaction((tx) => {
		const [existingJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.status, 'failed'),
					eq(fileProductionJobs.retryable, true)
				)
			)
			.limit(1)
			.all();

		if (!existingJob) {
			return null;
		}

		tx.update(fileProductionJobs)
			.set({
				status: 'queued',
				stage: null,
				currentAttemptId: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: null,
				cancelRequestedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.status, 'failed'),
					eq(fileProductionJobs.retryable, true)
				)
			)
			.run();

		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updatedJob ?? null;
	});

	return retried ? mapJobRow(retried, []) : null;
}

export async function cancelFileProductionJob(
	input: CancelFileProductionJobInput
): Promise<FileProductionJob | null> {
	const now = input.now ?? new Date();
	const cancelled = db.transaction((tx) => {
		const [existingJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ['queued', 'running'])
				)
			)
			.limit(1)
			.all();

		if (!existingJob) {
			return null;
		}

		if (existingJob.status === 'running' && existingJob.currentAttemptId) {
			tx.update(fileProductionJobAttempts)
				.set({
					status: 'cancelled',
					finishedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, existingJob.currentAttemptId),
						eq(fileProductionJobAttempts.jobId, existingJob.id),
						eq(fileProductionJobAttempts.status, 'running')
					)
				)
				.run();
		}

		tx.update(fileProductionJobs)
			.set({
				status: 'cancelled',
				stage: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: now,
				cancelRequestedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ['queued', 'running'])
				)
			)
			.run();

		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updatedJob ?? null;
	});

	return cancelled ? mapJobRow(cancelled, []) : null;
}

async function linkProducedFileToJob(params: {
	jobId: string;
	chatGeneratedFileId: string;
	sortOrder: number;
	createdAt: Date;
}): Promise<void> {
	await db
		.insert(fileProductionJobFiles)
		.values({
			id: randomUUID(),
			jobId: params.jobId,
			chatGeneratedFileId: params.chatGeneratedFileId,
			sortOrder: params.sortOrder,
			createdAt: params.createdAt,
		})
		.onConflictDoNothing({ target: fileProductionJobFiles.chatGeneratedFileId });
}

async function completeFileProductionJobAttempt(input: {
	jobId: string;
	attemptId: string;
	workerId: string;
	now: Date;
}): Promise<boolean> {
	return db.transaction((tx) => {
		const [job] = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, input.attemptId)
				)
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const attemptResult = tx
			.update(fileProductionJobAttempts)
			.set({
				status: 'succeeded',
				finishedAt: input.now,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, 'running')
				)
			)
			.run();

		if (attemptResult.changes === 0) {
			return false;
		}

		tx.update(fileProductionJobs)
			.set({
				status: 'succeeded',
				stage: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: input.now,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, 'running'),
					eq(fileProductionJobs.currentAttemptId, input.attemptId)
				)
			)
			.run();

		return true;
	});
}

async function getCurrentOwnedRunningJob(input: {
	jobId: string;
	attemptId: string;
	workerId: string;
}): Promise<typeof fileProductionJobs.$inferSelect | null> {
	const [job] = await db
		.select({ job: fileProductionJobs })
		.from(fileProductionJobs)
		.innerJoin(
			fileProductionJobAttempts,
			eq(fileProductionJobAttempts.id, fileProductionJobs.currentAttemptId)
		)
		.where(
			and(
				eq(fileProductionJobs.id, input.jobId),
				eq(fileProductionJobs.status, 'running'),
				eq(fileProductionJobs.currentAttemptId, input.attemptId),
				eq(fileProductionJobAttempts.id, input.attemptId),
				eq(fileProductionJobAttempts.jobId, input.jobId),
				eq(fileProductionJobAttempts.workerId, input.workerId),
				eq(fileProductionJobAttempts.status, 'running')
			)
		)
		.limit(1);

	return job?.job ?? null;
}

async function getAssistantMessageContent(assistantMessageId: string): Promise<string> {
	const [message] = await db
		.select({ content: messages.content })
		.from(messages)
		.where(eq(messages.id, assistantMessageId))
		.limit(1);

	return message?.content ?? '';
}

async function executeNextFileProductionJobStep(
	input: ExecuteNextFileProductionJobInput
): Promise<ExecuteNextFileProductionJobStepResult> {
	const now = input.now ?? new Date();
	const claimed = await claimNextFileProductionJob({
		workerId: input.workerId,
		now,
	});
	if (!claimed) {
		return { processed: false, result: null };
	}

	const [jobRow] = await db
		.select()
		.from(fileProductionJobs)
		.where(eq(fileProductionJobs.id, claimed.job.id))
		.limit(1);
	const request = parseFileProductionJobRequest(jobRow?.requestJson ?? null);
	if (!jobRow || !request.ok) {
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: request.ok ? 'missing_file_production_job' : request.errorCode,
			errorMessage: request.ok ? 'File production job is missing.' : request.errorMessage,
			retryable: false,
			now,
		});
		return { processed: true, result: null };
	}

	const storeGeneratedFile = input.storeGeneratedFile ?? storeChatGeneratedFile;
	let executionResult: ProgramExecutionResult;
	if (request.value.sourceMode === 'program') {
		const executeCode = input.executeCode ?? executeSandboxCode;
		try {
			executionResult = await executeCode(request.value.sourceCode, request.value.language);
		} catch (error) {
			await failFileProductionJobAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: input.workerId,
				errorCode: 'program_execution_threw',
				errorMessage: error instanceof Error ? error.message : 'Program execution failed.',
				retryable: true,
				now: new Date(),
			});
			return { processed: true, result: null };
		}
		if (executionResult.error) {
			await failFileProductionJobAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: input.workerId,
				errorCode: 'program_execution_failed',
				errorMessage: executionResult.error,
				retryable: true,
				now: new Date(),
			});
			return { processed: true, result: null };
		}
	} else {
		try {
			const files: ProgramExecutionFile[] = [];
			if (request.value.outputs.includes('pdf')) {
				const rendered = await renderStandardReportPdf(request.value.documentSource, {
					imageLoader: createDefaultGeneratedDocumentImageLoader({
						userId: jobRow.userId,
						conversationId: jobRow.conversationId,
					}),
				});
				files.push({
					filename: rendered.filename,
					mimeType: rendered.mimeType,
					content: rendered.content,
					sizeBytes: rendered.content.length,
				});
			}
			if (request.value.outputs.includes('docx')) {
				const rendered = await renderStandardReportDocx(request.value.documentSource);
				files.push({
					filename: rendered.filename,
					mimeType: rendered.mimeType,
					content: rendered.content,
					sizeBytes: rendered.content.length,
				});
			}
			if (request.value.outputs.includes('html')) {
				const rendered = renderStandardReportHtml(request.value.documentSource);
				files.push({
					filename: rendered.filename,
					mimeType: rendered.mimeType,
					content: rendered.content,
					sizeBytes: rendered.content.length,
				});
			}
			executionResult = {
				files,
				stdout: '',
				stderr: '',
				error: null,
			};
		} catch (error) {
			await failFileProductionJobAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: input.workerId,
				errorCode:
					error instanceof StandardReportPdfRenderError
						? error.code
						: 'document_render_failed',
				errorMessage:
					error instanceof Error ? error.message : 'Generated document rendering failed.',
				retryable:
					error instanceof StandardReportPdfRenderError
						? error.code === 'pdf_font_missing'
						: true,
				now: new Date(),
			});
			return { processed: true, result: null };
		}
	}

	if (executionResult.files.length === 0) {
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: 'program_no_outputs',
			errorMessage: 'The program finished without producing files.',
			retryable: false,
			now: new Date(),
		});
		return { processed: true, result: null };
	}

	const effectiveLimits = {
		...getFileProductionLimits(),
		...(input.limits ?? {}),
	};
	const outputLimit = validateFileProductionOutputLimits({
		fileSizes: executionResult.files.map((file) =>
			Buffer.isBuffer(file.content) ? file.content.length : Buffer.byteLength(file.content)
		),
		limits: effectiveLimits,
	});
	if (!outputLimit.ok) {
		console.warn('[FILE_PRODUCTION] Output limit failed', {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			code: outputLimit.code,
			limit: outputLimit.limit,
			actual: outputLimit.actual,
			unit: outputLimit.unit,
		});
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: outputLimit.code,
			errorMessage: outputLimit.message,
			retryable: outputLimit.retryable,
			diagnostics: {
				limit: outputLimit.limit,
				actual: outputLimit.actual,
				unit: outputLimit.unit,
			},
			now: new Date(),
		});
		return { processed: true, result: null };
	}

	const currentJobRow = await getCurrentOwnedRunningJob({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
	});
	if (!currentJobRow) {
		return { processed: true, result: null };
	}

	const producedFiles: FileProductionJob['files'] = [];
	try {
		for (const [index, file] of executionResult.files.entries()) {
			const filename =
				request.value.sourceMode === 'program' &&
				request.value.filename &&
				executionResult.files.length === 1
					? request.value.filename
					: file.filename;
			const storedFile = await storeGeneratedFile(currentJobRow.conversationId, currentJobRow.userId, {
				assistantMessageId: currentJobRow.assistantMessageId,
				filename,
				mimeType: file.mimeType,
				content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
			});
			await linkProducedFileToJob({
				jobId: jobRow.id,
				chatGeneratedFileId: storedFile.id,
				sortOrder: index,
				createdAt: now,
			});
			producedFiles.push(mapChatFileToProducedFile(storedFile));
		}
	} catch (error) {
		await failFileProductionJobAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
			errorCode: 'program_output_storage_failed',
			errorMessage: error instanceof Error ? error.message : 'Program output storage failed.',
			retryable: true,
			now: new Date(),
		});
		return { processed: true, result: null };
	}

	const completed = await completeFileProductionJobAttempt({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
		now: new Date(),
	});

	if (!completed) {
		return { processed: true, result: null };
	}

	if (currentJobRow.assistantMessageId && producedFiles.length > 0) {
		const syncGeneratedFilesToMemory =
			input.syncGeneratedFilesToMemory ?? syncChatGeneratedFilesToMemory;
		try {
			await syncGeneratedFilesToMemory({
				userId: currentJobRow.userId,
				conversationId: currentJobRow.conversationId,
				assistantMessageId: currentJobRow.assistantMessageId,
				fileIds: producedFiles.map((file) => file.id),
				assistantResponse: await getAssistantMessageContent(currentJobRow.assistantMessageId),
			});
		} catch (error) {
			console.error('[FILE_PRODUCTION] Background generated-file memory sync failed', {
				jobId: currentJobRow.id,
				assistantMessageId: currentJobRow.assistantMessageId,
				fileIds: producedFiles.map((file) => file.id),
				error,
			});
		}
	}

	return {
		processed: true,
		result: {
			job: {
				...claimed.job,
				assistantMessageId: currentJobRow.assistantMessageId,
				status: 'succeeded',
				stage: null,
				updatedAt: Date.now(),
				files: producedFiles,
			},
			files: producedFiles,
		},
	};
}

export async function executeNextFileProductionJob(
	input: ExecuteNextFileProductionJobInput
): Promise<ExecuteNextFileProductionJobResult | null> {
	const step = await executeNextFileProductionJobStep(input);
	return step.result;
}

export async function drainFileProductionWorker(
	input: DrainFileProductionWorkerInput = {}
): Promise<void> {
	for (;;) {
		const step = await executeNextFileProductionJobStep({
			...input,
			workerId: input.workerId ?? DEFAULT_WORKER_ID,
		});
		if (!step.processed) {
			return;
		}
	}
}

export function wakeFileProductionWorker(): void {
	if (drainPromise) {
		return;
	}

	drainPromise = Promise.resolve()
		.then(() => drainFileProductionWorker())
		.catch((error) => {
			console.error('[FILE_PRODUCTION] Worker drain failed', { error });
		})
		.finally(() => {
			drainPromise = null;
		});
}

export async function ensureFileProductionWorker(): Promise<void> {
	if (workerInitialized) {
		return;
	}
	workerInitialized = true;
	await recoverStaleFileProductionAttempts({
		staleBefore: new Date(Date.now() - DEFAULT_STALE_ATTEMPT_MS),
	});
	wakeFileProductionWorker();
}

export async function listConversationFileProductionJobs(
	userId: string,
	conversationId: string
): Promise<FileProductionJob[]> {
	const files = await getChatFiles(conversationId);
	const userFiles = files.filter((file) => file.userId === userId);
	await ensureLegacyJobs(userFiles);
	const fileById = new Map(userFiles.map((file) => [file.id, file]));
	const jobs = await db
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				eq(fileProductionJobs.conversationId, conversationId)
			)
		)
		.orderBy(desc(fileProductionJobs.createdAt));

	if (jobs.length === 0) {
		return [];
	}

	const links = await db
		.select()
		.from(fileProductionJobFiles)
		.where(
			inArray(
				fileProductionJobFiles.jobId,
				jobs.map((job) => job.id)
			)
		);
	const linksByJobId = new Map<string, typeof links>();
	for (const link of links) {
		const next = linksByJobId.get(link.jobId) ?? [];
		next.push(link);
		linksByJobId.set(link.jobId, next);
	}

	return jobs
		.map((job) => {
			const jobLinks = (linksByJobId.get(job.id) ?? []).sort(
				(a, b) => a.sortOrder - b.sortOrder
			);
			return mapJobRow(
				job,
				jobLinks
					.map((link) => fileById.get(link.chatGeneratedFileId))
					.filter((file): file is ChatFile => Boolean(file))
					.map(mapChatFileToProducedFile)
			);
		})
		.filter((job) => job.files.length > 0 || job.status !== 'succeeded');
}

export async function assignFileProductionJobsToAssistantMessage(
	userId: string,
	conversationId: string,
	assistantMessageId: string,
	jobIds: string[]
): Promise<void> {
	const uniqueJobIds = Array.from(new Set(jobIds.filter((jobId) => jobId.trim().length > 0)));
	if (uniqueJobIds.length === 0) {
		return;
	}

	await db
		.update(fileProductionJobs)
		.set({
			assistantMessageId,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				eq(fileProductionJobs.conversationId, conversationId),
				inArray(fileProductionJobs.id, uniqueJobIds),
				isNull(fileProductionJobs.assistantMessageId)
			)
		);

	const links = await db
		.select({ chatGeneratedFileId: fileProductionJobFiles.chatGeneratedFileId })
		.from(fileProductionJobFiles)
		.where(inArray(fileProductionJobFiles.jobId, uniqueJobIds));
	const linkedFileIds = Array.from(new Set(links.map((link) => link.chatGeneratedFileId)));
	if (linkedFileIds.length === 0) {
		return;
	}

	await db
		.update(chatGeneratedFiles)
		.set({ assistantMessageId })
		.where(
			and(
				eq(chatGeneratedFiles.conversationId, conversationId),
				inArray(chatGeneratedFiles.id, linkedFileIds),
				isNull(chatGeneratedFiles.assistantMessageId)
			)
		);
}
