import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store";

export function findConflictingDocumentPreferenceArtifactIds(params: {
	entries: Array<{
		artifactId: string;
		metadata: Record<string, unknown> | null;
	}>;
	targetArtifactId: string;
	targetFamilyId: string | null;
}): string[] {
	if (!params.targetFamilyId) return [];

	return Array.from(
		new Set(
			params.entries
				.filter((entry) => entry.artifactId !== params.targetArtifactId)
				.filter(
					(entry) =>
						parseWorkingDocumentMetadata(entry.metadata).documentFamilyId ===
						params.targetFamilyId,
				)
				.map((entry) => entry.artifactId),
		),
	);
}
