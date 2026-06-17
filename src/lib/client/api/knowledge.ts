import type {
	ArtifactSummary,
	KnowledgeDocumentItem,
	KnowledgeMemoryOverviewPayload,
	KnowledgeMemoryPayload,
	KnowledgeUploadResponse,
	MemoryProfileActionPayload,
	MemoryProfilePublicPayload,
	WorkCapsule,
} from "$lib/types";
import { _unwrapList } from "./_utils";
import {
	ApiError,
	type FetchLike,
	requestJson,
	requestText,
	requestVoid,
} from "./http";

export type KnowledgeLibrary = {
	documents: KnowledgeDocumentItem[];
	results: ArtifactSummary[];
	workflows: WorkCapsule[];
};

type LegacyKnowledgeMemoryActionPayload =
	| {
			action: "forget_persona_memory";
			clusterId?: string;
			conclusionId?: string;
	  }
	| { action: "forget_all_persona_memory" }
	| { action: "forget_task_memory"; taskId: string }
	| { action: "forget_focus_continuity"; continuityId: string }
	| { action: "forget_project_memory"; projectId: string };

export type KnowledgeMemoryActionPayload =
	| MemoryProfileActionPayload
	| LegacyKnowledgeMemoryActionPayload;

export type KnowledgeBulkAction =
	| "forget_all_documents"
	| "forget_all_results"
	| "forget_all_workflows"
	| "forget_everything";

type KnowledgeActionResult = {
	success?: boolean;
	deletedArtifactIds?: string[];
	message?: string;
	error?: string;
};

type KnowledgeDeleteResult = {
	success?: boolean;
	deletedArtifactIds?: string[];
	message?: string;
	error?: string;
};

const UPLOAD_INTERRUPTED_MESSAGE =
	"Upload was interrupted before it completed. Try again; if it keeps happening, the server or reverse proxy may be closing large uploads before AlfyAI receives them.";
const UPLOAD_GATEWAY_STATUSES = new Set([502, 503, 504]);
const UPLOAD_NAME_HEADER = "X-AlfyAI-Upload-Name";
const UPLOAD_SIZE_HEADER = "X-AlfyAI-Upload-Size";
const UPLOAD_TRACE_HEADER = "X-AlfyAI-Upload-Trace-Id";
const UPLOAD_CONVERSATION_HEADER = "X-AlfyAI-Conversation-Id";
const UPLOAD_CHUNK_INDEX_HEADER = "X-AlfyAI-Chunk-Index";
const UPLOAD_CHUNK_TOTAL_HEADER = "X-AlfyAI-Chunk-Total";
const UPLOAD_CHUNK_START_HEADER = "X-AlfyAI-Chunk-Start";
const UPLOAD_CHUNK_SIZE_HEADER = "X-AlfyAI-Chunk-Size";
const UPLOAD_CHUNK_FINAL_HEADER = "X-AlfyAI-Chunk-Final";
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 256 * 1024;

type KnowledgeUploadIntentResponse = {
	traceId: string;
	chunkBodyLimit?: number;
	rawUploadLimit?: number;
	requestBodyLimit?: number;
};

type ChunkUploadResponse =
	| (KnowledgeUploadResponse & {
			complete: true;
			traceId: string;
			receivedBytes: number;
			totalSize: number;
	  })
	| {
			complete: false;
			traceId: string;
			receivedBytes: number;
			totalSize: number;
			chunkIndex: number;
			totalChunks: number;
	  };

function encodeUploadHeaderValue(value: string): string {
	return encodeURIComponent(value).slice(0, 512);
}

