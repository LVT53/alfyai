// @vitest-environment node
//
// The picture check's classifier. The flagged path is held only through the
// stub (marker colours), never with a real explicit picture: none is kept,
// made or fetched anywhere for these tests. The real model is smoke-tested on
// safe pictures from the repository when its file is present.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyPicture,
	createOnnxPictureClassifier,
	type PictureCheckEngine,
	PictureCheckUnavailable,
	pictureCheckFileReady,
	STUB_EXPLICIT_COLOUR,
	STUB_UNAVAILABLE_COLOUR,
	usesStubClassifier,
} from "./classifier";
import { PICTURE_CHECK_MODEL } from "./model";

async function solid(colour: string, width = 64, height = 48) {
	return new Uint8Array(
		await sharp({
			create: { width, height, channels: 3, background: colour },
		})
			.png()
			.toBuffer(),
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the stub classifier (tests only)", () => {
	it("calls an ordinary picture safe", async () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		const verdict = await classifyPicture(await solid("#778899"));
		expect(verdict.explicit).toBe(false);
	});

	it("flags only the explicit marker colour", async () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		const verdict = await classifyPicture(await solid(STUB_EXPLICIT_COLOUR));
		expect(verdict.explicit).toBe(true);
	});

	it("cannot check the unavailable marker colour", async () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		await expect(
			classifyPicture(await solid(STUB_UNAVAILABLE_COLOUR)),
		).rejects.toBeInstanceOf(PictureCheckUnavailable);
	});

	it("is never used outside a test run, so a stray setting cannot switch the check off", () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		expect(usesStubClassifier()).toBe(true);
		vi.stubEnv("VITEST", "");
		vi.stubEnv("PLAYWRIGHT_TEST", "");
		expect(usesStubClassifier()).toBe(false);
	});
});

describe("the real classifier", () => {
	it("is unavailable when its model file is missing", async () => {
		const classifier = createOnnxPictureClassifier("/nonexistent/model.onnx");
		await expect(classifier.fileReady()).rejects.toBeInstanceOf(
			PictureCheckUnavailable,
		);
		await expect(
			classifier.classify(await solid("#778899")),
		).rejects.toBeInstanceOf(PictureCheckUnavailable);
	});

	it("is unavailable when the file is not the pinned model", async () => {
		const classifier = createOnnxPictureClassifier(
			join(process.cwd(), "package.json"),
		);
		await expect(classifier.fileReady()).rejects.toThrow(/SHA-256/);
	});

	it("reports ready through the stub too", async () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		await expect(pictureCheckFileReady()).resolves.toBeUndefined();
	});

	const modelPath = join(process.cwd(), PICTURE_CHECK_MODEL.path);
	it.skipIf(!existsSync(modelPath))(
		"smoke: calls safe pictures safe, quickly (model file present)",
		async () => {
			const classifier = createOnnxPictureClassifier(modelPath);
			// Load once outside the timings (hash and session build).
			await classifier.classify(await solid("#778899"));
			const safe = [
				"src/lib/server/services/images/guards/__fixtures__/room-0-base.png",
				"fixtures/mineru-v1/jpg/sample.jpg",
				"static/icon-512.png",
			];
			const times: number[] = [];
			for (const file of safe) {
				const png = new Uint8Array(
					await sharp(join(process.cwd(), file)).png().toBuffer(),
				);
				const verdict = await classifier.classify(png);
				expect(verdict.explicit, file).toBe(false);
				expect(verdict.score, file).toBeLessThan(0.1);
				times.push(verdict.ms);
			}
			// A safe 1248 x 832 picture, the size the picture server makes.
			const big = await sharp({
				create: {
					width: 1248,
					height: 832,
					channels: 3,
					background: "#6a8caf",
				},
			})
				.png()
				.toBuffer();
			const verdict = await classifier.classify(new Uint8Array(big));
			expect(verdict.explicit).toBe(false);
			times.push(verdict.ms);
			console.info("[picture-check smoke] ms per picture:", times);
			// fp32, measured 140-170 ms a check on the dev box (2 threads). A
			// generous bound so a busy box does not flake, well under the
			// check's own deadline and a render's 20-70 s.
			for (const ms of times) expect(ms).toBeLessThan(3_000);
		},
		60_000,
	);
});

