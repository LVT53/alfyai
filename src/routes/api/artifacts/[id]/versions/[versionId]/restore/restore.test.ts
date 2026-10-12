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
	body?: unknown,
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
		// Older callers send no body at all.
		request: {
			json: async () => {
				if (body === undefined) throw new SyntaxError("no body");
				return body;
			},
		},
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
		await expect(response.json()).resolves.toEqual({
			ok: true,
			version: 4,
			versionId: "version-new",
		});
		expect(mockRestoreVersion).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			versionId: "version-1",
			conversationId: "conv-1",
		});
	});

	it("says what kind of row the restore wrote, for the client to announce", async () => {
		mockRestoreVersion.mockResolvedValue({
			ok: true,
			versionId: "version-new",
			versionNumber: 5,
			kind: "undo_alfy_change",
		});

		const response = await POST(makeEvent());

		await expect(response.json()).resolves.toEqual({
			ok: true,
			version: 5,
			versionId: "version-new",
			kind: "undo_alfy_change",
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
	it("answers 422 not_runnable for an App version the contract audit forbids (ruling 58), like the saved-version route", async () => {
		mockRestoreVersion.mockResolvedValue({ ok: false, reason: "not_runnable" });

		const response = await POST(makeEvent());

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_runnable",
		});
	});

	it("forwards the history page's expectVersion and the toast's undoOf", async () => {
		mockRestoreVersion.mockResolvedValue({
			ok: true,
			versionId: "version-new",
			versionNumber: 5,
		});

		await POST(
			makeEvent("artifact-1", "version-1", "owner-user", null, {
				expectVersion: 4,
				undoOf: 4,
			}),
		);

		expect(mockRestoreVersion).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			versionId: "version-1",
			conversationId: null,
			expectVersion: 4,
			undoOf: 4,
		});
	});

	it("forwards the newest row's body hash the reader saw (RC-V M-1: a coalesced save keeps the number)", async () => {
		mockRestoreVersion.mockResolvedValue({
			ok: true,
			versionId: "version-new",
			versionNumber: 5,
		});

		await POST(
			makeEvent("artifact-1", "version-1", "owner-user", null, {
				expectVersion: 4,
				expectHash: "abc123",
			}),
		);

		expect(mockRestoreVersion).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "artifact-1",
			versionId: "version-1",
			conversationId: null,
			expectVersion: 4,
			expectHash: "abc123",
		});
	});

	it("answers 400 invalid_request, calling nothing, for a hash that is not a short text", async () => {
		for (const expectHash of [7, null, "", "x".repeat(200)]) {
			const response = await POST(
				makeEvent("artifact-1", "version-1", "owner-user", null, {
					expectVersion: 4,
					expectHash,
				}),
			);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "invalid_request",
			});
		}
		expect(mockRestoreVersion).not.toHaveBeenCalled();
	});

	it("answers 409 version_conflict when the artifact moved past what the reader saw", async () => {
		mockRestoreVersion.mockResolvedValue({
			ok: false,
			reason: "version_conflict",
		});

		const response = await POST(
			makeEvent("artifact-1", "version-1", "owner-user", null, {
				expectVersion: 2,
			}),
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "version_conflict",
		});
	});

	it("answers 400 invalid_undo for an undo that is not of the newest row", async () => {
		mockRestoreVersion.mockResolvedValue({ ok: false, reason: "invalid_undo" });

		const response = await POST(
			makeEvent("artifact-1", "version-1", "owner-user", null, { undoOf: 1 }),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "invalid_undo",
		});
	});

	it("answers 400 invalid_request, calling nothing, for a field that is not a whole number of at least one", async () => {
		for (const body of [
			{ expectVersion: "2" },
			{ expectVersion: 0 },
			{ undoOf: 1.5 },
			{ undoOf: -3 },
			{ expectVersion: null },
		]) {
			const response = await POST(
				makeEvent("artifact-1", "version-1", "owner-user", null, body),
			);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "invalid_request",
			});
		}
		expect(mockRestoreVersion).not.toHaveBeenCalled();
	});
});
