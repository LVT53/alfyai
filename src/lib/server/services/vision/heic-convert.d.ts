// heic-convert 2.1.0 ships no typings. This declares the one call
// prepare-image.ts makes: the primary image of a HEIC or HEIF file, encoded as
// a JPEG (a Buffer at run time).
declare module "heic-convert" {
	export default function convertHeic(options: {
		/** The whole HEIC or HEIF file. */
		buffer: Uint8Array;
		format: "JPEG" | "PNG";
		/** JPEG quality from 0 to 1. The library's own default is 0.92. */
		quality?: number;
	}): Promise<Uint8Array>;
}
