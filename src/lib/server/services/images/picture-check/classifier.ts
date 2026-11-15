// The picture half of the explicit-picture filter: a local image classifier
// run in this process on the CPU (onnxruntime-node). No picture leaves the
// server for it.
//
// The model (`model.ts`) is Falconsai/nsfw_image_detection in the
// onnx-community fp32 export (the owner's choice over int8), pinned by
// revision and SHA-256. `scripts/fetch-picture-check-model.ts` puts it at
// PICTURE_CHECK_MODEL.path (data/ is shared across releases on deploy); a file
// that is missing or does not hash to the pin makes the check unavailable, and
// the caller then fails closed (nothing is shown).
//
// Life cycle (Task 18 review):
// - Lazy: only a real check loads the model. Tool Health asks `fileReady`,
//   which checks the file's presence and hash (cached until the file changes)
//   and never builds a session.
// - One read per load: the file is read once, that buffer is hashed and handed
//   to the session, so what was hashed is what runs.
// - A failed load is not retried (or re-hashed) until the file changes.
// - Every check, its load included, has a deadline (CHECK_TIMEOUT_MS). A check
//   that misses it is unavailable (the take fails closed as unchecked), the
//   engine it ran on is dropped (released once it settles, if ever) and the
//   next check loads a fresh one: one hung run never wedges the queue.
// - After IMAGE_IDLE_FREE_MS with no check the session is released, so idle
//   memory returns.
//
// Tests never see a real explicit picture: under vitest or Playwright, and
// only there, IMAGE_CHECK_CLASSIFIER=stub swaps in a stub that flags one
// marker colour and cannot check another.

import { createHash } from "node:crypto";
import { readFile as readFileFromDisk, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { IMAGE_IDLE_FREE_MS } from "../take-request";
import { PICTURE_CHECK_MODEL } from "./model";

/** The model's input side and normalisation (its preprocessor_config.json). */
const SIDE = 224;
/** The side of one input frame, for the video path that feeds raw frames. */
export const PICTURE_CHECK_SIDE = SIDE;
/**
 * Frames per inference run. A clip is checked in batches of this many frames:
 * 121 frames cost 8 `session.run` calls, not 121, and the whole clip reuses
 * one session. 16 x 3 x 224 x 224 float32 is ~9.6 MB of input, small beside
 * the session itself.
 */
export const PICTURE_CHECK_BATCH_SIZE = 16;
/** "nsfw" is label 1 (config.json id2label); at or above this probability a picture is blocked. */
export const EXPLICIT_THRESHOLD = 0.5;
/** Kept low so a check never crowds the app's own work. */
const THREADS = 2;
/**
 * A check's deadline, its load included. fp32 measured 140-170 ms a check and
 * about 1 s to load (hash and session) on the dev box; 15 s is ~100x a check
 * and over 10x a load, so only a hung or starved run reaches it.
 */
export const CHECK_TIMEOUT_MS = 15_000;

export type PictureVerdict = {
	explicit: boolean;
	/** The model's probability that the picture is explicit, 0..1. */
	score: number;
	/** How long the check took, decode included. */
	ms: number;
};

/** The check could not run: no model file, a file that is not the pinned model, a timeout, or an error inside it. */
export class PictureCheckUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PictureCheckUnavailable";
	}
}

/**
 * What runs the model: logits for a `[batch, 3, 224, 224]` input, `batch * 2`
 * numbers in row-major batch order. A picture passes batch 1.
 */
export interface PictureCheckEngine {
	run(input: Float32Array, batch: number): Promise<ArrayLike<number>>;
	release(): Promise<void>;
}

export interface PictureClassifier {
	/** For Tool Health: resolves when the pinned file is in place. Never loads the model. */
	fileReady(): Promise<void>;
	classify(png: Uint8Array): Promise<PictureVerdict>;
	/**
	 * A clip's whole check pass: raw rgb24 frames already scaled to 224 x 224 by
	 * ffmpeg, classified `PICTURE_CHECK_BATCH_SIZE` at a time on ONE session.
	 * Answers one verdict per frame, in order.
	 */
	classifyRawFrames(frames: readonly Uint8Array[]): Promise<PictureVerdict[]>;
	/** Whether a session is held now. */
	loaded(): boolean;
}

type ClassifierOptions = {
	sha256?: string;
	loadEngine?: (bytes: Uint8Array) => Promise<PictureCheckEngine>;
	readFile?: (path: string) => Promise<Uint8Array>;
	timeoutMs?: number;
	idleMs?: number;
};

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
	return rgbFramesToTensor([new Uint8Array(data)], 1);
}

/**
 * Raw rgb24 frames (exactly 224 x 224, as ffmpeg writes them) into one
 * `[batch, 3, 224, 224]` tensor, scaled to -1..1, channels first per frame.
 * No decode and no resize: ffmpeg already produced the model's input.
 */
