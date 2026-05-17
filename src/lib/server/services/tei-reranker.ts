import { getConfig } from '$lib/server/config-store';
import type { TeiRerankDiagnostics } from './tei-observability';
import { postToTei } from './tei-client';

export interface TeiRerankResult {
  index: number;
  score: number;
  text?: string;
}

export interface RankedTeiItem<T> {
  item: T;
  index: number;
  score: number;
}

type TeiRerankResponse =
  | TeiRerankResult[]
  | { results?: TeiRerankResult[]; sorted_results?: TeiRerankResult[] };

function isRerankResult(value: unknown): value is TeiRerankResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as TeiRerankResult).index === 'number' &&
      typeof (value as TeiRerankResult).score === 'number'
  );
}

function normalizeRerankResponse(response: TeiRerankResponse): TeiRerankResult[] {
  const candidate =
    Array.isArray(response)
      ? response
      : Array.isArray(response.sorted_results)
        ? response.sorted_results
        : Array.isArray(response.results)
          ? response.results
          : null;

  if (!candidate || !candidate.every((item) => isRerankResult(item))) {
    throw new Error('Unexpected TEI rerank response shape');
  }

  return [...candidate].sort((left, right) => right.score - left.score);
}

function normalizeConfidenceScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score >= 0 && score <= 1) {
    return score;
  }
  return 1 / (1 + Math.exp(-score));
}

export function scoreToConfidencePercent(score: number): number {
  return Math.max(0, Math.min(100, Math.round(normalizeConfidenceScore(score) * 100)));
}

export function canUseTeiReranker(): boolean {
  const config = getConfig();
  return Boolean(config.teiRerankerUrl);
}

export function getTeiRerankerMaxTexts(): number {
  return Math.max(1, getConfig().teiRerankerMaxTexts);
}

function resolveRerankerMaxTexts(requestedMaxTexts?: number): number {
  const configuredMaxTexts = getTeiRerankerMaxTexts();
  if (requestedMaxTexts == null) return configuredMaxTexts;
  const requested = Number.isFinite(requestedMaxTexts)
    ? Math.max(1, Math.floor(requestedMaxTexts))
    : configuredMaxTexts;
  return Math.min(configuredMaxTexts, requested);
}

export async function rerankTexts(params: {
  query: string;
  texts: string[];
  truncate?: boolean;
  returnText?: boolean;
  maxTexts?: number;
  onDiagnostics?: (diagnostics: TeiRerankDiagnostics) => void;
}): Promise<TeiRerankResult[] | null> {
  const trimmedQuery = params.query.trim();
  const startedAt = Date.now();
  const report = (diagnostics: Omit<TeiRerankDiagnostics, 'queryLength' | 'inputCount' | 'latencyMs'>) =>
    params.onDiagnostics?.({
      queryLength: trimmedQuery.length,
      inputCount: params.texts.length,
      latencyMs: Date.now() - startedAt,
      ...diagnostics,
    });

  if (params.texts.length === 0) {
    report({
      limitedCount: 0,
      outputCount: 0,
      fallbackReason: 'no_items',
      confidence: 0,
    });
    return [];
  }
  if (!canUseTeiReranker()) {
    report({
      limitedCount: 0,
      outputCount: 0,
      fallbackReason: 'reranker_unavailable',
      confidence: null,
    });
    return null;
  }

  const config = getConfig();
  const maxTexts = resolveRerankerMaxTexts(params.maxTexts);
  const texts = params.texts.slice(0, maxTexts);

  const response = await postToTei<TeiRerankResponse>({
    baseUrl: config.teiRerankerUrl,
    path: '/rerank',
    apiKey: config.teiRerankerApiKey,
    body: {
      query: params.query,
      texts,
      truncate: params.truncate ?? true,
      return_text: params.returnText ?? false,
      raw_scores: false,
    },
  });

  const normalized = normalizeRerankResponse(response);
  report({
    limitedCount: texts.length,
    outputCount: normalized.length,
    fallbackReason: normalized.length === 0 ? 'empty_rerank_results' : null,
    confidence: normalized.length > 0 ? scoreToConfidencePercent(normalized[0]?.score ?? 0) : 0,
  });
  return normalized;
}

export async function rerankItems<T>(params: {
  query: string;
  items: T[];
  getText: (item: T) => string;
  maxTexts?: number;
  truncate?: boolean;
  onDiagnostics?: (diagnostics: TeiRerankDiagnostics) => void;
}): Promise<{ items: Array<RankedTeiItem<T>>; confidence: number } | null> {
  if (params.items.length === 0) {
    params.onDiagnostics?.({
      queryLength: params.query.trim().length,
      inputCount: 0,
      limitedCount: 0,
      outputCount: 0,
      latencyMs: 0,
      fallbackReason: 'no_items',
      confidence: 0,
    });
    return { items: [], confidence: 0 };
  }

  const maxTexts = resolveRerankerMaxTexts(params.maxTexts);
  const limitedItems = params.items.slice(0, maxTexts);
  let rerankDiagnostics: TeiRerankDiagnostics | null = null;
  const results = await rerankTexts({
    query: params.query,
    texts: limitedItems.map((item) => params.getText(item)),
    truncate: params.truncate,
    maxTexts,
    onDiagnostics: (diagnostics) => {
      rerankDiagnostics = diagnostics;
    },
  });

  if (!results) return null;

  const rankedItems = results
    .map((result) => {
      const item = limitedItems[result.index];
      if (item === undefined) return null;
      return {
        item,
        index: result.index,
        score: result.score,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value != null);

  if (rerankDiagnostics) {
    const diagnostics: TeiRerankDiagnostics = rerankDiagnostics;
    params.onDiagnostics?.({
      ...diagnostics,
      inputCount: params.items.length,
      limitedCount: limitedItems.length,
    });
  } else {
    params.onDiagnostics?.({
      queryLength: params.query.trim().length,
      inputCount: params.items.length,
      limitedCount: limitedItems.length,
      outputCount: rankedItems.length,
      latencyMs: 0,
      fallbackReason: null,
      confidence: rankedItems.length > 0 ? scoreToConfidencePercent(rankedItems[0]?.score ?? 0) : 0,
    });
  }

  return {
    items: rankedItems,
    confidence: rankedItems.length > 0 ? scoreToConfidencePercent(rankedItems[0].score) : 0,
  };
}
