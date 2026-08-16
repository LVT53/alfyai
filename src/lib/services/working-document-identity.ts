import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";

export type WorkingDocumentIdentityInput = Pick<
	KnowledgeDocumentItem,
	| "id"
	| "displayArtifactId"
	| "promptArtifactId"
	| "familyArtifactIds"
	| "normalizedAvailable"
	| "sourceChatFileId"
>;

export type LinkedContextSourceIdentityInput = Pick<
	LinkedContextSource,
	"displayArtifactId" | "promptArtifactId" | "familyArtifactIds"
>;

export interface WorkingDocumentArtifactIdentity {
	artifactId: string;
}

export interface WorkingDocumentPreviewIdentity
	extends WorkingDocumentArtifactIdentity {
	sourceChatFileId: string | null;
}

export interface WorkingDocumentFamilyIdentity {
	artifactIds: string[];
}

export interface WorkingDocumentIdentity {
	display: WorkingDocumentArtifactIdentity;
	prompt: WorkingDocumentArtifactIdentity | null;
	preview: WorkingDocumentPreviewIdentity;
	family: WorkingDocumentFamilyIdentity;
}

function compactUniqueIds(ids: Array<string | null | undefined>): string[] {
	const result: string[] = [];
	const seen = new Set<string>();

	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}

	return result;
}

export function resolveWorkingDocumentIdentity(
	document: WorkingDocumentIdentityInput,
): WorkingDocumentIdentity {
	const displayArtifactId = document.displayArtifactId || document.id;
	const promptArtifactId =
		document.normalizedAvailable && document.promptArtifactId
			? document.promptArtifactId
			: null;
	const familyArtifactIds = Array.isArray(document.familyArtifactIds)
		? document.familyArtifactIds
		: [];

	return {
		display: { artifactId: displayArtifactId },
		prompt: promptArtifactId ? { artifactId: promptArtifactId } : null,
		preview: {
			artifactId: displayArtifactId,
			sourceChatFileId: document.sourceChatFileId ?? null,
		},
		family: {
			artifactIds: compactUniqueIds([
				...familyArtifactIds,
				displayArtifactId,
				promptArtifactId,
			]),
		},
	};
}

export function isPromptReadyWorkingDocument(
	document: WorkingDocumentIdentityInput,
): boolean {
	return Boolean(resolveWorkingDocumentIdentity(document).prompt);
}

export function linkedContextSourceArtifactIds(
	source: LinkedContextSourceIdentityInput,
): string[] {
	return compactUniqueIds([
		source.displayArtifactId,
		source.promptArtifactId,
		...source.familyArtifactIds,
	]);
}

export function linkedContextSourcesOverlap(
	left: LinkedContextSourceIdentityInput,
	right: LinkedContextSourceIdentityInput,
): boolean {
	const leftIds = new Set(linkedContextSourceArtifactIds(left));
	return linkedContextSourceArtifactIds(right).some((id) => leftIds.has(id));
}

export function workingDocumentMatchesLinkedContextSource(
	document: WorkingDocumentIdentityInput,
	source: LinkedContextSourceIdentityInput,
): boolean {
	const familyIds = new Set(
		resolveWorkingDocumentIdentity(document).family.artifactIds,
	);
	return linkedContextSourceArtifactIds(source).some((id) => familyIds.has(id));
}

export function toCanonicalLinkedContextSource(
	document: KnowledgeDocumentItem,
): LinkedContextSource {
	const identity = resolveWorkingDocumentIdentity(document);
	return {
		displayArtifactId: identity.display.artifactId,
		promptArtifactId: identity.prompt?.artifactId ?? null,
		familyArtifactIds: identity.family.artifactIds,
		name: document.name,
		type: "document",
		mimeType: document.mimeType,
		documentOrigin: document.documentOrigin,
	};
}
