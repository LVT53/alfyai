import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPersonaSummary = vi.fn();
const mockGetActiveMemoryProfileContext = vi.fn();
const mockShortlistSemanticMatchesBySubject = vi.fn();
const mockGetConversationProjectId = vi.fn();
const mockRecordMemoryReworkTelemetry = vi.fn();

vi.mock("./memory-consolidation/summary", () => ({
	getPersonaSummary: mockGetPersonaSummary,
}));

vi.mock("./semantic-ranking", () => ({
	shortlistSemanticMatchesBySubject: mockShortlistSemanticMatchesBySubject,
}));

vi.mock("./projects", () => ({
	getConversationProjectId: mockGetConversationProjectId,
}));

vi.mock("./memory-profile/active-context", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./memory-profile/active-context")>();
	return {
		...actual,
		getActiveMemoryProfileContext: mockGetActiveMemoryProfileContext,
	};
});

vi.mock("./memory-profile/telemetry", () => ({
	recordMemoryReworkTelemetry: mockRecordMemoryReworkTelemetry,
}));

function activeItem(overrides: {
	id: string;
	statement: string;
	category?: string;
	updatedAt?: Date;
}) {
	return {
		id: overrides.id,
		itemKey: `memory-profile-item:v1:preferences:global:${overrides.id}`,
		category: overrides.category ?? "preferences",
		statement: overrides.statement,
		scope: { type: "global" as const },
		revision: 1,
		updatedAt: overrides.updatedAt ?? new Date("2026-06-01T00:00:00.000Z"),
	};
}

