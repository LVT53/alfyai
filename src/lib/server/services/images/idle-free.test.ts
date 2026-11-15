// @vitest-environment node
//
// GPU memory ownership: the idle timer frees BOTH configured picture services,
// and a take frees the OTHER model's service before it submits so the selected
// one loads into free memory. Two real fakes stand in for the two servers.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "./comfyui/testing/fake-comfyui";
import { setOtherEngineWaitForTests } from "./idle-free";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

const userId = "user-1";
const conversationId = "conv-1";
const cardId = "card-1";

let fixture: ImageFixture;
let qwen: FakeComfyUi;
let h3: FakeComfyUi;
let ltx: FakeComfyUi;

function freeCalls(fake: FakeComfyUi): number {
	return fake.requests.filter((request) => request.path === "/free").length;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for the free calls");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeEach(async () => {
	fixture = createImageFixture("image-idle-free");
	fixture.seedUser("user-1");
	fixture.seedConversation("conv-1", "user-1");
	fixture.seedCard({
		id: "card-1",
		userId: "user-1",
		conversationId: "conv-1",
	});
	process.env.DATABASE_PATH = fixture.dbPath;
	qwen = await createFakeComfyUi();
	h3 = await createFakeComfyUi();
	ltx = await createFakeComfyUi();
	process.env.COMFYUI_URL = qwen.baseUrl;
	process.env.COMFYUI_H3_URL = h3.baseUrl;
	process.env.COMFYUI_LTX_URL = ltx.baseUrl;
	delete process.env.IMAGE_MODEL;
	vi.resetModules();
});

afterEach(async () => {
	await qwen.close();
	await h3.close();
	await ltx.close();
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	delete process.env.COMFYUI_URL;
	delete process.env.COMFYUI_H3_URL;
	delete process.env.COMFYUI_LTX_URL;
	delete process.env.IMAGE_MODEL;
	setOtherEngineWaitForTests(undefined);
	vi.restoreAllMocks();
});

