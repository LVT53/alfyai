import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
	getVersionBody: vi.fn(),
}));

import { getArtifact, getVersionBody } from "$lib/server/services/artifacts";
import { GET } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockGetVersionBody = getVersionBody as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "artifact-1",
	versionId = "version-1",
	userId: string | null = "owner-user",
) {
	return {
		params: { id, versionId },
		url: new URL(`http://localhost/api/artifacts/${id}/versions/${versionId}`),
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

describe("GET /api/artifacts/[id]/versions/[versionId]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(
			GET(makeEvent("artifact-1", "v1", null)),
		).rejects.toMatchObject({ status: 401 });
	});

	it("answers not_found when the artifact itself is out of scope", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
		expect(mockGetVersionBody).not.toHaveBeenCalled();
	});

	it("answers not_found for a version of another artifact or another user", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockGetVersionBody.mockResolvedValue(null);

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("returns the stored body, ok: true", async () => {
		mockGetArtifact.mockResolvedValue(artifactFixture);
		mockGetVersionBody.mockResolvedValue("# Weekend\n\nOld text.");

		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			body: "# Weekend\n\nOld text.",
		});
	});
});
