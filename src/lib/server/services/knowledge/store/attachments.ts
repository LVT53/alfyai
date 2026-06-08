import { randomUUID } from "crypto";
import { mkdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
  artifactChunks,
  artifactLinks,
  artifacts,
} from "$lib/server/db/schema";
import type { Artifact, ChatAttachment, ArtifactType } from "$lib/types";
import {
  hasMeaningfulAttachmentText,
  logAttachmentTrace,
  summarizeAttachmentTraceText,
} from "../../attachment-trace";
import {
  createArtifact,
  createArtifactLink,
  fileExtension,
  findExistingArtifactByBinaryHash,
  getArtifactsForUser,
  getNormalizedArtifactForSource,
  hashBinaryBuffer,
  knowledgeUserDir,
  mapArtifact,
  withAttachmentDisplayName,
} from "./core";

type PromptArtifactDiagnostics = {
  contentLength: number;
  contentPreview: string | null;
  contentHash: string | null;
  chunkCount: number;
};

type PromptAttachmentResolutionItem = {
  requestedArtifactId: string;
  displayArtifact: Artifact | null;
  promptArtifact: Artifact | null;
  promptReady: boolean;
  readinessError: string | null;
  contentLength: number;
  contentPreview: string | null;
  contentHash: string | null;
  chunkCount: number;
};

export class AttachmentReadinessError extends Error {
  code = "attachment_not_ready" as const;
  status = 422 as const;
  attachmentIds: string[];

  constructor(message: string, attachmentIds: string[]) {
    super(message);
    this.name = "AttachmentReadinessError";
    this.attachmentIds = attachmentIds;
  }
}

export function isAttachmentReadinessError(
  error: unknown,
): error is AttachmentReadinessError {
  return (
    error instanceof AttachmentReadinessError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "attachment_not_ready")
  );
}

function buildAttachmentReadinessErrorMessage(
  items: PromptAttachmentResolutionItem[],
): string {
  if (items.some((item) => item.displayArtifact === null)) {
    return "One or more attached files are no longer available. Remove them and upload again.";
  }

  if (items.length === 1) {
    const item = items[0];
    if (item.displayArtifact?.name && item.readinessError) {
      return `${item.displayArtifact.name}: ${item.readinessError}`;
    }
  }

  return "One or more attached files could not be prepared for chat. Remove the file or upload a supported text-readable document.";
}

async function getPromptArtifactDiagnostics(
  userId: string,
  promptArtifact: Artifact | null,
): Promise<PromptArtifactDiagnostics> {
  if (!promptArtifact) {
    return {
      contentLength: 0,
      contentPreview: null,
      contentHash: null,
      chunkCount: 0,
    };
  }

  const [{ chunkCount = 0 } = { chunkCount: 0 }] = await db
    .select({
      chunkCount: sql<number>`count(*)`,
    })
    .from(artifactChunks)
    .where(
      and(
        eq(artifactChunks.userId, userId),
        eq(artifactChunks.artifactId, promptArtifact.id),
      ),
    );

  return {
    ...summarizeAttachmentTraceText(promptArtifact.contentText),
    chunkCount: Number(chunkCount ?? 0),
  };
}

async function buildPromptAttachmentResolutionItem(params: {
  userId: string;
  requestedArtifactId: string;
  displayArtifact: Artifact;
  promptArtifact: Artifact | null;
  readinessError: string;
}): Promise<PromptAttachmentResolutionItem> {
  const diagnostics = await getPromptArtifactDiagnostics(
    params.userId,
    params.promptArtifact,
  );
  const promptReady =
    Boolean(params.promptArtifact) &&
    hasMeaningfulAttachmentText(params.promptArtifact?.contentText) &&
    diagnostics.contentLength > 0;

  return {
    requestedArtifactId: params.requestedArtifactId,
    displayArtifact: params.displayArtifact,
    promptArtifact: params.promptArtifact,
    promptReady,
    readinessError: promptReady ? null : params.readinessError,
    contentLength: diagnostics.contentLength,
    contentPreview: diagnostics.contentPreview,
    contentHash: diagnostics.contentHash,
    chunkCount: diagnostics.chunkCount,
  };
}

