import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	applyFileServingRange,
	buildFileServingResponseHeaders,
} from "$lib/server/services/file-serving-response-policy";
import { resolveGeneratedFileServing } from "$lib/server/services/generated-file-serving";
import type { Artifact } from "$lib/types";
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
	const filenameArtifact =
		params.mode === "download" ? params.filenameArtifact : params.artifact;
	const safeName = filenameArtifact.name || "document";
	const downloadName =
		safeName.includes(".") || !filenameArtifact.extension
			? safeName
			: `${safeName}.${filenameArtifact.extension}`;

	if (params.artifact.contentText) {
		const textBuffer = Buffer.from(params.artifact.contentText, "utf-8");
		const rangedResponse = applyFileServingRange({
			body: textBuffer,
			rangeHeader: params.rangeHeader,
			headers: buildFileServingResponseHeaders({
				mode: params.mode,
				contentLength: textBuffer.length,
				contentType: "text/plain; charset=utf-8",
				filename: params.mode === "preview" ? safeName : downloadName,
				safetyFilenames: [downloadName],
			}),
		});
		return {
			ok: true,
			...rangedResponse,
		};
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

	if (
		params.artifact.storagePath.includes("..") ||
		params.artifact.storagePath.startsWith("/")
	) {
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

	try {
		const filePath = join(process.cwd(), params.artifact.storagePath);
		const fileBuffer = await readFile(filePath);
		const previewName =
			safeName.includes(".") || !params.artifact.extension
				? safeName
				: `${safeName}.${params.artifact.extension}`;

		const rangedResponse = applyFileServingRange({
			body: fileBuffer,
			rangeHeader: params.rangeHeader,
			headers: buildFileServingResponseHeaders({
				mode: params.mode,
				contentLength: fileBuffer.length,
				contentType:
					params.mode === "preview"
						? getPreviewContentType(previewName, params.artifact.mimeType)
						: params.artifact.mimeType || "application/octet-stream",
				filename: params.mode === "preview" ? safeName : downloadName,
				safetyFilenames: [previewName, params.artifact.storagePath],
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
				storagePath: params.artifact.storagePath,
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
