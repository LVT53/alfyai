import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { artifacts, conversationTaskStates } from '$lib/server/db/schema';
import { getConfig } from '$lib/server/config-store';
import type {
  Artifact,
  TaskState,
} from '$lib/types';
import { clipText, normalizeWhitespace } from '$lib/server/utils/text';
import { mapTaskState } from '$lib/server/services/task-state/mappers';
import {
  canUseTeiEmbedder,
  embedTexts,
  getTeiEmbedderBatchSize,
} from './tei-embedder';
import {
  listSemanticEmbeddingsBySubject,
  needsSemanticEmbeddingRefresh,
  upsertSemanticEmbedding,
} from './semantic-embeddings';

const QWEN3_EMBEDDING_CONTEXT_TOKENS = 32_768;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_SOURCE_TEXT_CHARS = QWEN3_EMBEDDING_CONTEXT_TOKENS * APPROX_CHARS_PER_TOKEN;
const queuedRefreshes = new Map<string, Promise<void>>();

type RefreshableSubject =
  | { subjectType: 'artifact'; subjectId: string; userId: string; sourceText: string }
  | { subjectType: 'task_state'; subjectId: string; userId: string; sourceText: string };

type ArtifactEmbeddingSource = Pick<Artifact, 'id' | 'userId' | 'name' | 'summary' | 'contentText'>;

function getEmbeddingModelName(): string | null {
  const modelName = normalizeWhitespace(getConfig().teiEmbedderModel ?? '');
  if (!modelName) return null;
  return modelName;
}

function compactLines(lines: Array<string | null | undefined>): string {
  return clipText(
    lines
      .map((line) => normalizeWhitespace(line ?? ''))
      .filter(Boolean)
      .join('\n'),
    MAX_SOURCE_TEXT_CHARS
  );
}

export function buildArtifactEmbeddingSourceText(artifact: ArtifactEmbeddingSource): string | null {
  const source = compactLines([
    artifact.name,
    artifact.summary,
    artifact.contentText,
  ]);
  return source || null;
}

export function buildTaskStateEmbeddingSourceText(taskState: TaskState): string | null {
  const source = compactLines([
    `Objective: ${taskState.objective}`,
    taskState.constraints.length > 0 ? `Constraints: ${taskState.constraints.join(' | ')}` : null,
    taskState.factsToPreserve.length > 0
      ? `Facts to preserve: ${taskState.factsToPreserve.join(' | ')}`
      : null,
    taskState.decisions.length > 0 ? `Decisions: ${taskState.decisions.join(' | ')}` : null,
    taskState.openQuestions.length > 0
      ? `Open questions: ${taskState.openQuestions.join(' | ')}`
      : null,
    taskState.nextSteps.length > 0 ? `Next steps: ${taskState.nextSteps.join(' | ')}` : null,
  ]);
  return source || null;
}

async function refreshSubjectEmbeddings(subjects: RefreshableSubject[]): Promise<number> {
  const modelName = getEmbeddingModelName();
  if (!modelName || !canUseTeiEmbedder() || subjects.length === 0) {
    return 0;
  }

  const refreshable = subjects.filter((subject) => subject.sourceText.trim());
  if (refreshable.length === 0) {
    return 0;
  }

  let refreshed = 0;
  const groups = new Map<string, RefreshableSubject[]>();
  for (const subject of refreshable) {
    const key = `${subject.userId}:${subject.subjectType}`;
    const group = groups.get(key) ?? [];
    group.push(subject);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const currentBySubject = await listSemanticEmbeddingsBySubject({
      userId: group[0]!.userId,
      subjectType: group[0]!.subjectType,
      subjectIds: group.map((subject) => subject.subjectId),
      modelName,
    });

    const pending = group.filter((subject) =>
      needsSemanticEmbeddingRefresh({
        current: currentBySubject.get(subject.subjectId) ?? null,
        sourceText: subject.sourceText,
      })
    );

    if (pending.length === 0) {
      continue;
    }

    const batchSize = getTeiEmbedderBatchSize();
    for (let index = 0; index < pending.length; index += batchSize) {
      const batch = pending.slice(index, index + batchSize);
      const embeddings = await embedTexts(batch.map((subject) => subject.sourceText));
      if (!embeddings) {
        continue;
      }

      await Promise.all(
        batch.map((subject, embeddingIndex) =>
          upsertSemanticEmbedding({
            userId: subject.userId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            modelName,
            sourceText: subject.sourceText,
            embedding: embeddings[embeddingIndex] ?? [],
          })
        )
      );
      refreshed += batch.length;
    }
  }

  return refreshed;
}

function queueSubjectRefresh(key: string, work: () => Promise<void>): void {
  if (queuedRefreshes.has(key)) {
    return;
  }

  const pending = work()
    .catch((error) => {
      console.error('[SEMANTIC_EMBEDDINGS] Refresh failed', { key, error });
    })
    .finally(() => {
      queuedRefreshes.delete(key);
    });

  queuedRefreshes.set(key, pending);
}

export function queueArtifactSemanticEmbeddingRefresh(artifact: Artifact): void {
  const sourceText = buildArtifactEmbeddingSourceText(artifact);
  if (!sourceText) return;

  queueSubjectRefresh(`artifact:${artifact.id}`, async () => {
    await refreshSubjectEmbeddings([
      {
        subjectType: 'artifact',
        subjectId: artifact.id,
        userId: artifact.userId,
        sourceText,
      },
    ]);
  });
}

export function queueTaskStateSemanticEmbeddingRefresh(taskState: TaskState): void {
  const sourceText = buildTaskStateEmbeddingSourceText(taskState);
  if (!sourceText) return;

  queueSubjectRefresh(`task_state:${taskState.taskId}`, async () => {
    await refreshSubjectEmbeddings([
      {
        subjectType: 'task_state',
        subjectId: taskState.taskId,
        userId: taskState.userId,
        sourceText,
      },
    ]);
  });
}

export async function backfillSemanticEmbeddingsForUser(userId: string): Promise<{
  artifactCount: number;
  taskStateCount: number;
}> {
  const modelName = getEmbeddingModelName();
  if (!modelName || !canUseTeiEmbedder()) {
    return { artifactCount: 0, taskStateCount: 0 };
  }

  const [artifactRows, taskRows] = await Promise.all([
    db.select().from(artifacts).where(eq(artifacts.userId, userId)),
    db.select().from(conversationTaskStates).where(eq(conversationTaskStates.userId, userId)),
  ]);

  const artifactCount = await refreshSubjectEmbeddings(
    artifactRows
      .map((row) => ({
        subjectType: 'artifact' as const,
        subjectId: row.id,
        userId: row.userId,
        sourceText:
          buildArtifactEmbeddingSourceText({
            id: row.id,
            userId: row.userId,
            name: row.name,
            summary: row.summary,
            contentText: row.contentText,
          }) ?? '',
      }))
  );

  const taskStateCount = await refreshSubjectEmbeddings(
    taskRows
      .map((row) => mapTaskState(row))
      .map((taskState) => ({
        subjectType: 'task_state' as const,
        subjectId: taskState.taskId,
        userId: taskState.userId,
        sourceText: buildTaskStateEmbeddingSourceText(taskState) ?? '',
      }))
  );

  return {
    artifactCount,
    taskStateCount,
  };
}
