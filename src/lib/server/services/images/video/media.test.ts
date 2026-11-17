// @vitest-environment node
//
// The GIF a clip downloads as (video plan, slice 8). The command is asserted on
// its own, so a change to the filter — 12 fps, a 480 long edge that never
// enlarges, lanczos, the palettegen/paletteuse pair, `-loop 0`, no audio —
// fails here even on a machine with no ffmpeg. The conversion itself runs the
// real ffmpeg the take's chain already uses, and skips cleanly without it.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { FAKE_VIDEO_BYTES } from "../comfyui/testing/fake-comfyui";
import {
	concatClips,
	convertToGif,
	decodeCheckFrames,
	extractFrameAt,
	extractLastFrame,
	stripClipMetadata,
	VIDEO_GIF_FPS,
	VIDEO_GIF_LONG_EDGE,
	VideoMediaError,
	videoGifArgs,
} from "./media";
import {
	frameLevel,
	makeNumberedClip,
	pngLevel,
	probeClip,
	probeTags,
	remuxWithMetadata,
} from "./testing/video-clip";

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

describe("the media calls' deadline", () => {
	/** A PATH where `ffmpeg` never exits: the wedged child a stuck take must not wait on. */
	async function hangingFfmpeg(): Promise<() => Promise<void>> {
		const dir = await mkdtemp(join(tmpdir(), "alfyai-hanging-ffmpeg-"));
		const script = join(dir, "ffmpeg");
		await writeFile(script, "#!/bin/sh\nexec sleep 60\n");
		await chmod(script, 0o755);
		const before = process.env.PATH ?? "";
		process.env.PATH = `${dir}:${before}`;
		return async () => {
			process.env.PATH = before;
			await rm(dir, { recursive: true, force: true });
		};
	}

	it("kills a wedged ffmpeg and answers failed instead of waiting on it", async () => {
		if (!FFMPEG) return;
		const restore = await hangingFfmpeg();
		try {
			const started = Date.now();
			const error = await extractFrameAt(
				FAKE_VIDEO_BYTES,
				{ index: 0 },
				{ timeoutMs: 200 },
			).then(
				() => null,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(VideoMediaError);
			expect(error).toMatchObject({ code: "failed" });
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			await restore();
		}
	});

	it("lets the take's stop win over the timeout", async () => {
		if (!FFMPEG) return;
		const restore = await hangingFfmpeg();
		try {
			const controller = new AbortController();
			const running = extractFrameAt(
				FAKE_VIDEO_BYTES,
				{ index: 0 },
				{ signal: controller.signal, timeoutMs: 60_000 },
			).then(
				() => null,
				(thrown: unknown) => thrown,
			);
			setTimeout(() => controller.abort(new Error("cancelled")), 50);
			const error = await running;
			expect(controller.signal.aborted).toBe(true);
			// The abort flows out as itself, never as a media failure the runner
			// would retry.
			expect(error).not.toBeInstanceOf(VideoMediaError);
		} finally {
			await restore();
		}
	});
});

describe("joining two clips", () => {
	/**
	 * A PATH where `ffmpeg` records the arguments it was given and then hangs:
	 * the join that times out or is stopped, and anything that must never follow.
	 */
	async function recordingHangingFfmpeg(): Promise<{
		calls: () => Promise<string[]>;
		restore: () => Promise<void>;
	}> {
		const dir = await mkdtemp(join(tmpdir(), "alfyai-recording-ffmpeg-"));
		const log = join(dir, "calls.log");
		const script = join(dir, "ffmpeg");
		await writeFile(
			script,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec sleep 60\n`,
		);
		await chmod(script, 0o755);
		const before = process.env.PATH ?? "";
		process.env.PATH = `${dir}:${before}`;
		return {
			calls: async () =>
				existsSync(log)
					? (await readFile(log, "utf8"))
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean)
					: [],
			restore: async () => {
				process.env.PATH = before;
				await rm(dir, { recursive: true, force: true });
			},
		};
	}

	it("fails a timed-out join as a media failure and starts nothing after it", async () => {
		if (!FFMPEG) return;
		const shim = await recordingHangingFfmpeg();
		try {
			const error = await concatClips([FAKE_VIDEO_BYTES, FAKE_VIDEO_BYTES], {
				timeoutMs: 250,
			}).then(
				() => null,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(VideoMediaError);
			expect(error).toMatchObject({ code: "failed" });

			const calls = await shim.calls();
			// One child: the join's one encode. Nothing retries it after a timeout.
			expect(calls).toHaveLength(1);
			expect(calls[0]).toContain("-filter_complex");
			expect(calls[0]).not.toContain("-f concat");
		} finally {
			await shim.restore();
		}
	});

	it("lets the take's stop flow out of the join as itself", async () => {
		if (!FFMPEG) return;
		const shim = await recordingHangingFfmpeg();
		const controller = new AbortController();
		try {
			const running = concatClips([FAKE_VIDEO_BYTES, FAKE_VIDEO_BYTES], {
				signal: controller.signal,
				timeoutMs: 60_000,
			}).then(
				() => null,
				(thrown: unknown) => thrown,
			);
			// Abort once the join is really running, so this is a stop mid-child
			// and not a pre-aborted call that never spawns.
			await vi.waitFor(async () => expect(await shim.calls()).toHaveLength(1));
			controller.abort(new Error("cancelled"));
			const error = await running;
			// The abort flows out as itself, never as a media failure a fallback
			// could act on.
			expect(error).not.toBeInstanceOf(VideoMediaError);
			expect(await shim.calls()).toHaveLength(1);
		} finally {
			await shim.restore();
		}
	});
});

describe.skipIf(!FFMPEG)(
	"the chain's seam (a 10 s take's two segments)",
	() => {
		// Segment 1's frame n is grey 2n (0..240), so a frame can be told from the
		// one before it. Segment 2's frame 0 is LTX's copy of its guide (pass 2 pins
		// the first latent frame to it), drawn here as grey 250; its frames after
		// that are grey 100.
		const segmentOne = (audio = false) =>
			makeNumberedClip({ level: (index) => 2 * index, audio });
		const segmentTwo = (audio = false) =>
			makeNumberedClip({
				level: (index) => (index === 0 ? 250 : 100),
				audio,
			});

		it("guides segment 2 with segment 1's very last frame, never the one before it", async () => {
			const last = await extractLastFrame(await segmentOne());
			// Frame 120 is grey 240; frame 119, the one -sseof -0.1 used to give, is 238.
			expect(await pngLevel(last)).toBe(240);
		});

		it("drops segment 2's copy of its guide, so the join neither holds nor steps back a frame", async () => {
			const joined = await concatClips([
				await segmentOne(),
				await segmentTwo(),
			]);
			const probe = await probeClip(joined);
			// 121 + 120 frames: one continuous 8n+1 clip.
			expect(probe.frames).toBe(241);
			expect(await frameLevel(joined, 120)).toBeCloseTo(240, -0.5);
			expect(await frameLevel(joined, 121)).toBeCloseTo(100, -0.5);
			expect(probe.audioSeconds).toBeNull();
		});

		it("keeps the two soundtracks in step with the picture across the join", async () => {
			const joined = await concatClips([
				await segmentOne(true),
				await segmentTwo(true),
			]);
			const probe = await probeClip(joined);
			expect(probe.frames).toBe(241);
			expect(probe.audioSeconds).not.toBeNull();
			// No priming or extra frame of sound left in the middle: the sound ends
			// with the picture, within one AAC frame.
			expect(
				Math.abs((probe.audioSeconds ?? 0) - probe.videoSeconds),
			).toBeLessThan(0.025);
			expect(probe.videoSeconds).toBeCloseTo(241 / 24, 1);
		});
	},
);

describe("the whole clip's check stream", () => {
	it("decodes every frame raw at the model's size, with the full-size poster, in one pass", async () => {
		if (!FFMPEG) return;
		const decoded = await decodeCheckFrames(FAKE_VIDEO_BYTES);
		// The fake's clip is five seconds at 24 fps.
		expect(decoded.frames).toHaveLength(120);
		for (const frame of decoded.frames) {
			expect(frame.byteLength).toBe(224 * 224 * 3);
		}
		const meta = await sharp(decoded.poster).metadata();
		expect(meta).toMatchObject({ format: "png", width: 64, height: 64 });
	});
});

describe("the container's metadata", () => {
	it("does not let ComfyUI's prompt tags reach what we serve", async () => {
		if (!FFMPEG) return;
		const tagged = await remuxWithMetadata(
			FAKE_VIDEO_BYTES,
			"comment",
			"the harbour at dusk, a slow tide",
		);
		expect(JSON.stringify(await probeTags(tagged))).toContain("harbour");

		const stripped = await stripClipMetadata(tagged);
		expect(JSON.stringify(await probeTags(stripped))).not.toContain("harbour");

		const joined = await concatClips([tagged, tagged]);
		expect(JSON.stringify(await probeTags(joined))).not.toContain("harbour");
	});
});