describe("memory-context persona recall v2", () => {
	beforeEach(() => {
		vi.resetModules();
		mockGetPersonaSummary.mockReset();
		mockGetActiveMemoryProfileContext.mockReset();
		mockShortlistSemanticMatchesBySubject.mockReset();
		mockGetConversationProjectId.mockReset();
		mockRecordMemoryReworkTelemetry.mockReset();

		mockGetConversationProjectId.mockResolvedValue(null);
		mockRecordMemoryReworkTelemetry.mockResolvedValue({ id: "telemetry-1" });
		mockShortlistSemanticMatchesBySubject.mockResolvedValue(null);
		mockGetPersonaSummary.mockResolvedValue({
			text: "The user is a cyclist who prefers concise answers about housing.",
			links: [],
			updatedAt: new Date("2026-06-02T00:00:00.000Z"),
		});
		mockGetActiveMemoryProfileContext.mockResolvedValue({
			resetGeneration: 0,
			projectionRevision: 3,
			items: [
				activeItem({
					id: "fact-1",
					statement: "The user is looking for housing near the city center.",
				}),
				activeItem({
					id: "fact-2",
					statement: "The user prefers concise answers.",
				}),
			],
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("persona mode returns summary + facts within budget and one evidence candidate per included fact", async () => {
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		expect(res.mode).toBe("persona");
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(res.status).toBe("available");
		expect(res.source).toBe("active_memory_profile");
		expect(res.content).toContain("Persona summary (auto-maintained):");
		expect(res.content).toContain(
			"The user is a cyclist who prefers concise answers about housing.",
		);
		expect(res.content).toContain("Facts:");
		expect(res.content).toContain(
			"The user is looking for housing near the city center.",
		);

		const factCandidates = res.evidenceCandidates.filter((c) =>
			c.id.startsWith("memory-fact:"),
		);
		expect(factCandidates.length).toBe(2);
		expect(factCandidates[0]?.metadata?.memoryItemId).toBeTruthy();
		expect(factCandidates[0]?.sourceType).toBe("memory");
		expect(factCandidates.map((c) => c.id)).toEqual(
			expect.arrayContaining(["memory-fact:fact-1", "memory-fact:fact-2"]),
		);

		const summaryCandidate = res.evidenceCandidates.find(
			(c) => c.id === "memory-context:summary:u1",
		);
		expect(summaryCandidate).toMatchObject({
			id: "memory-context:summary:u1",
			title: "Persona summary",
			sourceType: "memory",
		});
	});

	it("clips fact candidate titles to 120 chars", async () => {
		const longStatement = `START ${"x".repeat(400)} END`;
		mockGetActiveMemoryProfileContext.mockResolvedValueOnce({
			resetGeneration: 0,
			projectionRevision: 3,
			items: [activeItem({ id: "fact-long", statement: longStatement })],
		});
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		const factCandidate = res.evidenceCandidates.find(
			(c) => c.id === "memory-fact:fact-long",
		);
		expect(factCandidate).toBeTruthy();
		expect((factCandidate?.title ?? "").length).toBeLessThanOrEqual(120);
	});

	it("works with facts only when no summary exists yet", async () => {
		mockGetPersonaSummary.mockResolvedValueOnce(null);
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(res.status).toBe("available");
		expect(res.content).not.toContain("Persona summary");
		expect(res.content).toContain("Facts:");
		expect(
			res.evidenceCandidates.some((c) => c.id === "memory-context:summary:u1"),
		).toBe(false);
		expect(
			res.evidenceCandidates.filter((c) => c.id.startsWith("memory-fact:"))
				.length,
		).toBe(2);
	});

	it("returns empty status with no content when no facts and no summary", async () => {
		mockGetPersonaSummary.mockResolvedValueOnce(null);
		mockGetActiveMemoryProfileContext.mockResolvedValueOnce({
			resetGeneration: 0,
			projectionRevision: 3,
			items: [],
		});
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(res.status).toBe("empty");
		expect(res.source).toBe("active_memory_profile");
		expect(res.content).toBeNull();
		expect(res.evidenceCandidates).toEqual([]);
	});

	it("summary-only (no facts) still returns available with the summary candidate", async () => {
		mockGetActiveMemoryProfileContext.mockResolvedValueOnce({
			resetGeneration: 0,
			projectionRevision: 3,
			items: [],
		});
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(res.status).toBe("available");
		expect(res.content).toContain("Persona summary (auto-maintained):");
		expect(res.content).not.toContain("Facts:");
		expect(res.evidenceCandidates).toEqual([
			expect.objectContaining({ id: "memory-context:summary:u1" }),
		]);
	});

	it("applies semantic top-K shortlist only when query present and facts > 12", async () => {
		const manyItems = Array.from({ length: 20 }, (_, i) =>
			activeItem({ id: `fact-${i}`, statement: `Statement number ${i}.` }),
		);
		mockGetActiveMemoryProfileContext.mockResolvedValueOnce({
			resetGeneration: 0,
			projectionRevision: 3,
			items: manyItems,
		});
		mockShortlistSemanticMatchesBySubject.mockResolvedValueOnce(
			manyItems.slice(0, 12).map((item) => ({
				item,
				subjectId: item.id,
				semanticScore: 0.9,
			})),
		);
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(mockShortlistSemanticMatchesBySubject).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "u1",
				subjectType: "memory_profile_item",
				query: "housing",
				limit: 12,
			}),
		);
		const factCandidates = res.evidenceCandidates.filter((c) =>
			c.id.startsWith("memory-fact:"),
		);
		expect(factCandidates.length).toBe(12);
	});

	it("keeps all facts when shortlist returns null (no TEI)", async () => {
		const manyItems = Array.from({ length: 20 }, (_, i) =>
			activeItem({ id: `fact-${i}`, statement: `Statement number ${i}.` }),
		);
		mockGetActiveMemoryProfileContext.mockResolvedValueOnce({
			resetGeneration: 0,
			projectionRevision: 3,
			items: manyItems,
		});
		mockShortlistSemanticMatchesBySubject.mockResolvedValueOnce(null);
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		const factCandidates = res.evidenceCandidates.filter((c) =>
			c.id.startsWith("memory-fact:"),
		);
		expect(factCandidates.length).toBe(20);
	});

	it("does not shortlist when facts <= 12 even with a query", async () => {
		const { getMemoryContext } = await import("./memory-context");
		await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
		});
		expect(mockShortlistSemanticMatchesBySubject).not.toHaveBeenCalled();
	});

	it("respects the includeEvidenceCandidates gate", async () => {
		const { getMemoryContext } = await import("./memory-context");
		const res = await getMemoryContext({
			userId: "u1",
			conversationId: "c1",
			mode: "persona",
			query: "housing",
			includeEvidenceCandidates: false,
		});
		if (res.mode !== "persona") throw new Error("expected persona");
		expect(res.evidenceCandidates).toEqual([]);
	});
});
