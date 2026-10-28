// @vitest-environment node
//
// The picture check's classifier. The flagged path is held only through the
// stub (marker colours), never with a real explicit picture: none is kept,
// made or fetched anywhere for these tests. The real model is smoke-tested on
// safe pictures from the repository when its file is present.

import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyPicture,
	createOnnxPictureClassifier,
	PictureCheckUnavailable,
	pictureCheckReady,
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
		const classifier = createOnnxPictureClassifier(
			"/nonexistent/model.onnx",
		);
		await expect(classifier.ready()).rejects.toBeInstanceOf(
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
		await expect(classifier.ready()).rejects.toThrow(/SHA-256/);
	});

	it("reports ready through the stub too", async () => {
		vi.stubEnv("IMAGE_CHECK_CLASSIFIER", "stub");
		await expect(pictureCheckReady()).resolves.toBeUndefined();
	});

	const modelPath = join(process.cwd(), PICTURE_CHECK_MODEL.path);
	it.skipIf(!existsSync(modelPath))(
		"smoke: calls safe pictures safe, quickly (model file present)",
		async () => {
			const classifier = createOnnxPictureClassifier(modelPath);
			await classifier.ready();
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
			// Measured ~50-110 ms on the dev box; a generous bound so a busy CI
			// box does not flake, still far below a render's 20-70 s.
			for (const ms of times) expect(ms).toBeLessThan(2_000);
		},
		60_000,
	);
});
