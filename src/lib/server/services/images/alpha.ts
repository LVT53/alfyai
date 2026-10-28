import sharp from "sharp";

/**
 * A picture counts as see-through only when some pixel's alpha is below this.
 * Resampling and premultiplication round an opaque picture's alpha to 254 (or
 * thereabouts), which no one can see, so "any pixel under 255" would call
 * every picture see-through. 250 is well above that rounding and well below
 * anything a cutout or soft edge produces.
 */
export const SEE_THROUGH_ALPHA_BELOW = 250;

/** True when some pixel is meaningfully below opaque (the one see-through rule). */
export async function pngIsSeeThrough(bytes: Uint8Array): Promise<boolean> {
	const meta = await sharp(bytes).metadata();
	if (!meta.hasAlpha) return false;
	const { channels } = await sharp(bytes).stats();
	const alpha = channels[channels.length - 1];
	return Boolean(alpha && alpha.min < SEE_THROUGH_ALPHA_BELOW);
}

/**
 * The PNG as it should be stored: a picture whose alpha is only rounding noise
 * loses its alpha channel (RGB), a really see-through one is returned as is.
 * See-through is first the request's to decide (Task 17): with `mayBeSeeThrough`
 * false (a plain generate, an edit of an opaque base) the alpha is dropped
 * whatever the pixels say, and the threshold above is only the second guard for
 * a request that may be see-through.
 */
export async function normalizePngAlpha(
	png: Uint8Array,
	options: { mayBeSeeThrough?: boolean } = {},
): Promise<{ png: Uint8Array; hasAlpha: boolean }> {
	const mayBeSeeThrough = options.mayBeSeeThrough ?? true;
	if (mayBeSeeThrough && (await pngIsSeeThrough(png))) {
		return { png, hasAlpha: true };
	}
	const meta = await sharp(png).metadata();
	if (!meta.hasAlpha) return { png, hasAlpha: false };
	return {
		png: new Uint8Array(await sharp(png).removeAlpha().png().toBuffer()),
		hasAlpha: false,
	};
}
