import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindRelevantArtifactsByTypesDetailed,
  mockGetArtifactsForUser,
  mockResolveRelevantGeneratedDocumentSelection,
} = vi.hoisted(() => {
  const mockFindRelevantArtifactsByTypesDetailed = vi.fn(async () => []);
  const mockGetArtifactsForUser = vi.fn(async () => []);
  const mockResolveRelevantGeneratedDocumentSelection = vi.fn(() => ({
    orderedArtifacts: [],
    diagnostics: [],
  }));

  return {
    mockFindRelevantArtifactsByTypesDetailed,
    mockGetArtifactsForUser,
    mockResolveRelevantGeneratedDocumentSelection,
  };
});

vi.mock("./store", () => ({
  findRelevantArtifactsByTypesDetailed: mockFindRelevantArtifactsByTypesDetailed,
  getArtifactsForUser: mockGetArtifactsForUser,
}));

vi.mock("../memory-events", () => ({
  countRecentMemoryEventsBySubject: vi.fn(async () => new Map()),
}));

vi.mock("../document-resolution", () => ({
  getGeneratedDocumentBehaviorKey: vi.fn((artifact: { id: string }) => artifact.id),
  isGeneratedDocumentPromptEligible: vi.fn(() => true),
  resolveRelevantGeneratedDocumentSelection: mockResolveRelevantGeneratedDocumentSelection,
}));

describe("knowledge context retrieval", () => {
  beforeEach(() => {
    mockFindRelevantArtifactsByTypesDetailed.mockClear();
    mockFindRelevantArtifactsByTypesDetailed.mockResolvedValue([]);
    mockGetArtifactsForUser.mockClear();
    mockGetArtifactsForUser.mockResolvedValue([]);
    mockResolveRelevantGeneratedDocumentSelection.mockClear();
    mockResolveRelevantGeneratedDocumentSelection.mockReturnValue({
      orderedArtifacts: [],
      diagnostics: [],
    });
  });

  it("does not include Skill Notes in default broad relevance retrieval", async () => {
    const { findRelevantKnowledgeArtifacts } = await import("./context");

    const results = await findRelevantKnowledgeArtifacts({
      userId: "user-1",
      currentConversationId: "conv-1",
      query: "research notes",
      limit: 4,
    });

    expect(results).toEqual([]);
    expect(mockFindRelevantArtifactsByTypesDetailed).toHaveBeenCalledTimes(2);
    expect(
      mockFindRelevantArtifactsByTypesDetailed.mock.calls.map(([params]) => params.types),
    ).toEqual([["normalized_document"], ["generated_output"]]);
  });
});
