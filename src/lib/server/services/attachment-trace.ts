import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "$lib/server/config-store";

const DEFAULT_PREVIEW_LENGTH = 320;

export function isAttachmentTraceDebugEnabled(): boolean {
	return getConfig().attachmentTraceDebug === true;
}

export function createAttachmentTraceId(prefix = "attachment"): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function normalizeAttachmentTraceText(
	value: string | null | undefined,
): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

export function clipAttachmentTraceText(
	value: string | null | undefined,
	maxLength = DEFAULT_PREVIEW_LENGTH,
): string | null {
	const normalized = normalizeAttachmentTraceText(value);
	if (!normalized) return null;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function hashAttachmentTraceText(
	value: string | null | undefined,
): string | null {
	const normalized = normalizeAttachmentTraceText(value);
	if (!normalized) return null;
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function summarizeAttachmentTraceText(
	value: string | null | undefined,
	maxLength = DEFAULT_PREVIEW_LENGTH,
): {
	contentLength: number;
	contentPreview: string | null;
	contentHash: string | null;
} {
	const normalized = normalizeAttachmentTraceText(value);
	return {
		contentLength: normalized.length,
		contentPreview: clipAttachmentTraceText(normalized, maxLength),
		contentHash: hashAttachmentTraceText(normalized),
	};
}

export function hasMeaningfulAttachmentText(
	value: string | null | undefined,
): boolean {
	const normalized = normalizeAttachmentTraceText(value);
	if (!normalized) return false;
	const alphanumericCount = (normalized.match(/[A-Za-z0-9]/g) ?? []).length;
	return normalized.length >= 24 && alphanumericCount >= 12;
}

export function summarizeAttachmentSectionInInput(
	inputValue: string,
	maxLength = 480,
): {
	hasMarker: boolean;
	markerIndex: number;
	preview: string | null;
	previewHash: string | null;
} {
	const marker = "## Current Attachments";
	const markerIndex = inputValue.indexOf(marker);
	if (markerIndex < 0) {
		return {
			hasMarker: false,
			markerIndex,
			preview: null,
			previewHash: null,
		};
	}

	const preview = inputValue.slice(
		markerIndex,
		Math.min(inputValue.length, markerIndex + maxLength),
	);
	return {
		hasMarker: true,
		markerIndex,
		preview: clipAttachmentTraceText(preview, maxLength),
		previewHash: hashAttachmentTraceText(preview),
	};
}

export function logAttachmentTrace(
	stage: string,
	payload: Record<string, unknown>,
): void {
	if (!isAttachmentTraceDebugEnabled()) return;
	console.info("[ATTACHMENT_TRACE]", {
		stage,
		...payload,
	});
}
