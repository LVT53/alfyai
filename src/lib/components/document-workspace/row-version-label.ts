import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";

/**
 * The version tag on a row of the workspace's list of open documents (the rail on
 * a desktop, the sheet on a phone). Ruling 76 (Q2): no version number outside
 * History, with the one exception a list cannot do without: "v2" tells a later copy
 * of a document from an earlier one. So a number is printed when it is a real one
 * above 1, or when it is the first of a document whose later copy sits in the same
 * list. The first version of a document that stands alone is just the document: a
 * generated file's row used to read "v1", and a file with no persisted number was
 * given one.
 */
export function rowVersionLabel(
	document: Pick<
		DocumentWorkspaceItem,
		"id" | "versionNumber" | "documentFamilyId"
	>,
	documents: ReadonlyArray<
		Pick<DocumentWorkspaceItem, "id" | "versionNumber" | "documentFamilyId">
	>,
): string | null {
	const number = document.versionNumber;
	if (!number || number < 1) return null;
	if (number > 1) return `v${number}`;
	const familyId = document.documentFamilyId;
	if (!familyId) return null;
	return documents.some(
		(other) =>
			other.id !== document.id &&
			other.documentFamilyId === familyId &&
			(other.versionNumber ?? 0) > 1,
	)
		? "v1"
		: null;
}
