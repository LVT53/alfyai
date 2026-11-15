// The clip's bytes, decoded and joined by the ffmpeg the box already has.
//
// LTX hands back an mp4; the rest of the take needs frames out of it (the last
// frame to chain a second segment, the poster, four samples for the explicit
// filter) and, for a 10 s take, two clips joined into one. ffmpeg/ffprobe are
// the deployment's own binaries (`ffmpeg`, `ffprobe` on PATH): the feasibility
// trial used them for the concat, and no npm package decodes h264 here.
//
// Every call works in its own temp directory and cleans it up, so a failed
// decode leaves nothing behind. A missing binary is `unavailable` (the take
// cannot run on this box); a decode that fails is `failed` (retryable).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** A 1280x704 PNG frame is over execFile's 1 MB default; a probe is tiny. */
const MAX_BUFFER = 64 * 1024 * 1024;

const FFMPEG_BINARY = "ffmpeg";
const FFPROBE_BINARY = "ffprobe";

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

async function runBinary(
	binary: string,
	args: string[],
	options: { encoding?: "buffer" } = {},
): Promise<Buffer | string> {
	try {
		const result = await run(binary, args, {
			maxBuffer: MAX_BUFFER,
			encoding: options.encoding === "buffer" ? "buffer" : "utf8",
		});
		return result.stdout;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & {
			stderr?: string | Buffer;
			stdout?: string | Buffer;
		};
		if (failure.code === "ENOENT") {
			throw new VideoMediaError(
				"unavailable",
				`${binary} is not installed on this server.`,
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
			{ encoding: "buffer" },
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
 * The clip's last decoded frame: what a 10 s take feeds the second segment.
 * `-sseof` seeks from the end, so it does not depend on the frame count
 * ComfyUI happened to write.
 */
export async function extractLastFrame(mp4: Uint8Array): Promise<Uint8Array> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const output = await runBinary(
			FFMPEG_BINARY,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-sseof",
				"-0.1",
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
			{ encoding: "buffer" },
		);
		const png = Buffer.from(output);
		if (png.length === 0) {
			throw new VideoMediaError(
				"failed",
				"ffmpeg decoded no last frame from the clip.",
			);
		}
		return new Uint8Array(png);
	});
}

/** The clip's length in whole milliseconds, from the container. */
export async function probeDurationMs(mp4: Uint8Array): Promise<number> {
	return inTempDir(async (dir) => {
		const input = await writeClip(dir, "clip.mp4", mp4);
		const output = await runBinary(FFPROBE_BINARY, [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=nw=1:nk=1",
			input,
		]);
		const seconds = Number(String(output).trim());
		if (!Number.isFinite(seconds) || seconds <= 0) {
			throw new VideoMediaError("failed", "ffprobe found no clip length.");
		}
		return Math.round(seconds * 1000);
	});
}

async function hasAudioStream(input: string): Promise<boolean> {
	const output = await runBinary(FFPROBE_BINARY, [
		"-v",
		"error",
		"-select_streams",
		"a",
		"-show_entries",
		"stream=index",
		"-of",
		"csv=p=0",
		input,
	]);
	return String(output).trim() !== "";
}

/**
 * Two clips joined end to end, in order. The stream copy is what the trial
 * measured ("ffmpeg concat of two h264 clips is enough"): both segments come
 * from the same graph, so their codec parameters match. A copy ffmpeg refuses
 * falls back to a re-encode, which also handles a segment without audio.
 */
export async function concatClips(
	clips: readonly Uint8Array[],
): Promise<Uint8Array> {
	if (clips.length === 0) {
		throw new VideoMediaError("failed", "There is no clip to join.");
	}
	if (clips.length === 1) return clips[0] as Uint8Array;
	return inTempDir(async (dir) => {
		const inputs: string[] = [];
		for (const [index, clip] of clips.entries()) {
			inputs.push(await writeClip(dir, `clip-${index}.mp4`, clip));
		}
		const output = join(dir, "joined.mp4");
		const list = join(dir, "clips.txt");
		await writeFile(
			list,
			inputs
				.map((input) => `file '${input.replace(/'/g, "'\\''")}'`)
				.join("\n"),
		);
		try {
			await runBinary(FFMPEG_BINARY, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				list,
				"-c",
				"copy",
				"-movflags",
				"+faststart",
				"-y",
				output,
			]);
			return new Uint8Array(await readFile(output));
		} catch {
			// The segments do not share codec parameters (or one has no audio):
			// join them through the filter graph instead of failing the take.
		}
		// Both clips carry LTX's joint audio; a pair without a matching audio
		// stream is joined as video only rather than failing the take.
		const audio =
			(await hasAudioStream(inputs[0] as string)) &&
			(await hasAudioStream(inputs[1] as string));
		const filter = audio
			? "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"
			: "[0:v][1:v]concat=n=2:v=1:a=0[v]";
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			inputs[0] as string,
			"-i",
			inputs[1] as string,
			"-filter_complex",
			filter,
			"-map",
			"[v]",
			...(audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-preset",
			"veryfast",
			"-crf",
			"18",
			"-movflags",
			"+faststart",
			"-y",
			output,
		];
		await runBinary(FFMPEG_BINARY, args);
		return new Uint8Array(await readFile(output));
	});
}
