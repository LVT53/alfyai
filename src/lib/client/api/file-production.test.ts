import { describe, expect, it, vi } from "vitest";
import {
	cancelFileProductionJob,
	retryFileProductionJob,
} from "./file-production";

describe("file-production client API", () => {
	it("posts to the retry endpoint and returns the updated job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						job: {
							id: "job-1",
							conversationId: "conv-1",
							title: "Report",
							status: "queued",
							createdAt: 1,
							updatedAt: 2,
							files: [],
							warnings: [],
							error: null,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			retryFileProductionJob("job-1", fetchMock),
		).resolves.toMatchObject({
			id: "job-1",
			status: "queued",
		});
		expect(fetchMock).toHaveBeenCalledWith("/api/chat/files/jobs/job-1/retry", {
			method: "POST",
		});
	});

	it("posts to the cancel endpoint and returns the updated job", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						job: {
							id: "job-1",
							conversationId: "conv-1",
							title: "Report",
							status: "cancelled",
							createdAt: 1,
							updatedAt: 2,
							files: [],
							warnings: [],
							error: null,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(
			cancelFileProductionJob("job-1", fetchMock),
		).resolves.toMatchObject({
			id: "job-1",
			status: "cancelled",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/chat/files/jobs/job-1/cancel",
			{
				method: "POST",
			},
		);
	});
});
