// Runs the image kind over a test's database against a fake ComfyUI, the way
// the engine runs it in production: a thin wrapper over the engine's own
// `drain`, plus the config that points the kind at the fake. Imports the app
// after the test reset the module registry (dynamic imports), so it finds the
// test's database.

/** Points `COMFYUI_URL` at a fake (or clears it) before the config is first read. */
export function useFakeComfyUi(baseUrl: string | null): void {
	if (baseUrl) process.env.COMFYUI_URL = baseUrl;
	else delete process.env.COMFYUI_URL;
}

/** Runs every claimable take, one drain pass. */
export async function drainImageTakes(): Promise<void> {
	const { drain } = await import("$lib/server/services/jobs");
	const { imageJob } = await import("../image-job");
	await drain(imageJob);
}
