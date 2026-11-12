// @vitest-environment node
//
// The one client factory: which configured address it reaches for each picture
// model, including the model whose URL is NOT the selected one (idle-free needs
// both). Two real fakes stand in for the two picture servers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "./comfyui/testing/fake-comfyui";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

let fixture: ImageFixture;
let qwen: FakeComfyUi;
let h3: FakeComfyUi;

beforeEach(async () => {
	fixture = createImageFixture("image-comfy-client");
	process.env.DATABASE_PATH = fixture.dbPath;
	qwen = await createFakeComfyUi();
	h3 = await createFakeComfyUi();
	process.env.COMFYUI_URL = qwen.baseUrl;
	process.env.COMFYUI_H3_URL = h3.baseUrl;
	delete process.env.IMAGE_MODEL;
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	await qwen.close();
	await h3.close();
	fixture.cleanup();
	delete process.env.COMFYUI_URL;
	delete process.env.COMFYUI_H3_URL;
	delete process.env.IMAGE_MODEL;
	vi.restoreAllMocks();
});

function bytes(): Uint8Array {
	return new Uint8Array([1, 2, 3, 4]);
}

describe("createConfiguredComfyClient", () => {
	it("uses COMFYUI_H3_URL for h3 and COMFYUI_URL for qwen", async () => {
		const { createConfiguredComfyClient } = await import("./comfy-client");
		const qwenClient = createConfiguredComfyClient("qwen");
		const h3Client = createConfiguredComfyClient("h3");
		expect(qwenClient).not.toBeNull();
		expect(h3Client).not.toBeNull();
		if (!qwenClient || !h3Client) throw new Error("no client");

		await qwenClient.uploadImage(bytes(), "q.png");
		await h3Client.uploadImage(bytes(), "h.png");
		qwenClient.close();
		h3Client.close();

		expect(qwen.uploads.has("q.png")).toBe(true);
		expect(qwen.uploads.has("h.png")).toBe(false);
		expect(h3.uploads.has("h.png")).toBe(true);
		expect(h3.uploads.has("q.png")).toBe(false);
	});

	it("defaults to the selected model", async () => {
		process.env.IMAGE_MODEL = "h3";
		vi.resetModules();
		const { createConfiguredComfyClient } = await import("./comfy-client");
		const client = createConfiguredComfyClient();
		expect(client).not.toBeNull();
		await client?.uploadImage(bytes(), "selected.png");
		client?.close();
		expect(h3.uploads.has("selected.png")).toBe(true);
		expect(qwen.uploads.has("selected.png")).toBe(false);
	});

	it("reaches the non-selected model's service too, which the cross-model free needs", async () => {
		process.env.IMAGE_MODEL = "h3";
		vi.resetModules();
		const { createConfiguredComfyClient } = await import("./comfy-client");
		const qwenClient = createConfiguredComfyClient("qwen");
		expect(qwenClient).not.toBeNull();
		await qwenClient?.uploadImage(bytes(), "other-model.png");
		qwenClient?.close();
		expect(qwen.uploads.has("other-model.png")).toBe(true);
		expect(h3.uploads.has("other-model.png")).toBe(false);
	});

	it("returns null when that model's own address is empty", async () => {
		delete process.env.COMFYUI_H3_URL;
		vi.resetModules();
		const { createConfiguredComfyClient } = await import("./comfy-client");
		expect(createConfiguredComfyClient("h3")).toBeNull();
		// Qwen keeps its address: one model being off does not turn the other off.
		expect(createConfiguredComfyClient("qwen")).not.toBeNull();

		delete process.env.COMFYUI_URL;
		vi.resetModules();
		const fresh = await import("./comfy-client");
		expect(fresh.createConfiguredComfyClient("qwen")).toBeNull();
	});
});
