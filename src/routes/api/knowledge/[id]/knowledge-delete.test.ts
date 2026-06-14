import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	deleteArtifactForUser: vi.fn(),
	getArtifactForUser: vi.fn(),
	listArtifactLinksForUser: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { deleteArtifactForUser } from "$lib/server/services/knowledge";
import { DELETE } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDeleteArtifactForUser = deleteArtifactForUser as ReturnType<
	typeof vi.fn
>;
type KnowledgeDeleteEvent = Parameters<typeof DELETE>[0];

function makeEvent(id = "artifact-1"): KnowledgeDeleteEvent {
	return {
		request: new Request(`http://localhost/api/knowledge/${id}`, {
			method: "DELETE",
		}),
		locals: { user: { id: "user-1", email: "test@example.com" } },
		params: { id },
		url: new URL(`http://localhost/api/knowledge/${id}`),
		route: { id: "/api/knowledge/[id]" },
	} as KnowledgeDeleteEvent;
}

describe("DELETE /api/knowledge/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns a success payload with a message when deletion succeeds", async () => {
		mockDeleteArtifactForUser.mockResolvedValue({
			deletedArtifactIds: ["artifact-1", "artifact-2"],
			deletedStoragePaths: ["data/knowledge/user-1/file.pdf"],
			failedStoragePaths: [],
		});

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["artifact-1", "artifact-2"]);
		expect(data.message).toMatch(/removed from the knowledge base/i);
	});

	it("treats a missing artifact as a handled no-op success", async () => {
		mockDeleteArtifactForUser.mockResolvedValue(null);

		const response = await DELETE(makeEvent("missing-artifact"));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["missing-artifact"]);
		expect(data.message).toMatch(/already removed/i);
	});

	it("returns a structured 500 error payload when deletion throws", async () => {
		mockDeleteArtifactForUser.mockRejectedValue(new Error("disk failure"));

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.success).toBe(false);
		expect(data.error).toMatch(/failed to remove item/i);
		expect(data.message).toMatch(/failed to remove item/i);
	});
});
