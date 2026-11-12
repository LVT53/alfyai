// The one place the picture pipeline makes a ComfyUI client from the app's
// runtime config, so the job, the runner and the memory-free steps all reach a
// configured address and none reads env directly. `IMAGE_MODEL` selects the
// model for NEW takes; an in-flight take passes its own model here, and the
// idle-free step passes each configured model in turn.

import {
	getComfyuiUrlForModel,
	getImageModel,
	type ImageModel,
} from "$lib/server/config-store";
import { type ComfyUiClient, createComfyUiClient } from "./comfyui/client";

/**
 * A client for the given picture model's configured server, or null when that
 * model has no address. Defaults to the selected model; the caller closes it.
 */
export function createConfiguredComfyClient(
	model: ImageModel = getImageModel(),
): ComfyUiClient | null {
	const baseUrl = getComfyuiUrlForModel(model).trim();
	if (baseUrl === "") return null;
	return createComfyUiClient({ baseUrl });
}
