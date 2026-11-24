// The clip's bytes, decoded by the ffmpeg the box already has.
//
// LTX hands back an mp4; the rest of the take needs frames out of it (the
// poster, and the WHOLE clip as the explicit filter's raw check stream) and its
// container stripped of ComfyUI's tags. ffmpeg/ffprobe are the deployment's own
// binaries (`ffmpeg`, `ffprobe` on PATH), and no npm package decodes h264 here.
//
// Every call works in its own temp directory and cleans it up, so a failed
// decode leaves nothing behind. A missing binary is `unavailable` (the take
// cannot run on this box); a decode that fails is `failed` (retryable).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PICTURE_CHECK_SIDE } from "../picture-check/classifier";

const run = promisify(execFile);
/** A 1280x704 PNG frame is over execFile's 1 MB default; a probe is tiny. */
const MAX_BUFFER = 64 * 1024 * 1024;

const FFMPEG_BINARY = "ffmpeg";
const FFPROBE_BINARY = "ffprobe";

/**
 * The longest one media call may take. A frame extraction is seconds; a
 * whole-clip frame decode and a 10 s GIF are tens of seconds. 120 s is
 * generous for all of them and short enough that a wedged child cannot hold the
 * video kind's only slot: the render deadline (15 min) bounds the follow, this
 * bounds the media phase inside the same attempt, and the runner passes
 * whichever is smaller so the two never overlap.
 */
export const MEDIA_TIMEOUT_MS = 120_000;

// Test seam: a spec that must see a wedged child fail in a moment, not in two
// minutes. On `globalThis` so the test file's import and the app's own module
// graph (reset and re-imported per test) read the same value.
const TIMEOUT_KEY = Symbol.for("alfyai.video.mediaTimeoutMs");
type TimeoutHolder = { [TIMEOUT_KEY]?: number };
/** The effective per-call timeout: the constant, or a test's shorter one. */
export function mediaTimeoutMs(): number {
	return (globalThis as TimeoutHolder)[TIMEOUT_KEY] ?? MEDIA_TIMEOUT_MS;
}
export function setMediaTimeoutMsForTests(ms: number): void {
	if (!process.env.VITEST) {
		throw new Error("setMediaTimeoutMsForTests is for vitest only");
	}
	(globalThis as TimeoutHolder)[TIMEOUT_KEY] = Math.max(1, Math.trunc(ms));
}

/** What every media call accepts: the take's own signal and its share of the deadline. */
export type MediaCallOptions = {
	signal?: AbortSignal;
	/** Capped by the caller's remaining attempt budget; defaults to MEDIA_TIMEOUT_MS. */
	timeoutMs?: number;
};

/** Why the clip could not be worked on. */
export type VideoMediaErrorCode = "unavailable" | "failed";

export class VideoMediaError extends Error {
	readonly code: VideoMediaErrorCode;

	constructor(code: VideoMediaErrorCode, message: string) {
		super(message);
		this.name = "VideoMediaError";
		this.code = code;
	}
}

/**
 * A call ffmpeg/ffprobe did not finish inside its own timeout. It is still a
 * `VideoMediaError` (`failed`, retryable) for the runner and the route, but it
 * is NOT a codec failure: a caller that has a second way to do the same work
 * must not start it after a timeout, and this is how it tells the two apart.
 */
export class VideoMediaTimeoutError extends VideoMediaError {
	constructor(message: string) {
		super("failed", message);
		this.name = "VideoMediaTimeoutError";
	}
}

