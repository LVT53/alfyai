import { join } from "path";
import { and, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactLinks, artifacts } from "$lib/server/db/schema";
import type {
  Artifact,
  ArtifactSummary,
  ArtifactType,
  KnowledgeDocumentItem,
} from "$lib/types";
import { extractDocumentText } from "../../document-extraction";
import { shortlistSemanticMatchesBySubject } from "../../semantic-ranking";
import { canUseTeiReranker, rerankItems } from "../../tei-reranker";
import {
  determineTeiWinningMode,
  logTeiRetrievalSummary,
  type SemanticShortlistDiagnostics,
  type TeiRerankDiagnostics,
} from "../../tei-observability";
import { scoreMatch } from "../../working-set";
import { computeDecayScore } from "../../../utils/artifact-decay";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
  getArtifactDocumentOrigin,
  parseWorkingDocumentMetadata,
} from "./document-metadata";
import {
  buildArtifactVisibilityCondition,
  createArtifact,
  createArtifactLink,
  getArtifactOwnershipScope,
  guessSummary,
  isArtifactCanonicallyOwned,
  knowledgeArtifactListSelection,
  mapArtifact,
  mapArtifactSummary,
} from "./core";

const SEMANTIC_ARTIFACT_CANDIDATE_LIMIT = 120;
const SEMANTIC_ARTIFACT_SHORTLIST_LIMIT = 24;

export interface RankedArtifactMatch {
  artifact: Artifact;
  lexicalScore: number;
  semanticScore: number;
  rerankScore: number;
  finalScore: number;
}

function mapLogicalDocumentItem(params: {
  displayArtifact: ArtifactSummary;
  promptArtifactId: string | null;
  familyArtifactIds: string[];
  normalizedAvailable: boolean;
  summary: string | null;
  updatedAt: number;
  documentOrigin?: KnowledgeDocumentItem["documentOrigin"];
  documentFamilyId?: string | null;
  documentFamilyStatus?: KnowledgeDocumentItem["documentFamilyStatus"];
  documentLabel?: string | null;
  documentRole?: string | null;
  versionNumber?: number | null;
  originConversationId?: string | null;
  originAssistantMessageId?: string | null;
  sourceChatFileId?: string | null;
}): KnowledgeDocumentItem {
  return {
    id: params.displayArtifact.id,
    type: params.displayArtifact.type,
    displayArtifactId: params.displayArtifact.id,
    promptArtifactId: params.promptArtifactId,
    familyArtifactIds: params.familyArtifactIds,
    name: params.displayArtifact.name,
    mimeType: params.displayArtifact.mimeType,
    sizeBytes: params.displayArtifact.sizeBytes,
    conversationId: params.displayArtifact.conversationId,
    summary: params.summary,
    normalizedAvailable: params.normalizedAvailable,
    documentOrigin: params.documentOrigin,
    documentFamilyId: params.documentFamilyId ?? null,
    documentFamilyStatus: params.documentFamilyStatus ?? null,
    documentLabel: params.documentLabel ?? null,
    documentRole: params.documentRole ?? null,
    versionNumber: params.versionNumber ?? null,
    originConversationId: params.originConversationId ?? null,
    originAssistantMessageId: params.originAssistantMessageId ?? null,
    sourceChatFileId: params.sourceChatFileId ?? null,
    createdAt: params.displayArtifact.createdAt,
    updatedAt: params.updatedAt,
  };
}

export async function createNormalizedArtifact(params: {
  userId: string;
  conversationId?: string | null;
  sourceArtifactId: string;
  sourceStoragePath: string;
  sourceName: string;
  sourceMimeType: string | null;
}): Promise<Artifact | null> {
  const absoluteSourcePath = join(process.cwd(), params.sourceStoragePath);
  const extraction = await extractDocumentText(
    absoluteSourcePath,
    params.sourceMimeType,
    params.sourceName,
  );

  if (!extraction.text) return null;

  const artifact = await createArtifact({
    userId: params.userId,
    conversationId: params.conversationId,
    type: "normalized_document",
    name: extraction.normalizedName,
    mimeType: extraction.mimeType,
    extension: "txt",
    sizeBytes: Buffer.byteLength(extraction.text, "utf8"),
    storagePath: null,
    contentText: extraction.text,
    summary: guessSummary(extraction.text, params.sourceName),
    metadata: {
      sourceArtifactId: params.sourceArtifactId,
      normalizedFrom: params.sourceName,
    },
  });

  await createArtifactLink({
    userId: params.userId,
    artifactId: artifact.id,
    relatedArtifactId: params.sourceArtifactId,
    conversationId: params.conversationId,
    linkType: "derived_from",
  });

  return artifact;
}

