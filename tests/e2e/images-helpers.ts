import { expect, type Page } from "@playwright/test";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "../../src/lib/server/services/images/comfyui/testing/fake-comfyui";
import { clearAdminConfig } from "./helpers";

export type { FakeComfyUi };

/**
 * Starts a fake ComfyUI in the spec's own process and points the app at it
 * through the admin config route, the way settings-admin.spec.ts sets keys.
 * The setting is a live one, so the next turn sees it.
 */
export async function startFakeComfyUiForSpec(
	page: Page,
): Promise<FakeComfyUi> {
	const fake = await createFakeComfyUi();
	const response = await page.request.put("/api/admin/config", {
		data: { COMFYUI_URL: fake.baseUrl },
	});
	expect(response.ok(), `COMFYUI_URL set -> ${response.status()}`).toBe(true);
	return fake;
}

/** Puts the setting back (empty turns picture making off), then closes the fake. */
export async function stopFakeComfyUiForSpec(
	page: Page,
	fake: FakeComfyUi,
): Promise<void> {
	try {
		await clearAdminConfig(page, ["COMFYUI_URL"]);
	} finally {
		await fake.close();
	}
}