function rgbFramesToTensor(
	frames: readonly Uint8Array[],
	batch: number,
): Float32Array {
	const plane = SIDE * SIDE;
	const frameBytes = plane * 3;
	if (frames.length !== batch) {
		throw new PictureCheckUnavailable("The picture check batch is mis-sized.");
	}
	for (const frame of frames) {
		if (frame.byteLength !== frameBytes) {
			throw new PictureCheckUnavailable(
				`A picture check frame must be ${frameBytes} bytes.`,
			);
		}
	}
	const out = new Float32Array(batch * 3 * plane);
	for (let b = 0; b < batch; b++) {
		const frame = frames[b] as Uint8Array;
		const outAt = b * 3 * plane;
		for (let i = 0; i < plane; i++) {
			const pixel = i * 3;
			for (let c = 0; c < 3; c++) {
				out[outAt + c * plane + i] = (frame[pixel + c] ?? 0) / 127.5 - 1;
			}
		}
	}
	return out;
}

function softmaxExplicitAt(logits: ArrayLike<number>, index: number): number {
	const normal = Number(logits[index * 2]);
	const nsfw = Number(logits[index * 2 + 1]);
	const top = Math.max(normal, nsfw);
	const a = Math.exp(normal - top);
	const b = Math.exp(nsfw - top);
	return b / (a + b);
}

/** The real engine: an onnxruntime-node CPU session built from the bytes that were hashed. */
async function loadOnnxEngine(bytes: Uint8Array): Promise<PictureCheckEngine> {
	const ort = await import("onnxruntime-node");
	const session = await ort.InferenceSession.create(bytes, {
		executionProviders: ["cpu"],
		intraOpNumThreads: THREADS,
		interOpNumThreads: 1,
		graphOptimizationLevel: "all",
	});
	const inputName = session.inputNames[0] ?? "pixel_values";
	const outputName = session.outputNames[0] ?? "logits";
	return {
		run: async (input, batch) => {
			const tensor = new ort.Tensor("float32", input, [batch, 3, SIDE, SIDE]);
			const result = await session.run({ [inputName]: tensor });
			const logits = result[outputName]?.data as ArrayLike<number> | undefined;
			if (!logits || logits.length < batch * 2) {
				throw new PictureCheckUnavailable("The picture check gave no answer.");
			}
			return logits;
		},
		release: () => session.release(),
	};
}