export async function resolvePromptAttachmentArtifacts(
  userId: string,
  attachmentIds: string[],
): Promise<{
  displayArtifacts: Artifact[];
  promptArtifacts: Artifact[];
  items: PromptAttachmentResolutionItem[];
  unresolvedItems: PromptAttachmentResolutionItem[];
}> {
  const displayArtifacts = await getArtifactsForUser(userId, attachmentIds);
  if (displayArtifacts.length === 0) {
    const items = attachmentIds.map((attachmentId) => ({
      requestedArtifactId: attachmentId,
      displayArtifact: null,
      promptArtifact: null,
      promptReady: false,
      readinessError: "Attached file is no longer available.",
      contentLength: 0,
      contentPreview: null,
      contentHash: null,
      chunkCount: 0,
    }));
    return {
      displayArtifacts: [],
      promptArtifacts: [],
      items,
      unresolvedItems: items,
    };
  }

  const displayArtifactsById = new Map(
    displayArtifacts.map((artifact) => [artifact.id, artifact]),
  );
  const items = await Promise.all(
    attachmentIds.map(async (attachmentId) => {
      const displayArtifact = displayArtifactsById.get(attachmentId) ?? null;
      if (!displayArtifact) {
        return {
          requestedArtifactId: attachmentId,
          displayArtifact: null,
          promptArtifact: null,
          promptReady: false,
          readinessError: "Attached file is no longer available.",
          contentLength: 0,
          contentPreview: null,
          contentHash: null,
          chunkCount: 0,
        };
      }

      if (displayArtifact.type !== "source_document") {
        return buildPromptAttachmentResolutionItem({
          userId,
          requestedArtifactId: attachmentId,
          displayArtifact,
          promptArtifact: withAttachmentDisplayName(
            displayArtifact,
            displayArtifact,
          ),
          readinessError:
            "This attachment does not contain enough readable text to use in chat. Remove it or upload a supported text-readable document.",
        });
      }

      const normalized = await getNormalizedArtifactForSource(
        userId,
        displayArtifact.id,
      );
	      if (!normalized) {
	        return {
          requestedArtifactId: attachmentId,
          displayArtifact,
          promptArtifact: null,
          promptReady: false,
	          readinessError:
	            "This file could not be prepared for chat. Supported extraction currently works best for text, HTML, JSON, PDF, DOCX, PPTX, XLSX, and common image formats (including HEIC/HEIF when server conversion support is installed).",
          contentLength: 0,
          contentPreview: null,
          contentHash: null,
          chunkCount: 0,
        };
      }

      return buildPromptAttachmentResolutionItem({
        userId,
        requestedArtifactId: attachmentId,
        displayArtifact,
        promptArtifact: withAttachmentDisplayName(normalized, displayArtifact),
        readinessError:
          "This file was uploaded, but no usable readable text could be prepared for chat from it.",
      });
    }),
  );
  const unresolvedItems = items.filter((item) => !item.promptReady);

  return {
    displayArtifacts,
    promptArtifacts: Array.from(
      new Map(
        items.flatMap((item) =>
          item.promptReady && item.promptArtifact
            ? [[item.promptArtifact.id, item.promptArtifact] as const]
            : [],
        ),
      ).values(),
    ),
    items,
    unresolvedItems,
  };
}

