import { describe, expect, it } from "vitest";
import {
	MP3_FRAME_SECONDS,
	silentMp3,
	silentMp3DataUri,
	silentMp3Frames,
} from "./silent-mp3";

describe("silent MP3 frames", () => {
	it("makes 39 frames of 417 bytes for a second, each starting FF FB 90 C0", () => {
		const bytes = silentMp3(1);
		expect(bytes.length).toBe(39 * 417);
		for (let frame = 0; frame < 39; frame++) {
			expect([...bytes.slice(frame * 417, frame * 417 + 4)]).toEqual([
				0xff, 0xfb, 0x90, 0xc0,
			]);
			// The rest of a frame is zeros: silence.
			expect(bytes[frame * 417 + 4]).toBe(0);
			expect(bytes[frame * 417 + 416]).toBe(0);
		}
	});

	it("rounds a duration up to whole frames", () => {
		expect(MP3_FRAME_SECONDS).toBeCloseTo(0.026122, 6);
		expect(silentMp3(0.01).length).toBe(417);
		expect(silentMp3(0).length).toBe(0);
	});

	it("makes an exact number of frames", () => {
		expect(silentMp3Frames(12).length).toBe(12 * 417);
		expect(silentMp3Frames(0).length).toBe(0);
	});

	it("is a data address of 4 frames by default", () => {
		const uri = silentMp3DataUri();
		expect(uri.startsWith("data:audio/mpeg;base64,")).toBe(true);
		const decoded = Buffer.from(
			uri.slice("data:audio/mpeg;base64,".length),
			"base64",
		);
		expect(decoded.length).toBe(4 * 417);
		expect([...decoded.subarray(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
	});
});
