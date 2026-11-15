// @vitest-environment node
//
// The video kind's handler through the engine's own `drain`, against a real
// fake ComfyUI on a loopback port. The database is a migrated file; the clip
// and the picture files go to a temp working directory. ffmpeg is the real
// one: the chain, the poster and the sampled frames are decoded from the
// fake's mp4 the same way production decodes LTX's.

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
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
	parseVideoVersionBody,
	serializeVideoVersionBody,
} from "$lib/shared/artifacts/video-body";
import {
	createFakeComfyUi,
	FAKE_VIDEO_BYTES,
	type FakeComfyUi,
	type FakeComfyUiOptions,
} from "../comfyui/testing/fake-comfyui";
import { createImageFixture, type ImageFixture } from "../testing/fixture";
import {
	extractLastFrame,
	probeDurationMs,
	setMediaTimeoutMsForTests,
} from "./media";
import { parseVideoCheckpoint, type VideoTakeRequest } from "./request";
import {
	makeTestClip,
	makeTestClipWithFrameAt,
	probeTags,
	remuxWithMetadata,
} from "./testing/video-clip";

const userId = "user-1";
const conversationId = "conv-1";

type Graph = Record<
	string,
	{ class_type: string; inputs: Record<string, unknown> }
>;

let fixture: ImageFixture;
let workdir: string;
let fake: FakeComfyUi | null = null;
let qwen: FakeComfyUi | null = null;
let h3: FakeComfyUi | null = null;

beforeAll(async () => {
	await warmModules([
		() => import("./video-job"),
		() => import("./runner"),
		() => import("./media"),
		() => import("../files"),
		() => import("../idle-free"),
		() => import("$lib/server/services/artifacts"),
		() => import("$lib/server/services/jobs"),
	]);
}, 60_000);

beforeEach(async () => {
	fixture = createImageFixture("video-runner");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "video-runner-"));
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
	await fake?.close();
	fake = null;
	await qwen?.close();
	qwen = null;
	await h3?.close();
	h3 = null;
	delete process.env.COMFYUI_LTX_URL;
	delete process.env.COMFYUI_URL;
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_EXPLICIT_FILTER_ENABLED;
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

async function startLtx(
	options: FakeComfyUiOptions = {},
): Promise<FakeComfyUi> {
	fake = await createFakeComfyUi(options);
	process.env.COMFYUI_LTX_URL = fake.baseUrl;
	return fake;
}

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

async function storeStill(width = 1920, height = 1080): Promise<string> {
	const sharp = (await import("sharp")).default;
	const png = await sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 40, g: 90, b: 140 },
		},
	})
		.png()
		.toBuffer();
	const { storeImageFile } = await import("../files");
	const file = await storeImageFile({
		userId,
		conversationId,
		role: "input",
		png,
	});
	return file.id;
}

async function queueTake(
	overrides: Partial<VideoTakeRequest> = {},
	seed = 1001,
): Promise<string> {
	const stillId = await storeStill();
	const { enqueueVideoTake } = await import("./video-job");
	const { takeId } = await enqueueVideoTake({
		userId,
		conversationId,
		artifactId: null,
		toolCallId: "call-1",
		origin: "turn",
		retryOf: null,
		request: request({ sourceFileId: stillId, ...overrides }),
		seed,
	});
	return takeId;
}

