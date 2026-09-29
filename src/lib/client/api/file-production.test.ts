import { describe, expect, it, vi } from "vitest";
import {
	cancelFileProductionJob,
	chatFileStillExists,
	regenerateFileProductionJob,
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

	it("posts to the regenerate endpoint and returns the job, queued again", async () => {
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
			regenerateFileProductionJob("job-1", fetchMock),
		).resolves.toMatchObject({ id: "job-1", status: "queued" });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/chat/files/jobs/job-1/regenerate",
			{ method: "POST" },
		);
	});

	it("throws when there is nothing to regenerate", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nothing" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(
			regenerateFileProductionJob("job-1", fetchMock),
		).rejects.toMatchObject({ status: 404 });
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

// Polish G2-A: an Open on a produced file first asks whether the file is still
// there — a one-byte ranged read of its preview, which the server answers 404
// for a file that is gone.
describe("chatFileStillExists", () => {
	it("reads one byte of the preview, and is false only when the server says the file is gone", async () => {
		const gone = vi.fn(async () => new Response("{}", { status: 404 }));
		await expect(
			chatFileStillExists("/api/chat/files/file-1/preview", gone),
		).resolves.toBe(false);
		expect(gone).toHaveBeenCalledWith("/api/chat/files/file-1/preview", {
			headers: { Range: "bytes=0-0" },
		});

		const there = vi.fn(async () => new Response("x", { status: 206 }));
		await expect(
			chatFileStillExists("/api/chat/files/file-1/preview", there),
		).resolves.toBe(true);
	});

	it("gives the panel the benefit of the doubt when it cannot tell (offline, a server error)", async () => {
		const broken = vi.fn(async () => new Response("no", { status: 500 }));
		await expect(
			chatFileStillExists("/api/chat/files/file-1/preview", broken),
		).resolves.toBe(true);
		const offline = vi.fn(async () => {
			throw new TypeError("network");
		});
		await expect(
			chatFileStillExists("/api/chat/files/file-1/preview", offline),
		).resolves.toBe(true);
	});
});
