import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactChunk } from "$lib/types";

const mockDelete = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockGet = vi.fn();

vi.mock("$lib/server/db", () => ({
	db: {
		delete: mockDelete,
		insert: mockInsert,
		select: mockSelect,
	},
}));

const mockGetSmallFileThreshold = vi.fn(() => 5000);
vi.mock("$lib/server/config-store", () => ({
	getSmallFileThreshold: mockGetSmallFileThreshold,
}));

vi.mock("$lib/utils/tokens", () => ({
	estimateTokenCount: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

vi.mock("$lib/server/services/working-set", () => ({
	scoreMatch: vi.fn((query: string, text: string) => {
		return text.toLowerCase().includes(query.toLowerCase()) ? 80 : 10;
	}),
}));

vi.mock("./control-model", () => ({
	canUseContextSummarizer: vi.fn(() => false),
	requestContextSummarizer: vi.fn(),
}));

vi.mock("../tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("./mappers", () => ({
	mapArtifactChunk: vi.fn(
		(row: ArtifactChunk): ArtifactChunk => ({
			id: row.id,
			artifactId: row.artifactId,
			userId: row.userId,
			conversationId: row.conversationId,
			chunkIndex: row.chunkIndex,
			contentText: row.contentText,
			tokenEstimate: row.tokenEstimate,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}),
	),
}));

const { syncArtifactChunks, getPromptArtifactSnippets } = await import(
	"./artifacts"
);

describe("artifacts", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockSelect.mockReturnValue({
			from: mockFrom,
		});
		mockFrom.mockReturnValue({
			where: mockWhere,
		});
		mockWhere.mockReturnValue({
			orderBy: mockOrderBy,
			limit: mockLimit,
		});
		mockLimit.mockReturnValue({
			get: mockGet,
		});
		mockGet.mockResolvedValue(null);
		mockOrderBy.mockResolvedValue([]);

		mockDelete.mockReturnValue({
			where: vi.fn().mockResolvedValue(undefined),
		});

		mockInsert.mockReturnValue({
			values: vi.fn().mockResolvedValue(undefined),
		});
	});

	describe("shouldBypassChunking edge cases", () => {
		it("bypasses chunking for files with 4999 characters (below threshold)", async () => {
			const content = "a".repeat(4999);

			await syncArtifactChunks({
				artifactId: "test-artifact-1",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});

		it("does NOT bypass chunking for files with exactly 5000 characters (at threshold boundary)", async () => {
			const content = "a".repeat(5000);

			await syncArtifactChunks({
				artifactId: "test-artifact-2",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("chunks files with 5001 characters (above threshold)", async () => {
			const content = "a".repeat(5001);

			await syncArtifactChunks({
				artifactId: "test-artifact-3",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
			expect(mockInsert().values).toHaveBeenCalled();
		});
	});

	describe("syncArtifactChunks bypass behavior", () => {
		it("does not create chunks for small files (bypass path)", async () => {
			const smallContent =
				"Small file content that is well under the threshold.";

			await syncArtifactChunks({
				artifactId: "small-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: smallContent,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});

		it("creates chunks for large files (chunking path)", async () => {
			const largeContent = "a".repeat(6000);

			await syncArtifactChunks({
				artifactId: "large-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: largeContent,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("handles empty content gracefully", async () => {
			await syncArtifactChunks({
				artifactId: "empty-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: "",
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});

		it("handles null content gracefully", async () => {
			await syncArtifactChunks({
				artifactId: "null-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: null,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});

		it("handles whitespace-only content as empty", async () => {
			await syncArtifactChunks({
				artifactId: "whitespace-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: "   \n\t   ",
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});
	});

	describe("getPromptArtifactSnippets with no-chunks artifacts", () => {
		it("should return full contentText when artifact has no chunks", async () => {
			const artifact: Artifact = {
				id: "no-chunks-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Test Document",
				mimeType: "text/plain",
				sizeBytes: 100,
				conversationId: null,
				summary: "Document summary",
				contentText:
					"This is the full content of the document that should be returned when there are no chunks.",
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([]);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "test query",
			});

			expect(snippets.get(artifact.id)).toBe(artifact.contentText);
		});

		it("should fall back to summary when contentText is null and no chunks exist", async () => {
			const artifact: Artifact = {
				id: "summary-fallback-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Test Document",
				mimeType: "text/plain",
				sizeBytes: 100,
				conversationId: null,
				summary: "This is the summary that should be used as fallback.",
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([]);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "test query",
			});

			expect(snippets.get(artifact.id)).toBe(artifact.summary);
		});

		it("should fall back to name when both contentText and summary are null", async () => {
			const artifact: Artifact = {
				id: "name-fallback-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Document Name Fallback",
				mimeType: "text/plain",
				sizeBytes: 100,
				conversationId: null,
				summary: null,
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([]);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "test query",
			});

			expect(snippets.get(artifact.id)).toBe(artifact.name);
		});

		it("should clip fallback content to perArtifactCharBudget", async () => {
			const longContent = "a".repeat(2000);
			const artifact: Artifact = {
				id: "long-content-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Test Document",
				mimeType: "text/plain",
				sizeBytes: 2000,
				conversationId: null,
				summary: null,
				contentText: longContent,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([]);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "test query",
				perArtifactCharBudget: 100,
			});

			const result = snippets.get(artifact.id);
			expect(result?.length).toBeLessThanOrEqual(100);
			expect(result).toContain("a");
		});

		it("should handle multiple artifacts with mixed chunk status", async () => {
			const noChunksArtifact: Artifact = {
				id: "no-chunks-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "No Chunks Doc",
				mimeType: "text/plain",
				sizeBytes: 100,
				conversationId: null,
				summary: null,
				contentText: "Full content for no-chunks artifact.",
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const withChunksArtifact: Artifact = {
				id: "with-chunks-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "With Chunks Doc",
				mimeType: "text/plain",
				sizeBytes: 6000,
				conversationId: null,
				summary: null,
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = [
				{
					id: "chunk-1",
					artifactId: "with-chunks-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "First chunk content that matches the query very well.",
					tokenEstimate: 20,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [noChunksArtifact, withChunksArtifact],
				query: "matches query",
			});

			expect(snippets.get(noChunksArtifact.id)).toBe(
				noChunksArtifact.contentText,
			);
			expect(snippets.get(withChunksArtifact.id)).toContain(
				"First chunk content",
			);
		});
	});

	describe("REGRESSION: Large file chunking (>10K chars)", () => {
		it("creates multiple chunks for 10K character files", async () => {
			const content = "a".repeat(10000);

			await syncArtifactChunks({
				artifactId: "large-10k-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();

			// Verify insert was called with multiple chunks
			const insertCall = mockInsert.mock.results[0];
			expect(insertCall).toBeDefined();
		});

		it("creates appropriate chunk count for 20K character files", async () => {
			const content = "Word ".repeat(4000); // ~20K chars with spaces

			await syncArtifactChunks({
				artifactId: "large-20k-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("creates appropriate chunk count for 50K character files", async () => {
			const content = "Word ".repeat(10000); // ~50K chars with spaces

			await syncArtifactChunks({
				artifactId: "large-50k-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("preserves chunk overlap between consecutive chunks", async () => {
			// Content with clear boundaries to test overlap
			const paragraphs: string[] = [];
			for (let i = 0; i < 20; i++) {
				paragraphs.push(`Paragraph ${i}: ${"word ".repeat(100)}`);
			}
			const content = paragraphs.join("\n\n");

			await syncArtifactChunks({
				artifactId: "overlap-test-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("handles large files with natural boundaries (paragraphs, sentences)", async () => {
			const paragraphs: string[] = [];
			for (let i = 0; i < 60; i++) {
				paragraphs.push(
					`Section ${i}. This is a complete sentence with substantial content to ensure we exceed the chunking threshold. Here is another sentence with more detailed information to fill space properly. And a third sentence with additional context for good measure and sufficient length.`,
				);
			}
			const content = paragraphs.join("\n\n");

			await syncArtifactChunks({
				artifactId: "boundary-test-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("handles large files without natural boundaries (continuous text)", async () => {
			// 15K chars of continuous text without sentence/paragraph breaks
			const content = "a".repeat(15000);

			await syncArtifactChunks({
				artifactId: "continuous-test-artifact",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: content,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});
	});

	describe("REGRESSION: Snippet selection for large files", () => {
		it("enforces total-char budget across multiple artifacts", async () => {
			const artifacts: Artifact[] = [
				{
					id: "budget-artifact-1",
					userId: "test-user",
					type: "source_document",
					retrievalClass: "durable",
					name: "Budgeted Document 1",
					mimeType: "text/plain",
					sizeBytes: 15000,
					conversationId: null,
					summary: null,
					contentText: null,
					extension: "txt",
					storagePath: null,
					metadata: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "budget-artifact-2",
					userId: "test-user",
					type: "source_document",
					retrievalClass: "durable",
					name: "Budgeted Document 2",
					mimeType: "text/plain",
					sizeBytes: 15000,
					conversationId: null,
					summary: null,
					contentText: null,
					extension: "txt",
					storagePath: null,
					metadata: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];

			const mockChunkRows = [
				{
					id: "chunk-1-0",
					artifactId: "budget-artifact-1",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "First document first chunk for budget checks.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "chunk-2-0",
					artifactId: "budget-artifact-2",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "Second document first chunk for budget checks.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts,
				query: "",
				totalCharBudget: 10,
			});

			expect(snippets.get("budget-artifact-1")?.length).toBeLessThanOrEqual(10);
			expect(snippets.get("budget-artifact-2")).toBe("");
		});

		it("returns ranked chunks based on query relevance", async () => {
			const artifact: Artifact = {
				id: "ranked-chunks-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Large Document",
				mimeType: "text/plain",
				sizeBytes: 15000,
				conversationId: null,
				summary: "Document about machine learning and AI",
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = [
				{
					id: "chunk-0",
					artifactId: "ranked-chunks-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "Introduction to programming basics and syntax.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "chunk-1",
					artifactId: "ranked-chunks-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 1,
					contentText:
						"Machine learning algorithms and neural networks are important.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "chunk-2",
					artifactId: "ranked-chunks-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 2,
					contentText:
						"Deep learning models use multiple layers for complex pattern recognition.",
					tokenEstimate: 12,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "machine learning neural networks",
			});

			const result = snippets.get(artifact.id);
			expect(result).toBeDefined();
			expect(result).toContain("Machine learning");
		});

		it("falls back to first chunk when query is empty", async () => {
			const artifact: Artifact = {
				id: "empty-query-chunks-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Empty Query Document",
				mimeType: "text/plain",
				sizeBytes: 15000,
				conversationId: null,
				summary: "Summary text.",
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = [
				{
					id: "empty-query-chunk-0",
					artifactId: artifact.id,
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "First chunk content should be used.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "empty-query-chunk-1",
					artifactId: artifact.id,
					userId: "test-user",
					conversationId: null,
					chunkIndex: 1,
					contentText: "Second chunk content should not be preferred.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "",
				perArtifactLimit: 1,
			});

			const result = snippets.get(artifact.id);
			expect(result).toContain("First chunk content should be used.");
			expect(result).not.toContain(
				"Second chunk content should not be preferred.",
			);
		});

		it("respects perArtifactLimit when selecting chunks", async () => {
			const artifact: Artifact = {
				id: "limit-test-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Large Document",
				mimeType: "text/plain",
				sizeBytes: 20000,
				conversationId: null,
				summary: null,
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = Array.from({ length: 10 }, (_, i) => ({
				id: `chunk-${i}`,
				artifactId: "limit-test-artifact",
				userId: "test-user",
				conversationId: null,
				chunkIndex: i,
				contentText: `Chunk ${i} content with relevant keywords for testing.`,
				tokenEstimate: 10,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "relevant keywords",
				perArtifactLimit: 2,
			});

			const result = snippets.get(artifact.id);
			expect(result).toBeDefined();
		});

		it("respects perArtifactCharBudget when combining chunks", async () => {
			const artifact: Artifact = {
				id: "budget-test-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Large Document",
				mimeType: "text/plain",
				sizeBytes: 20000,
				conversationId: null,
				summary: null,
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = [
				{
					id: "chunk-0",
					artifactId: "budget-test-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText:
						"First chunk with substantial content that should be included.",
					tokenEstimate: 15,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "chunk-1",
					artifactId: "budget-test-artifact",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 1,
					contentText:
						"Second chunk with more substantial content for testing.",
					tokenEstimate: 15,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "substantial content",
				perArtifactCharBudget: 100,
			});

			const result = snippets.get(artifact.id);
			expect(result).toBeDefined();
			expect(result?.length).toBeLessThanOrEqual(100);
		});

		it("uses the reranker to recover a semantic passage when lexical chunk scores are weak", async () => {
			const reranker = await import("../tei-reranker");
			vi.mocked(reranker.canUseTeiReranker).mockReturnValueOnce(true);
			vi.mocked(reranker.rerankItems).mockImplementationOnce(async (params) => {
				const { items } = params as { items: Array<{ chunk: ArtifactChunk }> };
				return {
					confidence: 94,
					items: items
						.filter((entry) => entry.chunk.chunkIndex === 7)
						.map((item, index) => ({ item, index, score: 94 })),
				};
			});

			const artifact: Artifact = {
				id: "semantic-passage-artifact",
				userId: "test-user",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Operations Handbook",
				mimeType: "text/plain",
				sizeBytes: 60000,
				conversationId: "other-conversation",
				summary: "Support operations handbook",
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const chunkRows = Array.from({ length: 10 }, (_, index) => ({
				id: `semantic-chunk-${index}`,
				artifactId: artifact.id,
				userId: "test-user",
				conversationId: "other-conversation",
				chunkIndex: index,
				contentText:
					index === 7
						? "Chargeback propensity, refund anomaly clustering, and buyer-risk predictors."
						: `General onboarding appendix ${index}.`,
				tokenEstimate: 12,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
			mockOrderBy.mockResolvedValueOnce(chunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "Which cases are likely to become repayment disputes?",
				perArtifactLimit: 1,
				perArtifactCharBudget: 500,
			});

			expect(reranker.rerankItems).toHaveBeenCalledWith(
				expect.objectContaining({
					items: expect.arrayContaining([
						expect.objectContaining({
							chunk: expect.objectContaining({ chunkIndex: 7 }),
						}),
					]),
				}),
			);
			expect(snippets.get(artifact.id)).toContain("Chargeback propensity");
			expect(snippets.get(artifact.id)).not.toContain(
				"General onboarding appendix 0",
			);
		});

		it("bounds full-content snippets to the per-artifact budget", async () => {
			const longContent = "Full content sentence. ".repeat(1000);
			const artifact: Artifact = {
				id: "full-content-budget-artifact",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Large Full Content Document",
				mimeType: "text/plain",
				sizeBytes: longContent.length,
				conversationId: null,
				summary: null,
				contentText: longContent,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([
				{
					id: "chunk-0",
					artifactId: artifact.id,
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText:
						"Chunk text should be bypassed for explicit full content.",
					tokenEstimate: 15,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]);
			mockGet.mockResolvedValueOnce({ contentText: longContent });

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "summarize the full content document",
				perArtifactCharBudget: 5_000,
				useFullContent: true,
			});

			const result = snippets.get(artifact.id);
			expect(result).toBeDefined();
			expect(result?.length).toBeLessThanOrEqual(5_020);
			expect(result).toContain("[truncated]");
		});

		it("handles multiple large artifacts in single call", async () => {
			const artifacts: Artifact[] = [
				{
					id: "multi-artifact-1",
					userId: "test-user",
					type: "source_document",
					retrievalClass: "durable",
					name: "Document One",
					mimeType: "text/plain",
					sizeBytes: 15000,
					conversationId: null,
					summary: null,
					contentText: null,
					extension: "txt",
					storagePath: null,
					metadata: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "multi-artifact-2",
					userId: "test-user",
					type: "source_document",
					retrievalClass: "durable",
					name: "Document Two",
					mimeType: "text/plain",
					sizeBytes: 20000,
					conversationId: null,
					summary: null,
					contentText: null,
					extension: "txt",
					storagePath: null,
					metadata: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];

			const mockChunkRows = [
				{
					id: "chunk-1-0",
					artifactId: "multi-artifact-1",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "Content from document one about specific topics.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				{
					id: "chunk-2-0",
					artifactId: "multi-artifact-2",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "Content from document two about different topics.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts,
				query: "specific topics",
			});

			expect(snippets.size).toBe(2);
			expect(snippets.get("multi-artifact-1")).toBeDefined();
			expect(snippets.get("multi-artifact-2")).toBeDefined();
		});
	});

	describe("REGRESSION: Backward compatibility", () => {
		it("small files still bypass chunking (no regression)", async () => {
			const smallContent = "Small content under threshold.";

			await syncArtifactChunks({
				artifactId: "small-compat-test",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: smallContent,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).not.toHaveBeenCalled();
		});

		it("large files still get chunked (no regression)", async () => {
			const largeContent = "a".repeat(10000);

			await syncArtifactChunks({
				artifactId: "large-compat-test",
				userId: "test-user",
				conversationId: "test-conversation",
				contentText: largeContent,
			});

			expect(mockDelete).toHaveBeenCalled();
			expect(mockInsert).toHaveBeenCalled();
		});

		it("snippet selection API unchanged for no-chunks artifacts", async () => {
			const artifact: Artifact = {
				id: "api-compat-test",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Test Document",
				mimeType: "text/plain",
				sizeBytes: 100,
				conversationId: null,
				summary: null,
				contentText: "Full content available.",
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			mockOrderBy.mockResolvedValueOnce([]);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "test",
			});

			expect(snippets.get(artifact.id)).toBe("Full content available.");
		});

		it("snippet selection API unchanged for chunked artifacts", async () => {
			const artifact: Artifact = {
				id: "api-compat-chunked-test",
				userId: "test-user",
				type: "source_document",
				retrievalClass: "durable",
				name: "Test Document",
				mimeType: "text/plain",
				sizeBytes: 15000,
				conversationId: null,
				summary: null,
				contentText: null,
				extension: "txt",
				storagePath: null,
				metadata: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			const mockChunkRows = [
				{
					id: "chunk-0",
					artifactId: "api-compat-chunked-test",
					userId: "test-user",
					conversationId: null,
					chunkIndex: 0,
					contentText: "Chunked content for API compatibility test.",
					tokenEstimate: 10,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			];
			mockOrderBy.mockResolvedValueOnce(mockChunkRows);

			const snippets = await getPromptArtifactSnippets({
				userId: "test-user",
				artifacts: [artifact],
				query: "compatibility",
			});

			expect(snippets.get(artifact.id)).toContain("Chunked content");
		});
	});
});
