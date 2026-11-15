// @vitest-environment node
//
// The LTX-2.5 image-to-video graph in API form: the node set the plan pins,
// the conv VAE, the template's sigmas and 121 frames, and the exact wiring of
// the source still, the prompt and the seed.

import { describe, expect, it } from "vitest";
import {
	buildLtxVideoGraph,
	LTX_AUDIO_VAE,
	LTX_SIGMAS_PASS_1,
	LTX_SIGMAS_PASS_2,
	LTX_TEXT_ENCODER,
	LTX_UPSAMPLER,
	LTX_VIDEO_UNET,
	LTX_VIDEO_VAE,
} from "../comfyui/ltx-templates";

const built = buildLtxVideoGraph({
	prompt: "the harbour at dusk, a slow tide",
	seed: 1001,
	width: 1280,
	height: 704,
	image: "take-1.png",
});

function nodesOfType(graph: typeof built, type: string) {
	return Object.entries(graph).filter(([, node]) => node.class_type === type);
}

function nodeOf(graph: typeof built, type: string, index = 0) {
	const found = nodesOfType(graph, type)[index];
	if (!found) throw new Error(`No ${type} node at ${index}`);
	return { id: found[0], inputs: found[1].inputs };
}

const NODE_TYPES = [
	"CLIPLoader",
	"CLIPTextEncode",
	"CreateVideo",
	"EmptyLTXVLatentVideo",
	"KSamplerSelect",
	"LatentUpscaleModelLoader",
	"LTXVAudioVAEDecode",
	"LTXVAudioVAELoader",
	"LTXVConcatAVLatent",
	"LTXVConditioning",
	"LTXVDualCFGGuider",
	"LTXVEmptyLatentAudio",
	"LTXVImgToVideoInplace",
	"LTXVLatentUpsampler",
	"LTXVPreprocess",
	"LTXVSeparateAVLatent",
	"LoadImage",
	"ManualSigmas",
	"RandomNoise",
	"SamplerCustomAdvanced",
	"SaveVideo",
	"UNETLoader",
	"VAEDecodeTiled",
	"VAELoader",
];

