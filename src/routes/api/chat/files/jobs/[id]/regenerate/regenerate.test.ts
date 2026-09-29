import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	regenerateFileProductionJob: vi.fn(),
	wakeFileProductionWorker: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	regenerateFileProductionJob,
	wakeFileProductionWorker,
} from "$lib/server/services/file-production";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockRegenerate = regenerateFileProductionJob as ReturnType<typeof vi.fn>;
const mockWake = wakeFileProductionWorker as ReturnType<typeof vi.fn>;
type RegenerateJobEvent = Parameters<typeof POST>[0];

function makeEvent(user = { id: "user-1" }, id = "job-1"): RegenerateJobEvent {
	return {
		request: new Request(
			`http://localhost/api/chat/files/jobs/${id}/regenerate`,
			{ method: "POST" },
		),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/chat/files/jobs/${id}/regenerate`),
		route: { id: "/api/chat/files/jobs/[id]/regenerate" },
	} as RegenerateJobEvent;
}

describe("POST /api/chat/files/jobs/[id]/regenerate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("queues the signed-in user's job again and wakes the worker", async () => {
		mockRegenerate.mockResolvedValue({
			id: "job-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Report",
			status: "queued",
			files: [],
			warnings: [],
			error: null,
		});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockRegenerate).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "job-1",
		});
		expect(mockWake).toHaveBeenCalledTimes(1);
		expect(data.job).toMatchObject({ id: "job-1", status: "queued" });
	});

	it("answers 404 — and wakes nothing — when there is nothing to make again", async () => {
		mockRegenerate.mockResolvedValue(null);

		const response = await POST(makeEvent());

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "File production job not found or has nothing to regenerate",
		});
		expect(mockWake).not.toHaveBeenCalled();
	});
});
