// Which model file the picture check runs, where it lives and where it comes
// from. No imports: `scripts/fetch-picture-check-model.ts` reads it too.
//
// Falconsai/nsfw_image_detection (a ViT-base fine-tuned to tell "normal" from
// "nsfw", Apache-2.0), in the onnx-community int8 ONNX export, pinned by
// revision and by SHA-256.
export const PICTURE_CHECK_MODEL = {
	/** Relative to the app's working directory; data/ is shared across releases on deploy. */
	path: "data/models/picture-check/nsfw_image_detection.int8.onnx",
	url: "https://huggingface.co/onnx-community/nsfw_image_detection-ONNX/resolve/1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5/onnx/model_int8.onnx",
	sha256: "bdc941491cd09ae75c5f40b038a5cd64482fa4e2b5297747323c5cda31303920",
	bytes: 87_333_629,
} as const;
