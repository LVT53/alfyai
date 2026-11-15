import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	conversations,
	imageFiles,
	users,
	videoJobs,
} from "../../src/lib/server/db/schema";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "../../src/lib/server/services/images/comfyui/testing/fake-comfyui";
import { storeImageFile } from "../../src/lib/server/services/images/files";
import { probeDurationMs } from "../../src/lib/server/services/images/video/media";
import { enqueueVideoTake } from "../../src/lib/server/services/images/video/video-job";
import { parseVideoVersionBody } from "../../src/lib/shared/artifacts/video-body";
import { clearAdminConfig, login } from "./helpers";

// A video take, end to end on the server (docs/plans/ltx-video, slice 4): the
// real job engine claims the take, the real runner posts the LTX graph to a
// fake ComfyUI on a loopback port, decodes and joins the clips with the real
// ffmpeg, stores the mp4 with its poster and thumbnail, and writes the `video`
// artifact version. No GPU is involved. The card and the player are slice 3's
// spec; this one stays on the pipeline.
//
// The take is queued through the app's own `enqueueVideoTake` in this process,
// into the file the worker's server also writes; the server's idle tick claims
// it within five seconds. No chat turn is needed here (the tool slice's own
// tests cover `make_video`).

const CONFIG_KEYS = ["COMFYUI_LTX_URL"] as const;

type Graph = Record<
	string,
	{ class_type: string; inputs: Record<string, unknown> }
>;

let fake: FakeComfyUi;
let userId: string;
let conversationId: string;

async function adminId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"));
	if (!user) throw new Error("No seeded admin");
	return user.id;
}

