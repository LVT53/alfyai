# MiniMax H3 Image acceleration research — 2026-11-18

Research only: no model downloads, runtime changes, or benchmarks performed here. Read alongside [the local speed investigation](speed-investigation-2026-11-18.md).

## Best candidate: community pDMD 2-step LoRA

The [publisher's README](https://huggingface.co/akhaliq/minimax-h3-image-pdmd-2step/blob/main/README.md) documents a released adapter for the official MiniMax-H3-Image checkpoint, including native 4096×4096 output, ComfyUI workflows, and an approximately 2 GB native-layout LoRA. Its recommended quantized-model path applies that LoRA at runtime, strength 1.0; a BF16 premerged checkpoint is also available. Sampling changes to two evaluations, Euler/simple, BasicGuider, video shift 12 and audio shift 3. Quantized/rotated checkpoints cannot use the provided BF16 premerge.

The decisive published comparison is **25.1 seconds for the stock six-step model versus 17.4 seconds for two-step pDMD: about 1.4× faster**, at 4096² on one H200 using BF16/FA3. The broader “2–3×” headline is not a safe end-to-end promise. The diffusion examples use Pruna's 4B text encoder and video VAE, so they do not reproduce AlfyAI's entire stack. A heavy detail pass raises total time to roughly 50 seconds; two-step outputs can be soft. Compatibility and quality on AlfyAI's quantized GPU setup remain unmeasured. Treat the adapter as a benchmark candidate, not an accepted production replacement.

## Released files and provenance

The [repository file listing](https://huggingface.co/akhaliq/minimax-h3-image-pdmd-2step/tree/main) exposes a 1.96 GB ComfyUI LoRA, 40.2 GB merged BF16 checkpoint, and separate diffusers weights. The [workflow folder](https://huggingface.co/akhaliq/minimax-h3-image-pdmd-2step/tree/main/workflows) contains both loader variants and an optional detail-pass graph. These are published artifacts rather than a roadmap announcement.

The [original pDMD release](https://huggingface.co/pdmd2026/pdmd_2NFE_lora) targets the H3 video transformer: rank 128, alpha 128, BF16, 312 low-rank pairs. The image application above is a community transfer/validation of those weights, not a new MiniMax-official image distillation. The [ComfyUI conversion](https://huggingface.co/Iwannapose/minimax_h3_pdmd_2nfe_comfyui) is separately published. The [merge script](https://huggingface.co/akhaliq/minimax-h3-image-pdmd-2step/blob/main/merge_comfy.py) explicitly checks 208 applied deltas and zero missed modules when producing its pruned BF16 checkpoint.

## Other names are different targets

[MiniMax's official image card](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image) states that the current image checkpoint is already distilled to six evaluations without CFG. Official serving interfaces reject step counts other than six. A two-step path therefore requires both different weights and the appropriate sampling graph.

[Pruna P-H3-Image](https://huggingface.co/PrunaAI/P-H3-Image) is a separate H3-derived image pipeline: eight-step sampling, a smaller 4B text encoder, approximately 8 MP generation, and up to eight editing references. Its memory/latency claims cannot be applied to the official Image model as a drop-in LoRA.

The indexed [older P-H3 turbo adapter card](https://huggingface.co/akhaliq/p-h3-image-turbo-lora) reports 11.9→9.0 seconds for eight→six steps and 7.5 seconds at four steps on H200/8 MP, with softer four-step images. It targets **Pruna P-H3-Image**, not the official checkpoint. The original URL returned an access error during direct verification, so current download availability is unconfirmed; search indexing alone does not establish availability.

## Proposed next experiment

Keep the existing six-step pipeline as the reference. On the same hardware, compare two-, three-, and four-step pDMD against it at identical production sizes and across text-to-image, faces/hands/text, and identity-preserving edits. Record warm end-to-end latency, transformer time, text encoding, VAE time, memory, and load/offload costs separately. Use the native-layout runtime LoRA with AlfyAI's existing int8-convrot checkpoint, verify all patches apply, and retain a source/seed-controlled image review. No reliable source found establishes a 10× improvement for that exact stack.
