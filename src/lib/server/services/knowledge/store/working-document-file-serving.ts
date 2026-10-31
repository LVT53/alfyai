import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	applyFileServingRange,
	buildFileServingResponseHeaders,
	parseFileServingRange,
} from "$lib/server/services/file-serving-response-policy";
import { resolveGeneratedFileServing } from "$lib/server/services/generated-file-serving";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { getContentTypeForFile, resolveEntry } from "$lib/shared/file-types";
import { withFileExtension } from "$lib/shared/file-types/download-name";
import { getPreviewContentType } from "$lib/utils/file-preview";
import {
	getArtifactForUser,
	getSourceArtifactIdForNormalizedArtifact,
} from "./core";

export type WorkingDocumentFileServingMode = "preview" | "download";

export interface WorkingDocumentFileServingSuccess {
	ok: true;
	status: 200 | 206 | 416;
	body: Uint8Array;
	headers: Record<string, string>;
}

export interface WorkingDocumentFileServingError {
	ok: false;
	status: number;
	error: string;
}

export type WorkingDocumentFileServingResolution =
	| WorkingDocumentFileServingSuccess
	| WorkingDocumentFileServingError;

export async function resolveWorkingDocumentFileServing(params: {
	userId: string;
	artifactId: string;
	mode: WorkingDocumentFileServingMode;
	rangeHeader?: string | null;
}): Promise<WorkingDocumentFileServingResolution> {
	let artifact = await getArtifactForUser(params.userId, params.artifactId);
	if (!artifact) {
		return { ok: false, status: 404, error: "Artifact not found" };
	}
	const requestedArtifact = artifact;

	if (artifact.type === "normalized_document" && artifact.contentText) {
		const sourceArtifactId = await getSourceArtifactIdForNormalizedArtifact(
			params.userId,
			artifact.id,
		);
		if (sourceArtifactId) {
			const sourceArtifact = await getArtifactForUser(
				params.userId,
				sourceArtifactId,
			);
			if (sourceArtifact?.storagePath) {
				artifact = sourceArtifact;
			}
		}
	}

	const generatedSource = await resolveGeneratedOutputSource({
		userId: params.userId,
		artifact,
		mode: params.mode,
		rangeHeader: params.rangeHeader,
	});
	if (generatedSource) {
		return generatedSource;
	}
	if (isUnrenderedGeneratedDocumentSource(artifact)) {
		return {
			ok: false,
			status: 404,
			error:
				params.mode === "preview"
					? "File not available for preview"
					: "File not available for download",
		};
	}

	return resolveStoredArtifact({
		userId: params.userId,
		requestedArtifactId: params.artifactId,
		artifact,
		filenameArtifact: params.mode === "download" ? requestedArtifact : artifact,
		mode: params.mode,
		rangeHeader: params.rangeHeader,
	});
}

function isUnrenderedGeneratedDocumentSource(artifact: Artifact): boolean {
	if (artifact.type !== "generated_output" || artifact.storagePath) {
		return false;
	}

	const metadata = artifact.metadata ?? {};
	const status = metadata.generatedDocumentSourceStatus;
	if (typeof status === "string" && status !== "succeeded") {
		return true;
	}

	return (
		isGeneratedDocumentSourceMetadata(metadata) &&
		!readSourceChatFileId(metadata)
	);
}

function isGeneratedDocumentSourceMetadata(
	metadata: Record<string, unknown>,
): boolean {
	return (
		metadata.generatedDocumentSourceVersion !== undefined ||
		metadata.generatedDocumentSourceStatus !== undefined
	);
}

function readSourceChatFileId(
	metadata: Record<string, unknown> | null | undefined,
): string | null {
	const sourceChatFileId = metadata?.sourceChatFileId;
	return typeof sourceChatFileId === "string" && sourceChatFileId.trim()
		? sourceChatFileId.trim()
		: null;
}

async function resolveGeneratedOutputSource(params: {
	userId: string;
	artifact: Artifact;
	mode: WorkingDocumentFileServingMode;
	rangeHeader?: string | null;
}): Promise<WorkingDocumentFileServingResolution | null> {
	if (
		params.artifact.type !== "generated_output" ||
		params.artifact.storagePath
	) {
		return null;
	}

	const sourceChatFileId = readSourceChatFileId(params.artifact.metadata);
	if (!sourceChatFileId) {
		return null;
	}

	return resolveGeneratedFileServing({
		userId: params.userId,
		fileId: sourceChatFileId,
		mode: params.mode,
		displayFilename: params.artifact.name || null,
		rangeHeader: params.rangeHeader,
	});
}