describe("the LTX video graph", () => {
	it("keeps the minimal node set", () => {
		const types = new Set(Object.values(built).map((node) => node.class_type));
		expect([...types].sort()).toEqual([...NODE_TYPES].sort());
	});

	it("loads the NVFP4 transformer the numbers were measured on", () => {
		// The LTX worktree holds only this file; the template's int8 name is
		// 2.8 GB larger and was never measured on the card.
		expect(nodeOf(built, "UNETLoader").inputs.unet_name).toBe(
			"ltx-2.5-22b-distilled-transformer-nvfp4.safetensors",
		);
		expect(LTX_VIDEO_UNET).toBe(
			"ltx-2.5-22b-distilled-transformer-nvfp4.safetensors",
		);
		expect(nodeOf(built, "CLIPLoader").inputs.clip_name).toBe(
			"gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
		);
		expect(LTX_TEXT_ENCODER).toBe(
			"gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
		);
	});

	it("uses the conv video VAE and loads the audio VAE through its own checkpoint loader", () => {
		// The video VAE is the one plain VAELoader; the audio VAE is a
		// checkpoint (`models/checkpoints`) read by LTXVAudioVAELoader's
		// `ckpt_name`, exactly as the ComfyUI node defines it.
		expect(nodesOfType(built, "VAELoader")).toHaveLength(1);
		expect(nodeOf(built, "VAELoader").inputs.vae_name).toBe(
			"ltx-2.5-video-vae-conv-bf16.safetensors",
		);
		expect(LTX_VIDEO_VAE).toBe("ltx-2.5-video-vae-conv-bf16.safetensors");
		expect(nodesOfType(built, "LTXVAudioVAELoader")).toHaveLength(1);
		expect(nodeOf(built, "LTXVAudioVAELoader").inputs).toEqual({
			ckpt_name: "ltx-2.5-audio-vae-bf16.safetensors",
		});
		expect(LTX_AUDIO_VAE).toBe("ltx-2.5-audio-vae-bf16.safetensors");
		expect(nodeOf(built, "LatentUpscaleModelLoader").inputs.model_name).toBe(
			LTX_UPSAMPLER,
		);
	});

	it("runs two passes with the template's own sigmas", () => {
		const sigmas = nodesOfType(built, "ManualSigmas").map(
			([, node]) => node.inputs.sigmas,
		);
		expect(sigmas).toEqual([LTX_SIGMAS_PASS_1, LTX_SIGMAS_PASS_2]);
		expect(String(LTX_SIGMAS_PASS_1).split(",").length).toBe(9);
		expect(String(LTX_SIGMAS_PASS_2).split(",").length).toBe(4);
	});

	it("makes 121 frames of the given size at 24 fps", () => {
		expect(nodeOf(built, "EmptyLTXVLatentVideo").inputs).toMatchObject({
			// The template's first pass is half the output size.
			width: 640,
			height: 352,
			length: 121,
			batch_size: 1,
		});
		expect(nodeOf(built, "LTXVEmptyLatentAudio").inputs).toMatchObject({
			frames_number: 121,
			frame_rate: 24,
			batch_size: 1,
		});
		expect(nodeOf(built, "LTXVConditioning").inputs.frame_rate).toBe(24);
		expect(nodeOf(built, "CreateVideo").inputs).toMatchObject({
			fps: 24,
			bit_depth: 8,
			color_space: "sRGB",
		});
	});

	it("wires the uploaded still through the preprocess into both passes", () => {
		const load = nodeOf(built, "LoadImage");
		const preprocess = nodeOf(built, "LTXVPreprocess");
		expect(load.inputs.image).toBe("take-1.png");
		expect(preprocess.inputs).toMatchObject({
			image: [load.id, 0],
			img_compression: 18,
		});
		const inplace = nodesOfType(built, "LTXVImgToVideoInplace");
		expect(inplace).toHaveLength(2);
		expect(nodeOf(built, "LTXVImgToVideoInplace", 0).inputs).toMatchObject({
			image: [preprocess.id, 0],
			strength: 0.7,
			bypass: false,
		});
		expect(nodeOf(built, "LTXVImgToVideoInplace", 1).inputs).toMatchObject({
			image: [preprocess.id, 0],
			strength: 1,
			bypass: false,
		});
	});

	it("wires the prompt into the positive encoder and the seed into both passes", () => {
		const texts = nodesOfType(built, "CLIPTextEncode").map(
			([, node]) => node.inputs.text,
		);
		expect(texts).toContain("the harbour at dusk, a slow tide");
		expect(
			nodesOfType(built, "RandomNoise").map(
				([, node]) => node.inputs.noise_seed,
			),
		).toEqual([1001, 1002]);
	});

	it("ends in SaveVideo, never a preview", () => {
		expect(nodesOfType(built, "SaveVideo")).toHaveLength(1);
		expect(nodeOf(built, "SaveVideo").inputs.format).toBe("mp4");
		expect(nodesOfType(built, "PreviewImage")).toHaveLength(0);
	});

	it("halves whatever size it is given", () => {
		const portrait = buildLtxVideoGraph({
			prompt: "a portrait",
			seed: 7,
			width: 704,
			height: 1280,
			image: "still.png",
		});
		expect(nodeOf(portrait, "EmptyLTXVLatentVideo").inputs).toMatchObject({
			width: 352,
			height: 640,
		});
	});

	it("is a deep copy: building twice cannot share nodes", () => {
		const second = buildLtxVideoGraph({
			prompt: "other",
			seed: 1,
			width: 1280,
			height: 704,
			image: "x.png",
		});
		expect(second).not.toBe(built);
		for (const id of Object.keys(built)) {
			expect(second[id]).not.toBe(built[id]);
		}
	});
});
