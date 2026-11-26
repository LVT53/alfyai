// @vitest-environment node
// @always-run: exercises file or process inputs outside Vitest’s import graph.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	MP3_FRAME_SECONDS,
	silentMp3,
	silentMp3Frames,
} from "$lib/shared/read-aloud/silent-mp3";
import { joinMp3, Mp3Unreadable, readMp3 } from "./mp3-join";

function concat(...parts: Uint8Array[]): Uint8Array {
	const joined = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}
	return joined;
}

/** An ID3v2.4 tag with `size` payload bytes (the size is written syncsafe), and a footer if asked. */
function id3v2(size: number, footer = false): Uint8Array {
	const syncsafe = [
		(size >> 21) & 0x7f,
		(size >> 14) & 0x7f,
		(size >> 7) & 0x7f,
		size & 0x7f,
	];
	const tag = new Uint8Array(10 + size + (footer ? 10 : 0));
	tag.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, ...syncsafe]);
	if (footer) tag.set([0x33, 0x44, 0x49, 4, 0, 0x10, ...syncsafe], 10 + size);
	return tag;
}

/** An ID3v1 tag: 128 bytes that start with "TAG". */
function id3v1(): Uint8Array {
	const tag = new Uint8Array(128);
	tag.set([0x54, 0x41, 0x47]);
	return tag;
}

/** A frame that starts with `header` and is `length` bytes long. */
function frame(header: number[], length = 417): Uint8Array {
	const bytes = new Uint8Array(length);
	bytes.set(header);
	return bytes;
}

describe("readMp3", () => {
	it("reads the length of a clip from its frames, after its ID3 tag", () => {
		const frames = silentMp3Frames(10);
		const read = readMp3(concat(id3v2(300), frames));
		expect(read.frames).toEqual(frames);
		expect(read.seconds).toBeCloseTo(10 * MP3_FRAME_SECONDS, 9);
		// A footer adds ten bytes to the tag; no tag at all is fine too.
		expect(readMp3(concat(id3v2(20, true), frames)).frames).toEqual(frames);
		expect(readMp3(frames).frames).toEqual(frames);
		// Ten bytes of header and nothing else: the tag is empty.
		expect(readMp3(concat(id3v2(0), frames)).frames).toEqual(frames);
	});

	it("drops a trailing ID3v1 tag", () => {
		const frames = silentMp3Frames(6);
		const read = readMp3(concat(id3v2(40), frames, id3v1()));
		expect(read.frames).toEqual(frames);
		expect(read.seconds).toBeCloseTo(6 * MP3_FRAME_SECONDS, 9);
	});

	it("counts a padded frame by its own length", () => {
		// The padding bit (0x02 of the third byte) makes a 128 kbit/s frame 418 bytes.
		const padded = frame([0xff, 0xfb, 0x92, 0xc0], 418);
		const read = readMp3(concat(padded, silentMp3Frames(1), padded));
		expect(read.frames.length).toBe(418 + 417 + 418);
		expect(read.seconds).toBeCloseTo(3 * MP3_FRAME_SECONDS, 9);
	});

	it("reads a frame at another MPEG-1 Layer III bit rate by its length", () => {
		// 64 kbit/s (index 5): floor(144 × 64000 / 44100) = 208 bytes.
		const slow = frame([0xff, 0xfb, 0x50, 0xc0], 208);
		expect(readMp3(concat(slow, slow)).seconds).toBeCloseTo(
			2 * MP3_FRAME_SECONDS,
			9,
		);
	});

	it("refuses a clip that is not 44.1 kHz mono Layer III", () => {
		const refused: Array<[string, Uint8Array]> = [
			["48 kHz", frame([0xff, 0xfb, 0x94, 0xc0])],
			["32 kHz", frame([0xff, 0xfb, 0x98, 0xc0])],
			["a reserved sample rate", frame([0xff, 0xfb, 0x9c, 0xc0])],
			["stereo", frame([0xff, 0xfb, 0x90, 0x00])],
			["joint stereo", frame([0xff, 0xfb, 0x90, 0x40])],
			["dual channel", frame([0xff, 0xfb, 0x90, 0x80])],
			["Layer II", frame([0xff, 0xfd, 0x90, 0xc0])],
			["Layer I", frame([0xff, 0xff, 0x90, 0xc0])],
			["MPEG-2 (22.05 kHz)", frame([0xff, 0xf3, 0x90, 0xc0])],
			["a free-format bit rate", frame([0xff, 0xfb, 0x00, 0xc0])],
			["a bad bit rate", frame([0xff, 0xfb, 0xf0, 0xc0])],
			["no sync", frame([0x00, 0xfb, 0x90, 0xc0])],
			["noise", new Uint8Array(500).fill(7)],
			["nothing", new Uint8Array(0)],
			["a tag and no frames", id3v2(30)],
			["a frame cut short", silentMp3Frames(1).subarray(0, 300)],
			[
				"a good frame and then noise",
				concat(silentMp3Frames(2), new Uint8Array(40).fill(9)),
			],
			["a tag that runs past the end", concat(id3v2(900).subarray(0, 100))],
		];
		for (const [label, bytes] of refused) {
			expect(() => readMp3(bytes), label).toThrow(Mp3Unreadable);
		}
		// One bad frame in a good clip is refused too, wherever it is.
		expect(() =>
			readMp3(
				concat(
					silentMp3Frames(3),
					frame([0xff, 0xfb, 0x94, 0xc0]),
					silentMp3Frames(3),
				),
			),
		).toThrow(Mp3Unreadable);
	});
});

