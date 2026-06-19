import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/atlas", () => ({
	cancelAtlasJob: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { cancelAtlasJob } from "$lib/server/services/atlas";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCancelAtlasJob = cancelAtlasJob as ReturnType<typeof vi.fn>;
type CancelAtlasEvent = Parameters<typeof POST>[0];

function makeEvent(
	user = { id: "user-1" },
	id = "atlas-job-1",
): CancelAtlasEvent {
	return {
		request: new Request(`http://localhost/api/atlas/jobs/${id}/cancel`, {
			method: "POST",
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/atlas/jobs/${id}/cancel`),
		route: { id: "/api/atlas/jobs/[id]/cancel" },
	} as CancelAtlasEvent;
}

describe("POST /api/atlas/jobs/[id]/cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockCancelAtlasJob.mockResolvedValue({
			id: "atlas-job-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			title: "Atlas research",
			status: "cancelled",
			stage: "cancelled",
			progress: { percent: 0, stage: "cancelled", details: { queries: [] } },
			sourceCounts: { local: 0, web: 0, accepted: 0, rejected: 0 },
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costUsdMicros: 0,
			},
			outputs: {
				fileProductionJobId: null,
				htmlChatGeneratedFileId: null,
				pdfChatGeneratedFileId: null,
				markdownChatGeneratedFileId: null,
			},
			error: null,
			createdAt: 1,
			updatedAt: 2,
			completedAt: 2,
		});
	});

	it("cancels the requested Atlas job for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockCancelAtlasJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "atlas-job-1",
		});
		expect(data).toEqual({
			job: expect.objectContaining({
				id: "atlas-job-1",
				status: "cancelled",
				stage: "cancelled",
			}),
		});
	});
});
