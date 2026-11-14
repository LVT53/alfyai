import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import {
	createFakeComfyUi,
	type FakeComfyUi,
	type FakeRequest,
} from "../../src/lib/server/services/images/comfyui/testing/fake-comfyui";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { clearAdminConfig, configureFakeNormalChatCapacity } from "./helpers";

export type { FakeComfyUi };

/** The two picture models the Admin switch chooses between (`IMAGE_MODEL`). */
export type PictureModel = "qwen" | "h3";

/** The admin keys the picture-model specs write: both servers and the switch. */
export const PICTURE_CONFIG_KEYS = [
	"IMAGE_MODEL",
	"COMFYUI_URL",
	"COMFYUI_H3_URL",
] as const;

/** A graph POSTed to the fake, and the prompt id the app submitted it under. */
export type SubmittedPrompt = {
	graph: Record<
		string,
		{ class_type?: string; inputs?: Record<string, unknown> }
	>;
	promptId: string;
};

async function putPictureConfig(
	page: Page,
	values: Record<string, string>,
): Promise<void> {
	const response = await page.request.put("/api/admin/config", {
		data: values,
	});
	expect(
		response.ok(),
		`picture config set ${Object.keys(values).join(", ")} -> ${response.status()}`,
	).toBe(true);
}

/** Sets `IMAGE_MODEL` alone (the takes already queued keep their own model). */
export async function setPictureModel(
	page: Page,
	model: PictureModel,
): Promise<void> {
	await putPictureConfig(page, { IMAGE_MODEL: model });
}

/**
 * Starts a fake ComfyUI in the spec's own process and points the app at it
 * through the admin config route, the way settings-admin.spec.ts sets keys.
 * The setting is a live one, so the next turn sees it. `IMAGE_MODEL` is pinned
 * too: a worker keeps its database from one spec file to the next, so a spec
 * that leaves a model selected cannot decide this one's.
 */
export async function startFakeComfyUiForSpec(
	page: Page,
	model: PictureModel = "qwen",
): Promise<FakeComfyUi> {
	const fake = await createFakeComfyUi();
	await putPictureConfig(page, {
		COMFYUI_URL: fake.baseUrl,
		IMAGE_MODEL: model,
	});
	return fake;
}

/** Puts the settings back (empty turns picture making off), then closes the fake. */
export async function stopFakeComfyUiForSpec(
	page: Page,
	fake: FakeComfyUi,
): Promise<void> {
	try {
		await clearAdminConfig(page, ["COMFYUI_URL", "IMAGE_MODEL"]);
	} finally {
		await fake.close();
	}
}

export type FakePictureServers = { qwen: FakeComfyUi; h3: FakeComfyUi };

/**
 * Both picture servers as fakes, both configured, with the Admin switch on
 * `model`: what a spec needs to tell an H3 take from a Qwen one by the fake
 * that received it. `COMFYUI_URL` is the Qwen server and `COMFYUI_H3_URL` the
 * H3 server, exactly as the real 0.43/0.44 pair is wired.
 */
export async function startPictureServersForSpec(
	page: Page,
	model: PictureModel = "qwen",
): Promise<FakePictureServers> {
	const [qwen, h3] = await Promise.all([
		createFakeComfyUi(),
		createFakeComfyUi(),
	]);
	try {
		await putPictureConfig(page, {
			IMAGE_MODEL: model,
			COMFYUI_URL: qwen.baseUrl,
			COMFYUI_H3_URL: h3.baseUrl,
		});
	} catch (error) {
		await Promise.all([qwen.close(), h3.close()]);
		throw error;
	}
	return { qwen, h3 };
}

/** Puts all three picture keys back, then closes both fakes. */
export async function stopPictureServersForSpec(
	page: Page,
	servers: FakePictureServers | null,
): Promise<void> {
	if (!servers) return;
	try {
		await clearAdminConfig(page, [...PICTURE_CONFIG_KEYS]);
	} finally {
		await Promise.all([servers.qwen.close(), servers.h3.close()]);
	}
}

/** The requests a fake recorded, by method and path. */
export function comfyRequests(
	fake: FakeComfyUi,
	method: string,
	path: string,
): FakeRequest[] {
	return fake.requests.filter(
		(request) => request.method === method && request.path === path,
	);
}

/** Every `POST /prompt` a fake recorded, with the graph the app built. */
export function submittedPrompts(fake: FakeComfyUi): SubmittedPrompt[] {
	return comfyRequests(fake, "POST", "/prompt").map((request) => {
		const json = request.json as
			| { prompt?: SubmittedPrompt["graph"]; prompt_id?: unknown }
			| undefined;
		return {
			graph: json?.prompt ?? {},
			promptId: typeof json?.prompt_id === "string" ? json.prompt_id : "",
		};
	});
}

/** The one node of a class in a submitted graph, if the graph has it. */
export function graphNodeByClass(
	graph: SubmittedPrompt["graph"],
	classType: string,
): { class_type?: string; inputs?: Record<string, unknown> } | undefined {
	return Object.values(graph).find((node) => node.class_type === classType);
}

/**
 * The prompt text a submitted graph really carries: H3's conditioning node or
 * Qwen's text encoder. The transparent wrap and `<Picture 1> ` are visible here.
 */
export function submittedPromptText(graph: SubmittedPrompt["graph"]): string {
	const node =
		graphNodeByClass(graph, "MiniMaxH3ImageConditioning") ??
		graphNodeByClass(graph, "TextEncodeQwenImage21");
	const prompt = node?.inputs?.prompt;
	return typeof prompt === "string" ? prompt : "";
}

/** The width and height a submitted graph asks for, read from its first sized node. */
export function submittedCanvas(graph: SubmittedPrompt["graph"]): {
	width: number;
	height: number;
} {
	for (const node of Object.values(graph)) {
		const width = node.inputs?.width;
		const height = node.inputs?.height;
		if (typeof width === "number" && typeof height === "number") {
			return { width, height };
		}
	}
	throw new Error("the submitted graph carries no width/height");
}

/** The `LoadImage` slots a submitted graph still holds (`image` is a picture name). */
export function submittedImageSlots(graph: SubmittedPrompt["graph"]): string[] {
	return Object.values(graph)
		.filter((node) => node.class_type === "LoadImage")
		.map((node) => node.inputs?.image)
		.filter((image): image is string => typeof image === "string");
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
						contextLength: 131_072,
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
	await configureFakeNormalChatCapacity(
		page,
		`provider:${provider.id}:${models[0].id}`,
	);
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

/**
 * A large fake render: `side` x `side` pixels of softly varying colour, a few
 * MB as PNG (about 4 MB at 2048), the size class production pictures are in
 * (2-18 MB). A probe can then tell a download of the original from one of its
 * 1600 px display copy. Deterministic, so two runs measure the same bytes.
 */
export async function largePng(side = 2048): Promise<Uint8Array> {
	const source = 16;
	const noise = Buffer.alloc(source * source * 3);
	let state = 987654321;
	const random = () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	for (let index = 0; index < noise.length; index++) {
		noise[index] = Math.floor(random() * 256);
	}
	return new Uint8Array(
		await sharp(noise, { raw: { width: source, height: source, channels: 3 } })
			.resize(side, side, { kernel: "cubic" })
			.png()
			.toBuffer(),
	);
}

/** Picks the file in the composer and waits for its chip (the upload's own placeholder is gone). */
export async function attachPhoto(
	page: Page,
	photo: { name: string; buffer: Buffer; mimeType?: string },
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
		mimeType: photo.mimeType ?? "image/png",
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
