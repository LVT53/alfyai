import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
	saveDocumentBody: vi.fn(),
	updateArtifactBody: vi.fn(),
	documentTabsFromMetadata: vi.fn(() => []),
}));

import {
	documentTabsFromMetadata,
	getArtifact,
	saveDocumentBody,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import { PATCH } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;
const mockSaveDocumentBody = saveDocumentBody as ReturnType<typeof vi.fn>;
const mockUpdateArtifactBody = updateArtifactBody as ReturnType<typeof vi.fn>;
const mockDocumentTabs = documentTabsFromMetadata as ReturnType<typeof vi.fn>;

function makeEvent(params: {
	id?: string;
	userId?: string | null;
	body?: unknown;
	conversationId?: string | null;
}) {
	const {
		id = "artifact-1",
		userId = "owner-user",
		body = { body: "New text.", expectVersion: 2 },
		conversationId = null,
	} = params;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/body${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: { json: async () => body },
	} as never;
}

const documentFixture = {
	id: "artifact-1",
	kind: "document" as const,
	title: "Weekend checklist",
	conversationId: "conv-1",
	versionNumber: 2,
	commentCount: 0,
	updatedAt: 1,
	body: "# Weekend",
	bodyHash: "hash",
	metadata: { artifactType: "document", title: "Weekend checklist", tabs: [] },
};

describe("PATCH /api/artifacts/[id]/body", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDocumentTabs.mockReturnValue([]);
	});

	it("throws 401 with no authenticated user (ruling 39)", async () => {
		await expect(PATCH(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockGetArtifact).not.toHaveBeenCalled();
	});

	it("answers 400 invalid_patch for a non-string body", async () => {
		const response = await PATCH(makeEvent({ body: { body: 42 } }));
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "invalid_patch",
		});
		expect(mockGetArtifact).not.toHaveBeenCalled();
	});

	it("answers not_found when the artifact is out of scope", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await PATCH(makeEvent({}));

		expect(response.status).toBe(404);
		expect(mockSaveDocumentBody).not.toHaveBeenCalled();
	});

	it("saves a document body through saveDocumentBody, carrying the current tabs forward unchanged, opting into coalescing", async () => {
		mockGetArtifact.mockResolvedValue(documentFixture);
		mockDocumentTabs.mockReturnValue([
			{ id: "t1", title: "Plan", startBlockId: "p1" },
		]);
		mockSaveDocumentBody.mockResolvedValue({ ok: true, version: 3 });

		const response = await PATCH(
			makeEvent({
				body: { body: "New text.", expectVersion: 2 },
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, version: 3 });
		expect(mockSaveDocumentBody).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner-user",
				artifactId: "artifact-1",
				conversationId: "conv-1",
				body: {
					markdown: "New text.",
					tabs: [{ id: "t1", title: "Plan", startBlockId: "p1" }],
				},
				author: "user",
				expectVersion: 2,
				coalesceUserEdits: true,
			}),
		);
		expect(mockUpdateArtifactBody).not.toHaveBeenCalled();
	});

	// T9: `Tabs.svelte`'s one write path — a well-formed `tabs` field in the
	// request REPLACES the stored tabs instead of carrying them forward.
	it("uses a client-supplied well-formed tabs array instead of the stored tabs", async () => {
		mockGetArtifact.mockResolvedValue(documentFixture);
		mockDocumentTabs.mockReturnValue([
			{ id: "t1", title: "Plan", startBlockId: "p1" },
		]);
		mockSaveDocumentBody.mockResolvedValue({ ok: true, version: 4 });

		const response = await PATCH(
			makeEvent({
				body: {
					body: "New text.",
					expectVersion: 2,
					tabs: [
						{ id: "t1", title: "Plan", startBlockId: "p1" },
						{ id: "t2", title: "Budget", startBlockId: "p2" },
					],
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(mockSaveDocumentBody).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					markdown: "New text.",
					tabs: [
						{ id: "t1", title: "Plan", startBlockId: "p1" },
						{ id: "t2", title: "Budget", startBlockId: "p2" },
					],
				},
			}),
		);
	});

	it("falls back to the stored tabs when the supplied tabs field is malformed, rather than rejecting the save", async () => {
		mockGetArtifact.mockResolvedValue(documentFixture);
		mockDocumentTabs.mockReturnValue([
			{ id: "t1", title: "Plan", startBlockId: "p1" },
		]);
		mockSaveDocumentBody.mockResolvedValue({ ok: true, version: 3 });

		const response = await PATCH(
			makeEvent({
				body: { body: "New text.", tabs: [{ id: "t1" }] },
			}),
		);

		expect(response.status).toBe(200);
		expect(mockSaveDocumentBody).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					markdown: "New text.",
					tabs: [{ id: "t1", title: "Plan", startBlockId: "p1" }],
				},
			}),
		);
	});

	it("answers 409 version_conflict on a stale expectVersion, writing nothing", async () => {
		mockGetArtifact.mockResolvedValue(documentFixture);
		mockSaveDocumentBody.mockResolvedValue({
			ok: false,
			reason: "version_conflict",
		});

		const response = await PATCH(makeEvent({}));

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "version_conflict",
		});
	});

	it("answers 413 too_large over the body cap", async () => {
		mockGetArtifact.mockResolvedValue(documentFixture);
		mockSaveDocumentBody.mockResolvedValue({ ok: false, reason: "too_large" });

		const response = await PATCH(makeEvent({}));

		expect(response.status).toBe(413);
	});

	it("falls back to the generic updateArtifactBody for a non-document kind", async () => {
		mockGetArtifact.mockResolvedValue({ ...documentFixture, kind: "canvas" });
		mockUpdateArtifactBody.mockResolvedValue({
			ok: true,
			versionId: "v1",
			bodyHash: "h",
			versionNumber: 4,
		});

		const response = await PATCH(
			makeEvent({ body: { body: "{}", expectVersion: 3 } }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, version: 4 });
		expect(mockSaveDocumentBody).not.toHaveBeenCalled();
		expect(mockUpdateArtifactBody).toHaveBeenCalledWith(
			expect.objectContaining({ body: "{}", coalesceUserEdits: true }),
		);
	});
});
