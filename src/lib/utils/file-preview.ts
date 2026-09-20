// Preview classification, now a thin adapter over the shared file-type
// registry (`$lib/shared/file-types`).
//
// Every table that used to live here — TEXT_EXTENSIONS, IMAGE_EXTENSIONS,
// EXTENSION_CONTENT_TYPES, TRUSTED_PREVIEW_EXTENSIONS, MIME_TO_PREVIEW_TYPE
// and the two language maps — is now one field on a registry entry, so the
// preview surface, the composer chip and the knowledge list can no longer
// disagree about what a file is. See docs/plans/mineru4/phase1-registry-spec.md
// rows 3-12.
//
// The four exported functions keep their historical ARGUMENT ORDER
// (mimeType first, filename second, except `getPreviewContentType`), which is
// the opposite of the registry's, so that none of the importers listed in the
// spec's importer sweep has to change.

import {
	getContentTypeForFile,
	getPreviewKind,
	getPreviewLanguage as getRegistryPreviewLanguage,
	isPreviewable,
	type PreviewKind,
} from "$lib/shared/file-types";

/** Unchanged union — now an alias of the registry's `PreviewKind`. */
export type PreviewFileType = PreviewKind;

export function getPreviewContentType(
	filename: string,
	mimeType: string | null,
): string {
	return getContentTypeForFile(filename, mimeType);
}

export function determinePreviewFileType(
	mimeType: string | null,
	filename: string,
): PreviewFileType {
	return getPreviewKind(filename, mimeType);
}

export function isPreviewableFile(
	mimeType: string | null,
	filename: string,
): boolean {
	return isPreviewable(filename, mimeType);
}

export function getPreviewLanguage(
	mimeType: string | null,
	filename: string,
): string | undefined {
	return getRegistryPreviewLanguage(filename, mimeType);
}