export async function assertPromptReadyAttachments(params: {
  userId: string;
  conversationId: string;
  attachmentIds: string[];
  traceId?: string;
}): Promise<{
  displayArtifacts: Artifact[];
  promptArtifacts: Artifact[];
}> {
  const resolved = await resolvePromptAttachmentArtifacts(
    params.userId,
    params.attachmentIds,
  );

  if (params.attachmentIds.length > 0) {
    console.info("[ATTACHMENTS] Prompt readiness preflight", {
      conversationId: params.conversationId,
      requestedAttachmentIds: params.attachmentIds,
      displayArtifactCount: resolved.displayArtifacts.length,
      promptArtifactCount: resolved.promptArtifacts.length,
      unresolvedAttachmentIds: resolved.unresolvedItems.map(
        (item) => item.requestedArtifactId,
      ),
    });
    logAttachmentTrace("preflight", {
      traceId: params.traceId ?? null,
      conversationId: params.conversationId,
      requestedAttachmentIds: params.attachmentIds,
      displayArtifactIds: resolved.displayArtifacts.map(
        (artifact) => artifact.id,
      ),
      promptArtifactIds: resolved.promptArtifacts.map(
        (artifact) => artifact.id,
      ),
      unresolvedAttachments: resolved.unresolvedItems.map((item) => ({
        artifactId: item.requestedArtifactId,
        name: item.displayArtifact?.name ?? null,
        readinessError: item.readinessError,
        contentLength: item.contentLength,
        chunkCount: item.chunkCount,
        contentHash: item.contentHash,
      })),
    });
  }

  if (resolved.unresolvedItems.length > 0) {
    throw new AttachmentReadinessError(
      buildAttachmentReadinessErrorMessage(resolved.unresolvedItems),
      resolved.unresolvedItems.map((item) => item.requestedArtifactId),
    );
  }

  return {
    displayArtifacts: resolved.displayArtifacts,
    promptArtifacts: resolved.promptArtifacts,
  };
}

async function ensureConversationAttachmentLink(params: {
  userId: string;
  artifactId: string;
  conversationId: string;
}): Promise<void> {
  const existing = await db
    .select({ id: artifactLinks.id })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.userId, params.userId),
        eq(artifactLinks.artifactId, params.artifactId),
        eq(artifactLinks.conversationId, params.conversationId),
        eq(artifactLinks.linkType, "attached_to_conversation"),
        isNull(artifactLinks.messageId),
      ),
    )
    .limit(1);

  if (existing[0]) return;

  await createArtifactLink({
    userId: params.userId,
    artifactId: params.artifactId,
    linkType: "attached_to_conversation",
    conversationId: params.conversationId,
  });
}

async function findExistingArtifactByName(params: {
  userId: string;
  name: string;
}): Promise<Artifact | null> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.userId, params.userId),
        eq(artifacts.name, params.name),
      ),
    )
    .limit(1);

  return rows[0] ? mapArtifact(rows[0]) : null;
}

function generateUniqueFilename(
  originalName: string,
  existingNames: Set<string>,
): string {
  if (!existingNames.has(originalName)) {
    return originalName;
  }

  const extension = fileExtension(originalName);
  const baseName = extension
    ? originalName.slice(0, -(extension.length + 1))
    : originalName;

  let counter = 1;
  let newName: string;

  do {
    const suffix = `_${counter}`;
    newName = extension
      ? `${baseName}${suffix}.${extension}`
      : `${baseName}${suffix}`;
    counter++;
  } while (existingNames.has(newName));

  return newName;
}

async function getAllArtifactNamesForUser(
  userId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ name: artifacts.name })
    .from(artifacts)
    .where(
      eq(artifacts.userId, userId),
    );

  return new Set(rows.map((row) => row.name));
}

async function resolveArtifactNameWithAutoRename(params: {
  userId: string;
  originalName: string;
}): Promise<{
  finalName: string;
  wasRenamed: boolean;
  originalName: string;
}> {
  const existing = await findExistingArtifactByName({
    userId: params.userId,
    name: params.originalName,
  });

  if (!existing) {
    return {
      finalName: params.originalName,
      wasRenamed: false,
      originalName: params.originalName,
    };
  }

  // Conflict detected - get all names and generate unique one
  const allNames = await getAllArtifactNamesForUser(params.userId);
  const uniqueName = generateUniqueFilename(params.originalName, allNames);

  return {
    finalName: uniqueName,
    wasRenamed: true,
    originalName: params.originalName,
  };
}

