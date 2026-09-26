import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	runAlfyCommentReply: vi.fn(),
}));

import { runAlfyCommentReply } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockRunAlfyCommentReply = runAlfyCommentReply as ReturnType<typeof vi.fn>;

function makeEvent(params: {
	id?: string;
	commentId?: string;
	userId?: string | null;
	conversationId?: string | null;
	signal?: AbortSignal;
}) {
	const {
		id = "artifact-1",
		commentId = "comment-1",
		userId = "owner-user",
		conversationId = null,
		signal = new AbortController().signal,
	} = params;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id, commentId },
		url: new URL(
			`http://localhost/api/artifacts/${id}/comments/${commentId}/alfy${query}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { signal },
	} as never;
}

const replyFixture = {
	id: "comment-2",
	artifactId: "artifact-1",
	parentId: "comment-1",
	anchor: null,
	author: "alfy" as const,
	body: "Changed it.",
	status: "open" as const,
	createdAt: 2,
	replies: [],
};

describe("POST /api/artifacts/[id]/comments/[commentId]/alfy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockRunAlfyCommentReply).not.toHaveBeenCalled();
	});

	it("runs the hook and answers ok: true with the outcome shape", async () => {
		mockRunAlfyCommentReply.mockResolvedValue({
			ok: true,
			value: {
				outcome: "applied",
				applied: 1,
				refused: 0,
				version: 3,
				reply: replyFixture,
			},
		});

		const response = await POST(
			makeEvent({ conversationId: "conv-1", userId: "owner-user" }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			outcome: "applied",
			applied: 1,
			refused: 0,
			version: 3,
			reply: replyFixture,
		});
		expect(mockRunAlfyCommentReply).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner-user",
				artifactId: "artifact-1",
				commentId: "comment-1",
				conversationId: "conv-1",
			}),
		);
		// The route's own signal (the request's own, tied to a server timeout)
		// must reach the hook so it can stop mid-call and write nothing.
		expect(mockRunAlfyCommentReply.mock.calls[0][0].abortSignal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it("404s for a missing artifact or comment", async () => {
		mockRunAlfyCommentReply.mockResolvedValue({
			ok: false,
			reason: "not_found",
		});

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("404s a non-document artifact as not_a_document", async () => {
		mockRunAlfyCommentReply.mockResolvedValue({
			ok: false,
			reason: "not_a_document",
		});

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_a_document",
		});
	});

	it("answers 504 when the call was aborted, writing nothing new", async () => {
		mockRunAlfyCommentReply.mockResolvedValue({
			ok: false,
			reason: "aborted",
		});

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(504);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "aborted",
		});
	});
});
