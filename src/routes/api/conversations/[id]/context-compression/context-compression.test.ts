import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sendJsonControlMessage: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/context-compression", () => ({
	getLatestValidContextCompressionSnapshot: vi.fn(),
	listContextCompressionSourceMessages: vi.fn(),
	runContextCompression: vi.fn(),
	serializeContextCompressionSnapshot: vi.fn((snapshot) => ({
		id: snapshot.id,
		trigger: snapshot.trigger,
		status: snapshot.status,
		sourceEndMessageId: snapshot.sourceEndMessageId,
		createdAt: snapshot.createdAt.getTime(),
		updatedAt: snapshot.updatedAt.getTime(),
	})),
}));

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	getOrphanedStream: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: mocks.sendJsonControlMessage,
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getOrphanedStream } from "$lib/server/services/chat-turn/active-streams";
import {
	getLatestValidContextCompressionSnapshot,
	listContextCompressionSourceMessages,
	runContextCompression,
} from "$lib/server/services/context-compression";
import { getConversation } from "$lib/server/services/conversations";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetOrphanedStream = getOrphanedStream as ReturnType<typeof vi.fn>;
const mockGetLatestSnapshot =
	getLatestValidContextCompressionSnapshot as ReturnType<typeof vi.fn>;
const mockListSourceMessages =
	listContextCompressionSourceMessages as ReturnType<typeof vi.fn>;
const mockRunContextCompression = runContextCompression as ReturnType<
	typeof vi.fn
>;

function makeEvent(body: unknown, user = { id: "user-1" }, id = "conv-1") {
	return {
		request: new Request(
			`http://localhost/api/conversations/${id}/context-compression`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		),
		locals: { user },
		params: { id },
		url: new URL(
			`http://localhost/api/conversations/${id}/context-compression`,
		),
		route: { id: "/api/conversations/[id]/context-compression" },
	} as Parameters<typeof POST>[0];
}

describe("POST /api/conversations/[id]/context-compression", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1", userId: "user-1" });
		mockGetOrphanedStream.mockReturnValue(null);
		mockGetLatestSnapshot.mockResolvedValue(null);
		mockListSourceMessages.mockResolvedValue([
			{
				id: "message-1",
				role: "user",
				content: "Question",
				messageSequence: 1,
			},
			{
				id: "message-2",
				role: "assistant",
				content: "Answer",
				messageSequence: 2,
			},
		]);
		mockRunContextCompression.mockResolvedValue({
			id: "snapshot-1",
			trigger: "manual",
			status: "valid",
			modelId: "model2",
			sourceEndMessageId: "message-2",
			createdAt: new Date("2026-05-25T10:00:00.000Z"),
			updatedAt: new Date("2026-05-25T10:00:02.000Z"),
		});
	});

	it("runs manual context compression with the selected response model", async () => {
		const response = await POST(
			makeEvent({ selectedModelId: "model2", trigger: "manual" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetConversation).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockListSourceMessages).toHaveBeenCalledWith("conv-1");
		expect(mockRunContextCompression).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				userId: "user-1",
				trigger: "manual",
				selectedModelId: "model2",
				controlMessageSender: expect.any(Function),
				sourceMessages: [
					{
						id: "message-1",
						role: "user",
						content: "Question",
						messageSequence: 1,
					},
					{
						id: "message-2",
						role: "assistant",
						content: "Answer",
						messageSequence: 2,
					},
				],
				priorSnapshot: null,
			}),
		);
		expect(
			mockRunContextCompression.mock.calls[0]?.[0].controlMessageSender,
		).toBe(mocks.sendJsonControlMessage);
		expect(data.snapshot).toEqual({
			id: "snapshot-1",
			trigger: "manual",
			status: "valid",
			sourceEndMessageId: "message-2",
			createdAt: Date.parse("2026-05-25T10:00:00.000Z"),
			updatedAt: Date.parse("2026-05-25T10:00:02.000Z"),
		});
	});
});
