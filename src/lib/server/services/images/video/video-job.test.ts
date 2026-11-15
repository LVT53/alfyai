// @vitest-environment node
//
// The video KIND on the job engine: its registration, its own limits, and the
// queue/stop/retry surface the tool slice calls.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { warmModules } from "$lib/server/testing/warm-modules";
import { createImageFixture, type ImageFixture } from "../testing/fixture";
import type { VideoTakeRequest } from "./request";

const userId = "user-1";
const otherUserId = "user-2";
const conversationId = "conv-1";

let fixture: ImageFixture;
let workdir: string;

beforeEach(async () => {
	fixture = createImageFixture("video-job");
	fixture.seedUser(userId);
	fixture.seedUser(otherUserId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "video-job-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_LTX_URL = "http://127.0.0.1:9";
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	delete process.env.COMFYUI_LTX_URL;
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

function request(overrides: Partial<VideoTakeRequest> = {}): VideoTakeRequest {
	return {
		v: 1,
		prompt: "the harbour at dusk, a slow tide",
		durationSeconds: 5,
		sourceFileId: "still-1",
		title: "Harbour at dusk",
		summary: null,
		artifactId: null,
		...overrides,
	};
}

async function queue(
	overrides: Partial<VideoTakeRequest> = {},
): Promise<string> {
	const { enqueueVideoTake } = await import("./video-job");
	const { takeId } = await enqueueVideoTake({
		userId,
		conversationId,
		artifactId: null,
		toolCallId: "call-1",
		origin: "turn",
		retryOf: null,
		request: request(overrides),
		seed: 1001,
	});
	return takeId;
}

async function readTake(takeId: string) {
	const { db } = await import("$lib/server/db");
	const row = db
		.select()
		.from(schema.videoJobs)
		.where(eq(schema.videoJobs.id, takeId))
		.get();
	if (!row) throw new Error(`No take ${takeId}`);
	return row;
}

beforeEach(async () => {
	await warmModules([
		() => import("./video-job"),
		() => import("./runner"),
		() => import("$lib/server/services/jobs"),
	]);
});

describe("the video kind", () => {
	it("is registered with its own name, log prefix, phases and limits", async () => {
		const { videoJob } = await import("./video-job");
		const { internalsOf } = await import("$lib/server/services/jobs/define");
		const definition = internalsOf(videoJob).definition;
		expect(videoJob.name).toBe("video");
		expect(videoJob.logPrefix).toBe("[VIDEO]");
		expect(definition.phases).toEqual([
			"submitted",
			"starting",
			"rendering",
			"finishing",
		]);
		expect(definition.limits()).toEqual({ global: 1, perUser: 1 });
		expect(definition.lostAttempt("stale").code).toBe("video_worker_lost");
	});

	it("queues a take carrying its request, seed and tool call", async () => {
		const takeId = await queue();
		const row = await readTake(takeId);
		expect(row.status).toBe("queued");
		expect(row.seed).toBe(1001);
		expect(row.toolCallId).toBe("call-1");
		expect(JSON.parse(row.requestJson)).toMatchObject({
			durationSeconds: 5,
			sourceFileId: "still-1",
		});
	});

	it("keeps a 10 s request asking for two segments", async () => {
		const takeId = await queue({ durationSeconds: 10 });
		expect(JSON.parse((await readTake(takeId)).requestJson)).toMatchObject({
			durationSeconds: 10,
		});
	});

	it("stops a take and scopes the stop to its owner", async () => {
		const { cancelVideoTake } = await import("./video-job");
		const takeId = await queue();
		expect(await cancelVideoTake(otherUserId, takeId)).toBe(false);
		expect(await cancelVideoTake(userId, takeId)).toBe(true);
		expect((await readTake(takeId)).status).toBe("cancelled");
	});

	it("retries a failed take but never a blocked one", async () => {
		const { retryVideoTake } = await import("./video-job");
		const takeId = await queue();
		const { db } = await import("$lib/server/db");
		db.update(schema.videoJobs)
			.set({ status: "failed", errorCode: "video_render_failed" })
			.where(eq(schema.videoJobs.id, takeId))
			.run();
		expect(await retryVideoTake(userId, takeId)).toBe(true);
		expect((await readTake(takeId)).status).toBe("queued");

		db.update(schema.videoJobs)
			.set({ status: "failed", errorCode: "video_blocked" })
			.where(eq(schema.videoJobs.id, takeId))
			.run();
		expect(await retryVideoTake(userId, takeId)).toBe(false);
	});

	it("cancels every take of a person and of a chat", async () => {
		const { cancelVideoTakesForConversation, cancelVideoTakesForUser } =
			await import("./video-job");
		const first = await queue();
		const second = await queue();
		expect(
			await cancelVideoTakesForConversation(userId, conversationId),
		).toEqual({ cancelled: 2 });
		expect((await readTake(first)).status).toBe("cancelled");
		expect((await readTake(second)).status).toBe("cancelled");

		fixture.seedConversation("conv-2", userId);
		const third = await queue();
		expect(await cancelVideoTakesForUser(userId)).toEqual({ cancelled: 1 });
		expect((await readTake(third)).status).toBe("cancelled");
	});

	it("is enabled only when the LTX server has an address", async () => {
		const { internalsOf } = await import("$lib/server/services/jobs/define");
		const { videoJob } = await import("./video-job");
		expect(internalsOf(videoJob).definition.enabled()).toBe(true);
		delete process.env.COMFYUI_LTX_URL;
		vi.resetModules();
		const reloaded = await import("./video-job");
		expect(internalsOf(reloaded.videoJob).definition.enabled()).toBe(false);
	});
});