describe("the classifier's life cycle (an injected engine, no model)", () => {
	let dir: string;
	let file: string;
	let bytes: Buffer;
	let sha256: string;

	async function setUp() {
		dir = await mkdtemp(join(tmpdir(), "picture-check-"));
		file = join(dir, "model.onnx");
		bytes = Buffer.from(`fake model ${Math.random()}`);
		await writeFile(file, bytes);
		sha256 = createHash("sha256").update(bytes).digest("hex");
	}

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	function engine(
		run: () => Promise<ArrayLike<number>> = async () => [3, -3],
	): PictureCheckEngine & { release: ReturnType<typeof vi.fn> } {
		return { run: vi.fn(run), release: vi.fn(async () => undefined) };
	}

	function counting() {
		const reads = vi.fn((path: string) => readFile(path));
		return reads;
	}

	it("ends a check that hangs as unavailable, and the next check runs on a fresh engine", async () => {
		await setUp();
		const hung = engine(() => new Promise<ArrayLike<number>>(() => undefined));
		const fresh = engine();
		const loadEngine = vi
			.fn()
			.mockResolvedValueOnce(hung)
			.mockResolvedValueOnce(fresh);
		const classifier = createOnnxPictureClassifier(file, {
			sha256,
			loadEngine,
			timeoutMs: 60,
		});
		const first = classifier.classify(await solid("#778899"));
		const second = classifier.classify(await solid("#778899"));
		await expect(first).rejects.toThrow(/timed out/);
		await expect(second).resolves.toMatchObject({ explicit: false });
		expect(loadEngine).toHaveBeenCalledTimes(2);
		expect(fresh.run).toHaveBeenCalledTimes(1);
	});

	it("ends a load that hangs as unavailable too", async () => {
		await setUp();
		const loadEngine = vi
			.fn()
			.mockReturnValueOnce(new Promise(() => undefined))
			.mockResolvedValueOnce(engine());
		const classifier = createOnnxPictureClassifier(file, {
			sha256,
			loadEngine,
			timeoutMs: 60,
		});
		await expect(classifier.classify(await solid("#778899"))).rejects.toThrow(
			/timed out/,
		);
		await expect(
			classifier.classify(await solid("#778899")),
		).resolves.toMatchObject({ explicit: false });
	});

	it("reads the file once per load and hands the engine those very bytes", async () => {
		await setUp();
		const readFileImpl = counting();
		const loadEngine = vi.fn(async () => engine());
		const classifier = createOnnxPictureClassifier(file, {
			sha256,
			loadEngine,
			readFile: readFileImpl,
		});
		await classifier.classify(await solid("#778899"));
		await classifier.classify(await solid("#778899"));
		expect(readFileImpl).toHaveBeenCalledTimes(1);
		expect(Buffer.from(loadEngine.mock.calls[0]?.[0] as Uint8Array)).toEqual(
			bytes,
		);
	});

	it("does not hash the file again after a failed load until the file changes", async () => {
		await setUp();
		const readFileImpl = counting();
		const loadEngine = vi.fn(async () => engine());
		const classifier = createOnnxPictureClassifier(file, {
			sha256: "0".repeat(64),
			loadEngine,
			readFile: readFileImpl,
		});
		for (let i = 0; i < 3; i++) {
			await expect(classifier.classify(await solid("#778899"))).rejects.toThrow(
				/SHA-256/,
			);
		}
		await expect(classifier.fileReady()).rejects.toThrow(/SHA-256/);
		expect(readFileImpl).toHaveBeenCalledTimes(1);
		const later = new Date(Date.now() + 5_000);
		await utimes(file, later, later);
		await expect(classifier.classify(await solid("#778899"))).rejects.toThrow(
			/SHA-256/,
		);
		expect(readFileImpl).toHaveBeenCalledTimes(2);
		expect(loadEngine).not.toHaveBeenCalled();
	});

	it("checks the file for Tool Health without loading the model, once until it changes", async () => {
		await setUp();
		const readFileImpl = counting();
		const loadEngine = vi.fn(async () => engine());
		const classifier = createOnnxPictureClassifier(file, {
			sha256,
			loadEngine,
			readFile: readFileImpl,
		});
		await classifier.fileReady();
		await classifier.fileReady();
		expect(readFileImpl).toHaveBeenCalledTimes(1);
		expect(loadEngine).not.toHaveBeenCalled();
		expect(classifier.loaded()).toBe(false);
	});

	it("lets the model go after a quiet spell and loads it again for the next check", async () => {
		await setUp();
		const first = engine();
		const second = engine();
		const loadEngine = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second);
		const classifier = createOnnxPictureClassifier(file, {
			sha256,
			loadEngine,
			idleMs: 40,
		});
		await classifier.classify(await solid("#778899"));
		expect(classifier.loaded()).toBe(true);
		await expect
			.poll(() => classifier.loaded(), { timeout: 2_000 })
			.toBe(false);
		expect(first.release).toHaveBeenCalledTimes(1);
		await classifier.classify(await solid("#778899"));
		expect(loadEngine).toHaveBeenCalledTimes(2);
		expect(second.run).toHaveBeenCalledTimes(1);
	});
});
