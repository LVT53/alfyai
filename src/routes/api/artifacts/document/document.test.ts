import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	createDocumentArtifact: vi.fn(),
}));

import { createDocumentArtifact } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockCreate = createDocumentArtifact as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, userId: string | null = "owner-user") {
	return {
		request: { json: async () => body },
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("POST /api/artifacts/document", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user (requireApiUser, ruling 39)", async () => {
		await expect(
			POST(makeEvent({ title: "Trip" }, null)),
		).rejects.toMatchObject({ status: 401 });
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("answers 400 invalid_patch when the title is missing or blank", async () => {
		const response = await POST(makeEvent({ title: "   " }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "invalid_patch",
		});
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("creates a document from the editor's markdown, with conversationId null when the artifact had none", async () => {
		mockCreate.mockResolvedValue({
			id: "artifact-new",
			userId: "owner-user",
			conversationId: null,
			kind: "document",
			title: "Trip",
			body: "<!--b:p1-->\nHello",
			bodyHash: "h1",
			metadata: { artifactType: "document", title: "Trip" },
			versionNumber: 1,
			createdAt: 1,
			updatedAt: 1,
		});

		const response = await POST(
			makeEvent({ title: "Trip", markdown: "<!--b:p1-->\nHello" }),
		);

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.ok).toBe(true);
		expect(payload.artifact.id).toBe("artifact-new");
		expect(mockCreate).toHaveBeenCalledWith({
			userId: "owner-user",
			conversationId: null,
			title: "Trip",
			markdown: "<!--b:p1-->\nHello",
			author: "user",
			summary: "Saved as a new document",
		});
	});

	it("passes the conversationId through when the deleted artifact had one", async () => {
		mockCreate.mockResolvedValue({
			id: "artifact-new",
			userId: "owner-user",
			conversationId: "conv-1",
			kind: "document",
			title: "Trip",
			body: "",
			bodyHash: "h",
			metadata: { artifactType: "document", title: "Trip" },
			versionNumber: 1,
			createdAt: 1,
			updatedAt: 1,
		});

		await POST(makeEvent({ title: "Trip", conversationId: "conv-1" }));

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: "conv-1" }),
		);
	});
});
