// The picture half of the explicit-picture filter: a local image classifier
// run in this process on the CPU (onnxruntime-node). No picture leaves the
// server for it.
//
// The model (`model.ts`) is Falconsai/nsfw_image_detection in the
// onnx-community int8 export, pinned by revision and SHA-256.
// `scripts/fetch-picture-check-model.ts` puts it at PICTURE_CHECK_MODEL.path (data/ is shared across releases on deploy); a
// file that is missing or does not hash to the pin makes the check
// unavailable, and the caller then fails closed (nothing is shown).
//
// Tests never see a real explicit picture: under vitest or Playwright, and
// only there, IMAGE_CHECK_CLASSIFIER=stub swaps in a stub that flags one
// marker colour and cannot check another.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { PICTURE_CHECK_MODEL } from "./model";

/** The model's input side and normalisation (its preprocessor_config.json). */
const SIDE = 224;
/** "nsfw" is label 1; a picture at or above this probability is blocked. */
export const EXPLICIT_THRESHOLD = 0.5;
/** Kept low so a check never crowds the app's own work (~50-110 ms a picture). */
const THREADS = 2;

export type PictureVerdict = {
	explicit: boolean;
	/** The model's probability that the picture is explicit, 0..1. */
	score: number;
	/** How long the check took, decode included. */
	ms: number;
};

/** The check could not run: no model file, a file that is not the pinned model, or an error inside it. */
export class PictureCheckUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PictureCheckUnavailable";
	}
}

export interface PictureClassifier {
	/** Resolves once the model is loaded; rejects with PictureCheckUnavailable. */
	ready(): Promise<void>;
	classify(png: Uint8Array): Promise<PictureVerdict>;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = Awaited<
	ReturnType<OrtModule["InferenceSession"]["create"]>
>;

async function sha256Of(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve())
			.on("error", reject);
	});
	return hash.digest("hex");
}

function unavailable(error: unknown): PictureCheckUnavailable {
	return error instanceof PictureCheckUnavailable
		? error
		: new PictureCheckUnavailable(
				error instanceof Error ? error.message : String(error),
			);
}

