// A real mp4 for the video tests, made once with the ffmpeg the pipeline uses.
// Tests that need a clip of another colour or length make their own, so the
// fake stays a plain server and the runner meets real bytes.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

/**
 * A real mp4 of one solid colour. The frame is drawn with sharp, not ffmpeg's
 * colour source (which round-trips through YUV and lands a channel at 254),
 * and encoded LOSSLESSLY as RGB h264, so a decoded frame is EXACTLY the colour
 * asked for: the explicit-picture stub checks exact pixels.
 */
export async function makeTestClip(
	options: { colour?: string; seconds?: number; size?: number } = {},
): Promise<Uint8Array> {
	const colour = options.colour ?? "#336699";
	const seconds = options.seconds ?? 5;
	const size = options.size ?? 64;
	const dir = await mkdtemp(join(tmpdir(), "alfyai-video-clip-"));
	const frame = join(dir, "frame.png");
	const output = join(dir, "clip.mp4");
	try {
		await writeFile(
			frame,
			await sharp({
				create: { width: size, height: size, channels: 3, background: colour },
			})
				.png()
				.toBuffer(),
		);
		await run("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-loop",
			"1",
			"-i",
			frame,
			"-t",
			String(seconds),
			"-r",
			"24",
			"-c:v",
			"libx264rgb",
			"-qp",
			"0",
			"-pix_fmt",
			"rgb24",
			"-movflags",
			"+faststart",
			"-y",
			output,
		]);
		return new Uint8Array(await readFile(output));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * A clip of `frames` lossless RGB frames (24 fps), with one frame set to
 * `colour` (0-based). Lossless is deliberate: the filter stub checks exact
 * pixels, and an explicit frame in the middle of a clip must survive the
 * encode exactly.
 */
export async function makeTestClipWithFrameAt(options: {
	frameIndex: number;
	colour: string;
	frames?: number;
	size?: number;
}): Promise<Uint8Array> {
	const frames = options.frames ?? 121;
	const size = options.size ?? 64;
	const dir = await mkdtemp(join(tmpdir(), "alfyai-video-frames-"));
	const framesDir = join(dir, "frames");
	try {
		await mkdir(framesDir, { recursive: true });
		for (let index = 0; index < frames; index += 1) {
			const background =
				index === options.frameIndex ? options.colour : "#336699";
			await writeFile(
				join(framesDir, `frame-${String(index + 1).padStart(6, "0")}.png`),
				await sharp({
					create: { width: size, height: size, channels: 3, background },
				})
					.png()
					.toBuffer(),
			);
		}
		const output = join(dir, "clip.mp4");
		await run("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-framerate",
			"24",
			"-i",
			join(framesDir, "frame-%06d.png"),
			"-c:v",
			"libx264rgb",
			"-qp",
			"0",
			"-pix_fmt",
			"rgb24",
			"-movflags",
			"+faststart",
			"-y",
			output,
		]);
		return new Uint8Array(await readFile(output));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A clip's container tags, for proving the prompt does not survive into what we serve. */
export async function probeTags(
	mp4: Uint8Array,
): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), "alfyai-video-tags-"));
	const input = join(dir, "clip.mp4");
	try {
		await writeFile(input, mp4);
		const { stdout } = await run("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format_tags",
			"-of",
			"json",
			input,
		]);
		const parsed = JSON.parse(stdout) as {
			format?: { tags?: Record<string, string> };
		};
		return parsed.format?.tags ?? {};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The clip re-muxed with one container tag, standing in for ComfyUI's prompt tags. */
export async function remuxWithMetadata(
	mp4: Uint8Array,
	key: string,
	value: string,
): Promise<Uint8Array> {
	const dir = await mkdtemp(join(tmpdir(), "alfyai-video-tagged-"));
	const input = join(dir, "clip.mp4");
	const output = join(dir, "tagged.mp4");
	try {
		await writeFile(input, mp4);
		await run("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			input,
			"-metadata",
			`${key}=${value}`,
			"-map",
			"0",
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			"-y",
			output,
		]);
		return new Uint8Array(await readFile(output));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
