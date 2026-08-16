import type { Artifact } from "$lib/server/services/knowledge/types";

type ArtifactParams = {
	id: string;
	name: string;
	summary?: string | null;
	conversationId?: string | null;
	updatedAt?: number;
	metadata?: Record<string, unknown> | null;
};

type GeneratedArtifactSpec = readonly [
	id: string,
	name: string,
	updatedAt: number,
	familyId: string,
	label: string,
	versionNumber: number | undefined,
	extraMetadata?: Record<string, unknown>,
];

function makeArtifact(params: ArtifactParams): Artifact {
	return {
		id: params.id,
		userId: "user-1",
		type: "generated_output",
		retrievalClass: "durable",
		name: params.name,
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: params.conversationId ?? null,
		summary: params.summary ?? null,
		createdAt: params.updatedAt ?? 1,
		updatedAt: params.updatedAt ?? 1,
		extension: "pdf",
		storagePath: null,
		contentText: null,
		metadata: params.metadata ?? null,
	};
}

export function makeArtifacts(...specs: GeneratedArtifactSpec[]): Artifact[] {
	return specs.map(
		([id, name, updatedAt, familyId, label, versionNumber, extraMetadata]) =>
			makeArtifact({
				id,
				name,
				updatedAt,
				metadata: {
					documentFamilyId: familyId,
					documentLabel: label,
					...(versionNumber === undefined ? {} : { versionNumber }),
					...extraMetadata,
				},
			}),
	);
}

const BRIEF_FAMILY_ARTIFACT_SPECS: ReadonlyArray<GeneratedArtifactSpec> = [
	["artifact-1", "brief-v1.pdf", 1, "family-brief", "Project brief", 1],
	["artifact-2", "brief-v2.pdf", 2, "family-brief", "Project brief", 2],
	["artifact-3", "slides-v1.pdf", 3, "family-slides", "Investor slides", 1],
];

const CURRENT_DOCUMENT_ARTIFACT_SPECS: ReadonlyArray<GeneratedArtifactSpec> = [
	["artifact-brief", "brief-v2.pdf", 2, "family-brief", "Project brief", 2],
	[
		"artifact-slides",
		"slides-v3.pdf",
		3,
		"family-slides",
		"Investor slides",
		3,
	],
];

export function makeBriefFamilyArtifacts(): Artifact[] {
	return makeArtifacts(...BRIEF_FAMILY_ARTIFACT_SPECS);
}

export function makeCurrentDocumentArtifacts(): Artifact[] {
	return makeArtifacts(...CURRENT_DOCUMENT_ARTIFACT_SPECS);
}

export function makeEphemeralArtifact(params: ArtifactParams): Artifact {
	return {
		...makeArtifact(params),
		retrievalClass: "ephemeral",
	} as unknown as Artifact;
}

export { makeArtifact };
