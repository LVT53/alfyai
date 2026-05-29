import { getConfig } from '$lib/server/config-store';
import { postToTei } from './tei-client';

type TeiEmbedResponse = number[] | number[][] | { embeddings?: number[] | number[][] };

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function isEmbeddingMatrix(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every((item) => isNumberArray(item));
}

function normalizeEmbeddingResponse(response: TeiEmbedResponse): number[][] {
  if (isEmbeddingMatrix(response)) {
    return response;
  }

  if (isNumberArray(response)) {
    return [response];
  }

  if (response && typeof response === 'object' && 'embeddings' in response) {
    const embeddings = response.embeddings;
    if (isEmbeddingMatrix(embeddings)) {
      return embeddings;
    }
    if (isNumberArray(embeddings)) {
      return [embeddings];
    }
  }

  throw new Error('Unexpected TEI embed response shape');
}

export function canUseTeiEmbedder(): boolean {
  const config = getConfig();
  return Boolean(config.teiEmbedderUrl);
}

export function getTeiEmbedderBatchSize(): number {
  return Math.max(1, getConfig().teiEmbedderBatchSize);
}

export async function embedTexts(
  texts: string[],
  options: { normalize?: boolean; truncate?: boolean; promptName?: string } = {}
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  if (!canUseTeiEmbedder()) return null;

  const config = getConfig();
  const promptName = options.promptName?.trim();
  const body: Record<string, unknown> = {
    inputs: texts,
    normalize: options.normalize ?? true,
    truncate: options.truncate ?? true,
  };
  if (promptName) {
    body.prompt_name = promptName;
  }

  const response = await postToTei<TeiEmbedResponse>({
    baseUrl: config.teiEmbedderUrl,
    path: '/embed',
    apiKey: config.teiEmbedderApiKey,
    body,
  });

  return normalizeEmbeddingResponse(response);
}

export async function embedText(
  text: string,
  options: { normalize?: boolean; truncate?: boolean; promptName?: string } = {}
): Promise<number[] | null> {
  const embeddings = await embedTexts([text], options);
  return embeddings ? embeddings[0] ?? null : null;
}
