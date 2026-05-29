import { getConfig } from '$lib/server/config-store';
import type { SemanticEmbeddingSubjectType } from '$lib/types';
import type { SemanticShortlistDiagnostics } from './tei-observability';
import { listSemanticEmbeddingsBySubject } from './semantic-embeddings';
import { canUseTeiEmbedder, embedText } from './tei-embedder';
import { cosineSimilarity } from '$lib/server/utils/math';

export interface SemanticMatch<T> {
  item: T;
  subjectId: string;
  semanticScore: number;
}

function getEmbeddingModelName(): string | null {
  const modelName = getConfig().teiEmbedderModel?.trim();
  return modelName ? modelName : null;
}

function getQueryEmbeddingOptions(modelName: string): { promptName?: string } {
  return /(^|[/_-])qwen3[-_/]?embedding/i.test(modelName) ? { promptName: 'query' } : {};
}

export async function shortlistSemanticMatchesBySubject<T>(params: {
  userId: string;
  subjectType: SemanticEmbeddingSubjectType;
  query: string;
  items: T[];
  getSubjectId: (item: T) => string;
  limit: number;
  onDiagnostics?: (diagnostics: SemanticShortlistDiagnostics) => void;
}): Promise<Array<SemanticMatch<T>> | null> {
  const modelName = getEmbeddingModelName();
  const trimmedQuery = params.query.trim();
  const startedAt = Date.now();
  const report = (diagnostics: Omit<SemanticShortlistDiagnostics, 'queryLength' | 'inputCount' | 'latencyMs'>) =>
    params.onDiagnostics?.({
      queryLength: trimmedQuery.length,
      inputCount: params.items.length,
      latencyMs: Date.now() - startedAt,
      ...diagnostics,
    });

  if (!modelName || !canUseTeiEmbedder() || !trimmedQuery || params.items.length === 0) {
    report({
      storedEmbeddingCount: 0,
      matchCount: 0,
      fallbackReason: !trimmedQuery
        ? 'empty_query'
        : params.items.length === 0
          ? 'no_items'
          : !modelName
            ? 'model_unconfigured'
            : 'embedder_unavailable',
    });
    return null;
  }

  const queryEmbedding = await embedText(trimmedQuery, getQueryEmbeddingOptions(modelName));
  if (!queryEmbedding || queryEmbedding.length === 0) {
    report({
      storedEmbeddingCount: 0,
      matchCount: 0,
      fallbackReason: 'empty_query_embedding',
    });
    return null;
  }

  const subjectIds = Array.from(
    new Set(params.items.map((item) => params.getSubjectId(item)).filter(Boolean))
  );
  if (subjectIds.length === 0) {
    report({
      storedEmbeddingCount: 0,
      matchCount: 0,
      fallbackReason: 'no_subject_ids',
    });
    return null;
  }

  const storedEmbeddings = await listSemanticEmbeddingsBySubject({
    userId: params.userId,
    subjectType: params.subjectType,
    subjectIds,
    modelName,
  });

  const matches = params.items
    .map((item) => {
      const subjectId = params.getSubjectId(item);
      const embedding = storedEmbeddings.get(subjectId);
      if (!embedding || embedding.embedding.length === 0) {
        return null;
      }

      return {
        item,
        subjectId,
        semanticScore: cosineSimilarity(queryEmbedding, embedding.embedding),
      };
    })
    .filter((value): value is SemanticMatch<T> => Boolean(value))
    .sort((left, right) => right.semanticScore - left.semanticScore)
    .slice(0, Math.max(1, params.limit));

  report({
    storedEmbeddingCount: storedEmbeddings.size,
    matchCount: matches.length,
    fallbackReason: storedEmbeddings.size === 0 ? 'no_stored_embeddings' : null,
  });

  return matches;
}
