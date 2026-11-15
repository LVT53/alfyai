/**
 * The LTX-2.5 model names and timing the video pipeline pins, kept free of the
 * graph JSON.
 *
 * The graph module imports `graphs/ltx-image-to-video.api.json`, which Vite
 * (the app and vitest) handles but Playwright's transform does not: a bare JSON
 * import there needs an import attribute and stops the spec from loading. The
 * video request module needs the frame count and rate, so those live here
 * instead of inside the graph module, and the graph imports them from here too.
 * One authority, and no JSON on the request's import path.
 *
 * The transformer is the NVFP4 one the feasibility measurements were made on
 * (18.72 GB): the template's int8 file is 2.8 GB larger, was never measured on
 * the card, and is not in the LTX worktree. Everything else is the name that
 * exists on the box.
 */

/** 18.72 GB, measured: `feasibility.md`, "What was measured". */
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

/** 121 frames at 24 fps: the template's own 5 s segment. */
export const LTX_VIDEO_FPS = 24;
export const LTX_SEGMENT_FRAMES = 121;
