import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { json } from "@sveltejs/kit";
import { getUploadFormatGate } from "$lib/server/services/knowledge/format-availability";
import {
	isKnowledgeUploadConversationError,
	validateKnowledgeUploadConversation,
} from "$lib/server/services/knowledge/upload-intake";
import {
	formatUploadRejectMessageEn,
	UPLOAD_REJECT_I18N_KEYS,
	UPLOAD_UNSUPPORTED_TYPE_CODE,
} from "$lib/server/services/knowledge/upload-signature";
import {
	admitUpload,
	fileExtension,
	type RejectReasonKey,
} from "$lib/shared/file-types";

const UPLOAD_NAME_HEADER = "x-alfyai-upload-name";
const UPLOAD_SIZE_HEADER = "x-alfyai-upload-size";
const UPLOAD_TRACE_HEADER = "x-alfyai-upload-trace-id";
const UPLOAD_CONVERSATION_HEADER = "x-alfyai-conversation-id";

export type KnowledgeUploadRequestMetadata = {
	traceId: string;
	fileName: string | null;
	declaredFileSize: number | null;
	conversationId: string | null;
	mimeType: string | null;
};

export type KnowledgeUploadByteSinkParams = {
	source: AsyncIterable<Uint8Array>;
	tempPathAbsolute: string;
	expectedSize?: number | null;
	onChunk?: (params: {
		chunk: Uint8Array;
		receivedBytes: number;
	}) => Promise<void> | void;
	createSizeMismatchError?: (params: {
		expectedSize: number;
		receivedBytes: number;
	}) => Error;
};

export function parseContentLength(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseNonNegativeInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "unlimited";
	const mb = value / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

async function writeChunk(
	writer: ReturnType<typeof createWriteStream>,
	chunk: Uint8Array,
): Promise<void> {
	if (!writer.write(Buffer.from(chunk))) {
		await once(writer, "drain");
	}
}

async function finishWriter(
	writer: ReturnType<typeof createWriteStream>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		writer.once("finish", resolve);
		writer.once("error", reject);
		writer.end();
	});
}

async function cleanupWrittenUpload(tempPathAbsolute: string): Promise<void> {
	await unlink(tempPathAbsolute).catch(() => undefined);
}

function decodeHeaderValue(value: string | null): string | null {
	if (!value) return null;
	try {
		return decodeURIComponent(value).slice(0, 240);
	} catch {
		return value.slice(0, 240);
	}
}

function sanitizeHeaderValue(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 240) : null;
}

function sanitizeUploadTraceId(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return /^[a-z0-9:_-]{4,120}$/i.test(trimmed) ? trimmed : null;
}

export function readKnowledgeUploadRequestMetadata(
	request: Request,
): KnowledgeUploadRequestMetadata {
	return {
		traceId:
			sanitizeUploadTraceId(request.headers.get(UPLOAD_TRACE_HEADER)) ?? "",
		fileName: decodeHeaderValue(request.headers.get(UPLOAD_NAME_HEADER)),
		declaredFileSize: parseContentLength(
			request.headers.get(UPLOAD_SIZE_HEADER),
		),
		conversationId: sanitizeHeaderValue(
			request.headers.get(UPLOAD_CONVERSATION_HEADER),
		),
		mimeType:
			request.headers.get("content-type")?.split(";")[0]?.trim() || null,
	};
}

export async function writeKnowledgeUploadBytes(
	params: KnowledgeUploadByteSinkParams,
): Promise<{ receivedBytes: number; binaryHash: string }> {
	const writer = createWriteStream(params.tempPathAbsolute, { flags: "wx" });
	const hash = createHash("sha256");
	let receivedBytes = 0;

	try {
		for await (const chunk of params.source) {
			receivedBytes += chunk.byteLength;
			await params.onChunk?.({
				chunk,
				receivedBytes,
			});
			hash.update(chunk);
			await writeChunk(writer, chunk);
		}

		await finishWriter(writer);
	} catch (error) {
		writer.destroy();
		await cleanupWrittenUpload(params.tempPathAbsolute);
		throw error;
	}

	if (
		params.expectedSize !== null &&
		params.expectedSize !== undefined &&
		receivedBytes !== params.expectedSize
	) {
		await cleanupWrittenUpload(params.tempPathAbsolute);
		throw (
			params.createSizeMismatchError?.({
				expectedSize: params.expectedSize,
				receivedBytes,
			}) ?? new Error("Knowledge upload size mismatch.")
		);
	}

	return {
		receivedBytes,
		binaryHash: hash.digest("hex"),
	};
}