async function drainVideoTakes(): Promise<void> {
	const { drain } = await import("$lib/server/services/jobs");
	const { videoJob } = await import("./video-job");
	await drain(videoJob);
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

async function until<T>(
	read: () => Promise<T> | T,
	done: (value: T) => boolean,
	timeoutMs = 15_000,
): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Gave up waiting; last value: ${JSON.stringify(value)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function promptRequests(server: FakeComfyUi) {
	return server.requests.filter(
		(request) => request.method === "POST" && request.path === "/prompt",
	);
}

function graphOf(request: { json?: unknown }): Graph {
	return (request.json as { prompt: Graph }).prompt;
}

function nodeOfType(
	graph: Graph,
	type: string,
	index = 0,
): { class_type: string; inputs: Record<string, unknown> } {
	const found = Object.values(graph).filter((node) => node.class_type === type)[
		index
	];
	if (!found) throw new Error(`No ${type} node at ${index}`);
	return found;
}

/** The clip rows of a chat: the source still lives in the same table. */
async function storedClips() {
	const { db } = await import("$lib/server/db");
	const rows = await db
		.select()
		.from(schema.imageFiles)
		.where(eq(schema.imageFiles.conversationId, conversationId));
	return rows.filter((row) => row.storagePath.endsWith(".mp4"));
}

async function clipBytes(fileId: string): Promise<Uint8Array> {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select()
		.from(schema.imageFiles)
		.where(eq(schema.imageFiles.id, fileId))
		.limit(1);
	if (!row) throw new Error("No stored clip");
	return new Uint8Array(await readFile(join(workdir, row.storagePath)));
}

async function artifactOf(fileId: string) {
	const { db } = await import("$lib/server/db");
	const [file] = await db
		.select({ artifactId: schema.imageFiles.artifactId })
		.from(schema.imageFiles)
		.where(eq(schema.imageFiles.id, fileId))
		.limit(1);
	if (!file?.artifactId) return null;
	const [artifact] = await db
		.select()
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, file.artifactId))
		.limit(1);
	if (!artifact) return null;
	const versions = await db
		.select()
		.from(schema.artifactVersions)
		.where(eq(schema.artifactVersions.artifactId, artifact.id))
		.orderBy(desc(schema.artifactVersions.versionNumber));
	return { artifact, newest: versions[0] ?? null };
}

/** A clip's three files; the source still is not one of them. */
function clipFilesOnDisk(clipId: string): string[] {
	const dir = join(workdir, "data", "image-files", conversationId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.startsWith(clipId))
		.sort();
}

