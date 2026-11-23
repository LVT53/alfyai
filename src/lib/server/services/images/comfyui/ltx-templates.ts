/**
 * The LTX-2.5 image-to-video graph, API form.
 *
 * Hand-written from the shipped `video_ltx2_5_i2v` template's API export
 * (ComfyUI workflow templates, `image_to_video_ltx_2_5`), with two deliberate
 * differences the plan records:
 *
 * - the video VAE is the CONV one (`ltx-2.5-video-vae-conv-bf16`,
 *   16.1 s vs 24.0 s for a 5 s 704x1280 clip, and measurably crisper: the
 *   feasibility note's decoder measurement);
 * - the enhancer branch (`TextGenerateLTX2Prompt`, the switch, its caption
 *   primitives) is gone: the caption comes from the app's own model, and a
 *   shipped ComfyUI upgrade must not change it silently.
 *
 * The transformer is the NVFP4 one the feasibility measurements were made on
 * (18.72 GB): the int8 file the template names is 2.8 GB larger, was never
 * measured on the card, and does not exist in the LTX worktree.
 *
 * What is left is the template's own two-pass chain: a half-size first pass
 * (`LTXVImgToVideoInplace` strength 0.7), the latent spatial upscaler, a
 * full-size second pass (strength 1), then a tiled video decode and an audio
 * decode into `SaveVideo`. The sigmas, the sampler, the 18 compression, the
 * tile sizes and `euler_ancestral` are the template's, not guesses.
 *
 * Sizes are baked by `buildLtxVideoGraph`: the caller hands the output size
 * (a multiple of 32 per side) and the first pass halves it, exactly as the
 * template's own divide-by-two primitives do.
 *
 * The second variant swaps both the transformer and the text encoder, and
 * nothing else: the node set is identical to the first variant's, so neither
 * variant can carry a node the other lacks.
 *
 * A text take (`fromText`) is the same graph minus the image path, so the two
 * cannot drift.
 */

import ltxVideoGraph from "./graphs/ltx-image-to-video.api.json";
import {
	LTX_TEXT_ENCODER,
	LTX_TEXT_ENCODER_ALT,
	LTX_VIDEO_FPS,
	LTX_VIDEO_UNET,
	LTX_VIDEO_UNET_ALT,
	type LtxVideoVariant,
} from "./ltx-spec";
import type { ComfyGraph } from "./types";

/**
 * The model names and timing are pinned in `ltx-spec.ts`, which imports no
 * JSON: the video request module needs the frame constants, and a bare JSON
 * import on that module's path stops Playwright from loading an e2e spec. They
 * are re-exported here because this is the graph module a reader looks at.
 */
export {
	LTX_AUDIO_VAE,
	LTX_SEGMENT_FRAMES,
	LTX_SIGMAS_PASS_1,
	LTX_SIGMAS_PASS_2,
	LTX_TEXT_ENCODER,
	LTX_TEXT_ENCODER_ALT,
	LTX_UPSAMPLER,
	LTX_VIDEO_FPS,
	LTX_VIDEO_UNET,
	LTX_VIDEO_UNET_ALT,
	LTX_VIDEO_VAE,
} from "./ltx-spec";

/** The node ids the builder writes into; the rest of the graph is fixed. */
const UNET_NODE = "1";
const CLIP_NODE = "2";
const POSITIVE_PROMPT_NODE = "5";
const LOAD_IMAGE_NODE = "8";
const PREPROCESS_NODE = "9";
const EMPTY_LATENT_NODE = "10";
const INPLACE_1_NODE = "11";
const AUDIO_LATENT_NODE = "12";
const CONCAT_1_NODE = "13";
const NOISE_1_NODE = "14";
const UPSAMPLED_LATENT_NODE = "21";
const INPLACE_2_NODE = "22";
const CONCAT_2_NODE = "23";
const NOISE_2_NODE = "24";
const CONDITIONING_NODE = "7";
const CREATE_VIDEO_NODE = "32";