/** Identifies one state of the file on disk; a change means it may be read again. */
async function fileSignature(path: string): Promise<string> {
	const info = await stat(path).catch(() => null);
	return info?.isFile() ? `${info.size}:${info.mtimeMs}` : "missing";
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new PictureCheckUnavailable(
						`The picture check timed out after ${ms} ms.`,
					),
				),
			ms,
		);
		timer.unref?.();
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function createOnnxPictureClassifier(
	modelPath: string,
	options: ClassifierOptions = {},
): PictureClassifier {
	const sha256 = options.sha256 ?? PICTURE_CHECK_MODEL.sha256;
	const loadEngine = options.loadEngine ?? loadOnnxEngine;
	const readFile = options.readFile ?? readFileFromDisk;
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const idleMs = options.idleMs ?? IMAGE_IDLE_FREE_MS;

	let engine: PictureCheckEngine | null = null;
	let loading: Promise<PictureCheckEngine> | null = null;
	/** The file state a verdict about it was made on: verified, or the error. */
	let fileVerdict: {
		signature: string;
		error: PictureCheckUnavailable | null;
	} | null = null;
	let turn: Promise<unknown> = Promise.resolve();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let busy = 0;

	/** The bytes of the pinned file, read once; or the cached reason it is not usable. */
	const readVerified = async (): Promise<Uint8Array> => {
		const signature = await fileSignature(modelPath);
		if (fileVerdict?.signature === signature && fileVerdict.error) {
			throw fileVerdict.error;
		}
		try {
			if (signature === "missing") {
				throw new PictureCheckUnavailable(
					`The picture check's model file is missing (${modelPath}); run npm run models:fetch.`,
				);
			}
			const bytes = await readFile(modelPath);
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== sha256) {
				throw new PictureCheckUnavailable(
					`The picture check's model file does not match its pinned SHA-256 (${digest}).`,
				);
			}
			fileVerdict = { signature, error: null };
			return bytes;
		} catch (error) {
			fileVerdict = { signature, error: unavailable(error) };
			throw fileVerdict.error;
		}
	};

	const load = (): Promise<PictureCheckEngine> => {
		if (engine) return Promise.resolve(engine);
		loading ??= (async () => {
			const bytes = await readVerified();
			try {
				return await loadEngine(bytes);
			} catch (error) {
				throw unavailable(error);
			}
		})().then(
			(loaded) => {
				engine = loaded;
				loading = null;
				return loaded;
			},
			(error: unknown) => {
				loading = null;
				throw error;
			},
		);
		return loading;
	};

	/** Drops the engine a hung check ran on: released once its run settles, if ever. */
	const abandon = (
		stuck: Promise<unknown>,
		onEngine: PictureCheckEngine | null,
	) => {
		if (onEngine && engine === onEngine) engine = null;
		if (!onEngine) {
			// A load that hung: whatever it yields later is released, never used.
			const abandoned = loading;
			loading = null;
			abandoned?.then(
				(late) => {
					if (engine === late) engine = null;
					void late.release().catch(() => undefined);
				},
				() => undefined,
			);
			return;
		}
		stuck.then(
			() => onEngine.release().catch(() => undefined),
			() => onEngine.release().catch(() => undefined),
		);
	};

	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (busy > 0 || !engine) return;
			const idle = engine;
			engine = null;
			void idle.release().catch(() => undefined);
		}, idleMs);
		idleTimer.unref?.();
	};

	/** One inference under the check's deadline, on the one session, busy-accounted. */
	const runCheck = async <T>(
		work: (engine: PictureCheckEngine) => Promise<T>,
	): Promise<T> => {
		busy += 1;
		let usedEngine: PictureCheckEngine | null = null;
		const running = (async () => {
			const ready = await load();
			usedEngine = ready;
			return work(ready);
		})();
		try {
			return await deadline(running, timeoutMs);
		} catch (error) {
			const failure = unavailable(error);
			if (/timed out/.test(failure.message)) abandon(running, usedEngine);
			throw failure;
		} finally {
			busy -= 1;
			armIdle();
		}
	};

	const check = async (png: Uint8Array): Promise<PictureVerdict> => {
		const started = performance.now();
		const tensor = await toTensorData(png);
		const score = await runCheck(async (ready) => {
			const logits = await ready.run(tensor, 1);
			return softmaxExplicitAt(logits, 0);
		});
		return {
			explicit: score >= EXPLICIT_THRESHOLD,
			score,
			ms: Math.round(performance.now() - started),
		};
	};

	/**
	 * The clip's pass: `frames` are raw rgb24, already 224 x 224, and each batch
	 * of `PICTURE_CHECK_BATCH_SIZE` is ONE `run` on the same session. A batch
	 * that throws or misses the deadline is the same unavailable verdict a
	 * single failed check is (the caller fails closed).
	 */
	const checkRawFrames = async (
		frames: readonly Uint8Array[],
	): Promise<PictureVerdict[]> => {
		const started = performance.now();
		const verdicts: PictureVerdict[] = [];
		for (let at = 0; at < frames.length; at += PICTURE_CHECK_BATCH_SIZE) {
			const batch = frames.slice(at, at + PICTURE_CHECK_BATCH_SIZE);
			const tensor = rgbFramesToTensor(batch, batch.length);
			const scores = await runCheck(async (ready) => {
				const logits = await ready.run(tensor, batch.length);
				return batch.map((_frame, index) => softmaxExplicitAt(logits, index));
			});
			for (const score of scores) {
				verdicts.push({
					explicit: score >= EXPLICIT_THRESHOLD,
					score,
					ms: Math.round(performance.now() - started),
				});
			}
		}
		return verdicts;
	};

	return {
		classifyRawFrames: (frames) => {
			const next = turn.then(() => checkRawFrames(frames));
			turn = next.catch(() => undefined);
			return next;
		},
		fileReady: async () => {
			if (engine) return;
			const signature = await fileSignature(modelPath);
			if (fileVerdict?.signature === signature) {
				if (fileVerdict.error) throw fileVerdict.error;
				return;
			}
			await readVerified();
		},
		classify: (png) => {
			const next = turn.then(() => check(png));
			turn = next.catch(() => undefined);
			return next;
		},
		loaded: () => engine !== null,
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

/** True when every pixel of a raw rgb24 frame is exactly `hex`. */
function isAllRaw(frame: Uint8Array, hex: string): boolean {
	const [r, g, b] = hexToRgb(hex);
	for (let at = 0; at < frame.byteLength; at += 3) {
		if (frame[at] !== r || frame[at + 1] !== g || frame[at + 2] !== b) {
			return false;
		}
	}
	return true;
}

const stubClassifier: PictureClassifier = {
	fileReady: async () => undefined,
	loaded: () => false,
	classify: async (png) => {
		if (await isAll(png, STUB_UNAVAILABLE_COLOUR)) {
			throw new PictureCheckUnavailable("The stub cannot check this picture.");
		}
		const explicit = await isAll(png, STUB_EXPLICIT_COLOUR);
		return { explicit, score: explicit ? 1 : 0, ms: 0 };
	},
	classifyRawFrames: async (frames) => {
		if (frames.some((frame) => isAllRaw(frame, STUB_UNAVAILABLE_COLOUR))) {
			throw new PictureCheckUnavailable("The stub cannot check this picture.");
		}
		return frames.map((frame) => {
			const explicit = isAllRaw(frame, STUB_EXPLICIT_COLOUR);
			return { explicit, score: explicit ? 1 : 0, ms: 0 };
		});
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

/**
 * Checks a clip's raw rgb24 frames through the active classifier: the batch
 * entry point the video filter uses, and the stub under a test run.
 */
export function classifyPictureFrames(
	frames: readonly Uint8Array[],
): Promise<PictureVerdict[]> {
	return activeClassifier().classifyRawFrames(frames);
}

/** For Tool Health: resolves when the pinned model file is in place, without loading it. */
export function pictureCheckFileReady(): Promise<void> {
	return activeClassifier().fileReady();
}
