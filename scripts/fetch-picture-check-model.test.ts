// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchPictureCheckModel } from "./fetch-picture-check-model";

const BYTES = Buffer.from("not a real model, only bytes to hash");
const SHA = createHash("sha256").update(BYTES).digest("hex");

let dir: string;
let server: Server;
let url: string;
let hits = 0;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "picture-check-model-"));
	hits = 0;
	server = createServer((_request, response) => {
		hits += 1;
		response.end(BYTES);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	url = `http://127.0.0.1:${address.port}/model.onnx`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

describe("fetching the picture check's model", () => {
	it("downloads the pinned file once and keeps it", async () => {
		const dest = join(dir, "models", "model.onnx");
		const model = { url, sha256: SHA, bytes: BYTES.length };
		expect(await fetchPictureCheckModel({ ...model, dest })).toBe("fetched");
		expect(readFileSync(dest)).toEqual(BYTES);
		expect(await fetchPictureCheckModel({ ...model, dest })).toBe("present");
		expect(hits).toBe(1);
	});

	it("refuses a file that does not hash to the pin and leaves nothing behind", async () => {
		const dest = join(dir, "model.onnx");
		await expect(
			fetchPictureCheckModel({
				url,
				sha256: "0".repeat(64),
				bytes: BYTES.length,
				dest,
			}),
		).rejects.toThrow(/SHA-256/);
		expect(existsSync(dest)).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});
});
