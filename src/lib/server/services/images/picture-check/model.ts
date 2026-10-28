// Which model file the picture check runs, where it lives and where it comes
// from. No imports: `scripts/fetch-picture-check-model.ts` reads it too.
//
// Falconsai/nsfw_image_detection (a ViT-base fine-tuned to tell "normal" from
// "nsfw", Apache-2.0; id2label 0 normal, 1 nsfw), in the onnx-community fp32
// ONNX export (the owner chose fp32 over int8), pinned by revision and by
// SHA-256. Only this file is ever loaded.
export const PICTURE_CHECK_MODEL = {
	/** Relative to the app's working directory; data/ is shared across releases on deploy. */
	path: "data/models/picture-check/nsfw_image_detection.fp32.onnx",
	url: "https://huggingface.co/onnx-community/nsfw_image_detection-ONNX/resolve/1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5/onnx/model.onnx",
	sha256: "a4316a4fb750169ac4fcabaabee1fcbd982b0ee8c0cc63fe3e944954bb9a7d9c",
	bytes: 343_401_688,
} as const;
