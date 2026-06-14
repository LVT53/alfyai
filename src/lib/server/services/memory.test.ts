import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetPeerContext = vi.fn();
const mockListPersonaMemories = vi.fn();
const mockForgetAllPersonaMemories = vi.fn();
const mockForgetPersonaMemory = vi.fn();
const mockRotateHonchoPeerIdentity = vi.fn();
const mockIsHonchoEnabled = vi.fn();
const mockListTaskMemoryItems = vi.fn();
const mockListFocusContinuityItems = vi.fn();
const mockCountTaskMemoryItems = vi.fn();
const mockCountFocusContinuityItems = vi.fn();
const mockForgetFocusContinuity = vi.fn();
const mockForgetTaskMemory = vi.fn();

vi.mock("$lib/server/config-store", () => ({
	getConfig: () => ({ honchoPersonaContextWaitMs: 1500 }),
}));

vi.mock("./honcho", () => ({
	forgetAllPersonaMemories: mockForgetAllPersonaMemories,
	forgetPersonaMemory: mockForgetPersonaMemory,
	getPeerContext: mockGetPeerContext,
	isHonchoEnabled: mockIsHonchoEnabled,
	listPersonaMemories: mockListPersonaMemories,
	rotateHonchoPeerIdentity: mockRotateHonchoPeerIdentity,
}));

vi.mock("./task-state", () => ({
	forgetFocusContinuity: mockForgetFocusContinuity,
	forgetTaskMemory: mockForgetTaskMemory,
	countFocusContinuityItems: mockCountFocusContinuityItems,
	countTaskMemoryItems: mockCountTaskMemoryItems,
	listFocusContinuityItems: mockListFocusContinuityItems,
	listTaskMemoryItems: mockListTaskMemoryItems,
}));

