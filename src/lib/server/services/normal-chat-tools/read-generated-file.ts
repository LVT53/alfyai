import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store/document-metadata";

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
			const metadata = parseWorkingDocumentMetadata(row.metadataJson);
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

	const metadata = parseWorkingDocumentMetadata(bestMatch.metadataJson);
	const contentText = bestMatch.contentText?.trim() ?? null;
	const summary = bestMatch.summary?.trim() ?? null;

	return {
		filename: bestMatch.name,
		documentLabel: metadata.documentLabel ?? null,
		versionNumber: metadata.versionNumber ?? null,
		contentText,
		summary,
		mimeType: bestMatch.mimeType,
		contentLength: contentText?.length ?? 0,
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
