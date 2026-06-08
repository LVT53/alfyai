import { createHash, randomUUID } from "crypto";
import { basename, extname, join } from "path";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "$lib/server/db";
import {
  artifactLinks,
  artifacts,
  conversations,
} from "$lib/server/db/schema";
import type {
  Artifact,
  ArtifactLink,
  ArtifactSummary,
  ArtifactType,
} from "$lib/types";
import { parseJsonRecord } from "$lib/server/utils/json";
import { syncArtifactChunks } from "../../task-state/chunk-sync";
import { queueArtifactSemanticEmbeddingRefresh } from "../../semantic-embedding-refresh";
import { getConfig, getMaxModelContext as getPerModelMaxContext, getCompactionUiThreshold as getPerModelCompactionThreshold, getTargetConstructedContext as getPerModelTargetContext } from "../../../config-store";
import {
  getDocumentTokenBudget,
  getWorkingSetPromptTokenBudget,
  getSmallFileThreshold,
} from "../../../config-store";

export function getMaxModelContext(modelId?: string): number {
  return getPerModelMaxContext(modelId);
}

export function getCompactionUiThreshold(modelId?: string): number {
  return getPerModelCompactionThreshold(modelId);
}

export function getTargetConstructedContext(modelId?: string): number {
  return getPerModelTargetContext(modelId);
}

export const WORKING_SET_PROMPT_TOKEN_BUDGET = 3_000;
export const WORKING_SET_DOCUMENT_TOKEN_BUDGET = 1_200;
export const WORKING_SET_OUTPUT_TOKEN_BUDGET = 1_000;

export { getDocumentTokenBudget, getWorkingSetPromptTokenBudget, getSmallFileThreshold };

type ArtifactSummaryRow = Pick<
  typeof artifacts.$inferSelect,
  | "id"
  | "type"
  | "retrievalClass"
  | "name"
  | "mimeType"
  | "sizeBytes"
  | "conversationId"
  | "summary"
  | "createdAt"
  | "updatedAt"
>;

export type ArtifactOwnershipScope = {
  conversationIds: Set<string>;
};

type ArtifactOwnershipCandidate = Pick<
  typeof artifacts.$inferSelect,
  "userId" | "type" | "conversationId"
>;

export const knowledgeArtifactListSelection = {
  id: artifacts.id,
  userId: artifacts.userId,
  type: artifacts.type,
  retrievalClass: artifacts.retrievalClass,
  name: artifacts.name,
  mimeType: artifacts.mimeType,
  sizeBytes: artifacts.sizeBytes,
  conversationId: artifacts.conversationId,
  summary: artifacts.summary,
  metadataJson: artifacts.metadataJson,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
} as const;

export async function getArtifactOwnershipScope(
  userId: string,
): Promise<ArtifactOwnershipScope> {
  const conversationRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));

  return {
    conversationIds: new Set(conversationRows.map((row) => row.id)),
  };
}

export function buildArtifactVisibilityCondition(params: {
  userId: string;
  ownershipScope: ArtifactOwnershipScope;
}) {
  const conditions = [eq(artifacts.userId, params.userId)];
  const conversationIds = Array.from(params.ownershipScope.conversationIds);

  if (conversationIds.length > 0) {
    conditions.push(inArray(artifacts.conversationId, conversationIds));
  }

  return or(...conditions);
}

export function isArtifactCanonicallyOwned(params: {
  userId: string;
  ownershipScope: ArtifactOwnershipScope;
  artifact: ArtifactOwnershipCandidate;
}): boolean {
  const { artifact, ownershipScope, userId } = params;

  if (artifact.type === "generated_output" || artifact.type === "work_capsule") {
    return Boolean(
      artifact.conversationId &&
        ownershipScope.conversationIds.has(artifact.conversationId),
    );
  }

  if (artifact.conversationId) {
    return ownershipScope.conversationIds.has(artifact.conversationId);
  }

  return artifact.userId === userId;
}

