import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/memory", () => ({
	applyKnowledgeMemoryAction: vi.fn(),
	getKnowledgeMemory: vi.fn(),
	getKnowledgeMemoryOverview: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	applyKnowledgeMemoryAction,
	getKnowledgeMemory,
	getKnowledgeMemoryOverview,
} from "$lib/server/services/memory";
import { GET as GET_MEMORY } from "./+server";
import { POST as POST_MEMORY_ACTION } from "./actions/+server";
import { GET as GET_MEMORY_OVERVIEW } from "./overview/+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockApplyKnowledgeMemoryAction = applyKnowledgeMemoryAction as ReturnType<
	typeof vi.fn
>;
const mockGetKnowledgeMemory = getKnowledgeMemory as ReturnType<typeof vi.fn>;
const mockGetKnowledgeMemoryOverview = getKnowledgeMemoryOverview as ReturnType<
	typeof vi.fn
>;
type KnowledgeMemoryEvent = Parameters<typeof GET_MEMORY>[0];
type KnowledgeMemoryOverviewEvent = Parameters<typeof GET_MEMORY_OVERVIEW>[0];
type KnowledgeMemoryActionEvent = Parameters<typeof POST_MEMORY_ACTION>[0];

const memoryPayload = {
	personaMemories: [
		{
			id: "conclusion-1",
			content: "Prefers concise answers.",
			scope: "self",
			sessionId: "conv-1",
			conversationId: "conv-1",
			conversationTitle: "Plans",
			createdAt: Date.now(),
		},
	],
	taskMemories: [
		{
			taskId: "task-1",
			conversationId: "conv-1",
			conversationTitle: "Plans",
			objective: "Refine study plan",
			status: "active",
			locked: false,
			updatedAt: Date.now(),
			lastCheckpointAt: Date.now(),
			checkpointSummary: "Keep the new timeline and key constraints.",
		},
	],
	focusContinuities: [
		{
			continuityId: "continuity-1",
			name: "Study roadmap",
			summary: "Long-term planning for coursework and revision.",
			status: "active",
			lastActiveAt: Date.now(),
			updatedAt: Date.now(),
			linkedTaskCount: 2,
			conversationTitles: ["Plans"],
		},
	],
	summary: {
		personaCount: 1,
		taskCount: 1,
		focusContinuityCount: 1,
		overview: "The user likes concise responses.",
		overviewBullets: ["The user likes concise responses."],
		overviewSource: "honcho_scoped",
		overviewStatus: "ready",
		overviewUpdatedAt: Date.now(),
		overviewLastAttemptAt: Date.now(),
		durablePersonaCount: 1,
	},
};

function makeGetEvent(): KnowledgeMemoryEvent {
	return {
		request: new Request("http://localhost/api/knowledge/memory"),
		locals: { user: { id: "user-1", displayName: "Test User" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/memory"),
		route: { id: "/api/knowledge/memory" },
	} as KnowledgeMemoryEvent;
}

function makeOverviewEvent(force = false): KnowledgeMemoryOverviewEvent {
	return {
		request: new Request(
			`http://localhost/api/knowledge/memory/overview${force ? "?force=1" : ""}`,
		),
		locals: { user: { id: "user-1", displayName: "Test User" } },
		params: {},
		url: new URL(
			`http://localhost/api/knowledge/memory/overview${force ? "?force=1" : ""}`,
		),
		route: { id: "/api/knowledge/memory/overview" },
	} as KnowledgeMemoryOverviewEvent;
}

function makePostEvent(body: unknown): KnowledgeMemoryActionEvent {
	return {
		request: new Request("http://localhost/api/knowledge/memory/actions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", displayName: "Test User" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/memory/actions"),
		route: { id: "/api/knowledge/memory/actions" },
	} as KnowledgeMemoryActionEvent;
}

describe("knowledge memory routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("loads the current memory profile", async () => {
		mockGetKnowledgeMemory.mockResolvedValue(memoryPayload);

		const response = await GET_MEMORY(makeGetEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.summary.personaCount).toBe(1);
		expect(mockGetKnowledgeMemory).toHaveBeenCalledWith("user-1", "Test User");
	});

	it("loads the overview-only memory summary and supports force refresh", async () => {
		mockGetKnowledgeMemoryOverview.mockResolvedValue({
			summary: memoryPayload.summary,
		});

		const response = await GET_MEMORY_OVERVIEW(makeOverviewEvent(true));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.summary.overviewSource).toBe("honcho_scoped");
		expect(mockGetKnowledgeMemoryOverview).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				force: true,
			},
		);
	});

	it("applies a memory action and returns the refreshed payload", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue(memoryPayload);

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "forget_persona_memory",
				conclusionId: "conclusion-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.summary.taskCount).toBe(1);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				action: "forget_persona_memory",
				conclusionId: "conclusion-1",
			},
		);
	});

	it("rejects persona forget payloads with only blank ids", async () => {
		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "forget_persona_memory",
				conclusionId: "",
				clusterId: "   ",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid memory action payload/i);
		expect(mockApplyKnowledgeMemoryAction).not.toHaveBeenCalled();
	});

	it("supports forgetting a focus continuity item", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue(memoryPayload);

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "forget_focus_continuity",
				continuityId: "continuity-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.summary.focusContinuityCount).toBe(1);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				action: "forget_focus_continuity",
				continuityId: "continuity-1",
			},
		);
	});

	it("supports forgetting project memory through the route adapter", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue(memoryPayload);

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "forget_project_memory",
				projectId: "project-1",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.summary.focusContinuityCount).toBe(1);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				action: "forget_project_memory",
				projectId: "project-1",
			},
		);
	});

	it("rejects invalid memory action payloads", async () => {
		const response = await POST_MEMORY_ACTION(
			makePostEvent({ action: "forget_task_memory" }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid memory action payload/i);
	});
});