export async function listLogicalDocuments(
  userId: string,
  options?: {
    includeGeneratedOutputs?: boolean;
  },
): Promise<KnowledgeDocumentItem[]> {
  const includeGeneratedOutputs = options?.includeGeneratedOutputs ?? false;
  const ownershipScope = await getArtifactOwnershipScope(userId);
  const rows = await db
    .select(knowledgeArtifactListSelection)
    .from(artifacts)
    .where(
      and(
        buildArtifactVisibilityCondition({ userId, ownershipScope }),
        inArray(
          artifacts.type,
          includeGeneratedOutputs
            ? ["source_document", "normalized_document", "generated_output", "skill_note"]
            : ["source_document", "normalized_document"],
        ),
      ),
    )
    .orderBy(desc(artifacts.updatedAt));

  const scopedRows = rows.filter((row) =>
    isArtifactCanonicallyOwned({
      userId,
      ownershipScope,
      artifact: row,
    }),
  );

  if (scopedRows.length === 0) return [];

  const summaries = scopedRows.map(mapArtifactSummary);
  const byId = new Map(summaries.map((item) => [item.id, item]));
  const sourceArtifacts = summaries.filter(
    (item) => item.type === "source_document",
  );
  const normalizedArtifacts = summaries.filter(
    (item) => item.type === "normalized_document",
  );
  const generatedOutputArtifacts = summaries.filter(
    (item) => item.type === "generated_output",
  );
  const skillNoteArtifacts = summaries.filter((item) => item.type === "skill_note");
  const metadataById = new Map(
    scopedRows.map((row) => [
      row.id,
      parseWorkingDocumentMetadata(parseJsonRecord(row.metadataJson ?? null)),
    ]),
  );

  const derivedRows =
    normalizedArtifacts.length === 0
      ? []
      : await db
          .select({
            normalizedArtifactId: artifactLinks.artifactId,
            sourceArtifactId: artifactLinks.relatedArtifactId,
          })
          .from(artifactLinks)
          .where(
            and(
              eq(artifactLinks.userId, userId),
              inArray(
                artifactLinks.artifactId,
                normalizedArtifacts.map((item) => item.id),
              ),
              eq(artifactLinks.linkType, "derived_from"),
            ),
          );

  const normalizedBySourceId = new Map<string, ArtifactSummary>();
  const sourceByNormalizedId = new Map<string, string>();
  for (const row of derivedRows) {
    if (!(row.sourceArtifactId && row.normalizedArtifactId)) continue;
    const normalized = byId.get(row.normalizedArtifactId);
    if (!normalized) continue;
    normalizedBySourceId.set(row.sourceArtifactId, normalized);
    sourceByNormalizedId.set(row.normalizedArtifactId, row.sourceArtifactId);
  }

  const documents: KnowledgeDocumentItem[] = [];
  for (const source of sourceArtifacts) {
    const normalized = normalizedBySourceId.get(source.id) ?? null;
    documents.push(
      mapLogicalDocumentItem({
        displayArtifact: source,
        promptArtifactId: normalized?.id ?? null,
        familyArtifactIds: [source.id, normalized?.id ?? null].filter(
          (value): value is string => Boolean(value),
        ),
        normalizedAvailable: Boolean(normalized),
        summary: normalized?.summary ?? source.summary,
        updatedAt: Math.max(
          source.updatedAt,
          normalized?.updatedAt ?? source.updatedAt,
        ),
        documentOrigin: getArtifactDocumentOrigin(source.type) ?? undefined,
      }),
    );
  }

  for (const normalized of normalizedArtifacts) {
    if (sourceByNormalizedId.has(normalized.id)) continue;
    documents.push(
      mapLogicalDocumentItem({
        displayArtifact: normalized,
        promptArtifactId: normalized.id,
        familyArtifactIds: [normalized.id],
        normalizedAvailable: true,
        summary: normalized.summary,
        updatedAt: normalized.updatedAt,
        documentOrigin: getArtifactDocumentOrigin(normalized.type) ?? undefined,
      }),
    );
  }

  if (includeGeneratedOutputs) {
    for (const note of skillNoteArtifacts) {
      documents.push(
        mapLogicalDocumentItem({
          displayArtifact: note,
          promptArtifactId: note.id,
          familyArtifactIds: [note.id],
          normalizedAvailable: true,
          summary: note.summary,
          updatedAt: note.updatedAt,
          documentOrigin: "skill_note",
        }),
      );
    }

    const generatedByFamily = new Map<
      string,
      {
        artifacts: ArtifactSummary[];
        latest: ArtifactSummary;
        metadata: ReturnType<typeof parseWorkingDocumentMetadata>;
      }
    >();

    for (const artifact of generatedOutputArtifacts) {
      const metadata = metadataById.get(artifact.id) ?? {};
      // Only include generated outputs that represent actual generated files
      // (those with sourceChatFileId in metadata). Exclude non-file AI/process outputs
      // like workflow summaries, result text, and other process artifacts.
      if (!metadata.sourceChatFileId) {
        continue;
      }
      const familyId = metadata.documentFamilyId ?? artifact.id;
      const existing = generatedByFamily.get(familyId);

      if (!existing) {
        generatedByFamily.set(familyId, {
          artifacts: [artifact],
          latest: artifact,
          metadata,
        });
        continue;
      }

      existing.artifacts.push(artifact);
      const latest =
        artifact.updatedAt > existing.latest.updatedAt ? artifact : existing.latest;
      existing.latest = latest;
      if (latest.id === artifact.id) {
        existing.metadata = metadata;
      }
    }

    for (const [familyId, group] of generatedByFamily) {
      const versionCandidates = group.artifacts
        .map((artifact) => metadataById.get(artifact.id)?.versionNumber)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const versionNumber =
        versionCandidates.length > 0 ? Math.max(...versionCandidates) : null;

      documents.push(
        mapLogicalDocumentItem({
          displayArtifact: group.latest,
          promptArtifactId: group.latest.id,
          familyArtifactIds: group.artifacts.map((artifact) => artifact.id),
          normalizedAvailable: true,
          summary: group.latest.summary,
          updatedAt: group.latest.updatedAt,
          documentOrigin: "generated",
          documentFamilyId: familyId,
          documentFamilyStatus: group.metadata.documentFamilyStatus ?? null,
          documentLabel: group.metadata.documentLabel ?? group.latest.name,
          documentRole: group.metadata.documentRole ?? null,
          versionNumber,
          originConversationId: group.metadata.originConversationId ?? null,
          originAssistantMessageId: group.metadata.originAssistantMessageId ?? null,
          sourceChatFileId: group.metadata.sourceChatFileId ?? null,
        }),
      );
    }
  }

  return documents.sort((left, right) => right.updatedAt - left.updatedAt);
}

