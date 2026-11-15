// A real mp4 for the video tests, made once with the ffmpeg the pipeline uses.
// Tests that need a clip of another colour or length make their own, so the
// fake stays a plain server and the runner meets real bytes.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
