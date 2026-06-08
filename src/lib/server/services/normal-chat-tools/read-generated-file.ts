import { readFile } from "fs/promises";
import { join } from "path";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "$lib/server/db";
import { artifacts, chatGeneratedFiles } from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store/document-metadata";

// ── Memory‑text extraction ─────────────────────────────────────

/**
 * Strip the memory‑formatted wrapper added by
 * {@link buildGeneratedFileMemoryContent} (chat‑files.ts) and return
 * only the extracted file content section.
 *
 * When the artifact was copied into a forked conversation the
 * memory wrapper still references the source conversation id and
 * embeds the original assistant response text — both of which
 * confuse models that use {@link read_generated_file} as a "file
 * recall" mechanism.  Returning only the extracted content avoids
 * leaking that fork‑specific metadata.
 */
const EXTRACTED_CONTENT_MARKER = "\nExtracted file content:\n";
const NO_EXTRACTION_TEXT =
	"No readable text could be extracted from this file. Use the filename, file type, and surrounding chat context when continuing it.";

export function extractContentFromMemoryText(
	memoryText: string | null,
): string | null {
	if (!memoryText) return null;
	const markerIndex = memoryText.lastIndexOf(EXTRACTED_CONTENT_MARKER);
	if (markerIndex < 0) {
		// No standard marker — return the full text as a fallback.
		const trimmed = memoryText.trim();
		return trimmed || null;
	}
	const extracted = memoryText.slice(markerIndex + EXTRACTED_CONTENT_MARKER.length).trim();
	if (!extracted || extracted === NO_EXTRACTION_TEXT) {
		// Extraction produced nothing usable.
		return null;
	}
	return extracted;
}

// ── Optional disk read ─────────────────────────────────────────

const CHAT_FILES_DIR = join(process.cwd(), "data", "chat-files");

/**
 * Try to read the generated file bytes directly from disk so we
 * return the actual file content rather than the memory‑formatted
 * wrapper text.
 *
 * Falls back to `null` when the file is not on disk, is binary, or
 * cannot be decoded as UTF‑8.
 */
async function readGeneratedFileBinaryContent(
	userId: string,
	originalChatFileId: string,
): Promise<string | null> {
	try {
		const [fileRow] = await db
			.select({
				storagePath: chatGeneratedFiles.storagePath,
				mimeType: chatGeneratedFiles.mimeType,
			})
			.from(chatGeneratedFiles)
			.where(
				and(
					eq(chatGeneratedFiles.id, originalChatFileId),
					eq(chatGeneratedFiles.userId, userId),
				),
			)
			.limit(1);

		if (!fileRow) return null;

		const fullPath = join(CHAT_FILES_DIR, fileRow.storagePath);
		const buffer = await readFile(fullPath);

		const mimeType = fileRow.mimeType?.toLowerCase() ?? "";
		const isTextBased =
			mimeType.startsWith("text/") ||
			mimeType === "application/json" ||
			mimeType === "application/javascript" ||
			mimeType === "application/xml" ||
			mimeType === "application/x-yaml";

		if (isTextBased || mimeType === "" || mimeType === "application/octet-stream") {
			return buffer.toString("utf-8").trim() || null;
		}
		return null;
	} catch (error) {
		console.warn(
			"[READ_GENERATED_FILE] Disk read failed, falling back to memory text",
			{ originalChatFileId, userId, error },
		);
		return null;
	}
}

/**
 * Resolve the best available content for a generated‑output artifact,
 * preferring disk bytes over memory‑wrapper text.
 */
async function resolveBestContent(
	userId: string,
	artifactContentText: string | null,
	artifactMetadataJson: string | null,
): Promise<string | null> {
	const metadataRecord = parseJsonRecord(artifactMetadataJson);
	const originalChatFileId =
		typeof metadataRecord.originalChatFileId === "string"
			? metadataRecord.originalChatFileId
			: null;

	if (originalChatFileId) {
		const diskContent = await readGeneratedFileBinaryContent(
			userId,
			originalChatFileId,
		);
		if (diskContent) return diskContent;
	}

	const extracted = extractContentFromMemoryText(artifactContentText);
	if (extracted) return extracted;

	return artifactContentText?.trim() ?? null;
}

// ── Input schema ───────────────────────────────────────────────

export const readGeneratedFileInputSchema = z.object({
	filename: z.string().min(1).optional(),
	requestTitle: z.string().min(1).optional(),
});

export type ReadGeneratedFileInput = z.infer<
	typeof readGeneratedFileInputSchema
>;

// ── Composable query ───────────────────────────────────────────

export interface ReadGeneratedFileResult {
	filename: string | null;
	documentLabel: string | null;
	versionNumber: number | null;
	contentText: string | null;
	summary: string | null;
	mimeType: string | null;
	contentLength: number;
	notFound: boolean;
}