/** RGB, flattened on white (a see-through picture is judged as it is seen), 224 x 224, scaled to -1..1, channels first. */
async function toTensorData(png: Uint8Array): Promise<Float32Array> {
	const { data } = await sharp(png)
		.flatten({ background: "#ffffff" })
		.resize(SIDE, SIDE, { fit: "fill", kernel: "linear" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const plane = SIDE * SIDE;
	const out = new Float32Array(3 * plane);
	for (let i = 0; i < plane; i++) {
		for (let c = 0; c < 3; c++) {
			out[c * plane + i] = (data[i * 3 + c] ?? 0) / 127.5 - 1;
		}
	}
	return out;
}

function softmaxExplicit(logits: ArrayLike<number>): number {
	const normal = Number(logits[0]);
	const nsfw = Number(logits[1]);
	const top = Math.max(normal, nsfw);
	const a = Math.exp(normal - top);
	const b = Math.exp(nsfw - top);
	return b / (a + b);
}

export function createOnnxPictureClassifier(
	modelPath: string,
): PictureClassifier {
	let loading: Promise<{ ort: OrtModule; session: OrtSession }> | null = null;
	// One check at a time: six takes landing together queue here instead of
	// taking six cores.
	let turn: Promise<unknown> = Promise.resolve();

	const load = () => {
		loading ??= (async () => {
			try {
				const info = await stat(modelPath).catch(() => null);
				if (!info?.isFile()) {
					throw new PictureCheckUnavailable(
						`The picture check's model file is missing (${modelPath}); run the fetch-picture-check-model script.`,
					);
				}
				const digest = await sha256Of(modelPath);
				if (digest !== PICTURE_CHECK_MODEL.sha256) {
					throw new PictureCheckUnavailable(
						`The picture check's model file does not match its pinned SHA-256 (${digest}).`,
					);
				}
				const ort = await import("onnxruntime-node");
				const session = await ort.InferenceSession.create(modelPath, {
					executionProviders: ["cpu"],
					intraOpNumThreads: THREADS,
					interOpNumThreads: 1,
					graphOptimizationLevel: "all",
				});
				return { ort, session };
			} catch (error) {
				// The next call tries again (the file may have been fetched since).
				loading = null;
				throw unavailable(error);
			}
		})();
		return loading;
	};

	const classify = async (png: Uint8Array): Promise<PictureVerdict> => {
		const started = performance.now();
		const { ort, session } = await load();
		try {
			const input = new ort.Tensor("float32", await toTensorData(png), [
				1,
				3,
				SIDE,
				SIDE,
			]);
			const inputName = session.inputNames[0] ?? "pixel_values";
			const outputName = session.outputNames[0] ?? "logits";
			const result = await session.run({ [inputName]: input });
			const logits = result[outputName]?.data as ArrayLike<number> | undefined;
			if (!logits || logits.length < 2) {
				throw new PictureCheckUnavailable("The picture check gave no answer.");
			}
			const score = softmaxExplicit(logits);
			return {
				explicit: score >= EXPLICIT_THRESHOLD,
				score,
				ms: Math.round(performance.now() - started),
			};
		} catch (error) {
			throw unavailable(error);
		}
	};

	return {
		ready: async () => {
			await load();
		},
		classify: (png) => {
			const next = turn.then(() => classify(png));
			turn = next.catch(() => undefined);
			return next;
		},
	};
}

// --- the stub, for tests only ----------------------------------------------

/** A picture of only this colour is "explicit" to the stub. */
export const STUB_EXPLICIT_COLOUR = "#ff00ff";
/** A picture of only this colour cannot be checked by the stub. */
export const STUB_UNAVAILABLE_COLOUR = "#00ffff";

function isTestRun(): boolean {
	return Boolean(process.env.VITEST) || process.env.PLAYWRIGHT_TEST === "1";
}

/** True only inside a test run that asked for the stub: production always runs the model. */
export function usesStubClassifier(): boolean {
	return process.env.IMAGE_CHECK_CLASSIFIER === "stub" && isTestRun();
}

function hexToRgb(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** True when the corners and the centre are all exactly `hex`. */
async function isAll(png: Uint8Array, hex: string): Promise<boolean> {
	const { data, info } = await sharp(png)
		.flatten({ background: "#ffffff" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const [r, g, b] = hexToRgb(hex);
	const { width, height } = info;
	const points = [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
		[Math.floor(width / 2), Math.floor(height / 2)],
	];
	return points.every(([x, y]) => {
		const at = ((y ?? 0) * width + (x ?? 0)) * info.channels;
		return data[at] === r && data[at + 1] === g && data[at + 2] === b;
	});
}

const stubClassifier: PictureClassifier = {
	ready: async () => undefined,
	classify: async (png) => {
		if (await isAll(png, STUB_UNAVAILABLE_COLOUR)) {
			throw new PictureCheckUnavailable("The stub cannot check this picture.");
		}
		const explicit = await isAll(png, STUB_EXPLICIT_COLOUR);
		return { explicit, score: explicit ? 1 : 0, ms: 0 };
	},
};

// --- the one the app uses ----------------------------------------------------

let modelClassifier: PictureClassifier | null = null;

function activeClassifier(): PictureClassifier {
	if (usesStubClassifier()) return stubClassifier;
	modelClassifier ??= createOnnxPictureClassifier(
		join(process.cwd(), PICTURE_CHECK_MODEL.path),
	);
	return modelClassifier;
}

/** Checks one finished picture. Rejects with PictureCheckUnavailable when the check cannot run. */
export function classifyPicture(png: Uint8Array): Promise<PictureVerdict> {
	return activeClassifier().classify(png);
}

/** For Tool Health: resolves when the check can run (loading the model once). */
export function pictureCheckReady(): Promise<void> {
	return activeClassifier().ready();
}
