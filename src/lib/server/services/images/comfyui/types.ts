export type ComfyImageRef = {
	filename: string;
	subfolder: string;
	type: "input" | "output" | "temp";
};

// A saved media output, an image or a clip, is one `ComfyImageRef`: ComfyUI
// reports both with the same `{ filename, subfolder, type }` shape under
// `/history` (a `SaveVideo` writes its mp4 under `images` with an `animated`
// marker today, and custom nodes may use `videos` or `gifs`), so one ref shape
// reads them all.

export type ComfyGraph = Record<
	string,
	{ class_type: string; inputs: Record<string, unknown> }
>;

export type ComfyEvent =
	| { type: "queued"; ahead: number }
	| { type: "started" }
	| { type: "progress"; value: number; max: number }
	| { type: "done"; images: ComfyImageRef[]; videos: ComfyImageRef[] };

export type ComfyUiErrorCode =
	| "unreachable"
	| "rejected"
	| "execution_failed"
	| "timeout"
	| "missing_result"
	| "bad_response";

export class ComfyUiError extends Error {
	readonly code: ComfyUiErrorCode;
	readonly detail?: unknown;

	constructor(code: ComfyUiErrorCode, message: string, detail?: unknown) {
		super(message);
		this.name = "ComfyUiError";
		this.code = code;
		this.detail = detail;
	}
}

/**
 * What `cancel` found. "deleted" and "interrupted" are actions taken;
 * "running" means ours is running and the caller asked not to interrupt, so it
 * was left alone; "not_found" means ComfyUI does not list it.
 */
export type ComfyCancelResult =
	| "deleted"
	| "interrupted"
	| "running"
	| "not_found";

export interface ComfyUiClient {
	uploadImage(bytes: Uint8Array, name: string): Promise<ComfyImageRef>;
	/**
	 * `POST /prompt`. With `promptId` the caller names the prompt (ComfyUI takes
	 * a caller's `prompt_id`); the answer is the id ComfyUI actually gave it,
	 * which an older ComfyUI may pick itself.
	 */
	submit(
		graph: ComfyGraph,
		options?: { promptId?: string },
	): Promise<{ promptId: string }>;
	follow(
		promptId: string,
		options: {
			signal: AbortSignal;
			deadlineMs: number;
			onEvent: (event: ComfyEvent) => void;
		},
	): Promise<ComfyImageRef[]>;
	/**
	 * The same follow, for a graph whose output is a clip (`SaveVideo`). It
	 * answers the video outputs only, so a graph that saves both a preview and
	 * an mp4 hands the clip to the video runner. `follow` stays the image-only
	 * call the picture runner already uses.
	 */
	followVideo(
		promptId: string,
		options: {
			signal: AbortSignal;
			deadlineMs: number;
			onEvent: (event: ComfyEvent) => void;
		},
	): Promise<ComfyImageRef[]>;
	/** One saved media file's bytes, an image or a clip (`GET /view`). */
	fetchImage(ref: ComfyImageRef): Promise<Uint8Array>;
	cancel(
		promptId: string,
		options: { interrupt: boolean },
	): Promise<ComfyCancelResult>;
	queueSize(): Promise<number>;
	free(): Promise<void>;
	close(): void;
}