export function mapArtifactSummary(row: ArtifactSummaryRow): ArtifactSummary {
  return {
    id: row.id,
    type: row.type as ArtifactType,
    retrievalClass: (row.retrievalClass ??
      "durable") as ArtifactSummary["retrievalClass"],
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    conversationId: row.conversationId ?? null,
    summary: row.summary ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function mapArtifact(row: typeof artifacts.$inferSelect): Artifact {
  return {
    ...mapArtifactSummary(row),
    userId: row.userId,
    extension: row.extension ?? null,
    storagePath: row.storagePath ?? null,
    contentText: row.contentText ?? null,
    metadata: parseJsonRecord(row.metadataJson ?? null),
  };
}

function mapArtifactLink(row: typeof artifactLinks.$inferSelect): ArtifactLink {
  return {
    id: row.id,
    userId: row.userId,
    artifactId: row.artifactId,
    relatedArtifactId: row.relatedArtifactId ?? null,
    conversationId: row.conversationId ?? null,
    messageId: row.messageId ?? null,
    linkType: row.linkType as ArtifactLink["linkType"],
    createdAt: row.createdAt.getTime(),
  };
}

export function fileExtension(name: string): string | null {
  const ext = extname(name).toLowerCase();
  return ext ? ext.slice(1) : null;
}

export function knowledgeUserDir(userId: string): string {
  return join(process.cwd(), "data", "knowledge", userId);
}

export function guessSummary(text: string | null, fallback: string): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 240) : fallback.slice(0, 240);
}

export function safeStem(name: string): string {
  const stem = basename(name, extname(name)).trim();
  return stem.length > 0 ? stem : "artifact";
}

export function hashBinaryBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function findExistingArtifactByBinaryHash(params: {
  userId: string;
  binaryHash: string;
}): Promise<Artifact | null> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.userId, params.userId),
        eq(artifacts.binaryHash, params.binaryHash),
        eq(artifacts.type, "source_document"),
      ),
    )
    .limit(1);

  return rows[0] ? mapArtifact(rows[0]) : null;
}

export async function createArtifact(params: {
  id?: string;
  userId: string;
  conversationId?: string | null;
  type: ArtifactType;
  retrievalClass?: Artifact["retrievalClass"];
  name: string;
  mimeType?: string | null;
  extension?: string | null;
  sizeBytes?: number | null;
  binaryHash?: string | null;
  storagePath?: string | null;
  contentText?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<Artifact> {
  const id = params.id ?? randomUUID();
  const [artifact] = await db
    .insert(artifacts)
    .values({
      id,
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      type: params.type,
      retrievalClass: params.retrievalClass ?? "durable",
      name: params.name,
      mimeType: params.mimeType ?? null,
      extension: params.extension ?? null,
      sizeBytes: params.sizeBytes ?? null,
      binaryHash: params.binaryHash ?? null,
      storagePath: params.storagePath ?? null,
      contentText: params.contentText ?? null,
      summary: params.summary ?? null,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
      updatedAt: new Date(),
    })
    .returning();

  const mapped = mapArtifact(artifact);
  await syncArtifactChunks({
    artifactId: mapped.id,
    userId: mapped.userId,
    conversationId: mapped.conversationId,
    contentText: mapped.contentText,
  });
  queueArtifactSemanticEmbeddingRefresh(mapped);

  return mapped;
}

export async function updateArtifactBinaryHash(
  artifactId: string,
  binaryHash: string,
): Promise<void> {
  await db
    .update(artifacts)
    .set({
      binaryHash,
      updatedAt: new Date(),
    })
    .where(eq(artifacts.id, artifactId));
}

export async function getNormalizedArtifactForSource(
  userId: string,
  sourceArtifactId: string,
): Promise<Artifact | null> {
  const rows = await db
    .select({ artifact: artifacts })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.relatedArtifactId, sourceArtifactId),
        eq(artifactLinks.linkType, "derived_from"),
        eq(artifacts.type, "normalized_document"),
      ),
    )
    .orderBy(asc(artifactLinks.createdAt))
    .limit(1);

  return rows[0] ? mapArtifact(rows[0].artifact) : null;
}

