import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	verifyServiceAssertion: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		query: {
			conversations: {
				findFirst: vi.fn(),
			},
		},
	},
}));

vi.mock("$lib/server/services/memory-context", () => ({
	getMemoryContext: vi.fn(),
}));

import { verifyServiceAssertion } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { getMemoryContext } from "$lib/server/services/memory-context";
import { POST } from "./+server";

const mockVerifyServiceAssertion = verifyServiceAssertion as ReturnType<
	typeof vi.fn
>;
const mockFindConversation = db.query.conversations.findFirst as ReturnType<
	typeof vi.fn
>;
const mockGetMemoryContext = getMemoryContext as ReturnType<typeof vi.fn>;

type MemoryContextEvent = Parameters<typeof POST>[0];

function makeEvent(
	body: unknown,
	user: { id: string; email?: string; displayName?: string } | null = {
		id: "user-1",
		email: "test@example.com",
	},
	authorization?: string,
) {
	return {
		request: new Request("http://localhost/api/tools/memory-context", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/tools/memory-context"),
		route: { id: "/api/tools/memory-context" },
	} as unknown as MemoryContextEvent;
}

describe("POST /api/tools/memory-context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindConversation.mockResolvedValue({ id: "conv-1", userId: "user-1" });
		mockVerifyServiceAssertion.mockReturnValue({
			valid: true,
			claims: {
				conversationId: "conv-1",
				userId: "user-1",
				audience: "memory_context",
				exp: Date.now() + 60_000,
			},
		});
		mockGetMemoryContext.mockResolvedValue({
			success: true,
			mode: "project",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Plan",
				authority: "project_folder",
			},
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-1",
				scope: "conversation",
				requestedMaxSiblings: null,
				appliedMaxSiblings: 5,
				includeEvidenceCandidates: true,
			},
		});
	});

	it("returns project memory context for an authenticated conversation-scoped request", async () => {
		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				mode: "project",
				query: "pricing",
				maxSiblings: 3,
				includeEvidenceCandidates: false,
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.mode).toBe("project");
		expect(body.project.name).toBe("Launch Plan");
		expect(mockGetMemoryContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "project",
			query: "pricing",
			userDisplayName: undefined,
			maxSiblings: 3,
			siblingConversationId: null,
			maxMessages: undefined,
			maxHistoryConversations: undefined,
			historyConversationId: null,
			selectedConversationId: null,
			includeEvidenceCandidates: false,
		});
	});

	it("defaults omitted mode to persona memory", async () => {
		mockGetMemoryContext.mockResolvedValueOnce({
			success: true,
			mode: "persona",
			status: "available",
			source: "honcho_peer_chat",
			content: "The user prefers concise answers.",
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-1",
				query: "What should I remember?",
			},
		});

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				query: "What should I remember?",
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.mode).toBe("persona");
		expect(mockGetMemoryContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "persona",
				query: "What should I remember?",
			}),
		);
	});

	it("accepts a valid signed service assertion scoped to the same conversation", async () => {
		const response = await POST(
			makeEvent(
				{ conversationId: "conv-1", mode: "project" },
				null,
				"Bearer signed",
			),
		);

		expect(response.status).toBe(200);
		expect(mockVerifyServiceAssertion).toHaveBeenCalledWith("Bearer signed", {
			expectedAudience: "memory_context",
		});
		expect(mockGetMemoryContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "project",
			}),
		);
	});

	it("forwards persona mode fields for an authenticated request", async () => {
		mockGetMemoryContext.mockResolvedValueOnce({
			success: true,
			mode: "persona",
			status: "available",
			source: "honcho_peer_chat",
			content: "The user prefers concise answers.",
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-1",
				query: "What user preferences matter?",
			},
		});

		const response = await POST(
			makeEvent(
				{
					conversationId: "conv-1",
					mode: "persona",
					query: "What user preferences matter?",
					includeEvidenceCandidates: true,
				},
				{
					id: "user-1",
					email: "test@example.com",
					displayName: "Test User",
				},
			),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.mode).toBe("persona");
		expect(mockGetMemoryContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "persona",
			query: "What user preferences matter?",
			userDisplayName: "Test User",
			maxSiblings: undefined,
			siblingConversationId: null,
			maxMessages: undefined,
			maxHistoryConversations: undefined,
			historyConversationId: null,
			selectedConversationId: null,
			includeEvidenceCandidates: true,
		});
	});

	it("forwards history mode fields for a signed conversation-scoped request", async () => {
		mockGetMemoryContext.mockResolvedValueOnce({
			success: true,
			mode: "history",
			status: "available",
			source: "conversation_summaries",
			query: "cycling",
			conversations: [],
			omittedConversationCount: 0,
			selectedConversation: null,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-1",
				query: "cycling",
				requestedMaxHistoryConversations: 4,
				appliedMaxHistoryConversations: 4,
				historyConversationId: "conv-old",
				requestedMaxMessages: 12,
				appliedMaxMessages: 12,
			},
		});

		const response = await POST(
			makeEvent(
				{
					conversationId: "conv-1",
					mode: "history",
					query: "cycling",
					maxHistoryConversations: 4,
					historyConversationId: "conv-old",
					selectedConversationId: "conv-alias",
					maxMessages: 12,
					includeEvidenceCandidates: false,
				},
				null,
				"Bearer signed",
			),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.mode).toBe("history");
		expect(mockVerifyServiceAssertion).toHaveBeenCalledWith("Bearer signed", {
			expectedAudience: "memory_context",
		});
		expect(mockGetMemoryContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "history",
			query: "cycling",
			userDisplayName: undefined,
			maxSiblings: undefined,
			siblingConversationId: null,
			maxMessages: 12,
			maxHistoryConversations: 4,
			historyConversationId: "conv-old",
			selectedConversationId: "conv-alias",
			includeEvidenceCandidates: false,
		});
	});

	it("rejects service assertions for a different conversation", async () => {
		mockVerifyServiceAssertion.mockReturnValueOnce({
			valid: true,
			claims: {
				conversationId: "conv-other",
				userId: "user-1",
				exp: Date.now() + 60_000,
			},
		});

		const response = await POST(
			makeEvent(
				{ conversationId: "conv-1", mode: "project" },
				null,
				"Bearer wrong-conv",
			),
		);

		expect(response.status).toBe(401);
		expect(mockGetMemoryContext).not.toHaveBeenCalled();
	});

	it("rejects signed service assertions without the memory_context audience", async () => {
		mockVerifyServiceAssertion.mockReturnValueOnce({
			valid: false,
			reason: "missing_audience",
		});

		const response = await POST(
			makeEvent(
				{ conversationId: "conv-1", mode: "project" },
				null,
				"Bearer legacy",
			),
		);

		expect(response.status).toBe(401);
		expect(mockVerifyServiceAssertion).toHaveBeenCalledWith("Bearer legacy", {
			expectedAudience: "memory_context",
		});
		expect(mockGetMemoryContext).not.toHaveBeenCalled();
	});

	it("returns a clear client error for unsupported memory modes", async () => {
		mockGetMemoryContext.mockRejectedValueOnce(
			new Error("Unsupported memory_context mode: persona"),
		);

		const response = await POST(
			makeEvent({ conversationId: "conv-1", mode: "persona" }),
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toBe("Unsupported memory_context mode: persona");
	});

	it("returns project mode validation with memory_context wording", async () => {
		mockGetMemoryContext.mockRejectedValueOnce(
			new Error("siblingConversationId is outside memory_context scope"),
		);

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				mode: "project",
				siblingConversationId: "conv-outside",
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toBe(
			"siblingConversationId is outside memory_context scope",
		);
	});

	it("returns a clear client error for history conversations outside memory scope", async () => {
		mockGetMemoryContext.mockRejectedValueOnce(
			new Error(
				"historyConversationId is outside memory_context history scope",
			),
		);

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				mode: "history",
				historyConversationId: "conv-outside",
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toBe(
			"historyConversationId is outside memory_context history scope",
		);
	});
});
