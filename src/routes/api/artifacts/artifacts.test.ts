import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	listArtifactsForConversation: vi.fn(),
}));
vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

import { listArtifactsForConversation } from "$lib/server/services/artifacts";
import { getConversation } from "$lib/server/services/conversations";
import { GET } from "./+server";

const mockListArtifacts = listArtifactsForConversation as ReturnType<
	typeof vi.fn
>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;

function makeEvent(
	conversationId: string | null,
	userId: string | null = "owner-user",
) {
	const url = new URL(
		conversationId
			? `http://localhost/api/artifacts?conversationId=${conversationId}`
			: "http://localhost/api/artifacts",
	);
	return {
		url,
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("GET /api/artifacts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user (requireApiUser, ruling 39)", async () => {
		await expect(GET(makeEvent("conv-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockGetConversation).not.toHaveBeenCalled();
	});

	it("answers not_found for a conversation that is not the caller's", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await GET(makeEvent("conv-1"));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(mockListArtifacts).not.toHaveBeenCalled();
	});

	it("answers not_found when no conversationId is given", async () => {
		const response = await GET(makeEvent(null));

		expect(response.status).toBe(404);
		expect(mockGetConversation).not.toHaveBeenCalled();
	});

	it("returns the conversation's artifacts, newest first, for the owner", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			userId: "owner-user",
		});
		mockListArtifacts.mockResolvedValue([
			{
				id: "artifact-2",
				kind: "document",
				title: "Newer",
				conversationId: "conv-1",
				versionNumber: 1,
				commentCount: 0,
				updatedAt: 2,
			},
			{
				id: "artifact-1",
				kind: "file",
				title: "Older",
				conversationId: "conv-1",
				versionNumber: 0,
				commentCount: 0,
				updatedAt: 1,
			},
		]);

		const response = await GET(makeEvent("conv-1"));

		expect(response.status).toBe(200);
		const body = await response.json();
		// Ruling 49: every artifact route answers { ok: true, … } on success.
		expect(body.ok).toBe(true);
		expect(body.artifacts).toHaveLength(2);
		expect(body.artifacts[0].id).toBe("artifact-2");
		expect(mockListArtifacts).toHaveBeenCalledWith({
			userId: "owner-user",
			conversationId: "conv-1",
		});
	});
});
