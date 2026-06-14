import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	cancelFileProductionJob: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { cancelFileProductionJob } from "$lib/server/services/file-production";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCancelFileProductionJob = cancelFileProductionJob as ReturnType<
	typeof vi.fn
>;
type CancelJobEvent = Parameters<typeof POST>[0];

function makeEvent(user = { id: "user-1" }, id = "job-1"): CancelJobEvent {
	return {
		request: new Request(`http://localhost/api/chat/files/jobs/${id}/cancel`, {
			method: "POST",
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/chat/files/jobs/${id}/cancel`),
		route: { id: "/api/chat/files/jobs/[id]/cancel" },
	} as CancelJobEvent;
}

describe("POST /api/chat/files/jobs/[id]/cancel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockCancelFileProductionJob.mockResolvedValue({
			id: "job-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Report",
			status: "cancelled",
			stage: null,
			createdAt: 1,
			updatedAt: 2,
			files: [],
			warnings: [],
			error: null,
		});
	});

	it("cancels the requested job for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockCancelFileProductionJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "job-1",
		});
		expect(data.job).toMatchObject({
			id: "job-1",
			status: "cancelled",
		});
	});
});