function unsupportedTypeResponse(params: {
	fileName: string | null;
	traceId: string;
	userId: string;
	logLabel: string;
	reason: RejectReasonKey;
}): Response {
	const extension = fileExtension(params.fileName ?? "") || null;
	console.warn(`[KNOWLEDGE] ${params.logLabel} refused an unsupported type`, {
		traceId: params.traceId,
		userId: params.userId,
		fileName: params.fileName,
		extension,
		reason: params.reason,
	});
	return json(
		{
			error: formatUploadRejectMessageEn(params.reason, {
				fileName: params.fileName,
				extension,
			}),
			code: UPLOAD_UNSUPPORTED_TYPE_CODE,
			errorKey: UPLOAD_REJECT_I18N_KEYS[params.reason],
			traceId: params.traceId,
			details: {
				fileName: params.fileName,
				extension,
				reason: params.reason,
			},
		},
		{ status: 415 },
	);
}

/**
 * The type allowlist, in the one shape all four upload entry points answer
 * with (spec section 4.1). Returns the 415 response, or `null` when the file
 * may proceed.
 *
 * Every route that can receive bytes carries this check. `/intent` is a
 * handshake, not a gate: nothing stops a client from skipping it — or lying to
 * it and posting anyway — so `raw`, `chunk` and the legacy multipart route each
 * make the decision themselves, from server-visible values only (the declared
 * name and the request's own `Content-Type`), before a byte is written.
 *
 * The MinerU-4 gate (phase5-6 spec §3.5) runs right after the registry
 * admission: a format the registry allows but the configured backend cannot
 * parse right now (positively probed pre-4.x) gets the identical 415
 * `formatNotEnabled` envelope a not-yet-enabled format would. The gate fails
 * open, so this never blocks on the network — see
 * `format-availability.ts`'s `getUploadFormatGate`.
 */
export async function refuseUnsupportedUploadType(params: {
	fileName: string | null;
	mimeType: string | null;
	traceId: string;
	userId: string;
	logLabel: string;
}): Promise<Response | null> {
	const admission = admitUpload(params.fileName ?? "", params.mimeType);
	if (!admission.allowed) {
		return unsupportedTypeResponse({
			fileName: params.fileName,
			traceId: params.traceId,
			userId: params.userId,
			logLabel: params.logLabel,
			reason: admission.reason,
		});
	}

	if (admission.entry) {
		const gate = await getUploadFormatGate();
		if (gate.disabledEntryIds.has(admission.entry.id)) {
			return unsupportedTypeResponse({
				fileName: params.fileName,
				traceId: params.traceId,
				userId: params.userId,
				logLabel: params.logLabel,
				reason: "formatNotEnabled",
			});
		}
	}

	return null;
}

export async function resolveKnowledgeUploadConversation(params: {
	userId: string;
	conversationId: string | null;
	traceId: string;
}): Promise<
	| { conversationId: string | null; response: null }
	| { conversationId: null; response: Response }
> {
	try {
		const conversationId = await validateKnowledgeUploadConversation({
			userId: params.userId,
			conversationId: params.conversationId,
		});
		return { conversationId, response: null };
	} catch (error) {
		if (isKnowledgeUploadConversationError(error)) {
			return {
				conversationId: null,
				response: json(
					{
						error: "Conversation not found or access denied",
						code: "conversation_not_found",
						traceId: params.traceId,
					},
					{ status: 400 },
				),
			};
		}
		throw error;
	}
}
