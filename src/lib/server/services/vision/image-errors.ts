// The errors of turning an upload into a picture. A leaf module: prepare-image.ts
// and heif-decode.ts both import it, so neither has to import the other for a
// class (a cycle), and a caller that only needs to tell the errors apart loads
// no image library to do it.

/** The bytes could not be turned into a picture the model can be sent. */
export class ImagePreparationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ImagePreparationError";
	}
}

/** A photo with more pixels than the decoder takes: refused before any decoding starts. */
export class ImageTooLargeError extends ImagePreparationError {
	readonly pixels: number;
	readonly limit: number;

	constructor(pixels: number, limit: number) {
		super(`image has ${pixels} pixels, more than the ${limit} allowed`);
		this.name = "ImageTooLargeError";
		this.pixels = pixels;
		this.limit = limit;
	}
}

/** A decode that did not finish in the time it was given: its worker was stopped. */
export class ImageDecodeTimeoutError extends ImagePreparationError {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`image decode did not finish in ${timeoutMs} ms`);
		this.name = "ImageDecodeTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * No decoder could be started for the photo: the system would not make a worker
 * thread for it (out of threads or memory). The box is short of something, and
 * the photo is not at fault, so this is told apart from a photo libheif refuses
 * and from a worker that crashed on one.
 */
export class ImageDecodeUnavailableError extends ImagePreparationError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ImageDecodeUnavailableError";
	}
}
