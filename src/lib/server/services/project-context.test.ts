import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/task-state", () => ({
	getProjectReferenceContext: vi.fn(),
}));

import { getProjectReferenceContext } from "$lib/server/services/task-state";
import { getProjectContext } from "./project-context";

const mockGetProjectReferenceContext =
	getProjectReferenceContext as ReturnType<typeof vi.fn>;

describe("getProjectContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns bounded project folder summary context without transcripts", async () => {
		mockGetProjectReferenceContext.mockResolvedValue({
			source: "project_folder",
			projectId: "project-1",
			projectName: "Launch Plan",
			omittedSiblingCount: 2,
			entries: [
				{
					conversationId: "conv-2",
					title: "Pricing",
					objective: "Compare pricing options",
					summary: "Stable pricing brief.",
				},
				{
					conversationId: "conv-3",
					title: "Messaging",
					objective: null,
					summary: "Positioning decisions.",
				},
			],
		});

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			maxSiblings: 1,
			includeEvidenceCandidates: true,
		});

		expect(result).toMatchObject({
			success: true,
			mode: "summary",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Plan",
				authority: "project_folder",
			},
			omittedSiblingCount: 3,
			audit: {
				conversationId: "conv-1",
				requestedMaxSiblings: 1,
				appliedMaxSiblings: 1,
				scope: "conversation",
			},
		});
		expect(result.siblings).toEqual([
			{
				conversationId: "conv-2",
				title: "Pricing",
				objective: "Compare pricing options",
				summary: "Stable pricing brief.",
			},
		]);
		expect(result.evidenceCandidates).toEqual([
			{
				id: "conversation-summary:conv-2",
				title: "Pricing",
				snippet: "Stable pricing brief.",
				sourceType: "memory",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("messages");
		expect(JSON.stringify(result)).not.toContain("transcript");
	});

	it("returns an explicit non-error result when no folder or continuity exists", async () => {
		mockGetProjectReferenceContext.mockResolvedValue(null);

		const result = await getProjectContext({
			userId: "user-1",
			conversationId: "conv-empty",
			mode: "summary",
		});

		expect(result).toMatchObject({
			success: true,
			mode: "summary",
			hasProjectContext: false,
			source: "none",
			project: null,
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-empty",
				scope: "conversation",
				noProjectReason: "no_project_context",
			},
		});
	});

	it("rejects detail mode clearly", async () => {
		await expect(
			getProjectContext({
				userId: "user-1",
				conversationId: "conv-1",
				mode: "detail",
			}),
		).rejects.toThrow(/Only summary mode/);
		expect(mockGetProjectReferenceContext).not.toHaveBeenCalled();
	});
});
