import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "../../src/lib/server/services/images/comfyui/testing/fake-comfyui";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
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

// --- plan 2b T8: what the end-to-end image specs share -----------------------

/** The `imageMessageParts` capability a model keeps when the admin ticks "Can see images" (src/lib/model-image-input.ts). */
const CAN_SEE_IMAGES_JSON = JSON.stringify({
	chat: "detected",
	tools: "detected",
	imageMessageParts: {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	},
});

export type SpecChatModel = {
	providerId: string;
	previousModel: string | null;
	selectedModel: string;
};

/**
 * A model on the fake chat provider that can see pictures, made the way the
 * admin API makes them, and chosen for the signed-in reader. The reader's
 * earlier choice is kept for `releaseSpecChatModel`.
 */
export async function useSpecChatModel(
	page: Page,
	providerBaseUrl: string,
	prefix: string,
): Promise<SpecChatModel> {
	const settings = await page.request.get("/api/settings");
	expect(settings.ok(), `settings read -> ${settings.status()}`).toBe(true);
	const { preferences } = (await settings.json()) as {
		preferences?: { preferredModel?: string | null };
	};
	const unique = randomUUID().slice(0, 8);
	const createdProvider = await page.request.post("/api/admin/providers", {
		data: {
			name: `${prefix}${unique}`,
			displayName: `Pictures E2E ${unique}`,
			baseUrl: providerBaseUrl,
			apiKey: AI_SMOKE_API_KEY,
		},
	});
	expect(
		createdProvider.ok(),
		`provider create -> ${createdProvider.status()}`,
	).toBe(true);
	const { provider } = (await createdProvider.json()) as {
		provider: { id: string };
	};
	const createdModels = await page.request.post(
		`/api/admin/providers/${provider.id}/models/batch`,
		{
			data: {
				models: [
					{
						name: AI_SMOKE_MODEL_ID,
						displayName: `Pictures E2E Model ${unique}`,
						contextLength: 8192,
						supportsChat: true,
						supportsTools: true,
					},
				],
			},
		},
	);
	expect(createdModels.ok(), `model create -> ${createdModels.status()}`).toBe(
		true,
	);
	const { models } = (await createdModels.json()) as {
		models: Array<{ id: string }>;
	};
	// The batch route takes no capabilities: ticking "Can see images" is a save of the model.
	const ticked = await page.request.put(
		`/api/admin/providers/${provider.id}/models/${models[0].id}`,
		{ data: { capabilitiesJson: CAN_SEE_IMAGES_JSON } },
	);
	expect(ticked.ok(), `model save -> ${ticked.status()}`).toBe(true);
	const selectedModel = `provider:${provider.id}:${models[0].id}`;
	// The premise of every spec that sends a picture: the model is listed as one that sees.
	const listed = await page.request.get("/api/models");
	expect(listed.ok(), `model list -> ${listed.status()}`).toBe(true);
	const { providers } = (await listed.json()) as {
		providers: Array<{
			models: Array<{ id: string; supportsImages: boolean }>;
		}>;
	};
	expect(
		providers
			.flatMap((entry) => entry.models)
			.find((entry) => entry.id === selectedModel)?.supportsImages,
		"the temporary model is listed as one that can see images",
	).toBe(true);
	const chosen = await page.request.patch("/api/settings/preferences", {
		data: { preferredModel: selectedModel },
	});
	expect(chosen.ok(), `preference write -> ${chosen.status()}`).toBe(true);
	return {
		providerId: provider.id,
		previousModel: preferences?.preferredModel ?? null,
		selectedModel,
	};
}

export async function releaseSpecChatModel(
	page: Page,
	model: SpecChatModel,
): Promise<void> {
	await page.request.patch("/api/settings/preferences", {
		data: { preferredModel: model.previousModel },
	});
	await page.request.delete(`/api/admin/providers/${model.providerId}`);
}

/** A flat PNG of a random colour, so uploads (deduplicated by content) never meet another spec's. */
export async function randomPng(
	width = 96,
	height = 64,
): Promise<{ name: string; buffer: Buffer }> {
	const buffer = await sharp({
		create: {
			width,
			height,
			channels: 3,
			background: {
				r: randomInt(40, 216),
				g: randomInt(40, 216),
				b: randomInt(40, 216),
			},
		},
	})
		.png()
		.toBuffer();
	return { name: `photo-${randomUUID().slice(0, 8)}.png`, buffer };
}

/** Picks the file in the composer and waits for its chip (the upload's own placeholder is gone). */
export async function attachPhoto(
	page: Page,
	photo: { name: string; buffer: Buffer },
	chipsAfter: number,
): Promise<string> {
	const fileInput = page.locator('input[type="file"]').first();
	await expect(fileInput).toBeEnabled({ timeout: 20_000 });
	const uploaded = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/knowledge/upload/raw"),
	);
	await fileInput.setInputFiles({
		name: photo.name,
		mimeType: "image/png",
		buffer: photo.buffer,
	});
	const response = await uploaded;
	expect(response.ok(), `upload -> ${response.status()}`).toBe(true);
	const { artifact } = (await response.json()) as { artifact: { id: string } };
	await expect(page.getByTestId("composer-chip-upload")).toHaveCount(0);
	await expect(page.getByTestId("composer-chip-attachment")).toHaveCount(
		chipsAfter,
	);
	return artifact.id;
}

export type ChatPart = {
	type: string;
	text?: string;
	image_url?: { url: string };
};
type ChatMessage = { role: string; content: string | ChatPart[] };

/**
 * The parts of the last user message, in the last chat request the fake model
 * got, that holds `marker` in a text part: what the app sent for the turn.
 */
export function lastUserParts(
	requests: Array<{ body?: unknown }>,
	marker: string,
): ChatPart[] {
	for (let index = requests.length - 1; index >= 0; index--) {
		const messages = (requests[index].body as { messages?: ChatMessage[] })
			?.messages;
		if (!Array.isArray(messages)) continue;
		for (let at = messages.length - 1; at >= 0; at--) {
			const message = messages[at];
			if (message.role !== "user" || !Array.isArray(message.content)) continue;
			if (message.content.some((part) => part.text?.includes(marker))) {
				return message.content;
			}
		}
	}
	return [];
}

/**
 * One video of the test, for the owner's demo reel (plan 2b F19). Set
 * MOTION_VIDEO_DIR to keep them (`t8-<name>.webm` there); unset, the page is
 * closed and nothing is written. Closing the page ends the recording. Call it
 * last in `afterEach`, after the cleanup that needs the page.
 */
export const VIDEO_DIR = process.env.MOTION_VIDEO_DIR ?? null;

export async function saveSpecVideo(page: Page, name: string): Promise<void> {
	const video = page.video();
	await page.close();
	if (!video || !VIDEO_DIR) return;
	mkdirSync(VIDEO_DIR, { recursive: true });
	await video.saveAs(join(VIDEO_DIR, `t8-${name}.webm`));
}
