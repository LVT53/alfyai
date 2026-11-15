// @vitest-environment node
//
// One GPU, two engines: a picture take and a video take must take turns. The
// ledger is real and the take kinds are the engine's own; the ComfyUI servers
// are the fakes, one per engine. This is the collision that OOM'd the card
// live: a video render still running while a picture take submitted.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "$lib/server/db/schema";
import { warmModules } from "$lib/server/testing/warm-modules";
import {
	createFakeComfyUi,
	type FakeComfyUi,
	type FakeComfyUiOptions,
} from "./comfyui/testing/fake-comfyui";
import type { TakeRequest } from "./take-request";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

const userId = "user-1";
const conversationId = "conv-1";
const cardId = "card-1";

let fixture: ImageFixture;
let workdir: string;
let picture: FakeComfyUi | null = null;
let video: FakeComfyUi | null = null;

beforeAll(async () => {
	await warmModules([
		() => import("./image-job"),
		() => import("./image-runner"),
		() => import("./video/video-job"),
		() => import("./video/runner"),
		() => import("./video/media"),
		() => import("./files"),
		() => import("./idle-free"),
		() => import("$lib/server/services/artifacts"),
		() => import("$lib/server/services/jobs"),
	]);
}, 60_000);

beforeEach(async () => {
	fixture = createImageFixture("cross-engine");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	fixture.seedCard({ id: cardId, userId, conversationId });
	workdir = await mkdtemp(join(tmpdir(), "cross-engine-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.IMAGE_EXPLICIT_FILTER_ENABLED = "true";
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	await picture?.close();
	picture = null;
	await video?.close();
	video = null;
	delete process.env.COMFYUI_URL;
	delete process.env.COMFYUI_LTX_URL;
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_EXPLICIT_FILTER_ENABLED;
	try {
		const { setOtherEngineWaitForTests } = await import("./idle-free");
		setOtherEngineWaitForTests(undefined);
	} catch {
		// The images service was never imported.
	}
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

async function startEngines(
	pictureOptions: FakeComfyUiOptions = {},
	videoOptions: FakeComfyUiOptions = {},
): Promise<void> {
	picture = await createFakeComfyUi(pictureOptions);
	video = await createFakeComfyUi(videoOptions);
	process.env.COMFYUI_URL = picture.baseUrl;
	process.env.COMFYUI_LTX_URL = video.baseUrl;
}

async function setWait(next: { intervalMs?: number; deadlineMs?: number }) {
	const { setOtherEngineWaitForTests } = await import("./idle-free");
	setOtherEngineWaitForTests(next);
}

function pictureRequest(): TakeRequest {
	return {
		v: 1,
		model: "qwen",
		mode: "generate",
		prompt: "a cosy living room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 256, height: 192 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy living room",
		summary: null,
	};
}

async function queuePicture(): Promise<string> {
	const { enqueueTake } = await import("./image-job");
	const { takeId } = await enqueueTake({
		userId,
		conversationId,
		cardId,
		toolCallId: "call-1",
		origin: "turn",
		retryOf: null,
		request: pictureRequest(),
		seed: 1,
		heldUntil: null,
	});
	return takeId;
}

async function queueVideo(): Promise<string> {
	const png = await sharp({
		create: {
			width: 1600,
			height: 1200,
			channels: 3,
			background: { r: 40, g: 90, b: 140 },
		},
	})
		.png()
		.toBuffer();
	const { storeImageFile } = await import("./files");
	const still = await storeImageFile({
		userId,
		conversationId,
		role: "input",
		png,
	});
	const { enqueueVideoTake } = await import("./video/video-job");
	const { takeId } = await enqueueVideoTake({
		userId,
		conversationId,
		artifactId: null,
		toolCallId: "call-1",
		origin: "turn",
		retryOf: null,
		request: {
			v: 1,
			prompt: "the harbour at dusk",
			durationSeconds: 5,
			sourceFileId: still.id,
			title: "Harbour",
			summary: null,
			artifactId: null,
		},
		seed: 1,
	});
	return takeId;
}

async function drainPictures(): Promise<void> {
	const { drain } = await import("$lib/server/services/jobs");
	const { imageJob } = await import("./image-job");
	await drain(imageJob);
}

async function drainVideos(): Promise<void> {
	const { drain } = await import("$lib/server/services/jobs");
	const { videoJob } = await import("./video/video-job");
	await drain(videoJob);
}

async function readPicture(takeId: string) {
	const { db } = await import("$lib/server/db");
	const row = db
		.select()
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.get();
	if (!row) throw new Error(`No picture take ${takeId}`);
	return row;
}

async function readVideo(takeId: string) {
	const { db } = await import("$lib/server/db");
	const row = db
		.select()
		.from(schema.videoJobs)
		.where(eq(schema.videoJobs.id, takeId))
		.get();
	if (!row) throw new Error(`No video take ${takeId}`);
	return row;
}

function posts(server: FakeComfyUi): number {
	return server.requests.filter(
		(request) => request.method === "POST" && request.path === "/prompt",
	).length;
}

async function until<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	timeoutMs = 10_000,
): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeoutMs) {
			throw new Error("Gave up waiting for the fake's state");
		}
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the cross-engine gate", () => {
	it("makes a picture wait for a running video take, then submits", async () => {
		await startEngines({}, { hangAfterPromptCount: 0 });
		await setWait({ intervalMs: 20 });
		const videoId = await queueVideo();
		const videoDrain = drainVideos();
		await until(
			async () => (await readVideo(videoId)).status,
			(status) => status === "running",
		);

		const pictureId = await queuePicture();
		const pictureDrain = drainPictures();
		await sleep(120);
		expect(posts(picture as FakeComfyUi)).toBe(0);
		expect((await readPicture(pictureId)).status).toBe("running");

		(video as FakeComfyUi).releaseHanging();
		await videoDrain;
		await pictureDrain;
		expect((await readPicture(pictureId)).status).toBe("succeeded");
		expect(posts(picture as FakeComfyUi)).toBe(1);
	}, 30_000);

	it("makes a video wait for a running picture take, then submits", async () => {
		await startEngines({ hangAfterPromptCount: 0 }, {});
		await setWait({ intervalMs: 20 });
		const pictureId = await queuePicture();
		const pictureDrain = drainPictures();
		await until(
			async () => (await readPicture(pictureId)).status,
			(status) => status === "running",
		);

		const videoId = await queueVideo();
		const videoDrain = drainVideos();
		await sleep(120);
		expect(posts(video as FakeComfyUi)).toBe(0);
		expect((await readVideo(videoId)).status).toBe("running");

		(picture as FakeComfyUi).releaseHanging();
		await pictureDrain;
		await videoDrain;
		expect((await readVideo(videoId)).status).toBe("succeeded");
		expect(posts(video as FakeComfyUi)).toBe(1);
	}, 30_000);

	it("cancels a waiting take without posting it", async () => {
		await startEngines({}, { hangAfterPromptCount: 0 });
		await setWait({ intervalMs: 20 });
		const videoId = await queueVideo();
		const videoDrain = drainVideos();
		await until(
			async () => (await readVideo(videoId)).status,
			(status) => status === "running",
		);

		const pictureId = await queuePicture();
		const pictureDrain = drainPictures();
		await sleep(80);
		const { cancelTake } = await import("./image-job");
		await cancelTake(userId, pictureId);
		await pictureDrain;
		expect((await readPicture(pictureId)).status).toBe("cancelled");
		expect(posts(picture as FakeComfyUi)).toBe(0);

		(video as FakeComfyUi).releaseHanging();
		await videoDrain;
	}, 30_000);

	it("does not deadlock when both kinds are queued together: the older goes first", async () => {
		await startEngines({}, {});
		await setWait({ intervalMs: 20 });
		const pictureId = await queuePicture();
		const videoId = await queueVideo();
		await Promise.all([drainPictures(), drainVideos()]);
		expect((await readPicture(pictureId)).status).toBe("succeeded");
		expect((await readVideo(videoId)).status).toBe("succeeded");
	}, 30_000);

	it("gives up at the wait deadline with the picture timeout code", async () => {
		await startEngines({}, { hangAfterPromptCount: 0 });
		await setWait({ intervalMs: 20, deadlineMs: 100 });
		const videoId = await queueVideo();
		const videoDrain = drainVideos();
		await until(
			async () => (await readVideo(videoId)).status,
			(status) => status === "running",
		);

		const pictureId = await queuePicture();
		await drainPictures();
		const row = await readPicture(pictureId);
		expect([row.status, row.errorCode]).toEqual([
			"failed",
			"image_render_timeout",
		]);
		expect(posts(picture as FakeComfyUi)).toBe(0);

		(video as FakeComfyUi).releaseHanging();
		await videoDrain;
	}, 30_000);

	it("gives up at the wait deadline with the video timeout code", async () => {
		await startEngines({ hangAfterPromptCount: 0 }, {});
		await setWait({ intervalMs: 20, deadlineMs: 100 });
		const pictureId = await queuePicture();
		const pictureDrain = drainPictures();
		await until(
			async () => (await readPicture(pictureId)).status,
			(status) => status === "running",
		);

		const videoId = await queueVideo();
		await drainVideos();
		const take = await readVideo(videoId);
		expect([take.status, take.errorCode]).toEqual([
			"failed",
			"video_render_timeout",
		]);
		expect(posts(video as FakeComfyUi)).toBe(0);

		(picture as FakeComfyUi).releaseHanging();
		await pictureDrain;
	}, 30_000);
});
