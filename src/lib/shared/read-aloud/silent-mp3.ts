// Silent MP3 frames, for two users: the fake speech service's audio, and the
// browser's iOS unlock clip (a press handler plays a short silent clip before
// it awaits anything, so the page may play audio later; Plan 2, Task 10).
//
// No Node or DOM API beyond `btoa`, because both sides import it.
//
// Every frame is the MPEG-1 Layer III header FF FB 90 C0 (44.1 kHz, mono,
// 128 kbit/s, no CRC, no padding) followed by zero bytes, which decode as
// silence. 144 × 128000 / 44100 rounds down to 417 bytes a frame, and a frame
// holds 1152 samples.

export const MP3_FRAME_SECONDS = 1152 / 44100;

const FRAME_BYTES = 417;
const HEADER = [0xff, 0xfb, 0x90, 0xc0] as const;

/** `count` silent frames. */
export function silentMp3Frames(count: number): Uint8Array {
	const frames = Math.max(0, Math.floor(count));
	const bytes = new Uint8Array(frames * FRAME_BYTES);
	for (let frame = 0; frame < frames; frame++)
		bytes.set(HEADER, frame * FRAME_BYTES);
	return bytes;
}

/** At least `seconds` of silence, in whole frames. */
export function silentMp3(seconds: number): Uint8Array {
	return silentMp3Frames(Math.ceil(seconds / MP3_FRAME_SECONDS));
}

/** A short silent clip as a data address, for the iOS unlock. */
export function silentMp3DataUri(seconds = 0.1): string {
	let binary = "";
	for (const byte of silentMp3(seconds)) binary += String.fromCharCode(byte);
	return `data:audio/mpeg;base64,${btoa(binary)}`;
}
