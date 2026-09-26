import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
	listVersions: vi.fn(),
}));

import { getArtifact, listVersions } from "$lib/server/services/artifacts";
import { GET } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockListVersions = listVersions as ReturnType<typeof vi.fn>;

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
		url: new URL(`http://localhost/api/artifacts/${id}/versions${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

const artifactFixture = {
	id: "artifact-1",
	kind: "document" as const,
	title: "Weekend checklist",
	conversationId: "conv-1",
	versionNumber: 2,
	commentCount: 0,
	updatedAt: 1,
	body: "# Weekend",
	bodyHash: "hash",
	metadata: { artifactType: "document", title: "Weekend checklist" },
};

describe("GET /api/artifacts/[id]/versions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user (ruling 39)", async () => {
		await expect(GET(makeEvent("artifact-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockListVersions).not.toHaveBeenCalled();
	});

	it("answers not_found, never confirming existence, when the artifact is out of scope", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(mockListVersions).not.toHaveBeenCalled();
	});

	it("returns the version list, ok: true (ruling 49)", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		const versions = [
			{
				id: "v2",
				versionNumber: 2,
				author: "user",
				summary: "Edit",
				createdAt: 2,
			},
			{
				id: "v1",
				versionNumber: 1,
				author: "alfy",
				summary: "First draft",
				createdAt: 1,
			},
		];
		mockListVersions.mockResolvedValue(versions);

		const response = await GET(makeEvent("artifact-1", "owner-user", "conv-1"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, versions });
		expect(mockListVersions).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: "conv-1",
		});
	});
});
