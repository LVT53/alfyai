import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	resolveComment: vi.fn(),
}));

import { resolveComment } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockResolveComment = resolveComment as ReturnType<typeof vi.fn>;

function makeEvent(params: {
	id?: string;
	commentId?: string;
	userId?: string | null;
	body?: unknown;
	conversationId?: string | null;
}) {
	const {
		id = "artifact-1",
		commentId = "comment-1",
		userId = "owner-user",
		body = { resolved: true },
		conversationId = null,
	} = params;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id, commentId },
		url: new URL(
			`http://localhost/api/artifacts/${id}/comments/${commentId}/resolve${query}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { json: async () => body },
	} as never;
}

describe("POST /api/artifacts/[id]/comments/[commentId]/resolve", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockResolveComment).not.toHaveBeenCalled();
	});

	it("resolves and answers ok: true", async () => {
		mockResolveComment.mockResolvedValue(true);

		const response = await POST(
			makeEvent({ conversationId: "conv-1", body: { resolved: true } }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(mockResolveComment).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			commentId: "comment-1",
			conversationId: "conv-1",
			resolved: true,
		});
	});

	it("un-resolves when resolved: false is sent", async () => {
		mockResolveComment.mockResolvedValue(true);

		await POST(makeEvent({ body: { resolved: false } }));

		expect(mockResolveComment).toHaveBeenCalledWith(
			expect.objectContaining({ resolved: false }),
		);
	});

	it("404s, never confirming existence, for a foreign or missing comment", async () => {
		mockResolveComment.mockResolvedValue(false);

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});