async function resolveStoredArtifact(params: {
	userId: string;
	requestedArtifactId: string;
	artifact: Artifact;
	filenameArtifact: Artifact;
	mode: WorkingDocumentFileServingMode;
	rangeHeader?: string | null;
}): Promise<WorkingDocumentFileServingResolution> {
	const filenames = resolveStoredArtifactFilenames({
		artifact: params.artifact,
		filenameArtifact:
			params.mode === "download" ? params.filenameArtifact : params.artifact,
	});

	if (params.artifact.contentText) {
		return resolveStoredTextArtifact({
			mode: params.mode,
			artifactText: params.artifact.contentText,
			rangeHeader: params.rangeHeader,
			safeName: filenames.safeName,
			downloadName: filenames.downloadName,
		});
	}

	if (!params.artifact.storagePath) {
		return {
			ok: false,
			status: 404,
			error:
				params.mode === "preview"
					? "File not available for preview"
					: "File not available for download",
		};
	}

	if (isUnsafeStoredArtifactPath(params.artifact.storagePath)) {
		console.error(
			params.mode === "preview"
				? "[PREVIEW] Path traversal attempt blocked:"
				: "[DOWNLOAD] Path traversal attempt blocked:",
			{
				userId: params.userId,
				artifactId: params.requestedArtifactId,
				storagePath: params.artifact.storagePath,
			},
		);
		return { ok: false, status: 400, error: "Invalid path" };
	}

	return resolveStoredArtifactFromFile({
		mode: params.mode,
		userId: params.userId,
		requestedArtifactId: params.requestedArtifactId,
		artifact: params.artifact,
		storagePath: params.artifact.storagePath,
		safeName: filenames.safeName,
		downloadName: filenames.downloadName,
		previewName: filenames.previewContentName,
		rangeHeader: params.rangeHeader,
	});
}

function resolveStoredArtifactFilenames(params: {
	artifact: Artifact;
	filenameArtifact: Artifact;
}): { safeName: string; downloadName: string; previewContentName: string } {
	const safeName = params.filenameArtifact.name || "document";
	const downloadName = withFileExtension(
		safeName,
		params.filenameArtifact.extension,
	);
	const previewContentName = withFileExtension(
		safeName,
		params.artifact.extension,
	);

	return { safeName, downloadName, previewContentName };
}

function isUnsafeStoredArtifactPath(storagePath: string): boolean {
	return storagePath.includes("..") || storagePath.startsWith("/");
}

/** A text download is typed by its name: a `.md` note is `text/markdown`, not `text/plain`. */
function textDownloadContentType(name: string): string {
	const byName = getContentTypeForFile(name, null);
	return byName.startsWith("text/")
		? `${byName}; charset=utf-8`
		: "text/plain; charset=utf-8";
}

function resolveStoredTextArtifact(params: {
	mode: WorkingDocumentFileServingMode;
	artifactText: string;
	rangeHeader?: string | null;
	safeName: string;
	downloadName: string;
}): WorkingDocumentFileServingResolution {
	const textBuffer = Buffer.from(params.artifactText, "utf-8");
	const headers = buildFileServingResponseHeaders({
		mode: params.mode,
		contentLength: textBuffer.length,
		contentType:
			params.mode === "download"
				? textDownloadContentType(params.downloadName)
				: "text/plain; charset=utf-8",
		filename: params.mode === "preview" ? params.safeName : params.downloadName,
		safetyFilenames: [params.downloadName],
	});
	const rangedResponse = applyFileServingRange({
		body: textBuffer,
		rangeHeader: params.rangeHeader,
		headers,
	});

	return {
		ok: true,
		...rangedResponse,
	};
}

function isHeicArtifact(params: {
	artifact: Artifact;
	previewName: string;
}): boolean {
	const entry = resolveEntry(params.previewName, params.artifact.mimeType);
	return entry?.id === "heic" || entry?.id === "heif";
}

/**
 * Browsers other than Safari cannot draw HEIC, so a preview hands one over as a
 * PNG; the original stays what a download gets. The converter loads only when
 * such a photo is asked for. A file it cannot read is served as it is.
 */
