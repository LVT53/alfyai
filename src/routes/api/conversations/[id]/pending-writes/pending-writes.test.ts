import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/connections/pending-writes", () => ({
	listPendingWritesForConversation: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { getConversation } from "$lib/server/services/conversations";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockList = listPendingWritesForConversation as ReturnType<typeof vi.fn>;

type PendingWritesEvent = Parameters<typeof GET>[0];

function makeEvent(
	user = { id: "user-1" },
	conversationId = "conv-1",
): PendingWritesEvent {
	return {
		request: new Request(
			`http://localhost/api/conversations/${conversationId}/pending-writes`,
		),
		locals: { user },
		params: { id: conversationId },
		url: new URL(
			`http://localhost/api/conversations/${conversationId}/pending-writes`,
		),
		route: { id: "/api/conversations/[id]/pending-writes" },
	} as PendingWritesEvent;
}

const PREVIEW = {
	title: "Save note.txt",
	detail: "files.put — /AlfyAI/note.txt",
	reversible: true,
	destructive: false,
	withinAllowlist: true,
	warnings: [],
};

describe("GET /api/conversations/[id]/pending-writes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
	});

	it("returns 404 when the conversation doesn't belong to the caller", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await GET(makeEvent());
		expect(response.status).toBe(404);
		expect(mockList).not.toHaveBeenCalled();
	});

	it("returns the safe projection: id/assistantMessageId/status/preview/provider/createdAt — no secrets", async () => {
		mockList.mockResolvedValue([
			{
				id: "pw-1",
				userId: "user-1",
				connectionId: "conn-1",
				provider: "nextcloud",
				op: { provider: "nextcloud", connectionId: "conn-1" },
				content: "raw file content that must never reach the client",
				idempotencyKey: "key-1",
				status: "pending",
				preview: PREVIEW,
				etag: null,
				conversationId: "conv-1",
				assistantMessageId: null,
				createdAt: 1700000000,
			},
		]);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.pendingWrites).toEqual([
			{
				id: "pw-1",
				assistantMessageId: null,
				conversationId: "conv-1",
				status: "pending",
				preview: PREVIEW,
				provider: "nextcloud",
				// Converted from PendingWriteRecord's UNIX-seconds createdAt to
				// epoch ms, matching every other client-facing timestamp.
				createdAt: 1700000000_000,
			},
		]);
		// The raw op/content/idempotencyKey never leak into the response.
		const raw = JSON.stringify(data);
		expect(raw).not.toContain("raw file content");
		expect(raw).not.toContain("idempotencyKey");
	});

	it("calls listPendingWritesForConversation scoped to the caller and this conversation", async () => {
		mockList.mockResolvedValue([]);

		await GET(makeEvent({ id: "user-42" }, "conv-99"));

		expect(mockList).toHaveBeenCalledWith("user-42", "conv-99");
	});
});