/** Every file a refused take must not leave: no clip, no poster, no thumb. */
function clipFilesAnyOnDisk(): string[] {
	const dir = join(workdir, "data", "image-files", conversationId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(
		(name) =>
			name.endsWith(".mp4") ||
			name.endsWith(".poster.webp") ||
			name.endsWith(".thumb.webp"),
	);
}

async function renderSegmentOne(
	server: FakeComfyUi,
	takeId: string,
	promptId: string,
): Promise<unknown> {
	const { createComfyUiClient } = await import("../comfyui/client");
	const { buildLtxVideoGraph } = await import("../comfyui/ltx-templates");
	const sharp = (await import("sharp")).default;
	const { readImageFileBytes, getImageFile } = await import("../files");
	const stillId = JSON.parse((await readTake(takeId)).requestJson)
		.sourceFileId as string;
	const still = await getImageFile({
		userId,
		fileId: stillId,
		conversationId,
	});
	if (!still) throw new Error("No source still");
	const png = await sharp(await readImageFileBytes(still, "full"))
		.resize(1280, 960)
		.png()
		.toBuffer();
	const client = createComfyUiClient({ baseUrl: server.baseUrl, pollMs: 20 });
	try {
		const ref = await client.uploadImage(png, `${takeId}-1.png`);
		await client.submit(
			buildLtxVideoGraph({
				prompt: "the harbour at dusk, a slow tide",
				seed: 1001,
				width: 1280,
				height: 960,
				image: ref.filename,
			}),
			{ promptId },
		);
		const refs = await client.followVideo(promptId, {
			signal: new AbortController().signal,
			deadlineMs: 10_000,
			onEvent: () => undefined,
		});
		return refs[0] ?? null;
	} finally {
		client.close();
	}
}

async function writeCheckpoint(takeId: string, checkpoint: unknown) {
	const { db } = await import("$lib/server/db");
	db.update(schema.videoJobs)
		.set({ checkpoint: JSON.stringify(checkpoint) })
		.where(eq(schema.videoJobs.id, takeId))
		.run();
}

describe("a 5 second take", () => {
	it("submits one LTX graph at the size derived from the still and settles to a stored clip", async () => {
		const server = await startLtx();
		const takeId = await queueTake();
		await drainVideoTakes();

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(take.resultFileId).not.toBeNull();

		const posts = promptRequests(server);
		expect(posts).toHaveLength(1);
		const graph = graphOf(posts[0]);
		// A 16:9 still -> 1280 x 704, first pass at half (the measured 720p
		// product size: 720 snaps DOWN to 704, a multiple of 32).
		expect(nodeOfType(graph, "EmptyLTXVLatentVideo").inputs).toMatchObject({
			width: 640,
			height: 352,
			length: 121,
		});
		expect(nodeOfType(graph, "VAELoader").inputs.vae_name).toBe(
			"ltx-2.5-video-vae-conv-bf16.safetensors",
		);
		expect(nodeOfType(graph, "ManualSigmas").inputs.sigmas).toBe(
			"1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
		);
		expect(nodeOfType(graph, "CLIPTextEncode").inputs.text).toBe(
			"the harbour at dusk, a slow tide",
		);
		expect(
			server.requests.filter((request) => request.path === "/upload/image"),
		).toHaveLength(1);

		const clips = await storedClips();
		expect(clips).toHaveLength(1);
		const clip = clips[0];
		if (!clip) throw new Error("The take stored no clip");
		expect(clip.durationMs).toBe(5000);
		expect(clip.width).toBe(64);
		expect(clip.height).toBe(64);
		expect(clipFilesOnDisk(clip.id)).toEqual(
			[
				`${clip.id}.mp4`,
				`${clip.id}.poster.webp`,
				`${clip.id}.thumb.webp`,
			].sort(),
		);

		const artifact = await artifactOf(clip.id);
		expect(artifact?.artifact.metadataJson).toContain('"artifactType":"video"');
		expect(artifact?.artifact.name).toBe("Harbour at dusk");
		expect(parseVideoVersionBody(artifact?.newest?.body ?? null)).toMatchObject(
			{
				fileId: clip.id,
				durationMs: 5000,
				sourceFileId: JSON.parse(take.requestJson).sourceFileId,
			},
		);
	});

	it("sends a portrait still's shape as 352 x 640 first-pass", async () => {
		const server = await startLtx();
		const stillId = await storeStill(1080, 1920);
		const { enqueueVideoTake } = await import("./video-job");
		const { takeId } = await enqueueVideoTake({
			userId,
			conversationId,
			artifactId: null,
			toolCallId: "call-1",
			origin: "turn",
			retryOf: null,
			request: request({ sourceFileId: stillId }),
			seed: 1001,
		});
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		expect(
			nodeOfType(graphOf(promptRequests(server)[0]), "EmptyLTXVLatentVideo")
				.inputs,
		).toMatchObject({ width: 352, height: 640 });
	});
});

describe("a 10 second take", () => {
	it("chains a second segment from the last decoded frame and concatenates", async () => {
		const server = await startLtx();
		const takeId = await queueTake({ durationSeconds: 10 });
		await drainVideoTakes();

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		const posts = promptRequests(server);
		expect(posts).toHaveLength(2);

		const first = graphOf(posts[0]);
		const second = graphOf(posts[1]);
		expect(nodeOfType(first, "CLIPTextEncode").inputs.text).toBe(
			nodeOfType(second, "CLIPTextEncode").inputs.text,
		);
		const firstSource = nodeOfType(first, "LoadImage").inputs.image;
		const secondSource = nodeOfType(second, "LoadImage").inputs.image;
		expect(firstSource).not.toBe(secondSource);

		// The second upload is the last decoded frame of the first clip.
		const secondFilename = `${takeId}-2.png`;
		const uploaded = server.uploads.get(secondFilename);
		expect(uploaded).toBeDefined();
		expect(secondSource).toBe(secondFilename);
		expect(Buffer.from(uploaded ?? [])).toEqual(
			Buffer.from(await extractLastFrame(FAKE_VIDEO_BYTES)),
		);

		const clips = await storedClips();
		expect(clips).toHaveLength(1);
		const clip = clips[0];
		if (!clip) throw new Error("The take stored no clip");
		expect(clip.durationMs).toBe(10000);
		expect(await probeDurationMs(await clipBytes(clip.id))).toBeGreaterThan(
			9_500,
		);
		const artifact = await artifactOf(clip.id);
		expect(
			parseVideoVersionBody(artifact?.newest?.body ?? null)?.durationMs,
		).toBe(10000);
	});

	it("fails the whole take when the second segment fails, never a one-segment clip", async () => {
		const server = await startLtx({ failAfterPromptCount: 1 });
		const takeId = await queueTake({ durationSeconds: 10 });
		await drainVideoTakes();

		expect(promptRequests(server)).toHaveLength(2);
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.resultFileId).toBeNull();
		expect(await storedClips()).toHaveLength(0);
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});
});

