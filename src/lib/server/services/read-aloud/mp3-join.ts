// Reading and joining the MP3 clips of the speech service's preview (Plan 3,
// Task 5). A preview of two sentences is two calls, one clip each; the editor's
// player needs one stream with a gap between the sentences and the time each
// sentence starts and ends, so the clips are joined here, frame by frame.
//
// The service's format is fixed (its README, "The audio"): MPEG-1 Layer III,
// 44.1 kHz, mono, written by ffmpeg with an ID3v2 tag in front and no Xing
// header. Frames of that format can be put one after another and decode as one
// stream, so no audio is decoded or re-encoded. A clip in any other format is
// refused, not guessed at.
//
// Nothing here logs or keeps a byte: it reads what it is handed and returns
// new arrays.

import { silentMp3 } from "$lib/shared/read-aloud/silent-mp3";

/** A clip is not the MPEG-1 Layer III, 44.1 kHz, mono MP3 the speech service writes. */
export class Mp3Unreadable extends Error {
	override name = "Mp3Unreadable";
}

const SAMPLE_RATE = 44_100;
const SAMPLES_PER_FRAME = 1152;
/** MPEG-1 Layer III bit rates in kbit/s by the header's index; 0 is "free format" (index 0) and "bad" (index 15), neither of which is read. */
const BITRATES_KBPS = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;

/** The length in bytes of the frame that starts at `at`: its header must be this service's format. */
function frameLengthAt(bytes: Uint8Array, at: number, end: number): number {
	if (at + 4 > end) throw new Mp3Unreadable("a frame is cut short");
	const b0 = bytes[at] as number;
	const b1 = bytes[at + 1] as number;
	const b2 = bytes[at + 2] as number;
	const b3 = bytes[at + 3] as number;
	if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0)
		throw new Mp3Unreadable("not at a frame");
	if (((b1 >> 3) & 3) !== 3) throw new Mp3Unreadable("not MPEG-1");
	if (((b1 >> 1) & 3) !== 1) throw new Mp3Unreadable("not Layer III");
	const bitrate = BITRATES_KBPS[b2 >> 4] as number;
	if (bitrate === 0) throw new Mp3Unreadable("not a fixed bit rate");
	if (((b2 >> 2) & 3) !== 0) throw new Mp3Unreadable("not 44.1 kHz");
	if (((b3 >> 6) & 3) !== 3) throw new Mp3Unreadable("not mono");
	const padding = (b2 >> 1) & 1;
	const length = Math.floor((144 * bitrate * 1000) / SAMPLE_RATE) + padding;
	if (at + length > end) throw new Mp3Unreadable("a frame is cut short");
	return length;
}

/** The bytes the leading ID3v2 tag takes, 0 when there is none: a 10-byte header with a syncsafe size, and 10 more for a footer. */
function id3v2Length(bytes: Uint8Array): number {
	if (
		bytes.length < 10 ||
		bytes[0] !== 0x49 ||
		bytes[1] !== 0x44 ||
		bytes[2] !== 0x33
	)
		return 0;
	const size =
		(((bytes[6] as number) & 0x7f) << 21) |
		(((bytes[7] as number) & 0x7f) << 14) |
		(((bytes[8] as number) & 0x7f) << 7) |
		((bytes[9] as number) & 0x7f);
	const footer = ((bytes[5] as number) & 0x10) !== 0 ? 10 : 0;
	return 10 + size + footer;
}

/**
 * A clip's frames and their length. A leading ID3v2 tag and a trailing ID3v1
 * tag are left out. Every frame must be MPEG-1 Layer III, 44.1 kHz, mono, and
 * the clip must be whole frames from the tag to the end: anything else is
 * `Mp3Unreadable`.
 */
export function readMp3(bytes: Uint8Array): {
	frames: Uint8Array;
	seconds: number;
} {
	const start = id3v2Length(bytes);
	if (start > bytes.length)
		throw new Mp3Unreadable("the ID3 tag runs past the end");
	let end = bytes.length;
	if (
		end - start >= 128 &&
		bytes[end - 128] === 0x54 &&
		bytes[end - 127] === 0x41 &&
		bytes[end - 126] === 0x47
	)
		end -= 128;
	let at = start;
	let count = 0;
	while (at < end) {
		at += frameLengthAt(bytes, at, end);
		count++;
	}
	if (count === 0) throw new Mp3Unreadable("no frames");
	return {
		frames: bytes.subarray(start, end),
		seconds: (count * SAMPLES_PER_FRAME) / SAMPLE_RATE,
	};
}

const toMillisecond = (seconds: number): number =>
	Math.round(seconds * 1000) / 1000;

/**
 * The clips' frames one after another with `gapSeconds` of silence between
 * them (in whole frames, as `silentMp3` makes it), and where each clip starts
 * and ends on the joined clip's clock, in seconds rounded to the millisecond.
 * No gap before the first clip or after the last.
 */
export function joinMp3(
	clips: readonly Uint8Array[],
	gapSeconds: number,
): { audio: Uint8Array<ArrayBuffer>; sentences: Array<[number, number]> } {
	const read = clips.map(readMp3);
	const gap =
		clips.length > 1 && gapSeconds > 0 ? readMp3(silentMp3(gapSeconds)) : null;
	const parts: Uint8Array[] = [];
	const sentences: Array<[number, number]> = [];
	let clock = 0;
	read.forEach((clip, index) => {
		if (index > 0 && gap) {
			parts.push(gap.frames);
			clock += gap.seconds;
		}
		parts.push(clip.frames);
		sentences.push([toMillisecond(clock), toMillisecond(clock + clip.seconds)]);
		clock += clip.seconds;
	});
	const audio = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		audio.set(part, offset);
		offset += part.length;
	}
	return { audio, sentences };
}