async function runBinary(
	binary: string,
	args: string[],
	options: { encoding?: "buffer" } & MediaCallOptions = {},
): Promise<Buffer | string> {
	try {
		const result = await run(binary, args, {
			maxBuffer: MAX_BUFFER,
			encoding: options.encoding === "buffer" ? "buffer" : "utf8",
			// A wedged child is killed; the caller's stop wins over the timeout.
			timeout: options.timeoutMs ?? mediaTimeoutMs(),
			signal: options.signal,
		});
		return result.stdout;
	} catch (error) {
		// The take was stopped (or its claim lost): let the abort flow as a stop,
		// exactly as the follow does, rather than dressing it as a media failure.
		if (options.signal?.aborted) throw error;
		const failure = error as NodeJS.ErrnoException & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
			killed?: boolean;
		};
		if (failure.code === "ENOENT") {
			throw new VideoMediaError(
				"unavailable",
				`${binary} is not installed on this server.`,
			);
		}
		if (failure.killed === true || failure.code === "ETIMEDOUT") {
			throw new VideoMediaTimeoutError(
				`${binary} did not finish within ${options.timeoutMs ?? mediaTimeoutMs()} ms.`,
			);
		}
		const stderr = failure.stderr
			? Buffer.from(failure.stderr)
					.toString()
					.trim()
					.split("\n")
					.slice(-3)
					.join(" ")
			: "";
		throw new VideoMediaError(
			"failed",
			`${binary} failed: ${stderr || failure.message}`,
		);
	}
}

/** One temp directory per decode, removed however it ends. */
async function inTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "alfyai-video-media-"));
	try {
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeClip(dir: string, name: string, bytes: Uint8Array) {
	const path = join(dir, name);
	await writeFile(path, bytes);
	return path;
}

/** PNG bytes of one frame, by its zero-based index or by a time in seconds. */
export async function extractFrameAt(
	mp4: Uint8Array,
	at: { seconds: number } | { index: number },
	options: MediaCallOptions = {},
): Promise<Uint8Array> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const selector =
			"index" in at
				? ["-vf", `select=eq(n\\,${Math.max(0, Math.trunc(at.index))})`]
				: ["-ss", String(Math.max(0, at.seconds))];
		const output = await runBinary(
			FFMPEG_BINARY,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				...selector,
				"-i",
				input,
				"-frames:v",
				"1",
				"-f",
				"image2pipe",
				"-vcodec",
				"png",
				"pipe:1",
			],
			{ encoding: "buffer", ...options },
		);
		const png = Buffer.from(output);
		if (png.length === 0) {
			throw new VideoMediaError(
				"failed",
				"ffmpeg decoded no frame from the clip.",
			);
		}
		return new Uint8Array(png);
	});
}

/**
 * Decodes the whole clip ONCE into the explicit-picture filter's check stream:
 * raw rgb24 frames already scaled to the model's 224 x 224, plus the clip's
 * full-size frame 0 as the poster. One ffmpeg invocation, two outputs.
 *
 * Nothing here decodes a PNG in Node: `sharp` used to do a decode and resize
 * per frame (121 of them for a 5 s clip), which is where the filter's old cost
 * sat. ffmpeg now writes the model's input directly, and the single loop in
 * `picture-check/index.ts` batches it through the classifier.
 */
export async function decodeCheckFrames(
	mp4: Uint8Array,
	options: MediaCallOptions = {},
): Promise<{ poster: Uint8Array; frames: Uint8Array[] }> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const posterPath = join(dir, "poster.png");
		const side = PICTURE_CHECK_SIDE;
		const output = await runBinary(
			FFMPEG_BINARY,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				input,
				// The poster: one full-size frame, the clip's own dimensions.
				"-map",
				"0:v:0",
				"-frames:v",
				"1",
				"-y",
				posterPath,
				// The check stream: the classifier's input, produced by ffmpeg.
				"-map",
				"0:v:0",
				"-vf",
				`scale=${side}:${side}:flags=bilinear`,
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				"pipe:1",
			],
			{ encoding: "buffer", ...options },
		);
		const raw = Buffer.from(output);
		const frameBytes = side * side * 3;
		const frameCount = Math.floor(raw.byteLength / frameBytes);
		if (frameCount === 0) {
			throw new VideoMediaError(
				"failed",
				"ffmpeg decoded no frames from the clip.",
			);
		}
		const frames = Array.from({ length: frameCount }, (_entry, index) =>
			raw.subarray(index * frameBytes, (index + 1) * frameBytes),
		);
		return {
			poster: new Uint8Array(await readFile(posterPath)),
			frames,
		};
	});
}