describe("the idle free", () => {
	it("frees both configured services, not only the selected one", async () => {
		process.env.IMAGE_MODEL = "qwen";
		vi.resetModules();
		const { scheduleIdleFree } = await import("./idle-free");
		scheduleIdleFree({ delayMs: 5 });
		await until(
			() => freeCalls(qwen) > 0 && freeCalls(h3) > 0 && freeCalls(ltx) > 0,
		);
		expect(freeCalls(qwen)).toBe(1);
		expect(freeCalls(h3)).toBe(1);
		expect(freeCalls(ltx)).toBe(1);
	});

	it("does not free the same address twice when both models point at it", async () => {
		process.env.COMFYUI_H3_URL = qwen.baseUrl;
		vi.resetModules();
		const { scheduleIdleFree } = await import("./idle-free");
		scheduleIdleFree({ delayMs: 5 });
		await until(() => freeCalls(qwen) > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(freeCalls(qwen)).toBe(1);
		expect(freeCalls(h3)).toBe(0);
	});

	it("frees only the configured services", async () => {
		delete process.env.COMFYUI_H3_URL;
		delete process.env.COMFYUI_LTX_URL;
		vi.resetModules();
		const { scheduleIdleFree } = await import("./idle-free");
		scheduleIdleFree({ delayMs: 5 });
		await until(() => freeCalls(qwen) > 0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(freeCalls(h3)).toBe(0);
	});
});

describe("the pre-take cross-model free", () => {
	it("frees the other model's service, never the take's own", async () => {
		const { freeOtherPictureModel } = await import("./idle-free");
		await freeOtherPictureModel("h3");
		expect(freeCalls(qwen)).toBe(1);
		expect(freeCalls(h3)).toBe(0);

		await freeOtherPictureModel("qwen");
		expect(freeCalls(h3)).toBe(1);
		expect(freeCalls(qwen)).toBe(1);
		// The video engine is freed before BOTH picture takes.
		expect(freeCalls(ltx)).toBe(2);
	});

	it("skips a service that shares the take's own address", async () => {
		process.env.COMFYUI_H3_URL = qwen.baseUrl;
		vi.resetModules();
		const { freeOtherPictureModel } = await import("./idle-free");
		await freeOtherPictureModel("h3");
		expect(freeCalls(qwen)).toBe(0);
	});

	it("ignores an unreachable other service", async () => {
		process.env.COMFYUI_URL = "http://127.0.0.1:9";
		vi.resetModules();
		const { freeOtherPictureModel } = await import("./idle-free");
		await expect(freeOtherPictureModel("h3")).resolves.toBeUndefined();
		expect(freeCalls(h3)).toBe(0);
	});
});

describe("every other engine", () => {
	it("lists every engine except the take's own", async () => {
		const { otherPictureModels } = await import("./idle-free");
		expect(otherPictureModels("qwen")).toEqual(["h3", "ltx"]);
		expect(otherPictureModels("h3")).toEqual(["qwen", "ltx"]);
		expect(otherPictureModels("ltx")).toEqual(["qwen", "h3"]);
		for (const engine of ["qwen", "h3", "ltx"] as const) {
			expect(otherPictureModels(engine), engine).not.toContain(engine);
		}
	});

	it("frees every other engine before a video take, never the LTX server", async () => {
		const { freeOtherPictureModels } = await import("./idle-free");
		await freeOtherPictureModels("ltx");
		expect(freeCalls(qwen)).toBe(1);
		expect(freeCalls(h3)).toBe(1);
		expect(freeCalls(ltx)).toBe(0);
	});

	it("frees the video engine before a picture take too", async () => {
		const { freeOtherPictureModels } = await import("./idle-free");
		await freeOtherPictureModels("qwen");
		expect(freeCalls(ltx)).toBe(1);
		expect(freeCalls(qwen)).toBe(0);
	});

	it("skips an engine sharing the take's own address", async () => {
		process.env.COMFYUI_LTX_URL = qwen.baseUrl;
		vi.resetModules();
		const { freeOtherPictureModels } = await import("./idle-free");
		await freeOtherPictureModels("qwen");
		expect(freeCalls(qwen)).toBe(0);
	});
});

describe("the cross-engine gate", () => {
	/** The waiting take is newer than anything queued before it. */
	function claim(): { id: string; phaseAt: number } {
		return { id: "current-take", phaseAt: Date.now() };
	}

	/** A claimed take: the gate only sees takes that are on (or in) the GPU. */
	async function markRunning(takeId: string): Promise<void> {
		const { db } = await import("$lib/server/db");
		db.update(schema.imageJobs)
			.set({
				status: "running",
				phase: "submitted",
				phaseAt: Date.now() - 1_000,
			})
			.where(eq(schema.imageJobs.id, takeId))
			.run();
	}

	async function queueH3Take(): Promise<string> {
		const { enqueueTake: enqueuePictureTake } = await import("./image-job");
		return enqueuePictureTake({
			userId,
			conversationId,
			cardId,
			toolCallId: null,
			origin: "turn",
			retryOf: null,
			request: {
				v: 1,
				model: "h3",
				mode: "generate",
				prompt: "a quiet room",
				inputs: [],
				baseFromUpload: false,
				canvas: { width: 256, height: 192 },
				transparent: false,
				avoidSeeds: [],
				anchor: null,
				marks: null,
				title: "A quiet room",
				summary: null,
			},
			seed: 1,
			heldUntil: null,
		}).then(({ takeId }) => takeId);
	}

	it("is idle at once when no other engine has a take", async () => {
		const { waitForOtherEnginesIdle } = await import("./idle-free");
		await expect(
			waitForOtherEnginesIdle("qwen", {
				signal: new AbortController().signal,
				deadlineMs: 1_000,
				claim: claim(),
			}),
		).resolves.toBe("idle");
	});

	it("waits for another engine's live take, then reports idle when it settles", async () => {
		setOtherEngineWaitForTests({ intervalMs: 20 });
		const takeId = await queueH3Take();
		await markRunning(takeId);
		const { waitForOtherEnginesIdle } = await import("./idle-free");
		const { cancelImageTakesForUser } = await import("./image-job");
		const waiting = waitForOtherEnginesIdle("qwen", {
			signal: new AbortController().signal,
			deadlineMs: 2_000,
			claim: claim(),
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		await cancelImageTakesForUser(userId);
		await expect(waiting).resolves.toBe("idle");
		void takeId;
	});

	it("gives up at its deadline while the other engine is still live", async () => {
		setOtherEngineWaitForTests({ intervalMs: 20, deadlineMs: 80 });
		const takeId = await queueH3Take();
		await markRunning(takeId);
		const { waitForOtherEnginesIdle } = await import("./idle-free");
		await expect(
			waitForOtherEnginesIdle("qwen", {
				signal: new AbortController().signal,
				deadlineMs: 60_000,
				claim: claim(),
			}),
		).resolves.toBe("timeout");
	});

	it("reports cancelled when the take's Stop aborts the wait", async () => {
		setOtherEngineWaitForTests({ intervalMs: 20 });
		const takeId = await queueH3Take();
		await markRunning(takeId);
		const { waitForOtherEnginesIdle } = await import("./idle-free");
		const controller = new AbortController();
		const waiting = waitForOtherEnginesIdle("qwen", {
			signal: controller.signal,
			deadlineMs: 60_000,
			claim: claim(),
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		controller.abort(new Error("cancelled"));
		await expect(waiting).resolves.toBe("cancelled");
	});

	it("never frees an engine with a live take, and frees it once that take is gone", async () => {
		const { freeOtherPictureModels } = await import("./idle-free");
		await queueH3Take();
		await freeOtherPictureModels("qwen");
		expect(freeCalls(h3)).toBe(0);
		expect(freeCalls(ltx)).toBe(1);

		const { cancelImageTakesForUser } = await import("./image-job");
		await cancelImageTakesForUser(userId);
		await freeOtherPictureModels("qwen");
		expect(freeCalls(h3)).toBe(1);
	});

	it("does not free the video engine while a video take is live", async () => {
		const { freeOtherPictureModels } = await import("./idle-free");
		const { enqueueVideoTake } = await import("./video/video-job");
		await enqueueVideoTake({
			userId,
			conversationId,
			artifactId: null,
			toolCallId: null,
			origin: "turn",
			retryOf: null,
			request: {
				v: 1,
				prompt: "the harbour at dusk",
				durationSeconds: 5,
				sourceFileId: "still-1",
				title: "Harbour",
				summary: null,
				artifactId: null,
			},
			seed: 1,
		});
		await freeOtherPictureModels("qwen");
		expect(freeCalls(ltx)).toBe(0);
		expect(freeCalls(h3)).toBe(1);
	});
});