async function seedConversation(): Promise<string> {
	const id = randomUUID();
	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId,
		title: "A video take",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function storeStill(width = 1920, height = 1080): Promise<string> {
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
	const file = await storeImageFile({
		userId,
		conversationId,
		role: "input",
		png,
	});
	return file.id;
}

async function queueTake(
	durationSeconds: 5 | 10,
): Promise<{ takeId: string; stillId: string }> {
	const stillId = await storeStill();
	const { takeId } = await enqueueVideoTake({
		userId,
		conversationId,
		artifactId: null,
		toolCallId: "e2e-video-call",
		origin: "turn",
		retryOf: null,
		request: {
			v: 1,
			prompt: "the harbour at dusk, a slow tide",
			durationSeconds,
			sourceFileId: stillId,
			title: "Harbour at dusk",
			summary: null,
			artifactId: null,
		},
		seed: 1001,
	});
	return { takeId, stillId };
}

async function waitForTake(takeId: string) {
	const deadline = Date.now() + 45_000;
	for (;;) {
		const [row] = await db
			.select()
			.from(videoJobs)
			.where(eq(videoJobs.id, takeId));
		if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) {
			return row;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`The take never settled; last status ${row?.status ?? "missing"}${
					row?.errorMessage ? `: ${row.errorMessage}` : ""
				}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function promptGraphs(server: FakeComfyUi): Graph[] {
	return server.requests
		.filter(
			(request) => request.method === "POST" && request.path === "/prompt",
		)
		.map((request) => (request.json as { prompt: Graph }).prompt);
}

function nodeOfType(graph: Graph, type: string): Record<string, unknown> {
	const found = Object.values(graph).find((node) => node.class_type === type);
	if (!found) throw new Error(`No ${type} node in the submitted graph`);
	return found.inputs;
}

async function storedClip() {
	const rows = await db
		.select()
		.from(imageFiles)
		.where(eq(imageFiles.conversationId, conversationId));
	return rows.find((row) => row.storagePath.endsWith(".mp4")) ?? null;
}

async function storedArtifact(fileId: string) {
	const [file] = await db
		.select({ artifactId: imageFiles.artifactId })
		.from(imageFiles)
		.where(eq(imageFiles.id, fileId));
	if (!file?.artifactId) return null;
	const [artifact] = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.id, file.artifactId));
	if (!artifact) return null;
	const [newest] = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifact.id))
		.orderBy(desc(artifactVersions.versionNumber));
	return { artifact, newest: newest ?? null };
}

test.beforeEach(async ({ page }) => {
	await login(page);
	userId = await adminId();
	conversationId = await seedConversation();
	fake = await createFakeComfyUi();
	const saved = await page.request.put("/api/admin/config", {
		data: { COMFYUI_LTX_URL: fake.baseUrl },
	});
	expect(saved.ok(), `video server set -> ${saved.status()}`).toBe(true);
});

test.afterEach(async ({ page }) => {
	await clearAdminConfig(page, [...CONFIG_KEYS]);
	await fake.close();
	// The chat's rows (its takes, its clip rows) go with it; the files are on
	// this process's disk too, under the same conversation id.
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await rm(join(process.cwd(), "data", "image-files", conversationId), {
		recursive: true,
		force: true,
	});
});

test("a 5 second take renders, stores and becomes a video artifact", async ({
	page,
}) => {
	const { takeId, stillId } = await queueTake(5);
	const take = await waitForTake(takeId);
	expect(take.status, take.errorMessage ?? "").toBe("succeeded");
	expect(take.resultFileId).not.toBeNull();

	const graphs = promptGraphs(fake);
	expect(graphs).toHaveLength(1);
	const graph = graphs[0] as Graph;
	// A 16:9 still: 1280 x 704 (720 snapped down to a multiple of 32), first
	// pass at half; 121 frames at 24 fps.
	expect(nodeOfType(graph, "EmptyLTXVLatentVideo")).toMatchObject({
		width: 640,
		height: 352,
		length: 121,
	});
	// The graph is the LTX one: the measured NVFP4 transformer, the conv video
	// VAE, the two img-to-video passes and a SaveVideo tail. Literals on
	// purpose: importing the graph module would pull in its JSON, which
	// Playwright's transform cannot load outside Vite.
	expect(nodeOfType(graph, "UNETLoader").unet_name).toBe(
		"ltx-2.5-22b-distilled-transformer-nvfp4.safetensors",
	);
	expect(
		Object.values(graph).filter(
			(node) => node.class_type === "LTXVImgToVideoInplace",
		),
	).toHaveLength(2);
	expect(nodeOfType(graph, "SaveVideo").format).toBe("mp4");
	expect(nodeOfType(graph, "VAELoader").vae_name).toBe(
		"ltx-2.5-video-vae-conv-bf16.safetensors",
	);
	expect(nodeOfType(graph, "ManualSigmas").sigmas).toBe(
		"1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
	);
	expect(nodeOfType(graph, "CLIPTextEncode").text).toBe(
		"the harbour at dusk, a slow tide",
	);

	const clip = await storedClip();
	expect(clip).not.toBeNull();
	if (!clip) throw new Error("No stored clip");
	expect(clip.durationMs).toBe(5000);
	expect(clip.width).toBe(64);
	expect(clip.height).toBe(64);
	for (const suffix of [".mp4", ".poster.webp", ".thumb.webp"]) {
		expect(
			existsSync(
				join(process.cwd(), clip.storagePath.replace(/\.mp4$/, suffix)),
			),
			suffix,
		).toBe(true);
	}
	expect(
		await probeDurationMs(
			await readFile(join(process.cwd(), clip.storagePath)),
		),
	).toBe(5_000);

	const stored = await storedArtifact(clip.id);
	expect(stored?.artifact.name).toBe("Harbour at dusk");
	expect(stored?.artifact.metadataJson).toContain('"artifactType":"video"');
	const body = parseVideoVersionBody(stored?.newest?.body ?? null);
	expect(body).toMatchObject({
		fileId: clip.id,
		durationMs: 5000,
		sourceFileId: stillId,
	});

	// The serving route answers the clip the pipeline stored.
	const served = await page.request.get(`/api/images/files/${clip.id}`);
	expect(served.status()).toBe(200);
	expect(served.headers()["content-type"]).toContain("video/mp4");
	expect((await served.body()).byteLength).toBeGreaterThan(1_000);
});

test("a 10 second take renders two chained segments and stores ten seconds", async () => {
	const { takeId } = await queueTake(10);
	const take = await waitForTake(takeId);
	expect(take.status, take.errorMessage ?? "").toBe("succeeded");

	const graphs = promptGraphs(fake);
	expect(graphs).toHaveLength(2);
	const first = graphs[0] as Graph;
	const second = graphs[1] as Graph;
	const firstSource = nodeOfType(first, "LoadImage").image;
	const secondSource = nodeOfType(second, "LoadImage").image;
	// The chain's second segment is guided by a picture of its own: the last
	// decoded frame of the first clip, uploaded by the runner.
	expect(secondSource).not.toBe(firstSource);
	expect(
		fake.requests.filter((request) => request.path === "/upload/image"),
	).toHaveLength(2);

	const clip = await storedClip();
	expect(clip).not.toBeNull();
	if (!clip) throw new Error("No stored clip");
	expect(clip.durationMs).toBe(10000);
	expect(
		await probeDurationMs(
			await readFile(join(process.cwd(), clip.storagePath)),
		),
	).toBeGreaterThan(9_500);
	const stored = await storedArtifact(clip.id);
	expect(parseVideoVersionBody(stored?.newest?.body ?? null)?.durationMs).toBe(
		10_000,
	);
});
