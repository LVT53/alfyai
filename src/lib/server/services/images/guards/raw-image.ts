import sharp from "sharp";
import type { CanvasSize } from "../canvas";

/** RGBA, 8 bits per channel, row after row. */
export type RawImage = { data: Uint8Array; width: number; height: number };

export function isEmptyImage(image: RawImage): boolean {
	return image.width <= 0 || image.height <= 0;
}

export async function decodeRaw(
	bytes: Uint8Array,
	size?: CanvasSize,
): Promise<RawImage> {
	let pipeline = sharp(bytes).ensureAlpha();
	if (size) {
		pipeline = pipeline.resize(size.width, size.height, { fit: "fill" });
	}
	const { data, info } = await pipeline
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

export async function encodePng(image: RawImage): Promise<Buffer> {
	if (isEmptyImage(image)) throw new Error("Cannot encode an empty picture");
	return sharp(
		Buffer.from(
			image.data.buffer,
			image.data.byteOffset,
			image.data.byteLength,
		),
		{
			raw: { width: image.width, height: image.height, channels: 4 },
		},
	)
		.png()
		.toBuffer();
}

/** Resizes with sharp (Lanczos) to an exact size; used where a picture is rebuilt. */
export async function resizeRaw(
	image: RawImage,
	width: number,
	height: number,
): Promise<RawImage> {
	if (image.width === width && image.height === height) return image;
	const { data, info } = await sharp(
		Buffer.from(
			image.data.buffer,
			image.data.byteOffset,
			image.data.byteLength,
		),
		{ raw: { width: image.width, height: image.height, channels: 4 } },
	)
		.resize(width, height, { fit: "fill" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

/** Synchronous area-average resample, for measuring (not for output). */
export function downscale(
	image: RawImage,
	width: number,
	height: number,
): RawImage {
	if (width <= 0 || height <= 0 || isEmptyImage(image)) {
		return { data: new Uint8Array(0), width: 0, height: 0 };
	}
	if (image.width === width && image.height === height) return image;
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor((y * image.height) / height);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor((x * image.width) / width);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = y0; sy < y1 && sy < image.height; sy++) {
				for (let sx = x0; sx < x1 && sx < image.width; sx++) {
					const i = (sy * image.width + sx) * 4;
					r += image.data[i];
					g += image.data[i + 1];
					b += image.data[i + 2];
					a += image.data[i + 3];
					n++;
				}
			}
			const o = (y * width + x) * 4;
			out[o] = Math.round(r / n);
			out[o + 1] = Math.round(g / n);
			out[o + 2] = Math.round(b / n);
			out[o + 3] = Math.round(a / n);
		}
	}
	return { data: out, width, height };
}

/** Height that keeps the shape when the width is brought down to `workWidth`. */
export function workSize(
	image: RawImage,
	workWidth: number,
): { width: number; height: number } {
	const width = Math.max(1, Math.min(image.width, workWidth));
	const height = Math.max(1, Math.round((image.height * width) / image.width));
	return { width, height };
}
