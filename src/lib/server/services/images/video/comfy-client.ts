// The only place the video pipeline makes a ComfyUI client: it uses
// `COMFYUI_LTX_URL`, the third engine's own address, never a picture server's.
// Empty means video making is off.

import { getComfyuiLtxUrl } from "$lib/server/config-store";
import { type ComfyUiClient, createComfyUiClient } from "../comfyui/client";

export function createVideoComfyClient(): ComfyUiClient | null {
	const url = getComfyuiLtxUrl();
	if (url === "") return null;
	return createComfyUiClient({ baseUrl: url });
}