export async function saveUploadedArtifact(params: {
  userId: string;
  conversationId?: string | null;
  file: File;
  metadata?: Record<string, unknown> | null;
}): Promise<{
  artifact: Artifact;
  normalizedArtifact: Artifact | null;
  reusedExistingArtifact: boolean;
  renameInfo?: {
    originalName: string;
    wasRenamed: boolean;
  };
}> {
  const extension = fileExtension(params.file.name);
  const buffer = Buffer.from(await params.file.arrayBuffer());
  const binaryHash = hashBinaryBuffer(buffer);

  const existingArtifact = await findExistingArtifactByBinaryHash({
    userId: params.userId,
    binaryHash,
  });

  if (existingArtifact) {
    if (params.conversationId) {
      await ensureConversationAttachmentLink({
        userId: params.userId,
        artifactId: existingArtifact.id,
        conversationId: params.conversationId,
      });
    }

    return {
      artifact: existingArtifact,
      normalizedArtifact: null,
      reusedExistingArtifact: true,
    };
  }

  const userDir = knowledgeUserDir(params.userId);

  const nameResolution = await resolveArtifactNameWithAutoRename({
    userId: params.userId,
    originalName: params.file.name,
  });

  const finalArtifactId = randomUUID();
  await mkdir(userDir, { recursive: true });

  const fileName = extension
    ? `${finalArtifactId}.${extension}`
    : finalArtifactId;
  const storagePath = join("data", "knowledge", params.userId, fileName);
  const absolutePath = join(process.cwd(), storagePath);
  await writeFile(absolutePath, buffer);

  const artifact = await createArtifact({
    id: finalArtifactId,
    userId: params.userId,
    conversationId: params.conversationId,
    type: "source_document",
    name: nameResolution.finalName,
    mimeType: params.file.type || null,
    extension,
    sizeBytes: params.file.size,
    binaryHash,
    storagePath,
    summary: nameResolution.finalName,
    metadata: {
      uploadSource: "chat",
      ...(params.metadata ?? {}),
      ...(nameResolution.wasRenamed
        ? { originalName: nameResolution.originalName, renamed: true }
        : {}),
    },
  });

  if (params.conversationId) {
    await ensureConversationAttachmentLink({
      userId: params.userId,
      artifactId: artifact.id,
      conversationId: params.conversationId,
    });
  }

  return {
    artifact,
    normalizedArtifact: null,
    reusedExistingArtifact: false,
    ...(nameResolution.wasRenamed
      ? {
          renameInfo: {
            originalName: nameResolution.originalName,
            wasRenamed: true,
          },
        }
      : {}),
  };
}

export async function saveUploadedArtifactFromStoredFile(params: {
  userId: string;
  conversationId?: string | null;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  binaryHash: string;
  tempPathAbsolute: string;
  metadata?: Record<string, unknown> | null;
}): Promise<{
  artifact: Artifact;
  normalizedArtifact: Artifact | null;
  reusedExistingArtifact: boolean;
  renameInfo?: {
    originalName: string;
    wasRenamed: boolean;
  };
}> {
  const extension = fileExtension(params.fileName);

  const existingArtifact = await findExistingArtifactByBinaryHash({
    userId: params.userId,
    binaryHash: params.binaryHash,
  });

  if (existingArtifact) {
    await unlink(params.tempPathAbsolute).catch(() => undefined);

    if (params.conversationId) {
      await ensureConversationAttachmentLink({
        userId: params.userId,
        artifactId: existingArtifact.id,
        conversationId: params.conversationId,
      });
    }

    return {
      artifact: existingArtifact,
      normalizedArtifact: null,
      reusedExistingArtifact: true,
    };
  }

  const userDir = knowledgeUserDir(params.userId);

  const nameResolution = await resolveArtifactNameWithAutoRename({
    userId: params.userId,
    originalName: params.fileName,
  });

  const finalArtifactId = randomUUID();
  await mkdir(userDir, { recursive: true });

  const fileName = extension
    ? `${finalArtifactId}.${extension}`
    : finalArtifactId;
  const storagePath = join("data", "knowledge", params.userId, fileName);
  const absolutePath = join(process.cwd(), storagePath);
  await rename(params.tempPathAbsolute, absolutePath);

  let artifact: Artifact;
  try {
    artifact = await createArtifact({
      id: finalArtifactId,
      userId: params.userId,
      conversationId: params.conversationId,
      type: "source_document",
      name: nameResolution.finalName,
      mimeType: params.mimeType || null,
      extension,
      sizeBytes: params.sizeBytes,
      binaryHash: params.binaryHash,
      storagePath,
      summary: nameResolution.finalName,
      metadata: {
        uploadSource: "chat",
        ...(params.metadata ?? {}),
        ...(nameResolution.wasRenamed
          ? { originalName: nameResolution.originalName, renamed: true }
          : {}),
      },
    });
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }

  if (params.conversationId) {
    await ensureConversationAttachmentLink({
      userId: params.userId,
      artifactId: artifact.id,
      conversationId: params.conversationId,
    });
  }

  return {
    artifact,
    normalizedArtifact: null,
    reusedExistingArtifact: false,
    ...(nameResolution.wasRenamed
      ? {
          renameInfo: {
            originalName: nameResolution.originalName,
            wasRenamed: true,
          },
        }
      : {}),
  };
}