describe("resume", () => {
	it("follows a checkpointed prompt id instead of submitting the first segment again", async () => {
		const server = await startLtx();
		const takeId = await queueTake({ durationSeconds: 10 });
		await renderSegmentOne(server, takeId, "checkpointed-segment-1");
		await writeCheckpoint(takeId, {
			promptId: "checkpointed-segment-1",
			segment: 1,
			segments: [{ promptId: "checkpointed-segment-1", media: null }],
		});

		await drainVideoTakes();

		expect((await readTake(takeId)).status).toBe("succeeded");
		// One POST from the test, one from the runner (segment 2).
		expect(promptRequests(server)).toHaveLength(2);
		expect((await storedClips())[0]?.durationMs).toBe(10000);
	});

	it("follows a finished first segment's recorded media and only renders the second", async () => {
		const server = await startLtx();
		const takeId = await queueTake({ durationSeconds: 10 });
		const media = await renderSegmentOne(server, takeId, "finished-segment-1");
		await writeCheckpoint(takeId, {
			promptId: "finished-segment-1",
			segment: 1,
			segments: [{ promptId: "finished-segment-1", media }],
		});

		await drainVideoTakes();

		expect((await readTake(takeId)).status).toBe("succeeded");
		expect(promptRequests(server)).toHaveLength(2);
		// The finished take's checkpoint is cleared by the engine; the proof that
		// segment 1 was fetched rather than rendered is the single new prompt.
		expect((await readTake(takeId)).checkpoint).toBeNull();
	});

	it("re-renders once when ComfyUI no longer knows the checkpointed prompt", async () => {
		const server = await startLtx();
		const takeId = await queueTake();
		await writeCheckpoint(takeId, {
			promptId: "forgotten-by-a-restart",
			segment: 1,
			segments: [],
		});

		await drainVideoTakes();

		expect((await readTake(takeId)).status).toBe("succeeded");
		expect(promptRequests(server)).toHaveLength(1);
	});

	it("writes the prompt id as the checkpoint before it posts", async () => {
		const server = await startLtx();
		server.holdRequests("/prompt", true);
		const takeId = await queueTake();
		const draining = drainVideoTakes();
		const checkpointed = await until(
			async () => (await readTake(takeId)).checkpoint,
			(value) => value !== null,
		);
		const checkpoint = parseVideoCheckpoint(checkpointed);
		expect(checkpoint?.promptId).toBeTruthy();
		server.holdRequests("/prompt", false);
		await draining;
		expect((await readTake(takeId)).status).toBe("succeeded");
		expect(server.prompts.has(checkpoint?.promptId ?? "")).toBe(true);
	});
});

