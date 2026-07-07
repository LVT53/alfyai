import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/memory", () => ({
	MemoryProfileActionError: class MemoryProfileActionError extends Error {
		code: string;
		status: number;

		constructor(code: string, message: string, status: number) {
			super(message);
			this.name = "MemoryProfileActionError";
			this.code = code;
			this.status = status;
		}
	},
	applyKnowledgeMemoryAction: vi.fn(),
	getKnowledgeMemoryItemDetail: vi.fn(),
	getKnowledgeMemory: vi.fn(),
	getKnowledgeMemoryOverview: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	applyKnowledgeMemoryAction,
	getKnowledgeMemory,
	getKnowledgeMemoryItemDetail,
	getKnowledgeMemoryOverview,
	MemoryProfileActionError,
} from "$lib/server/services/memory";
import { GET as GET_MEMORY } from "./+server";
import { GET as GET_MEMORY_ITEM } from "./[itemId]/+server";
import { POST as POST_MEMORY_ACTION } from "./actions/+server";
import { GET as GET_MEMORY_OVERVIEW } from "./overview/+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockApplyKnowledgeMemoryAction = applyKnowledgeMemoryAction as ReturnType<
	typeof vi.fn
>;
const mockGetKnowledgeMemoryItemDetail =
	getKnowledgeMemoryItemDetail as ReturnType<typeof vi.fn>;
const mockGetKnowledgeMemory = getKnowledgeMemory as ReturnType<typeof vi.fn>;
const mockGetKnowledgeMemoryOverview = getKnowledgeMemoryOverview as ReturnType<
	typeof vi.fn
>;
type KnowledgeMemoryEvent = Parameters<typeof GET_MEMORY>[0];
type KnowledgeMemoryItemEvent = Parameters<typeof GET_MEMORY_ITEM>[0];
type KnowledgeMemoryOverviewEvent = Parameters<typeof GET_MEMORY_OVERVIEW>[0];
type KnowledgeMemoryActionEvent = Parameters<typeof POST_MEMORY_ACTION>[0];