function buildArtifactSearchBody(artifact: Artifact): string {
  return `${artifact.name}\n${artifact.summary ?? ""}\n${artifact.contentText ?? ""}`;
}

function tokenizeArtifactSearchQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
        .slice(0, 8)
    )
  );
}

async function selectArtifactSearchCandidates(params: {
  userId: string;
  query: string;
  types: ArtifactType[];
  excludeConversationId?: string;
  limit: number;
  preferSemanticBreadth?: boolean;
}): Promise<Artifact[]> {
  const ownershipScope = await getArtifactOwnershipScope(params.userId);
  const tokenFragments = tokenizeArtifactSearchQuery(params.query).map((token) => `%${token}%`);
  const semanticBreadth = params.preferSemanticBreadth ?? false;
  const baseConditions = [
    buildArtifactVisibilityCondition({
      userId: params.userId,
      ownershipScope,
    }),
    inArray(artifacts.type, params.types),
    params.types.includes("generated_output")
      ? or(ne(artifacts.type, "generated_output"), eq(artifacts.retrievalClass, "durable"))
      : undefined,
    params.excludeConversationId
      ? sql`${artifacts.conversationId} IS NULL OR ${artifacts.conversationId} <> ${params.excludeConversationId}`
      : undefined,
  ];

  if (!semanticBreadth && tokenFragments.length > 0) {
    baseConditions.push(
      or(
        ...tokenFragments.flatMap((fragment) => [
          like(artifacts.name, fragment),
          like(artifacts.summary, fragment),
          like(artifacts.contentText, fragment),
        ])
      )
    );
  }

  const rows = await db
    .select()
    .from(artifacts)
    .where(and(...baseConditions))
    .orderBy(desc(artifacts.updatedAt))
    .limit(params.limit);

  return rows
    .filter((row) =>
      isArtifactCanonicallyOwned({
        userId: params.userId,
        ownershipScope,
        artifact: row,
      }),
    )
    .map(mapArtifact);
}

