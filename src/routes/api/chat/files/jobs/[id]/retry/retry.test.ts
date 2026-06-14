import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	retryFileProductionJob: vi.fn(),
	wakeFileProductionWorker: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	retryFileProductionJob,
	wakeFileProductionWorker,
} from "$lib/server/services/file-production";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockRetryFileProductionJob = retryFileProductionJob as ReturnType<
	typeof vi.fn
>;
const mockWakeFileProductionWorker = wakeFileProductionWorker as ReturnType<
	typeof vi.fn
>;
type RetryJobEvent = Parameters<typeof POST>[0];

function makeEvent(user = { id: "user-1" }, id = "job-1"): RetryJobEvent {
	return {
		request: new Request(`http://localhost/api/chat/files/jobs/${id}/retry`, {
			method: "POST",
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/chat/files/jobs/${id}/retry`),
		route: { id: "/api/chat/files/jobs/[id]/retry" },
	} as RetryJobEvent;
}

describe("POST /api/chat/files/jobs/[id]/retry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockRetryFileProductionJob.mockResolvedValue({
			id: "job-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Report",
			status: "queued",
			stage: null,
			createdAt: 1,
			updatedAt: 2,
			files: [],
			warnings: [],
			error: null,
		});
	});

	it("retries the requested job for the signed-in user", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockRetryFileProductionJob).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "job-1",
		});
		expect(mockWakeFileProductionWorker).toHaveBeenCalledTimes(1);
		expect(data.job).toMatchObject({
			id: "job-1",
			status: "queued",
		});
	});
});
