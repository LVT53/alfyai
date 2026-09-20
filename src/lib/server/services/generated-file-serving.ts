import { open, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	getChatFileByConversationOwner,
	getChatFileByUser,
	readChatFileContentByConversationOwner,
	readChatFileContentByUser,
} from "$lib/server/services/chat-files";
import {
	isGeneratedFileTypeAllowed,
	validateGeneratedOutputFile,
} from "$lib/server/services/file-production/output-validation";
import { getSucceededFileProductionJobForChatFile } from "$lib/server/services/file-production/read-model";
import {
	applyFileServingRange,
	buildFileServingResponseHeaders,
	type FileServingPreviewProfile,
	parseFileServingRange,
} from "$lib/server/services/file-serving-response-policy";
import { requiresFullContentValidation } from "$lib/shared/file-types/production";
import { getPreviewContentType } from "$lib/utils/file-preview";

export type GeneratedFileServingMode = "preview" | "download";

export interface GeneratedFileServingSuccess {
	ok: true;
	status: 200 | 206 | 416;
	body: Uint8Array;
	headers: Record<string, string>;
}

export interface GeneratedFileServingError {
	ok: false;
	status: number;
	error: string;
}

export type GeneratedFileServingResult =
	| GeneratedFileServingSuccess
	| GeneratedFileServingError;

const CHAT_FILES_DIR = join(process.cwd(), "data", "chat-files");
export async function resolveGeneratedFileServing(params: {
	userId: string;
	fileId: string;
	mode: GeneratedFileServingMode;
	displayFilename?: string | null;
	rangeHeader?: string | null;
}): Promise<GeneratedFileServingResult> {
	const chatFile =
		(await getChatFileByUser(params.fileId, params.userId)) ??
		(await getChatFileByConversationOwner(params.fileId, params.userId));
	if (!chatFile) {
		return { ok: false, status: 404, error: "File not found" };
	}

	let succeededFileProductionJob:
		| Awaited<ReturnType<typeof getSucceededFileProductionJobForChatFile>>
		| undefined;
	const resolveSucceededFileProductionJob = async () => {
		succeededFileProductionJob ??=
			await getSucceededFileProductionJobForChatFile({
				userId: params.userId,
				conversationId: chatFile.conversationId,
				chatGeneratedFileId: chatFile.id,
			});
		return succeededFileProductionJob;
	};

	if (
		chatFile.assistantMessageId === null &&
		!(await resolveSucceededFileProductionJob())
	) {
		return { ok: false, status: 404, error: "File not found" };
	}

	if (!isGeneratedFileTypeAllowed(chatFile.filename, chatFile.mimeType)) {
		return {
			ok: false,
			status: 415,
			error: "Unsupported generated file type",
		};
	}

	const filename = params.displayFilename || chatFile.filename;
	const contentType = getPreviewContentType(
		chatFile.filename,
		chatFile.mimeType,
	);

	const partialResponse = await resolveGeneratedFilePartialRange({
		chatFile,
		mode: params.mode,
		rangeHeader: params.rangeHeader,
		contentType,
		filename,
	});
	if (partialResponse) {
		return partialResponse;
	}

	const fileContent =
		(await readChatFileContentByUser(params.fileId, params.userId)) ??
		(await readChatFileContentByConversationOwner(
			params.fileId,
			params.userId,
		));
	if (!fileContent) {
		return {
			ok: false,
			status: 500,
			error: "Failed to read file content",
		};
	}

	const contentValidation = await validateGeneratedOutputFile({
		filename: chatFile.filename,
		mimeType: chatFile.mimeType,
		content: fileContent,
	});
	if (!contentValidation.ok) {
		return {
			ok: false,
			status: 415,
			error: "Invalid generated file content",
		};
	}

	const rangedResponse = applyFileServingRange({
		body: fileContent,
		rangeHeader: params.rangeHeader,
		headers: buildFileServingResponseHeaders({
			mode: params.mode,
			contentLength: fileContent.length,
			contentType,
			filename,
			safetyFilenames: [chatFile.filename],
			previewProfile: await resolvePreviewProfile({
				mode: params.mode,
				contentType,
				resolveSucceededFileProductionJob,
			}),
		}),
	});

	return {
		ok: true,
		...rangedResponse,
	};
}

async function resolvePreviewProfile(params: {
	mode: GeneratedFileServingMode;
	contentType: string;
	resolveSucceededFileProductionJob: () => Promise<
		Awaited<ReturnType<typeof getSucceededFileProductionJobForChatFile>>
	>;
}): Promise<FileServingPreviewProfile | undefined> {
	if (params.mode !== "preview" || params.contentType !== "text/html") {
		return undefined;
	}

	const job = await params.resolveSucceededFileProductionJob();
	return job?.sourceMode === "document_source" ? "standard-report" : undefined;
}

async function resolveGeneratedFilePartialRange(params: {
	chatFile: { filename: string; storagePath: string };
	mode: GeneratedFileServingMode;
	rangeHeader?: string | null;
	contentType: string;
	filename: string;
}): Promise<GeneratedFileServingSuccess | null> {
	if (!params.rangeHeader) return null;
	if (requiresFullGeneratedFileValidation(params.chatFile.filename))
		return null;
	if (!isSafeChatFileStoragePath(params.chatFile.storagePath)) return null;

	const filePath = join(CHAT_FILES_DIR, params.chatFile.storagePath);
	let totalLength: number;
	try {
		totalLength = (await stat(filePath)).size;
	} catch {
		return null;
	}

	const range = parseFileServingRange(params.rangeHeader, totalLength);
	if (!range) return null;

	const headers = buildFileServingResponseHeaders({
		mode: params.mode,
		contentLength: totalLength,
		contentType: params.contentType,
		filename: params.filename,
		safetyFilenames: [params.chatFile.filename],
	});

	if (range.unsatisfiable) {
		return {
			ok: true,
			status: 416,
			body: new Uint8Array(0),
			headers: {
				...headers,
				"Content-Length": "0",
				"Content-Range": `bytes */${totalLength}`,
			},
		};
	}

	try {
		const body = await readFileRange(filePath, range.start, range.end);
		return {
			ok: true,
			status: 206,
			body,
			headers: {
				...headers,
				"Content-Length": body.byteLength.toString(),
				"Content-Range": `bytes ${range.start}-${range.end}/${totalLength}`,
			},
		};
	} catch {
		return null;
	}
}

// These generated-file types need full-content validation before serving. Range
// requests for them fall back to a full read, then the response policy copies the
// selected byte window so the full backing buffer is not retained by the response.
// The set is the registry's text-like extensions plus .xlsx, which is exactly
// what the local FULL_VALIDATION_EXTENSIONS listed (spec conflict 4).
function requiresFullGeneratedFileValidation(filename: string): boolean {
	return requiresFullContentValidation(extname(filename).toLowerCase());
}

function isSafeChatFileStoragePath(storagePath: string): boolean {
	return Boolean(
		storagePath &&
			!storagePath.includes("..") &&
			!storagePath.startsWith("/") &&
			!storagePath.startsWith("\\"),
	);
}

async function readFileRange(
	filePath: string,
	start: number,
	end: number,
): Promise<Uint8Array> {
	const byteLength = end - start + 1;
	const body = new Uint8Array(byteLength);
	const file = await open(filePath, "r");
	try {
		const { bytesRead } = await file.read(body, 0, byteLength, start);
		return bytesRead === byteLength ? body : body.slice(0, bytesRead);
	} finally {
		await file.close();
	}
}
