import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
	listComments: vi.fn(),
	listVersions: vi.fn(),
}));

import {
	getArtifact,
	listComments,
	listVersions,
} from "$lib/server/services/artifacts";
import { GET } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockListVersions = listVersions as ReturnType<typeof vi.fn>;
const mockListComments = listComments as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "artifact-1",
	userId: string | null = "owner-user",
	conversationId: string | null = null,
) {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

const artifactFixture = {
	id: "artifact-1",
	kind: "document" as const,
	title: "Weekend checklist",
	conversationId: "conv-1",
	versionNumber: 1,
	commentCount: 0,
	updatedAt: 1,
	body: "# Weekend",
	bodyHash: "hash",
	metadata: { artifactType: "document", title: "Weekend checklist" },
};

describe("GET /api/artifacts/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user (requireApiUser, ruling 39)", async () => {
		await expect(GET(makeEvent("artifact-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockGetArtifact).not.toHaveBeenCalled();
	});

	it("answers the family's not_found shape for another user's artifact, never a 403", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await GET(makeEvent("artifact-1", "owner-user"));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(mockGetArtifact).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: null,
		});
	});

	it("returns the artifact, its versions and its comments for the owner", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockListVersions.mockResolvedValue([
			{
				id: "version-1",
				versionNumber: 1,
				author: "user",
				summary: "First draft",
				createdAt: 1,
			},
		]);
		mockListComments.mockResolvedValue([]);

		const response = await GET(makeEvent("artifact-1", "owner-user"));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.artifact).toEqual(artifactFixture);
		expect(body.versions).toHaveLength(1);
		expect(body.comments).toEqual([]);
	});

	it("forwards ?conversationId= to all three reads, so an incognito chat can widen its own scope", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockListVersions.mockResolvedValue([]);
		mockListComments.mockResolvedValue([]);

		await GET(makeEvent("artifact-1", "owner-user", "conv-incognito"));

		expect(mockGetArtifact).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: "conv-incognito",
		});
		expect(mockListVersions).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: "conv-incognito",
		});
		expect(mockListComments).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: "conv-incognito",
		});
	});
});
