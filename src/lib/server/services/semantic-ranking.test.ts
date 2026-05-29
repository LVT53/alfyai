import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListSemanticEmbeddingsBySubject,
  mockCanUseTeiEmbedder,
  mockEmbedText,
  mockRuntimeConfig,
} = vi.hoisted(() => ({
  mockListSemanticEmbeddingsBySubject: vi.fn(async () => new Map()),
  mockCanUseTeiEmbedder: vi.fn(() => true),
  mockEmbedText: vi.fn(async () => [1, 0]),
  mockRuntimeConfig: {
    teiEmbedderModel: 'bge-m3',
  },
}));

vi.mock('$lib/server/config-store', () => ({
  getConfig: () => mockRuntimeConfig,
}));

vi.mock('./semantic-embeddings', () => ({
  listSemanticEmbeddingsBySubject: mockListSemanticEmbeddingsBySubject,
}));

vi.mock('./tei-embedder', () => ({
  canUseTeiEmbedder: mockCanUseTeiEmbedder,
  embedText: mockEmbedText,
}));

describe('semantic-ranking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUseTeiEmbedder.mockReturnValue(true);
    mockEmbedText.mockResolvedValue([1, 0]);
    mockListSemanticEmbeddingsBySubject.mockResolvedValue(new Map());
    mockRuntimeConfig.teiEmbedderModel = 'bge-m3';
  });

  it('computes cosine similarity safely', async () => {
    const { cosineSimilarity } = await import('$lib/server/utils/math');

    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [0, 1])).toBe(0);
  });

  it('shortlists semantic matches by stored subject embeddings', async () => {
    mockListSemanticEmbeddingsBySubject.mockResolvedValue(
      new Map([
        ['doc-1', { embedding: [1, 0] }],
        ['doc-2', { embedding: [0.2, 0.8] }],
      ])
    );

    const { shortlistSemanticMatchesBySubject } = await import('./semantic-ranking');
    const results = await shortlistSemanticMatchesBySubject({
      userId: 'user-1',
      subjectType: 'artifact',
      query: 'budget forecast',
      items: [{ id: 'doc-1' }, { id: 'doc-2' }],
      getSubjectId: (item) => item.id,
      limit: 2,
    });

    expect(results?.map((entry) => entry.subjectId)).toEqual(['doc-1', 'doc-2']);
    expect(results?.[0]?.semanticScore).toBeGreaterThan(results?.[1]?.semanticScore ?? 0);
  });

  it('reports semantic shortlist diagnostics for stored-embedding matches', async () => {
    mockListSemanticEmbeddingsBySubject.mockResolvedValue(
      new Map([['doc-1', { embedding: [1, 0] }]])
    );

    const diagnostics = vi.fn();
    const { shortlistSemanticMatchesBySubject } = await import('./semantic-ranking');
    await shortlistSemanticMatchesBySubject({
      userId: 'user-1',
      subjectType: 'artifact',
      query: 'forecast',
      items: [{ id: 'doc-1' }, { id: 'doc-2' }],
      getSubjectId: (item) => item.id,
      limit: 2,
      onDiagnostics: diagnostics,
    });

    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        queryLength: 'forecast'.length,
        inputCount: 2,
        storedEmbeddingCount: 1,
        matchCount: 1,
        fallbackReason: null,
      })
    );
  });

  it('uses the Qwen query prompt for Qwen3 query embeddings only', async () => {
    mockRuntimeConfig.teiEmbedderModel = 'Qwen/Qwen3-Embedding-0.6B';
    mockListSemanticEmbeddingsBySubject.mockResolvedValue(
      new Map([['doc-1', { embedding: [1, 0] }]])
    );

    const { shortlistSemanticMatchesBySubject } = await import('./semantic-ranking');
    await shortlistSemanticMatchesBySubject({
      userId: 'user-1',
      subjectType: 'artifact',
      query: 'forecast',
      items: [{ id: 'doc-1' }],
      getSubjectId: (item) => item.id,
      limit: 1,
    });

    expect(mockEmbedText).toHaveBeenCalledWith('forecast', { promptName: 'query' });
  });
});
