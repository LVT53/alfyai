// @vitest-environment node
//
// The image kind through the engine's own `drain`, against a real fake ComfyUI
// on a loopback port. The database is a migrated file; the picture files go to
// a temp working directory.

import { existsSync, readdirSync } from "node:fs";
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
import { createComfyUiClient } from "./comfyui/client";
import { buildPromptGraph, graphFor } from "./comfyui/templates";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "./comfyui/testing/fake-comfyui";
import { decodeRaw } from "./guards/raw-image";
import type { StoredTakeMeasures, TakeRequest } from "./take-request";
import { createImageFixture, type ImageFixture } from "./testing/fixture";
import { drainImageTakes, useFakeComfyUi } from "./testing/run-takes";

const userId = "user-1";
const conversationId = "conv-1";
const cardId = "card-1";

let fixture: ImageFixture;
let fake: FakeComfyUi | null = null;
let workdir: string;

async function startFake(
	options: Parameters<typeof createFakeComfyUi>[0] = {},
) {
	fake = await createFakeComfyUi(options);
	useFakeComfyUi(fake.baseUrl);
	return fake;
}

beforeAll(async () => {
	await warmModules([
		() => import("./image-job"),
		() => import("./image-runner"),
		() => import("./files"),
		() => import("./idle-free"),
		() => import("./cards"),
		() => import("$lib/server/services/jobs"),
	]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-runner");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	fixture.seedCard({ id: cardId, userId, conversationId });
	workdir = await mkdtemp(join(tmpdir(), "image-runner-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	vi.useRealTimers();
	await fake?.close();
	fake = null;
	useFakeComfyUi(null);
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.restoreAllMocks();
	vi.doUnmock("./files");
	await rm(workdir, { recursive: true, force: true });
});

function request(overrides: Partial<TakeRequest> = {}): TakeRequest {
	return {
		v: 1,
		mode: "generate",
		prompt: "a cosy living room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 1248, height: 832 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy living room",
		summary: null,
		...overrides,
	};
}

/** A picture with texture everywhere (blocks of pseudo-random colour), so alignment has something to hold on to. */
async function photo(width: number, height: number): Promise<Uint8Array> {
	const data = Buffer.alloc(width * height * 3);
	const cell = (x: number, y: number, channel: number) => {
		let h = (x * 374761393 + y * 668265263 + channel * 2147483647) >>> 0;
		h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
		return (h ^ (h >>> 16)) & 255;
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3;
			for (let c = 0; c < 3; c++) {
				data[at + c] = cell(Math.floor(x / 6), Math.floor(y / 6), c);
			}
		}
	}
	return new Uint8Array(
		await sharp(data, { raw: { width, height, channels: 3 } })
			.png()
			.toBuffer(),
	);
}

async function storeInput(png: Uint8Array): Promise<string> {
	const { storeImageFile } = await import("./files");
	const file = await storeImageFile({
		userId,
		conversationId,
		role: "input",
		png,
	});
	return file.id;
}

async function queueTake(req: TakeRequest, seed = 4242): Promise<string> {
	const { enqueueTake } = await import("./image-job");
	const { takeId } = await enqueueTake({
		userId,
		conversationId,
		cardId,
		toolCallId: "call-1",
		origin: "turn",
		retryOf: null,
		request: req,
		seed,
		heldUntil: null,
	});
	return takeId;
}

async function readTake(takeId: string) {
	const { db } = await import("$lib/server/db");
	const row = db
		.select()
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.get();
	if (!row) throw new Error(`No take ${takeId}`);
	return row;
}

async function until<T>(
	read: () => Promise<T> | T,
	done: (value: T) => boolean,
	timeoutMs = 10_000,
): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Gave up waiting; last value: ${JSON.stringify(value)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

async function resultBytes(takeId: string): Promise<Uint8Array> {
	const take = await readTake(takeId);
	if (!take.resultFileId) throw new Error("The take has no result file");
	const { getImageFile, readImageFileBytes } = await import("./files");
	const file = await getImageFile({
		userId,
		fileId: take.resultFileId,
		conversationId,
	});
	if (!file) throw new Error("Result file not found");
	return readImageFileBytes(file, "full");
}

describe("a new picture", () => {
	it("renders to a stored PNG and passes every phase", async () => {
		// A small canvas: the fake paints, and the runner decodes, guards and
		// stores, every pixel in JS, which at the full size is seconds of CPU
		// under a loaded run. The phases do not depend on the size.
		await startFake({ steps: 4, stepDelayMs: 40 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 192 } }),
		);

		const seen: string[] = [];
		const watching = (async () => {
			for (let i = 0; i < 400; i++) {
				const row = await readTake(takeId);
				if (row.phase && seen.at(-1) !== row.phase) seen.push(row.phase);
				if (row.status === "succeeded") return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		})();
		await drainImageTakes();
		await watching;

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(take.progressPercent).toBe(100);
		expect(take.measuresJson).toBeNull();
		expect(take.resultFileId).not.toBeNull();
		expect(seen).toEqual(["submitted", "starting", "rendering", "finishing"]);
		const meta = await sharp(await resultBytes(takeId)).metadata();
		expect(meta).toMatchObject({ format: "png", width: 256, height: 192 });
	});
});

describe("landing on a card", () => {
	it("makes a take that lands unheld the card's version in use", async () => {
		await startFake({ steps: 2 });
		const takeId = await queueTake(request());
		await drainImageTakes();

		const { db } = await import("$lib/server/db");
		const card = db
			.select()
			.from(schema.imageCards)
			.where(eq(schema.imageCards.id, cardId))
			.get();
		expect(card?.pickedTakeId).toBe(takeId);
		expect(card?.artifactId).toBeTruthy();
		expect((await readTake(takeId)).versionNumber).toBe(1);
	});
});

describe("an edit", () => {
	it("keeps everything it did not change", async () => {
		await startFake();
		const base = await photo(640, 480);
		const baseId = await storeInput(base);
		const takeId = await queueTake(
			request({
				mode: "edit",
				prompt: "make the middle red",
				inputs: [{ fileId: baseId, role: "base", name: "room.png" }],
				baseFromUpload: true,
				canvas: { width: 640, height: 480 },
			}),
		);
		await drainImageTakes();

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		const measures = JSON.parse(
			take.measuresJson ?? "null",
		) as StoredTakeMeasures;
		expect(measures.miss).toBeNull();
		expect(measures).toHaveProperty("chainSinceAnchor");
		expect(measures).toHaveProperty("anchorIsResult");

		const kept = await decodeRaw(await resultBytes(takeId));
		const original = await decodeRaw(base, { width: 640, height: 480 });
		expect(kept.width).toBe(640);
		expect(kept.height).toBe(480);
		// The fake recolours a square of 20% of the short side in the middle.
		let compared = 0;
		for (let y = 0; y < kept.height; y++) {
			for (let x = 0; x < kept.width; x++) {
				if (Math.abs(x - 320) <= 96 && Math.abs(y - 240) <= 96) continue;
				const at = (y * kept.width + x) * 4;
				for (let c = 0; c < 4; c++) {
					if (kept.data[at + c] !== original.data[at + c]) {
						throw new Error(`Pixel ${x},${y} channel ${c} changed`);
					}
				}
				compared += 1;
			}
		}
		expect(compared).toBeGreaterThan(200_000);
	});
});

describe("waiting in ComfyUI's queue", () => {
	it("writes how many are ahead", async () => {
		const comfy = await startFake();
		comfy.holdQueue(true);
		const other = graphFor("generate", false);
		if (!other) throw new Error("no generate graph");
		const client = createComfyUiClient({ baseUrl: comfy.baseUrl });
		await client.submit(
			buildPromptGraph(other.template, {
				prompt: "someone else",
				seed: 1,
				width: 256,
				height: 256,
				images: [],
			}),
		);
		client.close();

		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		const waiting = await until(
			() => readTake(takeId),
			(row) => row.queueAhead === 1,
		);
		expect(waiting.status).toBe("running");
		comfy.holdQueue(false);
		await draining;
		expect((await readTake(takeId)).status).toBe("succeeded");
	});

	it("deletes the prompt when stopped while it waits", async () => {
		const comfy = await startFake();
		comfy.holdQueue(true);
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.checkpoint !== null,
		);
		const { cancelTake } = await import("./image-job");
		expect(await cancelTake(userId, takeId)).toBe(true);
		await draining;

		expect((await readTake(takeId)).status).toBe("cancelled");
		await until(
			() => [...comfy.prompts.values()],
			(statuses) => !statuses.includes("pending"),
		);
		expect(comfy.requests.some((r) => r.path === "/interrupt")).toBe(false);
	});

	it("deletes a waiting prompt on the composer's Stop too", async () => {
		const comfy = await startFake();
		comfy.holdQueue(true);
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.checkpoint !== null,
		);
		const { cancelTake } = await import("./image-job");
		expect(await cancelTake(userId, takeId, { interrupt: false })).toBe(true);
		await draining;
		expect((await readTake(takeId)).status).toBe("cancelled");
		expect([...comfy.prompts.values()]).not.toContain("pending");
	});
});

