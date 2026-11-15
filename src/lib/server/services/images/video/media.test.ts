// @vitest-environment node
//
// The GIF a clip downloads as (video plan, slice 8). The command is asserted on
// its own, so a change to the filter — 12 fps, a 480 long edge that never
// enlarges, lanczos, the palettegen/paletteuse pair, `-loop 0`, no audio —
// fails here even on a machine with no ffmpeg. The conversion itself runs the
// real ffmpeg the take's chain already uses, and skips cleanly without it.
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	convertToGif,
	VIDEO_GIF_FPS,
	VIDEO_GIF_LONG_EDGE,
	VideoMediaError,
	videoGifArgs,
} from "./media";

const run = promisify(execFile);

function hasFfmpeg(): boolean {
	try {
		execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const FFMPEG = hasFfmpeg();

function filterOf(args: readonly string[]): string {
	const at = args.indexOf("-filter_complex");
	return at < 0 ? "" : (args[at + 1] ?? "");
}

/** A real clip for the conversion: ffmpeg's own colour source, no GPU. */
async function makeClip(options: {
	width: number;
	height: number;
	seconds: number;
}): Promise<Uint8Array> {
	const dir = await mkdtemp(join(tmpdir(), "alfyai-gif-clip-"));
	try {
		const output = join(dir, "clip.mp4");
		await run("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=#336699:s=${options.width}x${options.height}:d=${options.seconds}:r=24`,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-y",
			output,
		]);
		return new Uint8Array(await readFile(output));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** How many frames the GIF carries: 12 a second for as long as the clip runs. */
async function gifFrameCount(gif: Uint8Array): Promise<number> {
	const dir = await mkdtemp(join(tmpdir(), "alfyai-gif-probe-"));
	try {
		const path = join(dir, "clip.gif");
		await writeFile(path, gif);
		const { stdout } = await run("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-count_frames",
			"-show_entries",
			"stream=nb_read_frames",
			"-of",
			"csv=p=0",
			path,
		]);
		return Number(stdout.trim());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("the GIF's ffmpeg command", () => {
	it("asks for 12 fps, a 480 long edge that never enlarges, lanczos, the palette pair, a loop and no audio", () => {
		expect(VIDEO_GIF_FPS).toBe(12);
		expect(VIDEO_GIF_LONG_EDGE).toBe(480);

		const args = videoGifArgs("/tmp/in.mp4", "/tmp/out.gif");
		const filter = filterOf(args);
		expect(filter).toContain("fps=12");
		// The long edge is the larger side of either shape, and min() keeps a
		// smaller clip at its own size.
		expect(filter).toContain("min(480,iw)");
		expect(filter).toContain("min(480,ih)");
		expect(filter).toContain("flags=lanczos");
		expect(filter).toContain("palettegen=stats_mode=diff");
		expect(filter).toContain(
			"paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
		);
		expect(args.join(" ")).toContain("-loop 0");
		expect(args).toContain("-an");
		expect(args.slice(0, 2)).toEqual(["-hide_banner", "-loglevel"]);
		expect(args.at(-1)).toBe("/tmp/out.gif");
	});
});

describe.skipIf(!FFMPEG)("convertToGif with the real ffmpeg", () => {
	it("fits a landscape clip's long edge to 480, keeping its shape", async () => {
		const gif = await convertToGif(
			await makeClip({ width: 640, height: 360, seconds: 1 }),
		);
		expect(Buffer.from(gif.subarray(0, 6)).toString("latin1")).toMatch(
			/^GIF8[79]a$/,
		);
		const meta = await sharp(gif).metadata();
		expect(meta.width).toBe(480);
		expect(meta.height).toBe(270);
	});

	it("fits a portrait clip's long edge to 480 too", async () => {
		const gif = await convertToGif(
			await makeClip({ width: 360, height: 640, seconds: 1 }),
		);
		const meta = await sharp(gif).metadata();
		expect(meta.width).toBe(270);
		expect(meta.height).toBe(480);
	});

	it("never enlarges a clip smaller than the long edge", async () => {
		const gif = await convertToGif(
			await makeClip({ width: 64, height: 64, seconds: 1 }),
		);
		const meta = await sharp(gif).metadata();
		expect(meta.width).toBe(64);
		expect(meta.height).toBe(64);
	});

	it("converts a ten-second clip whole, with no five-second cap", async () => {
		const gif = await convertToGif(
			await makeClip({ width: 64, height: 64, seconds: 10 }),
		);
		const frames = await gifFrameCount(gif);
		expect(frames).toBeGreaterThanOrEqual(110);
		expect(frames).toBeLessThanOrEqual(130);
	});

	it("answers a clip ffmpeg cannot decode as failed", async () => {
		const error = await convertToGif(new Uint8Array(64)).then(
			() => null,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(VideoMediaError);
		expect(error).toMatchObject({ code: "failed" });
	});
});