describe("Stop", () => {
	it.each([
		"submitted",
		"starting",
		"rendering",
		"finishing",
	] as const)("settles a take stopped at %s and leaves no clip", async (phase) => {
		const server = await startLtx({
			steps: 30,
			stepDelayMs: 40,
			startDelayMs: phase === "submitted" ? 0 : 300,
		});
		if (phase === "submitted") server.holdRequests("/prompt", true);
		if (phase === "finishing") server.holdRequests("/view", true);
		const takeId = await queueTake();
		const draining = drainVideoTakes();
		await until(
			async () => (await readTake(takeId)).phase,
			(value) => value === phase,
		);
		const { cancelVideoTake } = await import("./video-job");
		expect(await cancelVideoTake(userId, takeId)).toBe(true);
		server.holdRequests("/prompt", false);
		server.holdRequests("/view", false);
		await draining;

		const take = await readTake(takeId);
		expect(take.status).toBe("cancelled");
		expect(take.resultFileId).toBeNull();
		expect(clipFilesAnyOnDisk()).toEqual([]);
		expect(await storedClips()).toHaveLength(0);
	});
});

describe("the explicit-picture filter", () => {
	it("blocks a clip whose sampled frames are explicit and stores nothing", async () => {
		const explicit = await makeTestClip({ colour: "#ff00ff", seconds: 5 });
		await startLtx({ videoBytes: explicit });
		const takeId = await queueTake();
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("video_blocked");
		expect(take.retryable).toBe(false);
		expect(take.resultFileId).toBeNull();
		expect(await storedClips()).toHaveLength(0);
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});

	it("fails closed when a frame cannot be checked", async () => {
		const unavailable = await makeTestClip({
			colour: "#00ffff",
			seconds: 5,
		});
		await startLtx({ videoBytes: unavailable });
		const takeId = await queueTake();
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.errorCode).toBe("video_unchecked");
		expect(take.retryable).toBe(true);
		expect(take.resultFileId).toBeNull();
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});

	it("classifies every frame of the clip, not a sample", async () => {
		await startLtx();
		await queueTake();
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		await drainVideoTakes();
		// 120 frames in batches of 16 = 8 checks (and 8 inference runs), never 120.
		expect(
			info.mock.calls.filter(
				([message]) => message === "[IMAGES] Picture check",
			),
		).toHaveLength(8);
	});

	it("blocks an explicit frame at the old 50% sample point", async () => {
		const clip = await makeTestClipWithFrameAt({
			frameIndex: 60,
			colour: "#ff00ff",
		});
		await startLtx({ videoBytes: clip });
		const takeId = await queueTake();
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("video_blocked");
		expect(take.resultFileId).toBeNull();
		await expect(storedClips()).resolves.toHaveLength(0);
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});

	it("blocks an explicit frame BETWEEN the old sample points (frame 37 of 121)", async () => {
		const clip = await makeTestClipWithFrameAt({
			frameIndex: 37,
			colour: "#ff00ff",
		});
		await startLtx({ videoBytes: clip });
		const takeId = await queueTake();
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("video_blocked");
		expect(take.resultFileId).toBeNull();
		await expect(storedClips()).resolves.toHaveLength(0);
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});
});

describe("GPU memory ownership", () => {
	it("frees every other engine before submitting, never the LTX server", async () => {
		qwen = await createFakeComfyUi();
		h3 = await createFakeComfyUi();
		process.env.COMFYUI_URL = qwen.baseUrl;
		process.env.COMFYUI_H3_URL = h3.baseUrl;
		const server = await startLtx();
		const takeId = await queueTake();
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		const frees = (target: FakeComfyUi) =>
			target.requests.filter((request) => request.path === "/free").length;
		expect(frees(qwen)).toBe(1);
		expect(frees(h3)).toBe(1);
		expect(frees(server)).toBe(0);
	});
});

