import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	createComment: vi.fn(),
	getArtifact: vi.fn(),
}));

import { createComment, getArtifact } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockCreateComment = createComment as ReturnType<typeof vi.fn>;
const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;

const artifactFixture = {
	id: "artifact-1",
	kind: "document" as const,
	title: "Trip notes",
	conversationId: "conv-1",
	versionNumber: 1,
	commentCount: 0,
	updatedAt: 1,
	body: "Book the flight.",
	bodyHash: "hash",
	metadata: { artifactType: "document", title: "Trip notes" },
};

const TEXT_ANCHOR = {
	kind: "text",
	blockId: "p1",
	quote: "flight",
	prefix: "Book the ",
	suffix: ".",
};

function makeEvent(params: {
	id?: string;
	userId?: string | null;
	body?: unknown;
	conversationId?: string | null;
}) {
	const {
		id = "artifact-1",
		userId = "owner-user",
		body = { anchor: TEXT_ANCHOR, body: "Too early?" },
		conversationId = null,
	} = params;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/comments${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { json: async () => body },
	} as never;
}

describe("POST /api/artifacts/[id]/comments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockCreateComment).not.toHaveBeenCalled();
	});

	it("answers not_found for a foreign or missing artifact, never calling createComment", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(mockCreateComment).not.toHaveBeenCalled();
	});

	it("creates the comment and answers ok: true (ruling 49)", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		const created = {
			id: "comment-1",
			artifactId: "artifact-1",
			parentId: null,
			anchor: TEXT_ANCHOR,
			author: "user",
			body: "Too early?",
			status: "open",
			createdAt: 1,
			replies: [],
		};
		mockCreateComment.mockResolvedValue(created);

		const response = await POST(
			makeEvent({ conversationId: "conv-1", userId: "owner-user" }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			comment: created,
		});
	});

	// T10.7: a client cannot author a comment as "alfy" — the route hardcodes
	// the human path's author regardless of anything the request body carries.
	it("ignores a client-supplied author field and always writes 'user'", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockCreateComment.mockResolvedValue({
			id: "comment-1",
			artifactId: "artifact-1",
			parentId: null,
			anchor: TEXT_ANCHOR,
			author: "user",
			body: "Too early?",
			status: "open",
			createdAt: 1,
			replies: [],
		});

		await POST(
			makeEvent({
				body: {
					anchor: TEXT_ANCHOR,
					body: "Too early?",
					author: "alfy",
				},
			}),
		);

		expect(mockCreateComment).toHaveBeenCalledWith(
			expect.objectContaining({ author: "user" }),
		);
	});

	it("answers invalid_request for a missing body or refused anchor, without a 500", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockCreateComment.mockResolvedValue(null);

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "invalid_request",
		});
	});

	it("400s a request with no body text at all before even reaching the service", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);

		const response = await POST(
			makeEvent({ body: { anchor: TEXT_ANCHOR, body: "" } }),
		);

		expect(response.status).toBe(400);
		expect(mockCreateComment).not.toHaveBeenCalled();
	});
});