export function withAttachmentDisplayName(
  promptArtifact: Artifact,
  displayArtifact: Artifact,
): Artifact {
  return {
    ...promptArtifact,
    name: displayArtifact.name,
    mimeType: displayArtifact.mimeType ?? promptArtifact.mimeType,
    sizeBytes: displayArtifact.sizeBytes ?? promptArtifact.sizeBytes,
  };
}

export async function createArtifactLink(params: {
  userId: string;
  artifactId: string;
  linkType: ArtifactLink["linkType"];
  relatedArtifactId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}): Promise<ArtifactLink> {
  const [row] = await db
    .insert(artifactLinks)
    .values({
      id: randomUUID(),
      userId: params.userId,
      artifactId: params.artifactId,
      linkType: params.linkType,
      relatedArtifactId: params.relatedArtifactId ?? null,
      conversationId: params.conversationId ?? null,
      messageId: params.messageId ?? null,
    })
    .returning();
  return mapArtifactLink(row);
}

export async function getArtifactForUser(
  userId: string,
  artifactId: string,
): Promise<Artifact | null> {
  const ownershipScope = await getArtifactOwnershipScope(userId);
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        buildArtifactVisibilityCondition({ userId, ownershipScope }),
      ),
    );
  if (
    !row ||
    !isArtifactCanonicallyOwned({
      userId,
      ownershipScope,
      artifact: row,
    })
  ) {
    return null;
  }
  return mapArtifact(row);
}

export async function listArtifactLinksForUser(
  userId: string,
  artifactId: string,
): Promise<ArtifactLink[]> {
  const rows = await db
    .select()
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.artifactId, artifactId),
      ),
    )
    .orderBy(desc(artifactLinks.createdAt));
  return rows.map(mapArtifactLink);
}

export async function getArtifactsForUser(
  userId: string,
  artifactIds: string[],
): Promise<Artifact[]> {
  if (artifactIds.length === 0) return [];
  const ownershipScope = await getArtifactOwnershipScope(userId);
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        inArray(artifacts.id, artifactIds),
        buildArtifactVisibilityCondition({ userId, ownershipScope }),
      ),
    );
  return rows
    .filter((row) =>
      isArtifactCanonicallyOwned({
        userId,
        ownershipScope,
        artifact: row,
      }),
    )
    .map(mapArtifact);
}

export async function listConversationOwnedArtifacts(
  userId: string,
  conversationId: string,
): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.userId, userId),
        eq(artifacts.conversationId, conversationId),
      ),
    )
    .orderBy(desc(artifacts.updatedAt));

  return rows.map(mapArtifact);
}

export async function getSourceArtifactIdForNormalizedArtifact(
  userId: string,
  normalizedArtifactId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sourceArtifactId: artifactLinks.relatedArtifactId })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.artifactId, normalizedArtifactId),
        eq(artifactLinks.linkType, "derived_from"),
        eq(artifacts.type, "normalized_document"),
      ),
    )
    .limit(1);

  return row?.sourceArtifactId ?? null;
}

export async function listConversationArtifacts(
  userId: string,
  conversationId: string,
): Promise<ArtifactSummary[]> {
  // Return artifacts with a pending (messageId IS NULL) conversation link,
  // but exclude any that have already been consumed by a message.  A LEFT
  // JOIN against message-level links filters them out while preserving the
  // original pending links that workspace and document systems rely on.
  const messageLinks = alias(artifactLinks, "message_links");

  const rows = await db
    .select({ artifact: artifacts })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .leftJoin(
      messageLinks,
      and(
        eq(messageLinks.artifactId, artifactLinks.artifactId),
        eq(messageLinks.conversationId, conversationId),
        eq(messageLinks.linkType, "attached_to_conversation"),
        isNotNull(messageLinks.messageId),
      ),
    )
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.conversationId, conversationId),
        eq(artifactLinks.linkType, "attached_to_conversation"),
        isNull(artifactLinks.messageId),
        isNull(messageLinks.id),
      ),
    )
    .orderBy(desc(artifacts.updatedAt));

  const unique = new Map<string, ArtifactSummary>();
  for (const row of rows) {
    unique.set(row.artifact.id, mapArtifactSummary(row.artifact));
  }
  return Array.from(unique.values());
}