async function heicAsPng(
	filePath: string,
	mimeType: string | null,
): Promise<Buffer | null> {
	try {
		const { decodeImageToPng } = await import(
			"$lib/server/services/vision/prepare-image"
		);
		const bytes = await readFile(filePath);
		return (await decodeImageToPng(bytes, mimeType)).png;
	} catch (error) {
		console.warn("[PREVIEW] A HEIC photo could not be converted", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function resolveStoredArtifactFromFile(params: {
	mode: WorkingDocumentFileServingMode;
	userId: string;
	requestedArtifactId: string;
	artifact: Artifact;
	storagePath: string;
	safeName: string;
	downloadName: string;
	previewName: string;
	rangeHeader?: string | null;
}): Promise<WorkingDocumentFileServingResolution> {
	const contentType =
		params.mode === "preview"
			? getPreviewContentType(params.previewName, params.artifact.mimeType)
			: params.artifact.mimeType || "application/octet-stream";
	const filename =
		params.mode === "preview" ? params.safeName : params.downloadName;
	const filePath = join(process.cwd(), params.storagePath);

	try {
		if (params.mode === "preview" && isHeicArtifact(params)) {
			const drawn = await heicAsPng(filePath, params.artifact.mimeType);
			if (drawn) {
				return {
					ok: true,
					status: 200,
					body: drawn,
					headers: buildFileServingResponseHeaders({
						mode: params.mode,
						contentLength: drawn.length,
						contentType: "image/png",
						filename,
						safetyFilenames: [params.previewName, params.storagePath],
					}),
				};
			}
		}
		const totalLength = await getStoredFileLength(filePath);
		const partialResponse = await resolveStoredArtifactPartialRange({
			filePath,
			mode: params.mode,
			rangeHeader: params.rangeHeader,
			totalLength,
			contentType,
			filename,
			safetyFilenames: [params.previewName, params.storagePath],
		});
		if (partialResponse) {
			return partialResponse;
		}

		const fileBuffer = await readFile(filePath);

		const rangedResponse = applyFileServingRange({
			body: fileBuffer,
			rangeHeader: params.rangeHeader,
			headers: buildFileServingResponseHeaders({
				mode: params.mode,
				contentLength: fileBuffer.length,
				contentType,
				filename,
				safetyFilenames: [params.previewName, params.storagePath],
			}),
		});

		return {
			ok: true,
			...rangedResponse,
		};
	} catch (error: unknown) {
		const errorCode =
			typeof error === "object" && error !== null && "code" in error
				? error.code
				: undefined;
		console.error(
			params.mode === "preview"
				? "[PREVIEW] Failed to read file:"
				: "[DOWNLOAD] Failed to read file:",
			{
				userId: params.userId,
				artifactId: params.requestedArtifactId,
				storagePath: params.storagePath,
				error: error instanceof Error ? error.message : error,
			},
		);

		if (errorCode === "ENOENT") {
			return { ok: false, status: 404, error: "File not found on disk" };
		}

		return {
			ok: false,
			status: 500,
			error: "Failed to read file",
		};
	}
}

async function resolveStoredArtifactPartialRange(params: {
	filePath: string;
	mode: WorkingDocumentFileServingMode;
	rangeHeader?: string | null;
	totalLength: number;
	contentType: string;
	filename: string;
	safetyFilenames: readonly string[];
}): Promise<WorkingDocumentFileServingSuccess | null> {
	if (!params.rangeHeader) return null;

	const range = parseFileServingRange(params.rangeHeader, params.totalLength);
	if (!range) return null;

	const headers = buildFileServingResponseHeaders({
		mode: params.mode,
		contentLength: params.totalLength,
		contentType: params.contentType,
		filename: params.filename,
		safetyFilenames: params.safetyFilenames,
	});

	if (range.unsatisfiable) {
		return {
			ok: true,
			status: 416,
			body: new Uint8Array(0),
			headers: {
				...headers,
				"Content-Length": "0",
				"Content-Range": `bytes */${params.totalLength}`,
			},
		};
	}

	const body = await readStoredFileRange(
		params.filePath,
		range.start,
		range.end,
	);
	return {
		ok: true,
		status: 206,
		body,
		headers: {
			...headers,
			"Content-Length": body.byteLength.toString(),
			"Content-Range": `bytes ${range.start}-${range.end}/${params.totalLength}`,
		},
	};
}

async function getStoredFileLength(filePath: string): Promise<number> {
	return (await stat(filePath)).size;
}

async function readStoredFileRange(
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