describe("joinMp3", () => {
	it("joins two clips with a 0.30 s gap and says where each starts and ends", () => {
		const joined = joinMp3([silentMp3Frames(10), silentMp3Frames(20)], 0.3);
		// 10 frames are 0.261 s, the gap is 12 frames (0.313 s), 20 frames are 0.522 s.
		expect(joined.sentences).toEqual([
			[0, 0.261],
			[0.575, 1.097],
		]);
		expect(joined.audio).toEqual(
			concat(silentMp3Frames(10), silentMp3(0.3), silentMp3Frames(20)),
		);
		expect(joined.audio.length).toBe((10 + 12 + 20) * 417);
	});

	it("leaves the clips' tags out, and keeps the order and the gaps of three", () => {
		const joined = joinMp3(
			[
				concat(id3v2(50), silentMp3Frames(2)),
				concat(silentMp3Frames(3), id3v1()),
				silentMp3Frames(1),
			],
			0.3,
		);
		expect(joined.audio).toEqual(
			concat(
				silentMp3Frames(2),
				silentMp3(0.3),
				silentMp3Frames(3),
				silentMp3(0.3),
				silentMp3Frames(1),
			),
		);
		const frames = (count: number) => count * MP3_FRAME_SECONDS;
		const gap = frames(12);
		const round = (value: number) => Math.round(value * 1000) / 1000;
		expect(joined.sentences).toEqual([
			[0, round(frames(2))],
			[round(frames(2) + gap), round(frames(5) + gap)],
			[round(frames(5) + 2 * gap), round(frames(6) + 2 * gap)],
		]);
	});

	it("has no gap after the last clip, none for one clip, and none when the gap is 0", () => {
		expect(joinMp3([silentMp3Frames(4)], 0.3)).toEqual({
			audio: silentMp3Frames(4),
			sentences: [[0, 0.104]],
		});
		expect(joinMp3([], 0.3)).toEqual({
			audio: new Uint8Array(0),
			sentences: [],
		});
		const back = joinMp3([silentMp3Frames(4), silentMp3Frames(4)], 0);
		expect(back.audio).toEqual(silentMp3Frames(8));
		expect(back.sentences).toEqual([
			[0, 0.104],
			[0.104, 0.209],
		]);
	});

	it("refuses to join a clip it cannot read", () => {
		expect(() =>
			joinMp3([silentMp3Frames(2), new Uint8Array(500).fill(1)], 0.3),
		).toThrow(Mp3Unreadable);
	});
});

// The service's own encoder command (deploy/speech-service/speech_service/audio.py's
// `_FFMPEG_ENCODE`), run here when ffmpeg with libmp3lame is on PATH: the parser meets
// the bytes a real encoder writes, not only this repository's silent frames.
const hasEncoder =
	spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
		encoding: "utf8",
	}).stdout?.includes("libmp3lame") ?? false;

function encode(seconds: number, hertz: number): Uint8Array {
	const samples = Math.round(seconds * 44100);
	const pcm = new Float32Array(samples);
	for (let i = 0; i < samples; i++)
		pcm[i] = 0.3 * Math.sin((2 * Math.PI * hertz * i) / 44100);
	const result = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-probesize",
			"32",
			"-analyzeduration",
			"0",
			"-f",
			"f32le",
			"-ar",
			"44100",
			"-ac",
			"1",
			"-i",
			"-",
			"-c:a",
			"libmp3lame",
			"-b:a",
			"128k",
			"-flush_packets",
			"1",
			"-f",
			"mp3",
			"-",
		],
		{ input: Buffer.from(pcm.buffer), maxBuffer: 32 << 20 },
	);
	if (result.status !== 0)
		throw new Error("ffmpeg could not encode the test tone");
	return new Uint8Array(result.stdout);
}

function decodedSeconds(mp3: Uint8Array): number {
	const result = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"mp3",
			"-i",
			"-",
			"-f",
			"f32le",
			"-ar",
			"44100",
			"-ac",
			"1",
			"-",
		],
		{ input: Buffer.from(mp3), maxBuffer: 64 << 20 },
	);
	if (result.status !== 0)
		throw new Error("ffmpeg could not decode the joined clip");
	return result.stdout.length / 4 / 44100;
}

describe.skipIf(!hasEncoder)("a real encoder's clips", () => {
	it("are read whole, ID3 tag dropped, and their length is that of their frames", () => {
		const clip = encode(0.5, 220);
		const read = readMp3(clip);
		expect(clip[0]).toBe(0x49); // the encoder starts the file with an ID3v2 tag
		expect(read.frames.length).toBeLessThan(clip.length);
		// The frames are what is left after the tag, to the byte.
		expect(clip.subarray(clip.length - read.frames.length)).toEqual(
			read.frames,
		);
		// 0.5 s of audio, the encoder's delay and its padding to a whole frame.
		expect(read.seconds).toBeGreaterThanOrEqual(0.5);
		expect(read.seconds).toBeLessThan(0.6);
	});

	it("join into one stream that decodes to the sum of their lengths and the gap", () => {
		const clips = [encode(0.4, 220), encode(0.7, 330)];
		const [one, two] = clips.map((clip) => readMp3(clip).seconds);
		const joined = joinMp3(clips, 0.3);
		const gap = 12 * MP3_FRAME_SECONDS;
		const total = (one ?? 0) + gap + (two ?? 0);
		expect(joined.sentences[1]?.[1]).toBeCloseTo(total, 2);
		expect(decodedSeconds(joined.audio)).toBeCloseTo(total, 1);
	});
});
