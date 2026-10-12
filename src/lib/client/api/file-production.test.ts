import { describe, expect, it, vi } from "vitest";
import {
	cancelFileProductionJob,
	chatFileStillExists,
	fetchFileProductionJob,
	regenerateFileProductionJob,
	retryFileProductionJob,
	waitForFileProductionJob,
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

function aJob(status: string, extra: Record<string, unknown> = {}) {
	return {
		id: "job-1",
		conversationId: "conv-1",
		title: "Trip plan",
		status,
		createdAt: 1,
		updatedAt: 2,
		files: [],
		warnings: [],
		dismissed: false,
		sourceMode: "document_source",
		...extra,
	} as never;
}

function aFile() {
	return {
		id: "file-1",
		filename: "trip-plan.pdf",
		mimeType: "application/pdf",
		sizeBytes: 100,
		downloadUrl: "/api/chat/files/file-1/download",
		previewUrl: "/api/chat/files/file-1/preview",
	};
}

function jobResponse(status: string, extra: Record<string, unknown> = {}) {
	return new Response(JSON.stringify({ job: aJob(status, extra) }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

// Friction audit F1: a Download follows the job it started to its end.
describe("fetchFileProductionJob", () => {
	it("reads one job by its id", async () => {
		const fetchMock = vi.fn(async () => jobResponse("running"));
		await expect(
			fetchFileProductionJob("job-1", fetchMock),
		).resolves.toMatchObject({ id: "job-1", status: "running" });
		expect(fetchMock).toHaveBeenCalledWith("/api/chat/files/jobs/job-1");
	});

	it("is null for a job that is not there for this user, and for a session that ended", async () => {
		for (const status of [404, 401]) {
			const fetchMock = vi.fn(async () => new Response("{}", { status }));
			await expect(
				fetchFileProductionJob("job-1", fetchMock),
			).resolves.toBeNull();
		}
	});

	it("throws on any other failure, which a wait takes for not-known-yet", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
		await expect(fetchFileProductionJob("job-1", fetchMock)).rejects.toThrow();
	});
});

describe("waitForFileProductionJob", () => {
	function clock() {
		let time = 0;
		return {
			now: () => time,
			sleep: vi.fn(async (ms: number) => {
				time += ms;
			}),
		};
	}

	it("reads the job at once and answers as soon as it has made its file", async () => {
		const { now, sleep } = clock();
		const reads = ["queued", "running", "succeeded"];
		const fetchImpl = vi.fn(async () =>
			jobResponse(reads.shift() ?? "succeeded"),
		);

		const result = await waitForFileProductionJob(aJob("queued"), {
			fetchImpl,
			now,
			sleep,
		});

		expect(result).toMatchObject({ state: "succeeded" });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		// Quick at first: a document export takes well under a second.
		expect(sleep).toHaveBeenNthCalledWith(1, 250);
	});

	it("answers failed for a job that failed or was cancelled, without a pause", async () => {
		const { now, sleep } = clock();
		for (const status of ["failed", "cancelled"]) {
			const result = await waitForFileProductionJob(aJob("running"), {
				fetchImpl: vi.fn(async () => jobResponse(status)),
				now,
				sleep,
			});
			expect(result).toMatchObject({ state: "failed" });
		}
		expect(sleep).not.toHaveBeenCalled();
	});

	it("does not even read a job that has already finished with its file in hand", async () => {
		const fetchImpl = vi.fn();
		await expect(
			waitForFileProductionJob(aJob("succeeded", { files: [aFile()] }), {
				fetchImpl,
			}),
		).resolves.toMatchObject({ state: "succeeded" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// FB-8 (FB-1's concern 1): a press for a Document that was exported before is
	// answered with the job of that export, which names the job and not its files. The
	// wait reads it once, and the file is the one the first press made.
	it("reads a finished job once when the answer names no file (the job an earlier press made), and answers with its file", async () => {
		const fetchImpl = vi.fn(async () =>
			jobResponse("succeeded", { files: [aFile()] }),
		);
		const result = await waitForFileProductionJob(aJob("succeeded"), {
			fetchImpl,
		});
		expect(result).toMatchObject({
			state: "succeeded",
			job: { files: [expect.objectContaining({ id: "file-1" })] },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("reads a finished job without a file once, and answers with what it finds when there is none (the file was deleted)", async () => {
		const fetchImpl = vi.fn(async () => jobResponse("succeeded"));
		const result = await waitForFileProductionJob(aJob("succeeded"), {
			fetchImpl,
		});
		expect(result).toMatchObject({ state: "succeeded" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("takes a read that failed for not-known-yet and reads again", async () => {
		const { now, sleep } = clock();
		const answers = [
			() => {
				throw new TypeError("network");
			},
			() => jobResponse("succeeded"),
		];
		const fetchImpl = vi.fn(async () => (answers.shift() as () => Response)());

		await expect(
			waitForFileProductionJob(aJob("queued"), { fetchImpl, now, sleep }),
		).resolves.toMatchObject({ state: "succeeded" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("gives up when the job is not there", async () => {
		const { now, sleep } = clock();
		await expect(
			waitForFileProductionJob(aJob("queued"), {
				fetchImpl: vi.fn(async () => new Response("{}", { status: 404 })),
				now,
				sleep,
			}),
		).resolves.toEqual({ state: "gone" });
	});

	it("stops waiting when the time is up and keeps the status the job last had", async () => {
		const { now, sleep } = clock();
		const fetchImpl = vi.fn(async () => jobResponse("running"));

		const result = await waitForFileProductionJob(aJob("queued"), {
			fetchImpl,
			now,
			sleep,
			timeoutMs: 3_000,
		});

		expect(result).toMatchObject({
			state: "timeout",
			job: { status: "running" },
		});
		expect(now()).toBe(3_000);
	});

	it("stops when told to", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn();
		await expect(
			waitForFileProductionJob(aJob("queued"), {
				fetchImpl,
				signal: controller.signal,
			}),
		).resolves.toMatchObject({ state: "timeout" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