function formatUploadBytes(value: number): string {
	const mb = value / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function uploadGatewayMessage(file: File, status: number): string {
	return `Upload gateway failed with HTTP ${status} while receiving "${file.name}" (${formatUploadBytes(file.size)}). AlfyAI did not finish receiving the file, so extraction did not start. Check reverse proxy body limits/timeouts and whether the Node server restarted while streaming the upload body.`;
}

function buildUploadHeaders(
	file: File,
	traceId: string,
	conversationId?: string | null,
): Record<string, string> {
	const headers: Record<string, string> = {
		[UPLOAD_NAME_HEADER]: encodeUploadHeaderValue(file.name),
		[UPLOAD_SIZE_HEADER]: String(file.size),
		[UPLOAD_TRACE_HEADER]: traceId,
		"Content-Type": file.type || "application/octet-stream",
	};
	if (conversationId) {
		headers[UPLOAD_CONVERSATION_HEADER] = conversationId;
	}
	return headers;
}

function errorName(error: unknown): string {
	return typeof error === "object" &&
		error !== null &&
		"name" in error &&
		typeof (error as { name?: unknown }).name === "string"
		? (error as { name: string }).name
		: "";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUploadTransportAbort(error: unknown): boolean {
	const name = errorName(error);
	const message = errorMessage(error);
	return (
		name === "AbortError" ||
		/\baborted\b|operation was aborted|failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(
			message,
		)
	);
}

function positiveFiniteBytes(value: number | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const bytes = Math.floor(value);
	return bytes > 0 ? bytes : null;
}

function resolveRawUploadLimit(intent: KnowledgeUploadIntentResponse): number {
	return (
		positiveFiniteBytes(intent.rawUploadLimit) ??
		positiveFiniteBytes(intent.requestBodyLimit) ??
		CHUNKED_UPLOAD_THRESHOLD_BYTES
	);
}

function resolveChunkSize(intent: KnowledgeUploadIntentResponse): number {
	const chunkBodyLimit =
		intent.chunkBodyLimit === undefined
			? UPLOAD_CHUNK_BYTES
			: positiveFiniteBytes(intent.chunkBodyLimit);
	if (chunkBodyLimit === null) {
		throw new Error(
			"Upload chunk size limit is too low for this file. Ask an administrator to increase the server upload body limit.",
		);
	}
	return Math.min(UPLOAD_CHUNK_BYTES, chunkBodyLimit);
}

export async function fetchKnowledgeLibrary(): Promise<KnowledgeLibrary> {
	const payload = await requestJson<Partial<KnowledgeLibrary>>(
		"/api/knowledge",
		undefined,
		"Failed to refresh the Knowledge Base.",
	);

	return {
		documents: _unwrapList<KnowledgeDocumentItem>(payload, "documents"),
		results: _unwrapList<ArtifactSummary>(payload, "results"),
		workflows: _unwrapList<WorkCapsule>(payload, "workflows"),
	};
}

export async function fetchMemoryProfile(): Promise<MemoryProfilePublicPayload> {
	return requestJson<MemoryProfilePublicPayload>(
		"/api/knowledge/memory",
		undefined,
		"Failed to load memory profile.",
	);
}

export async function fetchKnowledgeMemory(): Promise<KnowledgeMemoryPayload> {
	return fetchMemoryProfile();
}

export async function fetchKnowledgeMemoryOverview(
	options: { force?: boolean } = {},
): Promise<KnowledgeMemoryOverviewPayload> {
	const query = options.force ? "?force=1" : "";
	return requestJson<KnowledgeMemoryOverviewPayload>(
		`/api/knowledge/memory/overview${query}`,
		undefined,
		"Failed to refresh the live memory overview.",
	);
}

export async function submitKnowledgeMemoryAction(
	payload: KnowledgeMemoryActionPayload,
	fetchImpl: FetchLike = fetch,
): Promise<MemoryProfilePublicPayload> {
	return requestJson<MemoryProfilePublicPayload>(
		"/api/knowledge/memory/actions",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to update memory profile.",
		fetchImpl,
	);
}

export async function submitKnowledgeBulkAction(
	action: KnowledgeBulkAction,
): Promise<KnowledgeActionResult> {
	return requestJson<KnowledgeActionResult>(
		"/api/knowledge/actions",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ action }),
		},
		"Failed to update the Knowledge Base.",
	);
}

