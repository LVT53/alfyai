import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	restoreVersion: vi.fn(),
}));

import { restoreVersion } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockRestoreVersion = restoreVersion as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "artifact-1",
	versionId = "version-1",
	userId: string | null = "owner-user",
	conversationId: string | null = null,
) {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id, versionId },
		url: new URL(
			`http://localhost/api/artifacts/${id}/versions/${versionId}/restore${query}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("POST /api/artifacts/[id]/versions/[versionId]/restore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user", async () => {
		await expect(
			POST(makeEvent("artifact-1", "v1", null)),
		).rejects.toMatchObject({ status: 401 });
		expect(mockRestoreVersion).not.toHaveBeenCalled();
	});

	it("restores and answers ok: true with the new version NUMBER", async () => {
		mockRestoreVersion.mockResolvedValue({
			ok: true,
			versionId: "version-new",
			versionNumber: 4,
		});

		const response = await POST(
			makeEvent("artifact-1", "version-1", "owner-user", "conv-1"),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, version: 4 });
		expect(mockRestoreVersion).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			versionId: "version-1",
			conversationId: "conv-1",
		});
	});

	it("answers 404 not_found for a missing version or artifact", async () => {
		mockRestoreVersion.mockResolvedValue({ ok: false, reason: "not_found" });

		const response = await POST(makeEvent());

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("answers 400 for a version with no body", async () => {
		mockRestoreVersion.mockResolvedValue({ ok: false, reason: "no_body" });

		const response = await POST(makeEvent());

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "no_body",
		});
	});
});
