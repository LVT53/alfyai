import type { I18nKey } from "$lib/i18n";
import type {
	MemoryPersonaSummaryPayload,
	MemoryProfileActionPayload,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicPayload,
	MemoryTimelinePayload,
	MemoryV2ActionPayload,
} from "$lib/memory-profile-types";
import type {
	ArtifactSummary,
	KnowledgeDocumentItem,
	KnowledgeUploadResponse,
	WorkCapsule,
} from "$lib/server/services/knowledge/types";
import type {
	KnowledgeMemoryOverviewPayload,
	KnowledgeMemoryPayload,
} from "$lib/server/services/memory-types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { EXTRACTION_STATUS_BATCH_LIMIT } from "$lib/shared/extraction-status";
import { setDisabledFileTypeIds } from "$lib/stores/upload-format-gate";
import { setMaxFileUploadSize } from "$lib/stores/upload-limits";
import { formatByteSize } from "$lib/utils/format";
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

export type KnowledgeMemoryActionPayload = MemoryProfileActionPayload;

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

/**
 * The keys `/api/knowledge/upload*` answers a refused file with. The `error`
 * string those responses carry is English — the endpoints are not locale-aware
 * — so a caller that shows `err.message` shows English to a Hungarian user.
 * These six are the translated equivalents; anything else falls back to the
 * server string, which is still better than nothing.
 */
const UPLOAD_REFUSAL_KEYS: ReadonlySet<string> = new Set<I18nKey>([
	"knowledge.uploadUnsupportedType",
	"knowledge.uploadRejectedMedia",
	"knowledge.uploadRejectedArchive",
	"knowledge.uploadRejectedFormatNotEnabled",
	"knowledge.uploadRejectedConvertImage",
	"knowledge.uploadContentMismatch",
]);

/**
 * The refusals that are not a 415. Phase 3's direct-text cap answers 413 with
 * its own key and a `maxBytes` detail, and a set keyed only on 415 let that
 * fall through to the server's English sentence on all three upload surfaces.
 *
 * The two SIZE refusals beside it fell through the same way, for longer: the
 * endpoints have always minted `knowledge.uploadFileTooLarge` and
 * `knowledge.uploadBodyTooLarge`, and no dictionary ever defined them, so
 * "File too large. Maximum size is 50 MB." reached a Hungarian user verbatim.
 * They carry their limit under a different detail name, which
 * `refusalLimitBytes` below now reads.
 */
const UPLOAD_REFUSAL_KEYS_413: ReadonlySet<string> = new Set<I18nKey>([
	"knowledge.uploadDirectTextTooLarge",
	"knowledge.uploadFileTooLarge",
	"knowledge.uploadBodyTooLarge",
]);

/**
 * A 400: the upload was cut off part-way. Not a refusal of the file, but it
 * reaches the same banner and was equally untranslated.
 */
const UPLOAD_REFUSAL_KEYS_400: ReadonlySet<string> = new Set<I18nKey>([
	"knowledge.uploadAborted",
]);

/**
 * The byte limit a refusal is about, whichever detail name carries it.
 *
 * `maxBytes` is the direct-text cap, `maxFileUploadSize` the per-file admin
 * limit and `maxBodySize` the request-body ceiling. Three names for one
 * `{limit}` placeholder.
 */