describe("knowledge memory service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsHonchoEnabled.mockReturnValue(true);
		mockGetPeerContext.mockResolvedValue(null);
		mockListPersonaMemories.mockResolvedValue([]);
		mockListTaskMemoryItems.mockResolvedValue([]);
		mockListFocusContinuityItems.mockResolvedValue([]);
		mockCountTaskMemoryItems.mockResolvedValue(0);
		mockCountFocusContinuityItems.mockResolvedValue(0);
		mockForgetAllPersonaMemories.mockResolvedValue(0);
		mockForgetPersonaMemory.mockResolvedValue(true);
		mockRotateHonchoPeerIdentity.mockResolvedValue(1);
	});

	it("does not render a memory overview for an empty scoped Honcho memory set", async () => {
		const { getKnowledgeMemory } = await import("./memory");

		const payload = await getKnowledgeMemory("user-1", "Test User");

		expect(payload.personaMemories).toEqual([]);
		expect(payload.summary.overview).toBeNull();
		expect(payload.summary.overviewSource).toBeNull();
		expect(payload.summary.overviewStatus).toBe("not_enough_durable_memory");
		expect(payload.summary.durablePersonaCount).toBe(0);
	});

	it("maps scoped Honcho conclusions into visible persona memory and overview source", async () => {
		mockGetPeerContext.mockResolvedValue(
			"Scoped user memory from Honcho conclusions:\n- Prefers concise responses",
		);
		mockListPersonaMemories.mockResolvedValue([
			{
				id: "conclusion-1",
				content: "Prefers concise responses",
				scope: "assistant_about_user",
				sessionId: "session-1",
				createdAt: 1234,
			},
		]);

		const { getKnowledgeMemory } = await import("./memory");
		const payload = await getKnowledgeMemory("user-1", "Test User");

		expect(payload.personaMemories).toHaveLength(1);
		expect(payload.personaMemories[0]).toMatchObject({
			id: "conclusion-1",
			canonicalText: "Prefers concise responses",
			memoryClass: "long_term_context",
			state: "active",
		});
		expect(payload.summary.overviewSource).toBe("honcho_scoped");
		expect(payload.summary.personaCount).toBe(1);
		expect(payload.summary.durablePersonaCount).toBe(1);
	});

	it("returns app-ready overview bullets from scoped Honcho text", async () => {
		mockGetPeerContext.mockResolvedValue(
			"Explicit Observations [2026-04-25 23:15:33] Prefers concise responses. [2026-04-25 23:30:15] Uses contact email futuredesigncenter@nhlstenden.com for programme planning.",
		);
		mockListPersonaMemories.mockResolvedValue([
			{
				id: "conclusion-1",
				content: "Prefers concise responses",
				scope: "assistant_about_user",
				sessionId: "session-1",
				createdAt: 1234,
			},
		]);

		const { getKnowledgeMemory } = await import("./memory");
		const payload = await getKnowledgeMemory("user-1", "Test User");

		expect(payload.summary.overviewBullets).toEqual([
			"Prefers concise responses.",
			"Uses contact email [email address] for programme planning.",
		]);
		expect(payload.summary.overview).toBe(
			"Prefers concise responses.\nUses contact email [email address] for programme planning.",
		);
		expect(payload.summary.overviewSource).toBe("honcho_scoped");
		expect(payload.summary.overviewStatus).toBe("ready");
	});

	it("degrades to durable persona fallback when the live Honcho overview is unavailable", async () => {
		mockGetPeerContext.mockRejectedValue(new Error("Honcho timeout"));
		mockListPersonaMemories.mockResolvedValue([
			{
				id: "conclusion-1",
				content: "Prefers concise responses.",
				scope: "assistant_about_user",
				sessionId: "session-1",
				createdAt: 1234,
			},
		]);

		const { getKnowledgeMemory } = await import("./memory");
		const payload = await getKnowledgeMemory("user-1", "Test User");

		expect(payload.summary.overviewBullets).toEqual([
			"Prefers concise responses.",
		]);
		expect(payload.summary.overviewSource).toBe("persona_fallback");
		expect(payload.summary.overviewStatus).toBe("temporarily_unavailable");
		expect(payload.summary.overviewUpdatedAt).toBeNull();
		expect(payload.summary.overviewLastAttemptAt).toEqual(expect.any(Number));
		expect(mockGetPeerContext).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			expect.objectContaining({
				throwOnError: true,
			}),
		);
	});

	it("returns app-ready overview bullets from the overview-only service", async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		mockGetPeerContext.mockResolvedValue(
			"## Memory Overview\n- Prefers concise responses.\n- Uses Hungarian and English interfaces.",
		);

		try {
			const { getKnowledgeMemoryOverview } = await import("./memory");
			const payload = await getKnowledgeMemoryOverview("user-1", "Test User");

			expect(payload.summary.overviewBullets).toEqual([
				"Prefers concise responses.",
				"Uses Hungarian and English interfaces.",
			]);
			expect(payload.summary.overview).toBe(
				"Prefers concise responses.\nUses Hungarian and English interfaces.",
			);
			expect(payload.summary.overviewStatus).toBe("ready");
			expect(infoSpy).toHaveBeenCalledWith(
				"[KNOWLEDGE_MEMORY] Selected overview source",
				{
					source: "honcho_scoped",
					status: "ready",
					durablePersonaCount: 0,
					overviewBulletCount: 2,
					unavailable: false,
				},
			);
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("returns overview summary counts without full management rows", async () => {
		mockListPersonaMemories.mockResolvedValue([
			{
				id: "conclusion-1",
				content: "Prefers concise responses.",
				scope: "assistant_about_user",
				sessionId: "session-1",
				createdAt: 1234,
			},
		]);
		mockCountTaskMemoryItems.mockResolvedValue(2);
		mockCountFocusContinuityItems.mockResolvedValue(1);

		const { getKnowledgeMemoryOverview } = await import("./memory");
		const payload = await getKnowledgeMemoryOverview("user-1", "Test User");

		expect(mockListTaskMemoryItems).not.toHaveBeenCalled();
		expect(mockListFocusContinuityItems).not.toHaveBeenCalled();
		expect(mockCountTaskMemoryItems).toHaveBeenCalledWith("user-1");
		expect(mockCountFocusContinuityItems).toHaveBeenCalledWith("user-1");
		expect(payload).not.toHaveProperty("personaMemories");
		expect(payload).not.toHaveProperty("taskMemories");
		expect(payload).not.toHaveProperty("focusContinuities");
		expect(payload.summary.personaCount).toBe(1);
		expect(payload.summary.taskCount).toBe(2);
		expect(payload.summary.focusContinuityCount).toBe(1);
	});

	it("passes force refresh through to the Honcho overview lookup", async () => {
		mockGetPeerContext.mockResolvedValue(
			"## Memory Overview\n- Freshly refreshed scoped memory.",
		);

		const { getKnowledgeMemoryOverview } = await import("./memory");
		const payload = await getKnowledgeMemoryOverview("user-1", "Test User", {
			force: true,
		});

		expect(payload.summary.overviewBullets).toEqual([
			"Freshly refreshed scoped memory.",
		]);
		expect(mockGetPeerContext).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			expect.objectContaining({
				force: true,
				throwOnError: true,
			}),
		);
	});

	it("rotates Honcho peer identity after forget-all persona memory", async () => {
		const { applyKnowledgeMemoryAction } = await import("./memory");

		await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "forget_all_persona_memory",
		});

		expect(mockForgetAllPersonaMemories).toHaveBeenCalledWith("user-1");
		expect(mockRotateHonchoPeerIdentity).toHaveBeenCalledWith("user-1");
	});

	it("forgets a persona memory when the accepted route payload provides a cluster id", async () => {
		const { applyKnowledgeMemoryAction } = await import("./memory");

		await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "forget_persona_memory",
			clusterId: "conclusion-1",
		});

		expect(mockForgetPersonaMemory).toHaveBeenCalledWith(
			"user-1",
			"conclusion-1",
		);
	});

	it("uses the first non-empty persona memory id when conclusion id is blank", async () => {
		const { applyKnowledgeMemoryAction } = await import("./memory");

		await applyKnowledgeMemoryAction("user-1", "Test User", {
			action: "forget_persona_memory",
			conclusionId: "",
			clusterId: " conclusion-1 ",
		});

		expect(mockForgetPersonaMemory).toHaveBeenCalledWith(
			"user-1",
			"conclusion-1",
		);
	});
});