/** The nodes a text take removes: LoadImage, preprocess, both in-place guides. */
const IMAGE_PATH_NODES = [
	LOAD_IMAGE_NODE,
	PREPROCESS_NODE,
	INPLACE_1_NODE,
	INPLACE_2_NODE,
];

export type LtxVideoGraphInput = {
	/** The motion caption the app's model wrote, in LTX's caption style. */
	prompt: string;
	seed: number;
	/** The clip's size, both sides a multiple of 32. */
	width: number;
	height: number;
	/** The uploaded still's name in ComfyUI's input folder; a picture take only. */
	image?: string;
	/** True when the take starts from the prompt alone, with no image path. */
	fromText?: boolean;
	/** Frames to render: 121 for five seconds, 241 for ten, one pass either way. */
	frames: number;
	/** Which variant's graph to build. */
	variant: LtxVideoVariant;
};

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * The graph a take renders. A deep copy every time: the JSON module is
 * shared, and a mutation would leak into the next take.
 *
 * The second pass's seed is `seed + 1`, so a retake varies both passes; the
 * template's second pass uses a fixed 42, which would give every clip the
 * same noise at that stage.
 */
export function buildLtxVideoGraph(input: LtxVideoGraphInput): ComfyGraph {
	const graph = structuredClone(ltxVideoGraph) as ComfyGraph;
	const put = (nodeId: string, inputName: string, value: unknown) => {
		const node = graph[nodeId];
		if (!node) throw new Error(`The LTX graph has no node ${nodeId}`);
		node.inputs[inputName] = value;
	};
	if (input.variant === "alt") {
		put(UNET_NODE, "unet_name", LTX_VIDEO_UNET_ALT);
		put(CLIP_NODE, "clip_name", LTX_TEXT_ENCODER_ALT);
	} else {
		put(UNET_NODE, "unet_name", LTX_VIDEO_UNET);
		put(CLIP_NODE, "clip_name", LTX_TEXT_ENCODER);
	}
	put(POSITIVE_PROMPT_NODE, "text", input.prompt);
	if (!input.fromText) {
		if (!isNonEmptyString(input.image)) {
			throw new Error("A picture take needs an image");
		}
		put(LOAD_IMAGE_NODE, "image", input.image);
	}
	// The first pass runs at half the output size; the upscaler doubles it back.
	// The latent's own `// 32` would silently floor a half like 176 to 160, so
	// floor it here: both first-pass sides are multiples of 32, never an odd 16.
	const half = (side: number) =>
		Math.max(32, Math.floor(Math.floor(side / 2) / 32) * 32);
	put(EMPTY_LATENT_NODE, "width", half(input.width));
	put(EMPTY_LATENT_NODE, "height", half(input.height));
	// One authority for the frame count and rate, written into both passes.
	put(EMPTY_LATENT_NODE, "length", input.frames);
	put(AUDIO_LATENT_NODE, "frames_number", input.frames);
	put(CONDITIONING_NODE, "frame_rate", LTX_VIDEO_FPS);
	put(AUDIO_LATENT_NODE, "frame_rate", LTX_VIDEO_FPS);
	put(CREATE_VIDEO_NODE, "fps", LTX_VIDEO_FPS);
	put(NOISE_1_NODE, "noise_seed", input.seed);
	put(NOISE_2_NODE, "noise_seed", input.seed + 1);
	if (input.fromText) {
		// No still to guide either pass: the first pass starts from the empty
		// latent, the second from the upscaler's own output.
		for (const nodeId of IMAGE_PATH_NODES) delete graph[nodeId];
		put(CONCAT_1_NODE, "video_latent", [EMPTY_LATENT_NODE, 0]);
		put(CONCAT_2_NODE, "video_latent", [UPSAMPLED_LATENT_NODE, 0]);
	}
	return graph;
}
