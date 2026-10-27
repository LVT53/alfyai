// The one place the picture pipeline makes a ComfyUI client from the app's
// runtime config (`COMFYUI_URL`, admin-overridable), so the job, the runner and
// the idle-free timer all reach the same address and none reads env directly.

import { getConfig, isImageMakingConfigured } from "$lib/server/config-store";
import { type ComfyUiClient, createComfyUiClient } from "./comfyui/client";

/** A client for the configured picture server, or null when none is set. The caller closes it. */
export function createConfiguredComfyClient(): ComfyUiClient | null {
	const config = getConfig();
	if (!isImageMakingConfigured(config)) return null;
	return createComfyUiClient({ baseUrl: config.comfyuiUrl.trim() });
}