/**
 * The clip with its container metadata stripped. ComfyUI writes the whole
 * prompt, node graph and encoder tags into the mp4; a 5 s take never touches
 * ffmpeg otherwise, so this is the one pass that keeps that text from being
 * served. A stream copy: no re-encode, no quality change.
 */
export async function stripClipMetadata(
	mp4: Uint8Array,
	options: MediaCallOptions = {},
): Promise<Uint8Array> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const output = join(dir, "stripped.mp4");
		await runBinary(
			FFMPEG_BINARY,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				input,
				"-map",
				"0",
				"-c",
				"copy",
				"-map_metadata",
				"-1",
				"-movflags",
				"+faststart",
				"-y",
				output,
			],
			options,
		);
		const stripped = new Uint8Array(await readFile(output));
		if (stripped.byteLength === 0) {
			throw new VideoMediaError(
				"failed",
				"ffmpeg wrote no clip after stripping its metadata.",
			);
		}
		return stripped;
	});
}

/** The clip's length in whole milliseconds, from the container. */
export async function probeDurationMs(
	mp4: Uint8Array,
	options: MediaCallOptions = {},
): Promise<number> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const output = await runBinary(
			FFPROBE_BINARY,
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=nw=1:nk=1",
				input,
			],
			options,
		);
		const seconds = Number(String(output).trim());
		if (!Number.isFinite(seconds) || seconds <= 0) {
			throw new VideoMediaError("failed", "ffprobe found no clip length.");
		}
		return Math.round(seconds * 1000);
	});
}

/**
 * The GIF a clip downloads as (video plan, slice 8): 12 fps, a long edge of 480
 * pixels and never an enlargement. The constants live here, beside the
 * conversion, not in the serving route.
 */
export const VIDEO_GIF_FPS = 12;
export const VIDEO_GIF_LONG_EDGE = 480;

/**
 * The filter graph one GIF is made through: the clip scaled to the long edge
 * (`min()` keeps a smaller clip its own size), split into the palette pass and
 * the frames that will use it. `stats_mode=diff` measures only what changes
 * between frames, and the bayer dither across rectangles is what keeps the
 * small palette from banding the sky.
 */
export function videoGifFilter(): string {
	const edge = VIDEO_GIF_LONG_EDGE;
	return [
		`fps=${VIDEO_GIF_FPS}`,
		`scale='if(gt(a,1),min(${edge},iw),-2)':'if(gt(a,1),-2,min(${edge},ih))':flags=lanczos`,
		"split[s0][s1]",
		"[s0]palettegen=stats_mode=diff[p]",
		"[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
	].join(",");
}

/** The ffmpeg arguments that turn a clip into its GIF: looped, and with no audio. */
export function videoGifArgs(input: string, output: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		input,
		"-filter_complex",
		videoGifFilter(),
		// A GIF has no sound, whatever the clip carried.
		"-an",
		"-loop",
		"0",
		"-y",
		output,
	];
}

/**
 * The clip as a GIF. The whole clip is converted: nothing here stops at five
 * seconds, so a ten-second take lands as ten seconds of GIF. A missing binary
 * is `unavailable`; a decode that fails is `failed`, exactly as the other
 * media calls answer.
 */
export async function convertToGif(
	mp4: Uint8Array,
	options: MediaCallOptions = {},
): Promise<Uint8Array> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const output = join(dir, "clip.gif");
		await runBinary(FFMPEG_BINARY, videoGifArgs(input, output), options);
		const gif = new Uint8Array(await readFile(output));
		if (gif.byteLength === 0) {
			throw new VideoMediaError("failed", "ffmpeg wrote no GIF from the clip.");
		}
		return gif;
	});
}