async function rankArtifactMatches(params: {
  userId: string;
  query: string;
  candidates: Artifact[];
  limit: number;
}): Promise<RankedArtifactMatch[]> {
  if (params.candidates.length === 0) {
    return [];
  }

  const lexicalMatches = params.candidates.map((artifact) => ({
    artifact,
    lexicalScore: scoreMatch(params.query, buildArtifactSearchBody(artifact)),
  }));
  const lexicalTop = lexicalMatches
    .filter((entry) => entry.lexicalScore > 0)
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) return right.lexicalScore - left.lexicalScore;
      return right.artifact.updatedAt - left.artifact.updatedAt;
    })
    .slice(0, Math.max(params.limit * 2, 12));

  let semanticDiagnostics: SemanticShortlistDiagnostics | null = null;
  const semanticMatches =
    (await shortlistSemanticMatchesBySubject({
      userId: params.userId,
      subjectType: "artifact",
      query: params.query,
      items: params.candidates,
      getSubjectId: (artifact) => artifact.id,
      limit: SEMANTIC_ARTIFACT_SHORTLIST_LIMIT,
      onDiagnostics: (diagnostics) => {
        semanticDiagnostics = diagnostics;
      },
    })) ?? [];
  const semanticScoreById = new Map(
    semanticMatches.map((match) => [match.subjectId, match.semanticScore])
  );

  const candidateIds = new Set<string>();
  const shortlistedArtifacts: Artifact[] = [];

  for (const entry of lexicalTop) {
    if (candidateIds.has(entry.artifact.id)) continue;
    candidateIds.add(entry.artifact.id);
    shortlistedArtifacts.push(entry.artifact);
  }

  for (const match of semanticMatches) {
    if (candidateIds.has(match.subjectId)) continue;
    candidateIds.add(match.subjectId);
    shortlistedArtifacts.push(match.item);
  }

  if (shortlistedArtifacts.length === 0) {
    shortlistedArtifacts.push(...params.candidates.slice(0, params.limit));
  }

  let rerankScoreById = new Map<string, number>();
  let rerankDiagnostics: TeiRerankDiagnostics | null = null;
  if (canUseTeiReranker() && shortlistedArtifacts.length > 1) {
    try {
      const reranked = await rerankItems({
        query: params.query,
        items: shortlistedArtifacts,
        getText: (artifact) => buildArtifactSearchBody(artifact),
        onDiagnostics: (diagnostics) => {
          rerankDiagnostics = diagnostics;
        },
      });

      if (reranked && reranked.items.length > 0) {
        rerankScoreById = new Map(
          reranked.items.map((entry) => [entry.item.id, entry.score])
        );
      }
    } catch (error) {
      console.error("[KNOWLEDGE] Artifact semantic reranker failed:", error);
    }
  }

  const rankedMatches = shortlistedArtifacts
    .map((artifact) => {
      const lexicalScore = lexicalMatches.find((entry) => entry.artifact.id === artifact.id)?.lexicalScore ?? 0;
      const semanticScore = semanticScoreById.get(artifact.id) ?? 0;
      const rerankScore = rerankScoreById.get(artifact.id) ?? 0;
      const baseScore = lexicalScore * 10 + semanticScore * 18 + rerankScore * 24 + (artifact.updatedAt / 1_000_000_000_000);
      const ageSeconds = Math.max(0, (Date.now() - artifact.updatedAt) / 1000);
      
      const finalScore = computeDecayScore({
        importance: baseScore,
        ageSeconds,
        staleSeconds: ageSeconds,
        queryOverlap: lexicalScore,
        queryLength: 1,
        decayRate: 0.001,
      });

      return {
        artifact,
        lexicalScore,
        semanticScore,
        rerankScore,
        finalScore,
      };
    })
    .filter((entry) => entry.lexicalScore > 0 || entry.semanticScore > 0 || entry.rerankScore > 0)
    .sort((left, right) => {
      if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
      return right.artifact.updatedAt - left.artifact.updatedAt;
    })
    .slice(0, params.limit);

  const winner = rankedMatches[0] ?? null;
  logTeiRetrievalSummary({
    scope: 'documents',
    userId: params.userId,
    queryLength: params.query.trim().length,
    candidateCount: params.candidates.length,
    semantic: semanticDiagnostics,
    rerank: rerankDiagnostics,
    winningMode: determineTeiWinningMode({
      lexicalScore: winner?.lexicalScore,
      semanticScore: winner?.semanticScore,
      rerankScore: winner?.rerankScore,
    }),
    winnerId: winner?.artifact.id ?? null,
    extra: {
      winnerType: winner?.artifact.type ?? null,
      shortlistedCount: shortlistedArtifacts.length,
      lexicalTopCount: lexicalTop.length,
      returnedCount: rankedMatches.length,
    },
  });

  return rankedMatches;
}