export async function deleteKnowledgeArtifact(
	id: string,
): Promise<KnowledgeDeleteResult> {
	return requestJson<KnowledgeDeleteResult>(
		`/api/knowledge/${id}`,
		{
			method: "DELETE",
		},
		"Failed to remove artifact.",
	);
}

export async function uploadKnowledgeAttachment(
	file: File,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<KnowledgeUploadResponse> {
	const intent = await requestJson<KnowledgeUploadIntentResponse>(
		"/api/knowledge/upload/intent",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				fileName: file.name,
				fileSize: file.size,
				mimeType: file.type || null,
				conversationId: conversationId ?? null,
			}),
		},
		"Failed to prepare upload.",
		fetchImpl,
	);
	try {
		if (file.size > resolveRawUploadLimit(intent)) {
			return await uploadChunkedKnowledgeAttachment(
				file,
				intent.traceId,
				conversationId,
				fetchImpl,
				resolveChunkSize(intent),
			);
		}
		return await requestJson<KnowledgeUploadResponse>(
			"/api/knowledge/upload/raw",
			{
				method: "POST",
				headers: buildUploadHeaders(file, intent.traceId, conversationId),
				body: file,
			},
			"Failed to upload attachment.",
			fetchImpl,
		);
	} catch (error) {
		if (
			error instanceof ApiError &&
			UPLOAD_GATEWAY_STATUSES.has(error.status)
		) {
			throw new Error(uploadGatewayMessage(file, error.status));
		}
		if (isUploadTransportAbort(error)) {
			throw new Error(UPLOAD_INTERRUPTED_MESSAGE);
		}
		throw error;
	}
}

async function uploadChunkedKnowledgeAttachment(
	file: File,
	traceId: string,
	conversationId: string | null | undefined,
	fetchImpl: FetchLike,
	chunkSize: number,
): Promise<KnowledgeUploadResponse> {
	const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
	let finalResponse: KnowledgeUploadResponse | null = null;

	for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
		const start = chunkIndex * chunkSize;
		const end = Math.min(file.size, start + chunkSize);
		const chunk = file.slice(
			start,
			end,
			file.type || "application/octet-stream",
		);
		const isFinal = chunkIndex === totalChunks - 1;
		const response = await requestJson<ChunkUploadResponse>(
			"/api/knowledge/upload/chunk",
			{
				method: "POST",
				headers: {
					...buildUploadHeaders(file, traceId, conversationId),
					[UPLOAD_CHUNK_INDEX_HEADER]: String(chunkIndex),
					[UPLOAD_CHUNK_TOTAL_HEADER]: String(totalChunks),
					[UPLOAD_CHUNK_START_HEADER]: String(start),
					[UPLOAD_CHUNK_SIZE_HEADER]: String(end - start),
					[UPLOAD_CHUNK_FINAL_HEADER]: isFinal ? "true" : "false",
				},
				body: chunk,
			},
			"Failed to upload attachment.",
			fetchImpl,
		);

		if (response.complete) {
			finalResponse = response;
		}
	}

	if (!finalResponse) {
		throw new Error("Upload finished without a completed server response.");
	}
	return finalResponse;
}

export async function recordDocumentWorkspaceOpen(
	artifactId: string,
): Promise<void> {
	await requestVoid(
		"/api/knowledge/documents/behavior",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "workspace_opened",
				artifactId,
			}),
		},
		"Failed to record document workspace behavior.",
	);
}

export async function fetchKnowledgeWorkspaceDocument(
	artifactId: string,
): Promise<KnowledgeDocumentItem | null> {
	const payload = await requestJson<{
		document?: KnowledgeDocumentItem | null;
	}>(
		`/api/knowledge/documents/resolve?artifactId=${encodeURIComponent(
			artifactId,
		)}`,
		undefined,
		"Failed to resolve Knowledge document.",
	);
	return payload.document ?? null;
}

export async function fetchDocumentPreviewText(url: string): Promise<string> {
	return requestText(url, undefined, "Failed to load document preview.");
}
