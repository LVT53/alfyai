import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCanUseTeiEmbedder,
	mockEmbedText,
	mockUpsertSemanticEmbedding,
	mockGetConfig,
} = vi.hoisted(() => ({
	mockCanUseTeiEmbedder: vi.fn(() => true),
	mockEmbedText: vi.fn(async () => [0.1, 0.2, 0.3]),
	mockUpsertSemanticEmbedding: vi.fn(async () => undefined),
	mockGetConfig: vi.fn(() => ({
		teiEmbedderModel: "bge-m3",
		teiEmbedderUrl: "http://tei:8080",
	})),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mockGetConfig,
}));

vi.mock("$lib/server/services/tei-embedder", () => ({
	canUseTeiEmbedder: mockCanUseTeiEmbedder,
	embedText: mockEmbedText,
}));

vi.mock("$lib/server/services/semantic-embeddings", () => ({
	upsertSemanticEmbedding: mockUpsertSemanticEmbedding,
}));

describe("generateImportEmbeddings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCanUseTeiEmbedder.mockReturnValue(true);
		mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
		mockUpsertSemanticEmbedding.mockResolvedValue(undefined);
		mockGetConfig.mockReturnValue({
			teiEmbedderModel: "bge-m3",
			teiEmbedderUrl: "http://tei:8080",
		});
	});

	it("constructs source text from title and messages", async () => {
		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "My Chat", [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		]);

		expect(mockEmbedText).toHaveBeenCalledWith(
			"Title: My Chat\nuser: Hello\nassistant: Hi there!",
		);
	});

	it("generates embedding and persists it via upsertSemanticEmbedding", async () => {
		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "My Chat", [
			{ role: "user", content: "Hello" },
		]);

		expect(mockEmbedText).toHaveBeenCalledTimes(1);
		expect(mockUpsertSemanticEmbedding).toHaveBeenCalledTimes(1);
		expect(mockUpsertSemanticEmbedding).toHaveBeenCalledWith({
			userId: "user-1",
			subjectType: "imported_conversation",
			subjectId: "conv-1",
			modelName: "bge-m3",
			sourceText: "Title: My Chat\nuser: Hello",
			embedding: [0.1, 0.2, 0.3],
		});
	});

	it("uses default model name when teiEmbedderModel is not configured", async () => {
		mockGetConfig.mockReturnValue({
			teiEmbedderModel: "",
			teiEmbedderUrl: "http://tei:8080",
		});

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(mockUpsertSemanticEmbedding).toHaveBeenCalledWith(
			expect.objectContaining({ modelName: "tei-embedder" }),
		);
	});

	it("skips when TEI embedder is not configured", async () => {
		mockCanUseTeiEmbedder.mockReturnValue(false);

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(mockEmbedText).not.toHaveBeenCalled();
		expect(mockUpsertSemanticEmbedding).not.toHaveBeenCalled();
	});

	it("handles embedText returning null gracefully", async () => {
		mockEmbedText.mockResolvedValue(null);

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(mockUpsertSemanticEmbedding).not.toHaveBeenCalled();
	});

	it("handles embedText returning empty array gracefully", async () => {
		mockEmbedText.mockResolvedValue([]);

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(mockUpsertSemanticEmbedding).not.toHaveBeenCalled();
	});

	it("handles embedText throwing an error gracefully", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mockEmbedText.mockRejectedValue(new Error("TEI timeout"));

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(mockUpsertSemanticEmbedding).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[CHATGPT_IMPORT] Embedding generation failed:",
			"TEI timeout",
		);

		consoleErrorSpy.mockRestore();
	});

	it("handles upsertSemanticEmbedding throwing an error gracefully", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mockUpsertSemanticEmbedding.mockRejectedValue(new Error("DB write error"));

		const { generateImportEmbeddings } = await import("./embeddings");

		await generateImportEmbeddings("conv-1", "user-1", "Chat", [
			{ role: "user", content: "Hi" },
		]);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[CHATGPT_IMPORT] Embedding persistence failed:",
			"DB write error",
		);

		consoleErrorSpy.mockRestore();
	});

	it("handles conversations with many messages", async () => {
		const { generateImportEmbeddings } = await import("./embeddings");

		const messages = Array.from({ length: 50 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `Message content ${i}`,
		}));

		await generateImportEmbeddings("conv-1", "user-1", "Long Chat", messages);

		expect(mockEmbedText).toHaveBeenCalledTimes(1);
		const sourceText = mockEmbedText.mock.calls[0][0] as string;
		expect(sourceText).toContain("Title: Long Chat");
		expect(sourceText).toContain("user: Message content 0");
		expect(sourceText).toContain("assistant: Message content 49");
	});
});