const memoryPayload = {
	resetGeneration: 0,
	projectionRevision: 7,
	categories: [
		{
			category: "about_you",
			items: [
				{
					id: "item-about",
					itemKey: "memory-profile-item:v1:about_you:global:item-about",
					category: "about_you",
					statement: "Lives in Amsterdam.",
					scope: { type: "global" },
					status: "active",
					revision: 1,
					updatedAt: "2026-06-01T10:00:00.000Z",
					canEdit: true,
					canDelete: true,
					canSuppress: true,
				},
			],
		},
		{ category: "preferences", items: [] },
		{ category: "goals_ongoing_work", items: [] },
		{ category: "constraints_boundaries", items: [] },
	],
	review: {
		visibleItems: [
			{
				id: "review-1",
				subject: "preferred language",
				question: "Which language should be remembered?",
				reason: "Conflicting evidence.",
				canAccept: true,
			},
		],
		openCount: 4,
		overflowCount: 1,
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

function makeGetItemEvent(itemId = "item-about"): KnowledgeMemoryItemEvent {
	return {
		request: new Request(
			`http://localhost/api/knowledge/memory/${encodeURIComponent(itemId)}`,
		),
		locals: { user: { id: "user-1", displayName: "Test User" } },
		params: { itemId },
		url: new URL(
			`http://localhost/api/knowledge/memory/${encodeURIComponent(itemId)}`,
		),
		route: { id: "/api/knowledge/memory/[itemId]" },
	} as KnowledgeMemoryItemEvent;
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

	it("loads the projection-backed memory profile without legacy memory rows", async () => {
		mockGetKnowledgeMemory.mockResolvedValue(memoryPayload);

		const response = await GET_MEMORY(makeGetEvent());
		const data = await response.json();
		const dataJson = JSON.stringify(data);

		expect(response.status).toBe(200);
		expect(data.categories).toHaveLength(4);
		expect(data.review.openCount).toBe(4);
		expect(mockGetKnowledgeMemory).toHaveBeenCalledWith("user-1", "Test User");
		expect(dataJson).not.toContain("taskMemories");
		expect(dataJson).not.toContain("focusContinuities");
		expect(dataJson).not.toContain("confidence");
		expect(dataJson).not.toContain("debug");
	});

	it("keeps overview as a projection-backed compatibility wrapper", async () => {
		mockGetKnowledgeMemoryOverview.mockResolvedValue({
			summary: {
				personaCount: 1,
				taskCount: 0,
				focusContinuityCount: 0,
				overview: null,
				overviewBullets: [],
				overviewSource: null,
				overviewStatus: "ready",
				overviewUpdatedAt: null,
				overviewLastAttemptAt: 1234,
				durablePersonaCount: 1,
			},
			profile: memoryPayload,
		});

		const response = await GET_MEMORY_OVERVIEW(makeOverviewEvent(true));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.profile.categories).toHaveLength(4);
		expect(mockGetKnowledgeMemoryOverview).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				force: true,
			},
		);
	});

	it("loads a curated memory item detail with provenance chips", async () => {
		mockGetKnowledgeMemoryItemDetail.mockResolvedValue({
			...memoryPayload.categories[0].items[0],
			sourceChips: [
				{
					id: "source-1",
					sourceType: "user_statement",
					label: "Chat",
					summary: "User said this directly.",
				},
			],
			whyRemembered: "User said this directly.",
		});

		const response = await GET_MEMORY_ITEM(makeGetItemEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.sourceChips).toEqual([
			{
				id: "source-1",
				sourceType: "user_statement",
				label: "Chat",
				summary: "User said this directly.",
			},
		]);
		expect(mockGetKnowledgeMemoryItemDetail).toHaveBeenCalledWith(
			"user-1",
			"item-about",
		);
	});

	it("applies suppress actions with the expected projection revision", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue({
			...memoryPayload,
			projectionRevision: 8,
			categories: memoryPayload.categories.map((group) => ({
				...group,
				items: [],
			})),
		});

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "suppress",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.projectionRevision).toBe(8);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				action: "suppress",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			},
		);
	});

	it("applies delete actions with the expected projection revision", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue({
			...memoryPayload,
			projectionRevision: 8,
			categories: memoryPayload.categories.map((group) => ({
				...group,
				items: [],
			})),
		});

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "delete",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.projectionRevision).toBe(8);
		expect(
			data.categories.flatMap((group: { items: unknown[] }) => group.items),
		).toEqual([]);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				action: "delete",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			},
		);
	});

	it("forwards review accept actions with the expected projection revision", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue({
			...memoryPayload,
			projectionRevision: 8,
			review: {
				visibleItems: [],
				openCount: 0,
				overflowCount: 0,
			},
		});

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				target: "review_item",
				action: "accept",
				itemId: "review-1",
				expectedProjectionRevision: 7,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.projectionRevision).toBe(8);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				target: "review_item",
				action: "accept",
				itemId: "review-1",
				expectedProjectionRevision: 7,
			},
		);
	});

	it("forwards review suppress actions as dismiss decisions with the expected projection revision", async () => {
		mockApplyKnowledgeMemoryAction.mockResolvedValue({
			...memoryPayload,
			projectionRevision: 8,
			review: {
				visibleItems: [],
				openCount: 0,
				overflowCount: 0,
			},
		});

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				target: "review_item",
				action: "suppress",
				itemId: "review-1",
				expectedProjectionRevision: 7,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.projectionRevision).toBe(8);
		expect(mockApplyKnowledgeMemoryAction).toHaveBeenCalledWith(
			"user-1",
			"Test User",
			{
				target: "review_item",
				action: "suppress",
				itemId: "review-1",
				expectedProjectionRevision: 7,
			},
		);
	});

	it("rejects profile actions without the current projection revision", async () => {
		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "delete",
				itemId: "item-about",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid memory action payload/i);
		expect(mockApplyKnowledgeMemoryAction).not.toHaveBeenCalled();
	});

	it("rejects unknown memory action targets", async () => {
		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				target: "unknown_item",
				action: "delete",
				itemId: "item-about",
				expectedProjectionRevision: 7,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid memory action payload/i);
		expect(mockApplyKnowledgeMemoryAction).not.toHaveBeenCalled();
	});

	it("returns conflict when a profile action uses a stale projection revision", async () => {
		mockApplyKnowledgeMemoryAction.mockRejectedValue(
			new MemoryProfileActionError(
				"stale_projection",
				"Memory profile changed before this action was applied.",
				409,
			),
		);

		const response = await POST_MEMORY_ACTION(
			makePostEvent({
				action: "edit",
				itemId: "item-about",
				statement: "Lives in Rotterdam.",
				expectedProjectionRevision: 6,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.code).toBe("stale_projection");
	});
});
