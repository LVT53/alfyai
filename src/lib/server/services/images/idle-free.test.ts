// @vitest-environment node
//
// GPU memory ownership: the idle timer frees BOTH configured picture services,
// and a take frees the OTHER model's service before it submits so the selected
// one loads into free memory. Two real fakes stand in for the two servers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "./comfyui/testing/fake-comfyui";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

let fixture: ImageFixture;
let qwen: FakeComfyUi;
let h3: FakeComfyUi;

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
	process.env.DATABASE_PATH = fixture.dbPath;
	qwen = await createFakeComfyUi();
	h3 = await createFakeComfyUi();
	process.env.COMFYUI_URL = qwen.baseUrl;
	process.env.COMFYUI_H3_URL = h3.baseUrl;
	delete process.env.IMAGE_MODEL;
	vi.resetModules();
});

afterEach(async () => {
	await qwen.close();
	await h3.close();
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	delete process.env.COMFYUI_URL;
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_MODEL;
	vi.restoreAllMocks();
});

describe("the idle free", () => {
	it("frees both configured services, not only the selected one", async () => {
		process.env.IMAGE_MODEL = "qwen";
		vi.resetModules();
		const { scheduleIdleFree } = await import("./idle-free");
		scheduleIdleFree({ delayMs: 5 });
		await until(() => freeCalls(qwen) > 0 && freeCalls(h3) > 0);
		expect(freeCalls(qwen)).toBe(1);
		expect(freeCalls(h3)).toBe(1);
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
