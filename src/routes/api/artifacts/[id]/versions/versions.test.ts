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
	search = "",
) {
	const params = new URLSearchParams(search);
	if (conversationId) params.set("conversationId", conversationId);
	const query = params.size > 0 ? `?${params.toString()}` : "";
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

	it("pages with before and limit (ruling 47: history is paged)", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockListVersions.mockResolvedValue([]);

		await GET(makeEvent("artifact-1", "owner-user", null, "before=7&limit=3"));

		expect(mockListVersions).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			conversationId: null,
			before: 7,
			limit: 3,
		});
	});

	it("answers 400 for a malformed before or limit, looking nothing up", async () => {
		for (const search of ["before=x", "before=0", "limit=-1", "limit=1.5"]) {
			const response = await GET(
				makeEvent("artifact-1", "owner-user", null, search),
			);
			expect(response.status, search).toBe(400);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "invalid_request",
			});
		}
		expect(mockGetArtifact).not.toHaveBeenCalled();
		expect(mockListVersions).not.toHaveBeenCalled();
	});
});
