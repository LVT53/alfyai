import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	getConversationContextStatus: vi.fn(),
}));

vi.mock("$lib/server/services/analytics", () => ({
	getConversationCostSummary: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConversationCostSummary } from "$lib/server/services/analytics";
import { getConversation } from "$lib/server/services/conversations";
import { getConversationContextStatus } from "$lib/server/services/knowledge";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetContextStatus = getConversationContextStatus as ReturnType<
	typeof vi.fn
>;
const mockGetCostSummary = getConversationCostSummary as ReturnType<
	typeof vi.fn
>;
type ContextStatusEvent = Parameters<typeof GET>[0];

function makeEvent(
	user = { id: "user-1" },
	conversationId = "conv-1",
): ContextStatusEvent {
	return {
		request: new Request(
			`http://localhost/api/conversations/${conversationId}/context-status`,
		),
		locals: { user },
		params: { id: conversationId },
		url: new URL(
			`http://localhost/api/conversations/${conversationId}/context-status`,
		),
		route: { id: "/api/conversations/[id]/context-status" },
	} as ContextStatusEvent;
}

const baseContextStatus = {
	conversationId: "conv-1",
	userId: "user-1",
	estimatedTokens: 5000,
	maxContextTokens: 262144,
	thresholdTokens: 209715,
	targetTokens: 157286,
	compactionApplied: false,
	compactionMode: "none" as const,
	routingStage: "deterministic" as const,
	routingConfidence: 100,
	verificationStatus: "skipped" as const,
	layersUsed: [],
	workingSetCount: 3,
	workingSetArtifactIds: ["a1", "a2", "a3"],
	workingSetApplied: true,
	taskStateApplied: true,
	promptArtifactCount: 1,
	recentTurnCount: 5,
	summary: null,
	updatedAt: Date.now(),
};

describe("GET /api/conversations/[id]/context-status", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
	});

	it("returns cost summary when conversation has usage events", async () => {
		mockGetContextStatus.mockResolvedValue(baseContextStatus);
		mockGetCostSummary.mockResolvedValue({
			totalCostUsdMicros: 420000,
			totalTokens: 12400,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.contextStatus).toBeTruthy();
		expect(data.totalCostUsdMicros).toBe(420000);
		expect(data.totalTokens).toBe(12400);
		expect(mockGetCostSummary).toHaveBeenCalledWith("conv-1");
	});

	it("returns zero cost for conversation with no usage events", async () => {
		mockGetContextStatus.mockResolvedValue(baseContextStatus);
		mockGetCostSummary.mockResolvedValue({
			totalCostUsdMicros: 0,
			totalTokens: 0,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.totalCostUsdMicros).toBe(0);
		expect(data.totalTokens).toBe(0);
	});

	it("returns null cost when context status is null", async () => {
		mockGetContextStatus.mockResolvedValue(null);
		mockGetCostSummary.mockResolvedValue({
			totalCostUsdMicros: 0,
			totalTokens: 0,
		});

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.contextStatus).toBeNull();
		expect(data.totalCostUsdMicros).toBe(0);
		expect(data.totalTokens).toBe(0);
	});
});
