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

	// This used to answer 200 "already removed" with a fabricated
	// `deletedArtifactIds: [id]`. For an unknown id that was merely untrue; for a
	// `generated_output` whose conversation had been deleted it was the bug that
	// hid the leak — the row was still on disk and the caller was told it was
	// gone, so nothing ever removed it.
	it("404s when the artifact does not exist", async () => {
		mockDeleteArtifactForUser.mockResolvedValue(null);

		const response = await DELETE(makeEvent("missing-artifact"));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.success).toBeUndefined();
		expect(data.deletedArtifactIds).toBeUndefined();
		expect(data.error).toMatch(/not found/i);
	});

	it("404s, indistinguishably, when the row exists but is not the caller's", async () => {
		mockDeleteArtifactForUser.mockResolvedValue(null);
		const unknown = await DELETE(makeEvent("missing-artifact"));

		// The store answers `null` for both, and the wire must not tell them
		// apart: a different body would turn DELETE into an id oracle.
		mockDeleteArtifactForUser.mockResolvedValue(null);
		const foreign = await DELETE(makeEvent("someone-elses-artifact"));

		expect(foreign.status).toBe(unknown.status);
		expect(await foreign.json()).toEqual(await unknown.json());
	});

	// The quieter of the two "nothing happened" shapes: a non-null result whose
	// id list is empty. A 200 here would report a deletion that did not occur.
	it("404s when the store deleted nothing at all", async () => {
		mockDeleteArtifactForUser.mockResolvedValue({
			deletedArtifactIds: [],
			deletedStoragePaths: [],
			failedStoragePaths: [],
		});

		const response = await DELETE(makeEvent("out-of-scope"));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toMatch(/not found/i);
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