function refusalLimitBytes(details: Record<string, unknown>): number | null {
	for (const name of ["maxBytes", "maxFileUploadSize", "maxBodySize"]) {
		const value = details[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

export type UploadRefusal = {
	readonly key: I18nKey;
	/**
	 * `{name}`, `{ext}` and `{limit}` are what the server's refusal keys use.
	 * The client-composed failures below add their own (`{status}`, `{size}`),
	 * so the record is open — a key only ever reads the placeholders it names.
	 */
	readonly params: Record<string, string | number> & {
		readonly name: string;
	};
};

/**
 * A failure the CLIENT composed, carrying the i18n key for it.
 *
 * Most upload refusals are the server's: it answers `errorKey` and
 * `uploadRefusalFromError` turns that into a translated sentence. Two are not
 * — a transport abort and a gateway status — because no server body reaches us
 * to carry a key. Those were plain `Error`s with English prose in `message`,
 * which every call site then rendered verbatim whatever language the user was
 * in; the gateway one was operator prose about reverse proxy body limits and
 * the Node server, shown to an end user.
 *
 * `message` keeps the English so a non-UI caller (a test, a log line) still
 * reads something, and `key`/`params` are what the three upload surfaces
 * actually render.
 */
export class TranslatableUploadError extends Error {
	readonly key: I18nKey;
	readonly params: UploadRefusal["params"];

	constructor(message: string, key: I18nKey, params: UploadRefusal["params"]) {
		super(message);
		this.name = "TranslatableUploadError";
		this.key = key;
		this.params = params;
	}
}

/**
 * Translate a refused upload into an i18n key plus its parameters, or `null`
 * when the error is anything else (the caller then keeps whatever it did
 * before). `file` supplies the name when the server did not echo one.
 */
export function uploadRefusalFromError(
	error: unknown,
	file: { name: string },
): UploadRefusal | null {
	// The client-composed failures carry their own key; they never had a
	// server body to read one off.
	if (error instanceof TranslatableUploadError) {
		return { key: error.key, params: error.params };
	}
	if (!(error instanceof ApiError)) return null;
	const key = error.errorKey;
	if (!key) return null;

	const recognized =
		(error.status === 415 && UPLOAD_REFUSAL_KEYS.has(key)) ||
		(error.status === 413 && UPLOAD_REFUSAL_KEYS_413.has(key)) ||
		(error.status === 400 && UPLOAD_REFUSAL_KEYS_400.has(key));
	if (!recognized) return null;

	const details = error.details ?? {};
	const fileName =
		typeof details.fileName === "string" && details.fileName.trim()
			? details.fileName
			: file.name;
	const extension =
		typeof details.extension === "string" && details.extension.trim()
			? details.extension
			: (fileName.split(".").slice(1).pop() ?? "");
	const maxBytes = refusalLimitBytes(details);

	return {
		key: key as I18nKey,
		params: {
			name: fileName,
			ext: extension.toUpperCase(),
			limit:
				maxBytes === null
					? ""
					: formatByteSize(maxBytes, {
							trimWholeUnits: true,
						}),
		},
	};
}

/** The English fallback. The user sees `knowledge.uploadInterrupted`. */
const UPLOAD_INTERRUPTED_MESSAGE =
	"Upload was interrupted before it completed. Try again; if it keeps happening, the server or reverse proxy may be closing large uploads before AlfyAI receives them.";

function uploadInterruptedError(file: File): TranslatableUploadError {
	return new TranslatableUploadError(
		UPLOAD_INTERRUPTED_MESSAGE,
		"knowledge.uploadInterrupted",
		{ name: file.name },
	);
}
const UPLOAD_GATEWAY_STATUSES = new Set([502, 503, 504]);
const UPLOAD_NAME_HEADER = "X-AlfyAI-Upload-Name";
const UPLOAD_SIZE_HEADER = "X-AlfyAI-Upload-Size";
const UPLOAD_TRACE_HEADER = "X-AlfyAI-Upload-Trace-Id";
const UPLOAD_CONVERSATION_HEADER = "X-AlfyAI-Conversation-Id";
/** Set when the upload was started from inside a project's Files modal. */
const UPLOAD_PROJECT_HEADER = "X-AlfyAI-Project-Id";
const UPLOAD_CHUNK_INDEX_HEADER = "X-AlfyAI-Chunk-Index";
const UPLOAD_CHUNK_TOTAL_HEADER = "X-AlfyAI-Chunk-Total";
const UPLOAD_CHUNK_START_HEADER = "X-AlfyAI-Chunk-Start";
const UPLOAD_CHUNK_SIZE_HEADER = "X-AlfyAI-Chunk-Size";
const UPLOAD_CHUNK_FINAL_HEADER = "X-AlfyAI-Chunk-Final";
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 256 * 1024;

type KnowledgeUploadIntentResponse = {
	traceId: string;
	/** The authoritative per-file limit; published into `$maxFileUploadSizeBytes`. */
	maxFileUploadSize?: number;
	chunkBodyLimit?: number;
	rawUploadLimit?: number;
	requestBodyLimit?: number;
	/**
	 * The MinerU-4 gate's current answer (phase5-6 spec §3.5), published into
	 * `$disabledFileTypeIds` next to `maxFileUploadSize`. Absent or malformed
	 * means "open" — see `setDisabledFileTypeIds`.
	 */
	disabledFileTypeIds?: string[];
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

/** The English fallback. The user sees `knowledge.uploadGatewayFailed`. */
function uploadGatewayMessage(file: File, status: number): string {
	return `Upload gateway failed with HTTP ${status} while receiving "${file.name}" (${formatUploadBytes(file.size)}). AlfyAI did not finish receiving the file, so extraction did not start. Check reverse proxy body limits/timeouts and whether the Node server restarted while streaming the upload body.`;
}

function uploadGatewayError(
	file: File,
	status: number,
): TranslatableUploadError {
	return new TranslatableUploadError(
		uploadGatewayMessage(file, status),
		"knowledge.uploadGatewayFailed",
		{ name: file.name, status, size: formatUploadBytes(file.size) },
	);
}

function buildUploadHeaders(
	file: File,
	traceId: string,
	conversationId?: string | null,
	projectId?: string | null,
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
	if (projectId) {
		headers[UPLOAD_PROJECT_HEADER] = projectId;
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

/**
 * Which of the user's projects know each of these documents — the library's
 * per-row token ("In 1 project"), asked once for a whole page of rows.
 *
 * Keyed by the document's own display artifact id, which is exactly the id the
 * library table holds and the id a link is stored against. A document no
 * project knows is simply absent from the answer, and a failure to answer is
 * the caller's to swallow: a missing token is a cosmetic loss, and the library
 * table is not a place to raise an error about a badge.
 *
 * The server caps one request at 200 ids, four times the library's own page
 * cap, so a page of rows never has to be split.
 */
export async function fetchProjectKnowledgeLinks(
	artifactIds: string[],
): Promise<Record<string, string[]>> {
	const ids = [
		...new Set(artifactIds.map((id) => id.trim()).filter((id) => id !== "")),
	];
	if (ids.length === 0) return {};

	const query = ids.map((id) => encodeURIComponent(id)).join(",");
	const payload = await requestJson<{ links?: Record<string, string[]> }>(
		`/api/projects/knowledge-links?artifactIds=${query}`,
		undefined,
		"Failed to load the projects these documents belong to",
	);
	return payload.links ?? {};
}

export async function fetchMemoryProfile(): Promise<MemoryProfilePublicPayload> {
	return requestJson<MemoryProfilePublicPayload>(
		"/api/knowledge/memory",
		undefined,
		"Failed to load memory profile.",
	);
}

export async function fetchMemoryProfileItemDetail(
	itemId: string,
	fetchImpl: FetchLike = fetch,
): Promise<MemoryProfilePublicItemDetail> {
	return requestJson<MemoryProfilePublicItemDetail>(
		`/api/knowledge/memory/${encodeURIComponent(itemId)}`,
		undefined,
		"Failed to load memory item.",
		fetchImpl,
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

export async function fetchMemorySummary(
	fetchImpl: FetchLike = fetch,
): Promise<MemoryPersonaSummaryPayload> {
	return requestJson<MemoryPersonaSummaryPayload>(
		"/api/knowledge/memory/summary",
		undefined,
		"Failed to load memory summary.",
		fetchImpl,
	);
}

export async function fetchMemoryTimeline(
	fetchImpl: FetchLike = fetch,
): Promise<MemoryTimelinePayload> {
	return requestJson<MemoryTimelinePayload>(
		"/api/knowledge/memory/timeline",
		undefined,
		"Failed to load memory timeline.",
		fetchImpl,
	);
}

/**
 * Sends one of the v2 kind-discriminated memory actions. Summary edits
 * come back as the updated summary payload; profile-item corrections,
 * retirements and consolidation undos come back as the refreshed profile.
 */
export async function submitMemoryV2Action(
	payload: Extract<MemoryV2ActionPayload, { kind: "summary" }>,
	fetchImpl?: FetchLike,
): Promise<MemoryPersonaSummaryPayload>;
export async function submitMemoryV2Action(
	payload: Exclude<MemoryV2ActionPayload, { kind: "summary" }>,
	fetchImpl?: FetchLike,
): Promise<MemoryProfilePublicPayload>;
export async function submitMemoryV2Action(
	payload: MemoryV2ActionPayload,
	fetchImpl: FetchLike = fetch,
): Promise<MemoryPersonaSummaryPayload | MemoryProfilePublicPayload> {
	return requestJson<MemoryPersonaSummaryPayload | MemoryProfilePublicPayload>(
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

/**
 * Uploads one file into the library.
 *
 * `projectId` (the fourth parameter, beside the custom-fetch escape hatch every
 * caller on the server-tested paths already ignores) is set only by the Files
 * modal's own Upload button: the file is stored as an ordinary library document
 * and linked to the project in the same request, in that order — a failed store
 * must never leave a link pointing at a document that does not exist. It
 * travels on both the raw and the chunked path.
 */
export async function uploadKnowledgeAttachment(
	file: File,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
	projectId?: string | null,
): Promise<KnowledgeUploadResponse> {
	let intent: KnowledgeUploadIntentResponse;
	try {
		intent = await requestJson<KnowledgeUploadIntentResponse>(
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
	} catch (error) {
		// A 413 is the other authoritative reading of the limit: the admin
		// lowered it since the page loaded, and the response says by how much.
		// Adopting it here is what stops the drop zone from going on offering
		// the old number after the refusal.
		if (error instanceof ApiError && error.status === 413) {
			// `setMaxFileUploadSize` ignores anything that is not a positive
			// finite number, so an absent or malformed `details` is a no-op.
			const reported = error.details?.maxFileUploadSize;
			setMaxFileUploadSize(typeof reported === "number" ? reported : null);
		}
		throw error;
	}
	// The intent response is the authoritative limit: it reflects the live
	// admin setting, where the client seed only reflects the one in force when
	// the shell was rendered. Same reasoning for the gate: it lands here before
	// any other upload on the page, so it is never staler than the SSR shell.
	setMaxFileUploadSize(intent.maxFileUploadSize);
	setDisabledFileTypeIds(intent.disabledFileTypeIds);
	try {
		if (file.size > resolveRawUploadLimit(intent)) {
			return await uploadChunkedKnowledgeAttachment(
				file,
				intent.traceId,
				conversationId,
				fetchImpl,
				resolveChunkSize(intent),
				projectId,
			);
		}
		return await requestJson<KnowledgeUploadResponse>(
			"/api/knowledge/upload/raw",
			{
				method: "POST",
				headers: buildUploadHeaders(
					file,
					intent.traceId,
					conversationId,
					projectId,
				),
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
			throw uploadGatewayError(file, error.status);
		}
		if (isUploadTransportAbort(error)) {
			throw uploadInterruptedError(file);
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
	projectId?: string | null,
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
					...buildUploadHeaders(file, traceId, conversationId, projectId),
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

/**
 * Ask about the extraction state of any number of documents.
 *
 * The endpoint omits ids it cannot resolve for THIS user rather than answering
 * for them, so the returned array is not guaranteed to be as long as the one
 * asked about — callers key the result by `sourceArtifactId` instead of by
 * index. Ids are de-duplicated here because the endpoint's fifty-id cap counts
 * distinct ids, and a caller holding the same document twice should not lose a
 * slot to it.
 *
 * The cap is enforced HERE, not only in the poller: this is the shared client
 * for the endpoint, and any other caller handing it a long list would
 * otherwise get a 400 that looks like the endpoint being broken. A list longer
 * than the cap becomes several requests, never a refusal.
 */
export async function fetchExtractionJobs(
	artifactIds: string[],
	fetchImpl: FetchLike = fetch,
): Promise<DocumentExtractionJobDTO[]> {
	const ids = Array.from(
		new Set(artifactIds.map((id) => id.trim()).filter(Boolean)),
	);
	if (ids.length === 0) return [];

	const jobs: DocumentExtractionJobDTO[] = [];
	for (
		let start = 0;
		start < ids.length;
		start += EXTRACTION_STATUS_BATCH_LIMIT
	) {
		const batch = ids.slice(start, start + EXTRACTION_STATUS_BATCH_LIMIT);
		const query = batch.map((id) => encodeURIComponent(id)).join(",");
		const payload = await requestJson<{ jobs?: DocumentExtractionJobDTO[] }>(
			`/api/knowledge/extraction?artifactIds=${query}`,
			undefined,
			"Failed to check document processing status.",
			fetchImpl,
		);
		jobs.push(..._unwrapList<DocumentExtractionJobDTO>(payload, "jobs"));
	}
	return jobs;
}

/**
 * Retry a failed extraction. Keyed on the artifact, not the job, so a document
 * that predates the ledger (and therefore has no job row yet) can be retried
 * with the same call — the endpoint materialises a row for it first.
 */
export async function retryExtraction(
	artifactId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DocumentExtractionJobDTO> {
	const payload = await requestJson<{ job: DocumentExtractionJobDTO }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/retry`,
		{ method: "POST" },
		"Failed to retry document processing.",
		fetchImpl,
	);
	return payload.job;
}

/**
 * The extraction tiers this server offers for one document.
 *
 * Read when the Re-extract menu opens rather than with the library page: the
 * answer costs a capability probe, it is the same for every row, and a library
 * of fifty documents should not pay for a menu nobody opened. An `ApiError`
 * carrying `code` is the caller's cue — `unavailable` means the backend is
 * down, not that the document is broken.
 */
export async function fetchReextractTiers(
	artifactId: string,
	fetchImpl: FetchLike = fetch,
): Promise<string[]> {
	const payload = await requestJson<{ tiers?: string[] }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/reextract`,
		undefined,
		"Failed to read the available extraction tiers.",
		fetchImpl,
	);
	return Array.isArray(payload.tiers) ? payload.tiers : [];
}

/**
 * Re-extract a document at a chosen tier. Keyed on the artifact like Retry,
 * and legal from a SUCCEEDED job — which is the whole point: the document is
 * readable, and the user wants it read better.
 */
export async function reextractDocument(
	artifactId: string,
	tier: string,
	fetchImpl: FetchLike = fetch,
): Promise<DocumentExtractionJobDTO> {
	const payload = await requestJson<{ job: DocumentExtractionJobDTO }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/reextract`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tier }),
		},
		"Failed to start re-extraction.",
		fetchImpl,
	);
	return payload.job;
}

/** Cancel an extraction that is still queued or running. */
export async function cancelExtraction(
	artifactId: string,
	fetchImpl: FetchLike = fetch,
): Promise<DocumentExtractionJobDTO> {
	const payload = await requestJson<{ job: DocumentExtractionJobDTO }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/cancel`,
		{ method: "POST" },
		"Failed to cancel document processing.",
		fetchImpl,
	);
	return payload.job;
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