export async function readGeneratedFileContent(params: {
	userId: string;
	conversationId: string;
	filename?: string | null;
	requestTitle?: string | null;
}): Promise<ReadGeneratedFileResult> {
	const conditions = [
		eq(artifacts.userId, params.userId),
		eq(artifacts.conversationId, params.conversationId),
		eq(artifacts.type, "generated_output"),
		eq(artifacts.retrievalClass, "durable"),
	];

	if (params.filename) {
		const trimmed = params.filename.trim();
		if (trimmed) {
			conditions.push(
				or(
					eq(artifacts.name, trimmed),
				),
			);
		}
	}

	const rows = await db
		.select({
			name: artifacts.name,
			contentText: artifacts.contentText,
			summary: artifacts.summary,
			mimeType: artifacts.mimeType,
			metadataJson: artifacts.metadataJson,
		})
		.from(artifacts)
		.where(and(...conditions))
		.orderBy(desc(artifacts.updatedAt))
		.limit(8);

	// Filter by filename first, then by requestTitle
	const filenameLower = params.filename?.trim().toLowerCase();
	const requestTitleLower = params.requestTitle?.trim().toLowerCase();

	let bestMatch: (typeof rows)[number] | undefined;

	if (filenameLower) {
		bestMatch = rows.find(
			(row) => row.name.trim().toLowerCase() === filenameLower,
		);
		if (!bestMatch) {
			bestMatch = rows.find((row) =>
				row.name.trim().toLowerCase().includes(filenameLower),
			);
		}
	}

	if (!bestMatch && requestTitleLower) {
		bestMatch = rows.find((row) => {
			const metadata = parseWorkingDocumentMetadata(
				parseJsonRecord(row.metadataJson),
			);
			const label = metadata.documentLabel?.toLowerCase();
			return (
				row.name.trim().toLowerCase().includes(requestTitleLower) ||
				(label && label.includes(requestTitleLower)) ||
				(row.contentText?.toLowerCase().includes(requestTitleLower) ?? false)
			);
		});
	}

	// Fallback: most recent generated_output
	if (!bestMatch && rows.length > 0) {
		bestMatch = rows[0];
	}

	if (!bestMatch) {
		return {
			filename: params.filename ?? null,
			documentLabel: null,
			versionNumber: null,
			contentText: null,
			summary: null,
			mimeType: null,
			contentLength: 0,
			notFound: true,
		};
	}

	const metadata = parseWorkingDocumentMetadata(
		parseJsonRecord(bestMatch.metadataJson),
	);

	const resolvedContent = await resolveBestContent(
		params.userId,
		bestMatch.contentText,
		bestMatch.metadataJson,
	);
	const summary = bestMatch.summary?.trim() ?? null;

	return {
		filename: bestMatch.name,
		documentLabel: metadata.documentLabel ?? null,
		versionNumber: metadata.versionNumber ?? null,
		contentText: resolvedContent,
		summary,
		mimeType: bestMatch.mimeType,
		contentLength: resolvedContent?.length ?? 0,
		notFound: false,
	};
}

// ── Model payload ──────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 24000;

export function buildReadGeneratedFileModelPayload(
	result: ReadGeneratedFileResult,
): Record<string, unknown> {
	if (result.notFound) {
		return {
			found: false,
			filename: result.filename,
			error:
				"No generated file matching the requested filename or title was found in this conversation.",
		};
	}

	const content =
		result.contentText && result.contentText.length > 0
			? result.contentText.length > MAX_CONTENT_LENGTH
				? `${result.contentText.slice(0, MAX_CONTENT_LENGTH)}...\n[Content truncated — ${result.contentText.length - MAX_CONTENT_LENGTH} more characters]`
				: result.contentText
			: null;

	return {
		found: true,
		filename: result.filename,
		documentLabel: result.documentLabel,
		versionNumber: result.versionNumber,
		content,
		summary: result.summary,
		mimeType: result.mimeType,
		contentLength: result.contentLength,
		truncated: result.contentLength > MAX_CONTENT_LENGTH,
	};
}

export function summarizeReadGeneratedFileResult(
	result: ReadGeneratedFileResult,
): string {
	if (result.notFound) {
		return "No matching generated file found.";
	}
	const label = result.documentLabel ?? result.filename ?? "file";
	const version = result.versionNumber ? ` v${result.versionNumber}` : "";
	const length = result.contentLength
		? ` (${result.contentLength} chars)`
		: "";
	return `Found "${label}"${version}${length}.`;
}

// ── Sanitization ───────────────────────────────────────────────

export function sanitizeReadGeneratedFileInput(
	input: ReadGeneratedFileInput,
): Record<string, unknown> {
	const safe: Record<string, unknown> = {};
	if (typeof input.filename === "string" && input.filename.trim()) {
		safe.filename = input.filename.trim();
	}
	if (typeof input.requestTitle === "string" && input.requestTitle.trim()) {
		safe.requestTitle = input.requestTitle.trim();
	}
	return safe;
}
