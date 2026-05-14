import { DAY_MS } from "$lib/server/utils/constants";
import type {
  Artifact,
  ArtifactType,
  WorkingDocumentFamilyStatus,
  WorkingDocumentMetadata,
} from "$lib/types";

function readString(
  value: unknown,
): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(
  value: unknown,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function readWorkingDocumentFamilyStatus(
  value: unknown,
): WorkingDocumentFamilyStatus | null {
  return value === "active" || value === "historical" ? value : null;
}

const GENERATED_DOCUMENT_FAMILY_HISTORICAL_AFTER_DAYS = 30;

export function parseWorkingDocumentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): WorkingDocumentMetadata {
  if (!metadata) return {};

  return {
    documentFamilyId: readString(metadata.documentFamilyId),
    documentFamilyStatus: readWorkingDocumentFamilyStatus(metadata.documentFamilyStatus),
    documentLabel: readString(metadata.documentLabel),
    documentRole: readString(metadata.documentRole),
    versionNumber: readPositiveInteger(metadata.versionNumber),
    supersedesArtifactId: readString(metadata.supersedesArtifactId),
    originConversationId: readString(metadata.originConversationId),
    originAssistantMessageId: readString(metadata.originAssistantMessageId),
    sourceChatFileId: readString(metadata.sourceChatFileId),
  };
}

export interface GeneratedDocumentVersionCandidate {
  artifactId: string;
  artifactName: string;
  updatedAt: number;
  metadata: Record<string, unknown> | null;
}

export interface GeneratedDocumentFamilyCandidate
  extends GeneratedDocumentVersionCandidate {}

function buildLegacyGeneratedArtifactName(filename: string): string {
  return `${filename} generated file`;
}

function matchesGeneratedDocumentReference(
  candidate: GeneratedDocumentVersionCandidate,
  filename: string,
): boolean {
  const metadata = parseWorkingDocumentMetadata(candidate.metadata);
  const rawGeneratedFilename =
    typeof candidate.metadata?.generatedFilename === "string"
      ? candidate.metadata.generatedFilename.trim()
      : null;

  return (
    rawGeneratedFilename === filename ||
    metadata.documentLabel === filename ||
    candidate.artifactName === buildLegacyGeneratedArtifactName(filename)
  );
}

export function resolveGeneratedDocumentFamilyContext(params: {
  filename: string;
  candidates: GeneratedDocumentVersionCandidate[];
}): {
  familyId: string | null;
  documentLabel: string | null;
  documentRole: string | null;
  matchingArtifactIds: string[];
} {
  const sortedCandidates = params.candidates
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const seed = sortedCandidates.find((candidate) =>
    matchesGeneratedDocumentReference(candidate, params.filename),
  );

  if (!seed) {
    return {
      familyId: null,
      documentLabel: null,
      documentRole: null,
      matchingArtifactIds: [],
    };
  }

  const seedMetadata = parseWorkingDocumentMetadata(seed.metadata);
  const familyId = seedMetadata.documentFamilyId ?? null;

  if (!familyId) {
    return {
      familyId: null,
      documentLabel: seedMetadata.documentLabel ?? params.filename,
      documentRole: seedMetadata.documentRole ?? null,
      matchingArtifactIds: sortedCandidates
        .filter((candidate) => matchesGeneratedDocumentReference(candidate, params.filename))
        .map((candidate) => candidate.artifactId),
    };
  }

  const matchingArtifactIds = sortedCandidates
    .filter(
      (candidate) =>
        parseWorkingDocumentMetadata(candidate.metadata).documentFamilyId === familyId,
    )
    .map((candidate) => candidate.artifactId);

  return {
    familyId,
    documentLabel: seedMetadata.documentLabel ?? params.filename,
    documentRole: seedMetadata.documentRole ?? null,
    matchingArtifactIds,
  };
}

export function buildGeneratedOutputDocumentMetadata(params: {
  familyId: string;
  familyStatus?: WorkingDocumentFamilyStatus | null;
  label: string;
  role?: string | null;
  versionNumber: number;
  supersedesArtifactId?: string | null;
  originConversationId: string;
  originAssistantMessageId: string;
  sourceChatFileId: string;
}): WorkingDocumentMetadata {
  return {
    documentFamilyId: params.familyId,
    documentFamilyStatus: readWorkingDocumentFamilyStatus(params.familyStatus) ?? "active",
    documentLabel: params.label,
    documentRole: readString(params.role),
    versionNumber: params.versionNumber,
    supersedesArtifactId: readString(params.supersedesArtifactId),
    originConversationId: params.originConversationId,
    originAssistantMessageId: params.originAssistantMessageId,
    sourceChatFileId: params.sourceChatFileId,
  };
}

export function getArtifactDocumentOrigin(
  artifactType: ArtifactType,
): "uploaded" | "generated" | "skill_note" | null {
  if (artifactType === "generated_output") return "generated";
  if (artifactType === "skill_note") return "skill_note";
  if (artifactType === "source_document" || artifactType === "normalized_document") {
    return "uploaded";
  }
  return null;
}

export function getArtifactDocumentLabel(
  artifact: Pick<Artifact, "name" | "type" | "metadata">,
): string {
  const metadata = parseWorkingDocumentMetadata(artifact.metadata);
  return metadata.documentLabel ?? artifact.name;
}

export function getGeneratedOutputFamilyKey(
  artifact: Pick<Artifact, "id" | "metadata">,
): string | null {
  const metadata = parseWorkingDocumentMetadata(artifact.metadata);
  return metadata.documentFamilyId ? `output_family:${metadata.documentFamilyId}` : null;
}

export function resolveGeneratedDocumentFamilyStatus(params: {
  updatedAt: number;
  now?: number;
  historicalAfterDays?: number;
}): WorkingDocumentFamilyStatus {
  const historicalAfterMs =
    (params.historicalAfterDays ?? GENERATED_DOCUMENT_FAMILY_HISTORICAL_AFTER_DAYS) *
    DAY_MS;
  return (params.now ?? Date.now()) - params.updatedAt >= historicalAfterMs
    ? "historical"
    : "active";
}

export function selectLatestGeneratedDocumentCandidatesByFamily<
  T extends GeneratedDocumentFamilyCandidate,
>(candidates: T[]): T[] {
  const latestByFamily = new Map<string, T>();

  for (const candidate of candidates) {
    const metadata = parseWorkingDocumentMetadata(candidate.metadata);
    const familyKey = metadata.documentFamilyId
      ? `output_family:${metadata.documentFamilyId}`
      : `output_artifact:${candidate.artifactId}`;
    const existing = latestByFamily.get(familyKey);
    if (!existing || candidate.updatedAt > existing.updatedAt) {
      latestByFamily.set(familyKey, candidate);
    }
  }

  return Array.from(latestByFamily.values()).sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}