describe("an exempt person", () => {
	it("never runs the classifier and never decodes the check stream", async () => {
		const { db } = await import("$lib/server/db");
		db.update(schema.users)
			.set({ explicitPictureFilterExempt: true })
			.where(eq(schema.users.id, userId))
			.run();
		await startLtx();
		const classifier = await import("../picture-check/classifier");
		const classify = vi.spyOn(classifier, "classifyPictureFrames");
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const takeId = await queueTake();
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		// The decision is made once in the runner: no frames are decoded for the
		// check and the classifier is never entered.
		expect(classify).not.toHaveBeenCalled();
		expect(
			info.mock.calls.filter(
				([message]) => message === "[IMAGES] Picture check",
			),
		).toHaveLength(0);
		expect(await storedClips()).toHaveLength(1);
	});

	it("still runs the classifier in batches for a filtered person", async () => {
		await startLtx();
		const classifier = await import("../picture-check/classifier");
		const classify = vi.spyOn(classifier, "classifyPictureFrames");
		const takeId = await queueTake();
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		// 120 frames in batches of 16 = 8 runs.
		expect(classify).toHaveBeenCalledTimes(8);
	});
});

describe("the media phase's own deadline", () => {
	it("fails a take whose ffmpeg wedges, and frees the one video slot", async () => {
		const { chmod, writeFile } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "video-hanging-ffmpeg-"));
		const script = join(dir, "ffmpeg");
		await writeFile(script, "#!/bin/sh\nexec sleep 60\n");
		await chmod(script, 0o755);
		const before = process.env.PATH ?? "";
		process.env.PATH = `${dir}:${before}`;
		setMediaTimeoutMsForTests(200);
		try {
			await startLtx();
			const takeId = await queueTake();
			const started = Date.now();
			await drainVideoTakes();
			const take = await readTake(takeId);
			expect(take.status).toBe("failed");
			expect(take.errorCode).toBe("video_media_failed");
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(await storedClips()).toHaveLength(0);
			expect(clipFilesAnyOnDisk()).toEqual([]);
		} finally {
			process.env.PATH = before;
			setMediaTimeoutMsForTests(120_000);
			await rm(dir, { recursive: true, force: true });
		}

		// The slot is free: the next take renders normally on the same server.
		const next = await queueTake();
		await drainVideoTakes();
		const nextTake = await readTake(next);
		expect(nextTake.status, nextTake.errorCode ?? "").toBe("succeeded");
	});
});

