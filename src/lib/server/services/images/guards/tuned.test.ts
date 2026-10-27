import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { guardEdit } from "./guard-edit";
import { decodeRaw, type RawImage } from "./raw-image";

// Small pictures of generated rooms (Qwen renders, 320 px wide); never a photo.
const DIR = join(__dirname, "__fixtures__");
const load = async (name: string) =>
	decodeRaw(new Uint8Array(await readFile(join(DIR, name))));

async function run(base: RawImage, result: RawImage) {
	return guardEdit({
		base,
		anchor: null,
		chainSinceAnchor: 0,
		result,
		marks: null,
	});
}

describe("the tuned guards on real renders", () => {
	it("a recolour pair: every pixel outside the dilated change is the base's", async () => {
		const base = await load("room-1-base.png");
		const result = await load("room-1-recolour.png");
		const out = await run(base, result);
		expect(out.measures.global).toBe(false);
		expect(out.measures.miss).toBeNull();
		let inside = 0;
		for (let i = 0; i < out.mask.length; i++) {
			if (out.mask[i] > 0) {
				inside++;
				continue;
			}
			for (let c = 0; c < 4; c++)
				expect(out.picture.data[i * 4 + c]).toBe(base.data[i * 4 + c]);
		}
		expect(inside).toBeGreaterThan(0);
		expect(inside / out.mask.length).toBeLessThan(0.5);
	}, 60_000);

	it("a pair where nothing changed is a nothing_changed miss", async () => {
		const base = await load("room-1-base.png");
		const png = await sharp(
			Buffer.from(base.data.buffer, base.data.byteOffset, base.data.length),
			{ raw: { width: base.width, height: base.height, channels: 4 } },
		)
			.blur(0.6)
			.png()
			.toBuffer();
		const out = await run(base, await decodeRaw(new Uint8Array(png)));
		expect(out.measures.miss).toBe("nothing_changed");
	}, 60_000);

	it("a global restyle pair is global", async () => {
		const base = await load("room-0-base.png");
		const result = await load("room-0-move.png");
		const out = await run(base, result);
		expect(out.measures.global).toBe(true);
	}, 60_000);
});