export async function findRelevantArtifactsByTypesDetailed(params: {
  userId: string;
  query: string;
  types: ArtifactType[];
  limit: number;
  excludeConversationId?: string;
}): Promise<RankedArtifactMatch[]> {
  const semanticBreadth = params.query.trim().length > 0;
  const candidates = await selectArtifactSearchCandidates({
    userId: params.userId,
    query: params.query,
    types: params.types,
    excludeConversationId: params.excludeConversationId,
    limit: semanticBreadth ? SEMANTIC_ARTIFACT_CANDIDATE_LIMIT : Math.max(params.limit, 12),
    preferSemanticBreadth: semanticBreadth,
  });

  if (params.query.trim().length === 0) {
    return candidates.slice(0, params.limit).map((artifact) => ({
      artifact,
      lexicalScore: 0,
      semanticScore: 0,
      rerankScore: 0,
      finalScore: artifact.updatedAt,
    }));
  }

  return rankArtifactMatches({
    userId: params.userId,
    query: params.query,
    candidates,
    limit: params.limit,
  });
}

export async function findRelevantArtifactsByTypes(params: {
  userId: string;
  query: string;
  types: ArtifactType[];
  limit: number;
  excludeConversationId?: string;
}): Promise<Artifact[]> {
  const matches = await findRelevantArtifactsByTypesDetailed(params);
  return matches.map((entry) => entry.artifact);
}

function buildSearchSnippet(
  query: string,
  contentText: string | null,
  fallback: string | null,
): string | null {
  const source = (contentText ?? fallback ?? "").replace(/\s+/g, " ").trim();
  if (!source) return null;

  if (!query) {
    return source.slice(0, 180);
  }

  const normalizedQuery = query.toLowerCase();
  const normalizedSource = source.toLowerCase();
  const matchIndex = normalizedSource.indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return source.slice(0, 180);
  }

  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(source.length, matchIndex + Math.max(query.length, 40) + 70);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";

  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}