describe("a restart mid-chain", () => {
	it("keeps a readable checkpoint with segment 1's clip while segment 2 renders", async () => {
		const server = await startLtx({ hangAfterPromptCount: 1 });
		const takeId = await queueTake({ durationSeconds: 10 });
		const draining = drainVideoTakes();
		await until(
			async () => promptRequests(server).length,
			(count) => count === 2,
		);
		const raw = await until(
			async () => (await readTake(takeId)).checkpoint,
			(value) => value !== null,
		);
		const checkpoint = parseVideoCheckpoint(raw);
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.segment).toBe(2);
		expect(checkpoint?.segments).toHaveLength(2);
		expect(checkpoint?.segments[0]?.promptId).toBeTruthy();
		expect(checkpoint?.segments[0]?.media).not.toBeNull();
		expect(checkpoint?.segments[1]?.promptId).toBeTruthy();
		expect(checkpoint?.segments[1]?.media).toBeNull();

		const { videoJob } = await import("./video-job");
		const { recover } = await import("$lib/server/services/jobs");
		await recover(videoJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		server.releaseHanging();
		await draining;
		await drainVideoTakes();
		await server.close();
		fake = null;
	});

	it("resumes a mid-segment-2 take by following segment 2, never re-rendering segment 1", async () => {
		const server = await startLtx({ hangAfterPromptCount: 1 });
		const takeId = await queueTake({ durationSeconds: 10 });
		const draining = drainVideoTakes();
		await until(
			async () => promptRequests(server).length,
			(count) => count === 2,
		);
		await until(
			async () => (await readTake(takeId)).checkpoint,
			(value) => value !== null,
		);
		// The worker dies: the engine takes the attempt back (keeps the
		// checkpoint) and aborts this run.
		const { videoJob } = await import("./video-job");
		const { recover } = await import("$lib/server/services/jobs");
		await recover(videoJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		// ComfyUI kept rendering segment 2 after the app died; release it before
		// the re-claimed job can follow it, so neither drain blocks on the hang.
		server.releaseHanging();
		await draining;

		// `video_worker_lost` requeues with a 2 s delay: the retry is claimable then.
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		await drainVideoTakes();

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(take.resultFileId).not.toBeNull();
		// Two prompts total: segment 1 was fetched from its recorded clip, never
		// rendered again.
		expect(promptRequests(server)).toHaveLength(2);
		const clips = await storedClips();
		expect(clips).toHaveLength(1);
		expect(clips[0]?.durationMs).toBe(10000);
	});
});

describe("the item a take was asked to append to", () => {
	async function seedItem(): Promise<string> {
		const { createArtifact } = await import("$lib/server/services/artifacts");
		const created = await createArtifact({
			userId,
			conversationId,
			kind: "video",
			title: "An older clip",
			body: serializeVideoVersionBody({
				v: 1,
				fileId: "older-file",
				posterFileId: "older-file",
				width: 64,
				height: 64,
				durationMs: 5000,
				sourceFileId: null,
			}),
			author: "alfy",
			versionSummary: "Alfy made the video",
		});
		if (!created.ok) throw new Error("could not seed the item");
		return created.artifact.id;
	}

	async function queueAnother(artifactId: string): Promise<string> {
		const stillId = await storeStill();
		const { enqueueVideoTake } = await import("./video-job");
		const { takeId } = await enqueueVideoTake({
			userId,
			conversationId,
			artifactId,
			toolCallId: "call-2",
			origin: "another",
			retryOf: null,
			request: request({ sourceFileId: stillId, artifactId }),
			seed: 2002,
		});
		return takeId;
	}

	it("fails video_item_deleted and leaves no clip when the item is deleted mid-take", async () => {
		await startLtx();
		const artifactId = await seedItem();
		const takeId = await queueAnother(artifactId);
		// The person deletes the item while the take is queued/rendering.
		const { deleteArtifact } = await import("$lib/server/services/artifacts");
		await deleteArtifact({ userId, artifactId });
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("video_item_deleted");
		await expect(storedClips()).resolves.toHaveLength(0);
		expect(clipFilesAnyOnDisk()).toEqual([]);
	});

	it("appends to the item it made when a worker is lost before the settle", async () => {
		await startLtx();
		const takeId = await queueTake();
		await drainVideoTakes();
		const first = await readTake(takeId);
		expect(first.status).toBe("succeeded");
		const artifactId = first.createdArtifactId;
		expect(artifactId).toBeTruthy();
		if (!artifactId) throw new Error("the take recorded no item");

		// The worker died before settling: the take is claimable again with the
		// item id it already recorded.
		const { db } = await import("$lib/server/db");
		db.update(schema.videoJobs)
			.set({
				status: "queued",
				checkpoint: null,
				resultFileId: null,
				completedAt: null,
				errorCode: null,
				errorMessage: null,
				currentAttemptId: null,
				startedAt: null,
				runAfter: null,
			})
			.where(eq(schema.videoJobs.id, takeId))
			.run();
		await drainVideoTakes();

		const artifacts = db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.conversationId, conversationId))
			.all();
		expect(artifacts).toHaveLength(1);
		const versions = db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, artifactId))
			.all();
		expect(versions).toHaveLength(2);
		expect((await readTake(takeId)).artifactId).toBe(artifactId);
	});

	it("takes the appended version back when the take is stopped after the store", async () => {
		await startLtx();
		const artifactId = await seedItem();
		const { db } = await import("$lib/server/db");
		const before = db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		const takeId = await queueAnother(artifactId);
		vi.doMock("$lib/server/services/artifacts", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("$lib/server/services/artifacts")>();
			return {
				...actual,
				updateArtifactBody: async (
					params: Parameters<typeof actual.updateArtifactBody>[0],
				) => {
					const written = await actual.updateArtifactBody(params);
					// The person's Stop lands in the store→settle window.
					const { cancelVideoTake } = await import("./video-job");
					await cancelVideoTake(userId, takeId, { interrupt: true });
					return written;
				},
			};
		});
		try {
			await drainVideoTakes();
		} finally {
			vi.doUnmock("$lib/server/services/artifacts");
		}
		const take = await readTake(takeId);
		expect(take.status).toBe("cancelled");
		await expect(storedClips()).resolves.toHaveLength(0);

		const item = db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		expect(item?.contentText).toBe(before?.contentText);
		const versions = db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, artifactId))
			.all();
		expect(versions).toHaveLength(1);
	});
});