describe("stopping a render", () => {
	it("interrupts our own prompt when the card's Stop is pressed", async () => {
		const comfy = await startFake({ steps: 30, stepDelayMs: 100 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.phase === "rendering",
		);
		const promptId = [...comfy.prompts.keys()][0];
		const { cancelTake } = await import("./image-job");
		expect(await cancelTake(userId, takeId)).toBe(true);
		await draining;

		expect((await readTake(takeId)).status).toBe("cancelled");
		const interrupt = comfy.requests.find((r) => r.path === "/interrupt");
		expect(interrupt?.json).toEqual({ prompt_id: promptId });
	});

	it("leaves a started render alone when the composer's Stop is pressed", async () => {
		const comfy = await startFake({ steps: 6, stepDelayMs: 80 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.phase === "rendering",
		);
		const { cancelTake } = await import("./image-job");
		expect(await cancelTake(userId, takeId, { interrupt: false })).toBe(false);
		await draining;

		expect((await readTake(takeId)).status).toBe("succeeded");
		expect(comfy.requests.some((r) => r.path === "/interrupt")).toBe(false);
	});
});

describe("when ComfyUI cannot render", () => {
	it("fails fast and retryable when it is down", async () => {
		const comfy = await startFake();
		await comfy.close();
		const takeId = await queueTake(request());
		const started = Date.now();
		await drainImageTakes();

		expect(Date.now() - started).toBeLessThan(3000);
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("image_server_unreachable");
		expect(take.retryable).toBe(true);
		expect(take.attemptCount).toBe(1);
	});

	it("does not retry a refused graph", async () => {
		await startFake({ fail: "reject" });
		const takeId = await queueTake(request());
		await drainImageTakes();
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("image_graph_rejected");
		expect(take.retryable).toBe(false);
	});

	it("calls a failed render retryable", async () => {
		await startFake({ fail: "execution" });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		await drainImageTakes();
		const take = await readTake(takeId);
		expect(take.errorCode).toBe("image_render_failed");
		expect(take.retryable).toBe(true);
	});

	it("does not retry a take whose input picture is gone", async () => {
		await startFake();
		const takeId = await queueTake(
			request({
				mode: "edit",
				inputs: [{ fileId: "no-such-file", role: "base", name: "room.png" }],
				canvas: { width: 256, height: 256 },
			}),
		);
		await drainImageTakes();
		const take = await readTake(takeId);
		expect(take.errorCode).toBe("image_input_missing");
		expect(take.retryable).toBe(false);
	});

	it("resumes the same prompt when the worker was lost after submitting", async () => {
		const comfy = await startFake({ steps: 3, stepDelayMs: 20 });
		comfy.holdQueue(true);
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const firstRun = drainImageTakes();
		const submitted = await until(
			() => readTake(takeId),
			(row) => row.checkpoint !== null,
		);
		const promptId = (
			JSON.parse(submitted.checkpoint ?? "{}") as { promptId: string }
		).promptId;

		// The worker stops beating: the engine takes the attempt back and requeues it.
		const { recover } = await import("$lib/server/services/jobs");
		const { imageJob } = await import("./image-job");
		await recover(imageJob, { staleBefore: new Date(Date.now() + 60_000) });
		await firstRun;
		const requeued = await readTake(takeId);
		expect(requeued.status).toBe("queued");
		expect(requeued.checkpoint).not.toBeNull();

		comfy.holdQueue(false);
		fixture.sqlite.exec("UPDATE image_jobs SET run_after = NULL");
		await drainImageTakes();

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(take.attemptCount).toBe(2);
		expect(comfy.requests.filter((r) => r.path === "/prompt")).toHaveLength(1);
		expect([...comfy.prompts.keys()]).toEqual([promptId]);
	});

	it("submits once more when ComfyUI restarted and forgot the prompt", async () => {
		const comfy = await startFake({ steps: 10, stepDelayMs: 100 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.phase === "rendering",
		);
		comfy.restart();
		await draining;

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(comfy.requests.filter((r) => r.path === "/prompt")).toHaveLength(2);
	}, 30_000);

	it("gives up after one more submit", async () => {
		const comfy = await startFake({ steps: 10, stepDelayMs: 100 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.phase === "rendering",
		);
		comfy.restart();
		await until(
			() => comfy.requests.filter((r) => r.path === "/prompt").length,
			(count) => count === 2,
		);
		comfy.restart();
		await draining;
		const take = await readTake(takeId);
		expect(take.status).toBe("failed");
		expect(take.errorCode).toBe("image_result_missing");
		expect(take.retryable).toBe(true);
	}, 30_000);
});

describe("freeing ComfyUI", () => {
	it("frees it once when nothing is queued or running", async () => {
		const comfy = await startFake();
		const { freeIfIdle } = await import("./idle-free");
		const client = createComfyUiClient({ baseUrl: comfy.baseUrl });
		expect(await freeIfIdle(client)).toBe(true);
		client.close();
		expect(comfy.requests.filter((r) => r.path === "/free")).toHaveLength(1);
	});

	it("does not free it while ComfyUI has work queued", async () => {
		const comfy = await startFake();
		comfy.holdQueue(true);
		const other = graphFor("generate", false);
		if (!other) throw new Error("no generate graph");
		const client = createComfyUiClient({ baseUrl: comfy.baseUrl });
		await client.submit(
			buildPromptGraph(other.template, {
				prompt: "x",
				seed: 1,
				width: 256,
				height: 256,
				images: [],
			}),
		);
		const { freeIfIdle } = await import("./idle-free");
		expect(await freeIfIdle(client)).toBe(false);
		client.close();
		expect(comfy.requests.filter((r) => r.path === "/free")).toHaveLength(0);
	});

	it("does not free it while a take is live in the app", async () => {
		const comfy = await startFake();
		await queueTake(request());
		const { freeIfIdle } = await import("./idle-free");
		const client = createComfyUiClient({ baseUrl: comfy.baseUrl });
		expect(await freeIfIdle(client)).toBe(false);
		client.close();
		expect(comfy.requests.filter((r) => r.path === "/free")).toHaveLength(0);
	});

	it("frees it after a quiet spell when the timer fires", async () => {
		const comfy = await startFake();
		const { scheduleIdleFree, IMAGE_IDLE_FREE_MS } = await import(
			"./idle-free"
		);
		expect(IMAGE_IDLE_FREE_MS).toBe(15 * 60_000);
		scheduleIdleFree({ delayMs: 20 });
		await until(
			() => comfy.requests.filter((r) => r.path === "/free").length,
			(count) => count === 1,
			2000,
		);
	});

	it("re-arms one timer, so two schedules free once", async () => {
		const comfy = await startFake();
		const { scheduleIdleFree } = await import("./idle-free");
		scheduleIdleFree({ delayMs: 20 });
		scheduleIdleFree({ delayMs: 20 });
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(comfy.requests.filter((r) => r.path === "/free")).toHaveLength(1);
	});
});

describe("stopping takes in bulk", () => {
	it("cancels a chat's takes without touching another chat's", async () => {
		fixture.seedConversation("conv-2", userId);
		fixture.seedCard({ id: "card-2", userId, conversationId: "conv-2" });
		const mine = await queueTake(request());
		const { enqueueTake, cancelImageTakesForConversation } = await import(
			"./image-job"
		);
		const { takeId: other } = await enqueueTake({
			userId,
			conversationId: "conv-2",
			cardId: "card-2",
			toolCallId: null,
			origin: "turn",
			retryOf: null,
			request: request(),
			seed: 5,
			heldUntil: null,
		});
		expect(
			await cancelImageTakesForConversation(userId, conversationId),
		).toEqual({
			cancelled: 1,
		});
		expect((await readTake(mine)).status).toBe("cancelled");
		expect((await readTake(other)).status).toBe("queued");
	});

	it("cancels all of a person's takes and lets a stopped one be retried", async () => {
		const first = await queueTake(request());
		const second = await queueTake(request());
		const { cancelImageTakesForUser, retryTake } = await import("./image-job");
		expect(await cancelImageTakesForUser(userId)).toEqual({ cancelled: 2 });
		expect((await readTake(first)).status).toBe("cancelled");
		expect(await retryTake(userId, second)).toBe(true);
		expect((await readTake(second)).status).toBe("queued");
		expect(await retryTake("someone-else", first)).toBe(false);
	});
});

describe("a picture server that goes dark mid-render", () => {
	it("is waited for, then the take is submitted once more", async () => {
		const comfy = await startFake({ steps: 10, stepDelayMs: 100 });
		const takeId = await queueTake(
			request({ canvas: { width: 256, height: 256 } }),
		);
		const draining = drainImageTakes();
		await until(
			() => readTake(takeId),
			(row) => row.phase === "rendering",
		);
		// Connection refused for a while, then back with no memory of the prompt.
		comfy.outage(2500);
		await draining;

		const take = await readTake(takeId);
		expect(take.status).toBe("succeeded");
		expect(comfy.requests.filter((r) => r.path === "/prompt")).toHaveLength(2);
	}, 40_000);
});

describe("the seed", () => {
	it("is never one that made an input", async () => {
		const takeId = await queueTake(request({ avoidSeeds: [4242, 7] }), 4242);
		const take = await readTake(takeId);
		expect(take.seed).not.toBe(4242);
		expect(take.seed).not.toBe(7);
		const fine = await queueTake(request({ avoidSeeds: [7] }), 99);
		expect((await readTake(fine)).seed).toBe(99);
	});
});

describe("a take stopped while its picture is stored", () => {
	function picturesOnDisk(): string[] {
		const dir = join(workdir, "data", "image-files", conversationId);
		return existsSync(dir) ? readdirSync(dir) : [];
	}

	async function withStoreHook(after: () => Promise<void> | void) {
		vi.doMock("./files", async () => {
			const actual = await vi.importActual<typeof import("./files")>("./files");
			return {
				...actual,
				storeImageFile: async (
					params: Parameters<typeof actual.storeImageFile>[0],
				) => {
					const file = await actual.storeImageFile(params);
					await after();
					return file;
				},
			};
		});
	}

	it("leaves no file when the stop reaches the run before it succeeds", async () => {
		await startFake();
		let takeId = "";
		await withStoreHook(async () => {
			const { cancelTake } = await import("./image-job");
			await cancelTake(userId, takeId);
		});
		takeId = await queueTake(request({ canvas: { width: 256, height: 256 } }));
		await drainImageTakes();

		expect((await readTake(takeId)).status).toBe("cancelled");
		expect(picturesOnDisk()).toEqual([]);
		expect(fixture.sqlite.prepare("SELECT id FROM image_files").all()).toEqual(
			[],
		);
	});

	it("leaves no file when the chat was deleted and its cleanup already ran", async () => {
		await startFake();
		await withStoreHook(() => {
			// The chat goes (rows cascade) after the files were stored.
			fixture.sqlite.exec("DELETE FROM conversations");
		});
		await queueTake(request({ canvas: { width: 256, height: 256 } }));
		await drainImageTakes();

		expect(picturesOnDisk()).toEqual([]);
	});
});