export async function listMessageAttachments(
  conversationId: string,
): Promise<Map<string, ChatAttachment[]>> {
  const rows = await db
    .select({
      link: artifactLinks,
      artifact: artifacts,
    })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .where(
      and(
        eq(artifactLinks.conversationId, conversationId),
        eq(artifactLinks.linkType, "attached_to_conversation"),
        sql`${artifactLinks.messageId} IS NOT NULL`,
      ),
    )
    .orderBy(desc(artifactLinks.createdAt));

  const result = new Map<string, ChatAttachment[]>();
  for (const row of rows) {
    if (!row.link.messageId) continue;
    const attachments = result.get(row.link.messageId) ?? [];
    attachments.push({
      id: row.link.id,
      artifactId: row.artifact.id,
      name: row.artifact.name,
      type: row.artifact.type as ArtifactType,
      mimeType: row.artifact.mimeType ?? null,
      sizeBytes: row.artifact.sizeBytes ?? null,
      conversationId: row.artifact.conversationId ?? null,
      messageId: row.link.messageId,
      createdAt: row.link.createdAt.getTime(),
    });
    result.set(row.link.messageId, attachments);
  }

  return result;
}

export async function attachArtifactsToMessage(params: {
  userId: string;
  conversationId: string;
  messageId: string;
  artifactIds: string[];
}): Promise<void> {
  const uniqueArtifactIds = Array.from(new Set(params.artifactIds));
  if (uniqueArtifactIds.length === 0) return;

  const ownedArtifacts = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.userId, params.userId),
        inArray(artifacts.id, uniqueArtifactIds),
      ),
    );

  for (const artifact of ownedArtifacts) {
    await createArtifactLink({
      userId: params.userId,
      artifactId: artifact.id,
      conversationId: params.conversationId,
      messageId: params.messageId,
      linkType: "attached_to_conversation",
    });
  }
}

export async function listConversationSourceArtifactIds(
  userId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ artifactId: artifactLinks.artifactId })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.conversationId, conversationId),
        eq(artifactLinks.linkType, "attached_to_conversation"),
        eq(artifacts.type, "source_document"),
      ),
    );
  return Array.from(new Set(rows.map((row) => row.artifactId)));
}

export async function listConversationSourceArtifactNames(
  userId: string,
  conversationId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: artifacts.id, name: artifacts.name })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
    .where(
      and(
        eq(artifactLinks.userId, userId),
        eq(artifactLinks.conversationId, conversationId),
        eq(artifactLinks.linkType, "attached_to_conversation"),
        eq(artifacts.type, "source_document"),
      ),
    );
  const seen = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return Array.from(seen.values());
}