describe("a re-rendered chain", () => {
	it("drops the older segment 2 when segment 1 has to be rendered again", async () => {
		const first = await startLtx();
		await queueTake();
		await drainVideoTakes();
		const promptId = [...first.prompts.keys()][0];
		if (!promptId) throw new Error("the first take recorded no prompt");
		const staleSegment2 = {
			promptId: "stale-segment-2",
			media: {
				filename: `fake_${promptId}.mp4`,
				subfolder: "",
				type: "output" as const,
			},
		};
		const takeId = await queueTake({ durationSeconds: 10 });
		const { db } = await import("$lib/server/db");
		db.update(schema.videoJobs)
			.set({
				checkpoint: JSON.stringify({
					promptId: "forgotten-segment-1",
					segment: 2,
					segments: [
						{ promptId: "forgotten-segment-1", media: null },
						staleSegment2,
					],
				}),
			})
			.where(eq(schema.videoJobs.id, takeId))
			.run();
		await drainVideoTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		// One POST for the first take, then BOTH segments rendered again: the
		// stale segment 2 must not be joined to a fresh segment 1.
		expect(promptRequests(first)).toHaveLength(3);
		expect(
			(await storedClips()).some((clip) => clip.durationMs === 10000),
		).toBe(true);
	});
});

describe("a letterboxed still", () => {
	it("floors each first-pass half to a multiple of 32", async () => {
		const server = await startLtx();
		const stillId = await storeStill(2560, 720);
		const { enqueueVideoTake } = await import("./video-job");
		const { takeId } = await enqueueVideoTake({
			userId,
			conversationId,
			artifactId: null,
			toolCallId: "call-1",
			origin: "turn",
			retryOf: null,
			request: request({ sourceFileId: stillId }),
			seed: 1001,
		});
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		// 1280 x 352 output; the template's half would be 176, whose latent
		// floors to 160 silently. The builder floors it explicitly.
		expect(
			nodeOfType(graphOf(promptRequests(server)[0]), "EmptyLTXVLatentVideo")
				.inputs,
		).toMatchObject({ width: 640, height: 160 });
	});
});

describe("the container's tags", () => {
	it("stores a clip without ComfyUI's prompt metadata", async () => {
		const tagged = await remuxWithMetadata(
			FAKE_VIDEO_BYTES,
			"comment",
			"the harbour at dusk, a slow tide",
		);
		await startLtx({ videoBytes: tagged });
		const takeId = await queueTake();
		await drainVideoTakes();
		expect((await readTake(takeId)).status).toBe("succeeded");
		const clip = (await storedClips())[0];
		if (!clip) throw new Error("No stored clip");
		const tags = JSON.stringify(await probeTags(await clipBytes(clip.id)));
		expect(tags).not.toContain("harbour");
	});
});
