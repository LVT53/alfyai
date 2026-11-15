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
 */

import ltxVideoGraph from "./graphs/ltx-image-to-video.api.json";
import type { ComfyGraph } from "./types";

/**
 * The transformer the feasibility numbers were measured on (`feasibility.md`:
 * 18.72 GB NVFP4). It is the only transformer in the LTX worktree's
 * `diffusion_models/`; the template's int8 file is larger and unmeasured.
 */
export const LTX_VIDEO_UNET =
	"ltx-2.5-22b-distilled-transformer-nvfp4.safetensors";
/** The int8 Gemma-4 encoder that ships beside it (15.37 GB). */
export const LTX_TEXT_ENCODER =
	"gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors";
/** The conv decoder: faster and crisper than the diffusion VAE (feasibility.md, "The VAE"). */
export const LTX_VIDEO_VAE = "ltx-2.5-video-vae-conv-bf16.safetensors";
/** Joint audio: the audio VAE lives in `checkpoints` and is read by its own loader. */
export const LTX_AUDIO_VAE = "ltx-2.5-audio-vae-bf16.safetensors";
export const LTX_UPSAMPLER =
	"ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors";

/** The template's six-step equivalent schedule: eight steps down, then three. */
export const LTX_SIGMAS_PASS_1 =
	"1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
export const LTX_SIGMAS_PASS_2 = "0.85, 0.7250, 0.4219, 0.0";

export const LTX_VIDEO_FPS = 24;
export const LTX_SEGMENT_FRAMES = 121;

/** The node ids the builder writes into; the rest of the graph is fixed. */
const UNET_NODE = "1";
const CLIP_NODE = "2";
const POSITIVE_PROMPT_NODE = "5";
const LOAD_IMAGE_NODE = "8";
const EMPTY_LATENT_NODE = "10";
const AUDIO_LATENT_NODE = "12";
const NOISE_1_NODE = "14";
const NOISE_2_NODE = "24";
const CONDITIONING_NODE = "7";
const CREATE_VIDEO_NODE = "32";

export type LtxVideoGraphInput = {
	/** The motion caption the app's model wrote, in LTX's caption style. */
	prompt: string;
	seed: number;
	/** The clip's size, both sides a multiple of 32. */
	width: number;
	height: number;
	/** The uploaded still's name in ComfyUI's input folder. */
	image: string;
};

/**
 * The graph one segment renders. A deep copy every time: the JSON module is
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
	put(UNET_NODE, "unet_name", LTX_VIDEO_UNET);
	put(CLIP_NODE, "clip_name", LTX_TEXT_ENCODER);
	put(POSITIVE_PROMPT_NODE, "text", input.prompt);
	put(LOAD_IMAGE_NODE, "image", input.image);
	// The first pass runs at half the output size; the upscaler doubles it back.
	put(EMPTY_LATENT_NODE, "width", Math.floor(input.width / 2));
	put(EMPTY_LATENT_NODE, "height", Math.floor(input.height / 2));
	// One authority for the frame count and rate, written into both passes.
	put(EMPTY_LATENT_NODE, "length", LTX_SEGMENT_FRAMES);
	put(AUDIO_LATENT_NODE, "frames_number", LTX_SEGMENT_FRAMES);
	put(CONDITIONING_NODE, "frame_rate", LTX_VIDEO_FPS);
	put(AUDIO_LATENT_NODE, "frame_rate", LTX_VIDEO_FPS);
	put(CREATE_VIDEO_NODE, "fps", LTX_VIDEO_FPS);
	put(NOISE_1_NODE, "noise_seed", input.seed);
	put(NOISE_2_NODE, "noise_seed", input.seed + 1);
	return graph;
}
