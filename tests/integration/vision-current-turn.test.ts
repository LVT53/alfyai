// The pictures of the current message, end to end: real attachments in the
// test database, the app's own context assembly and plain model run, and a
// capturing fake provider that records the request body a model would get.
//
// Pixels go to a model the admin marked "Can see images" and to no other, only
// in the turn that attached them, prepared (upright, flat, at most 1600 px, a
// JPEG) and never the stored original. A model that cannot see is told so in
// one line and works from the extracted text.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import sharp from "sharp";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.hoisted(() => {
	process.env.MODEL_1_BASEURL = "http://model1.fake/v1";
	process.env.MODEL_1_NAME = "fake-model-1";
	process.env.MODEL_1_API_KEY = "k1";
	process.env.MODEL_1_SYSTEM_PROMPT = "alfyai-nemotron";
	process.env.MODEL_2_BASEURL = "http://model2.fake/v1";
	process.env.MODEL_2_NAME = "fake-model-2";
	process.env.MODEL_2_API_KEY = "k2";
});

import { createModelCapabilitySet } from "../../src/lib/model-capabilities";
import { getConfig } from "../../src/lib/server/config-store";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { buildConstructedContext } from "../../src/lib/server/services/chat-turn/context-selection";
import { buildBaselineDepthMetadata } from "../../src/lib/server/services/chat-turn/depth-metadata";
import { runPlainNormalChatSendModel } from "../../src/lib/server/services/chat-turn/plain-normal-chat-model-run";
import { createConversation } from "../../src/lib/server/services/conversations";
import { attachArtifactsToMessage } from "../../src/lib/server/services/knowledge/store/attachments";
import { createArtifact } from "../../src/lib/server/services/knowledge/store/core";
import type { Artifact } from "../../src/lib/server/services/knowledge/types";
import { createMessage } from "../../src/lib/server/services/messages";
import { CANNOT_SEE_IMAGES_GUIDANCE } from "../../src/lib/server/services/vision/turn-images";
import {
	capture,
	installFakeProvider,
	lastMessageText,
	removeFakeProvider,
} from "./language-capture";

type ChatBody = {
	messages: Array<{ role: string; content: unknown }>;
};
type Part = { type: string; text?: string; image_url?: { url: string } };

const SEEING = createModelCapabilitySet({
	imageMessageParts: {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	},
});

let userId: string;
let email: string;
let directory: string;
let counter = 0;

beforeAll(async () => {
	installFakeProvider();
	directory = await mkdtemp(join(tmpdir(), "alfyai-vision-turn-"));
	userId = randomUUID();
	email = `vision-${randomUUID().slice(0, 6)}@example.com`;
	await db.insert(users).values({
		id: userId,
		email,
		passwordHash: "not-a-real-hash",
		name: "Alex Morgan",
		role: "user",
	});
});

afterAll(async () => {
	removeFakeProvider();
	await rm(directory, { recursive: true, force: true });
});

// The model run logs each step it finishes to the console; a test that wants to
// see what was logged reads this spy, and the output stays clean.
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
});

async function newConversation(): Promise<string> {
	return (await createConversation(userId, "Pictures")).id;
}

async function photoBytes(width = 800, height = 600): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background: "#3366cc" },
	})
		.png()
		.toBuffer();
}

/** A stored upload: the path is relative to the working directory, as in the app. */
async function storeFile(name: string, bytes: Uint8Array): Promise<string> {
	counter += 1;
	const absolute = join(directory, `${counter}-${name}`);
	await writeFile(absolute, bytes);
	return relative(process.cwd(), absolute);
}

/** An image attachment whose text has been extracted, so it is ready to send. */
async function readyImage(
	conversationId: string,
	name: string,
	options: { bytes?: Uint8Array; mimeType?: string } = {},
): Promise<Artifact> {
	const bytes = options.bytes ?? (await photoBytes());
	return createArtifact({
		userId,
		conversationId,
		type: "normalized_document",
		name,
		mimeType: options.mimeType ?? "image/png",
		extension: name.split(".").pop() ?? null,
		sizeBytes: bytes.byteLength,
		storagePath: await storeFile(name, bytes),
		contentText: `Text read from ${name}: the receipt total is 42 euros.`,
	});
}

function provider(canSee: boolean) {
	return {
		id: "fake",
		modelId: "model1" as const,
		name: "fake",
		displayName: "Fake Model",
		baseUrl: "http://model1.fake/v1",
		modelName: "fake-model-1",
		apiKey: "k1",
		...(canSee ? { capabilities: SEEING } : {}),
	};
}

/** One plain chat turn; the request the model got. */
async function ask(params: {
	conversationId: string;
	message: string;
	attachments?: Artifact[];
	canSee: boolean;
}): Promise<ChatBody> {
	const requests = await capture("vision turn", () =>
		runPlainNormalChatSendModel({
			userId,
			runtimeConfig: getConfig(),
			message: params.message,
			conversationId: params.conversationId,
			modelId: "model1",
			user: { id: userId, displayName: "Alex Morgan", email },
			attachmentIds: params.attachments?.map((artifact) => artifact.id),
			depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
			enabledConnectionCapabilities: [],
			overrideProvider: provider(params.canSee),
		}),
	);
	const chat = requests.find((request) =>
		lastMessageText(request.body, "user").includes("## Turn Guidance"),
	);
	if (!chat) throw new Error("the model was never asked");
	return chat.body as ChatBody;
}

function lastUser(body: ChatBody): { content: unknown } {
	const user = body.messages
		.filter((message) => message.role === "user")
		.at(-1);
	if (!user) throw new Error("no user message");
	return user;
}

/** What the person's last message says, text parts only. */
function userText(body: ChatBody): string {
	return lastMessageText(body as unknown as Record<string, unknown>, "user");
}

function imageUrls(body: ChatBody): string[] {
	const content = lastUser(body).content;
	if (!Array.isArray(content)) return [];
	return (content as Part[]).flatMap((part) =>
		part.type === "image_url" && part.image_url ? [part.image_url.url] : [],
	);
}

async function decode(url: string) {
	return sharp(Buffer.from(url.split(",")[1] ?? "", "base64")).metadata();
}

describe("a model that can see", () => {
	it("is sent the pictures of the message, prepared, beside the text it was sent before", async () => {
		const conversationId = await newConversation();
		const attachments = [
			await readyImage(conversationId, "receipt.png"),
			await readyImage(conversationId, "screenshot.png"),
		];

		const body = await ask({
			conversationId,
			message: "What do these two show?",
			attachments,
			canSee: true,
		});

		const content = lastUser(body).content as Part[];
		expect(content.map((part) => part.type)).toEqual([
			"text",
			"image_url",
			"image_url",
		]);
		const text = userText(body);
		expect(text).toContain("What do these two show?");
		// The extracted text travels with the pixels.
		expect(text).toContain("Text read from receipt.png");
		expect(text).toContain("Text read from screenshot.png");
		expect(text).not.toContain(CANNOT_SEE_IMAGES_GUIDANCE);
		expect(text).not.toContain("were not sent as pictures");

		for (const url of imageUrls(body)) {
			expect(url).toMatch(/^data:image\/jpeg;base64,/);
			const meta = await decode(url);
			expect([meta.format, meta.width, meta.height]).toEqual([
				"jpeg",
				800,
				600,
			]);
		}
	});

	it("is sent a photo shrunk to the budget, not the stored original", async () => {
		const conversationId = await newConversation();
		const big = await sharp({
			create: { width: 4032, height: 3024, channels: 3, background: "#888888" },
		})
			.jpeg()
			.toBuffer();

		const body = await ask({
			conversationId,
			message: "Where was this?",
			attachments: [
				await readyImage(conversationId, "holiday.jpg", {
					bytes: big,
					mimeType: "image/jpeg",
				}),
			],
			canSee: true,
		});

		const meta = await decode(imageUrls(body)[0] ?? "");
		expect([meta.width, meta.height]).toEqual([1600, 1200]);
	});

	it("names the pictures the limit left out when ten are attached", async () => {
		const conversationId = await newConversation();
		const attachments: Artifact[] = [];
		for (let index = 0; index < 10; index += 1) {
			attachments.push(
				await readyImage(conversationId, `photo-${index}.png`, {
					bytes: await photoBytes(64, 48),
				}),
			);
		}

		const body = await ask({
			conversationId,
			message: "Which of these is the sharpest?",
			attachments,
			canSee: true,
		});

		expect(imageUrls(body)).toHaveLength(8);
		expect(userText(body)).toContain(
			"2 more attached images were not sent as pictures because of the limit: photo-8.png, photo-9.png.",
		);
	});

	it("goes on without a picture it cannot read, and sends the others", async () => {
		const conversationId = await newConversation();
		const attachments = [
			await readyImage(conversationId, "broken.png", {
				bytes: Buffer.from("not a picture"),
			}),
			await readyImage(conversationId, "fine.png"),
		];

		const body = await ask({
			conversationId,
			message: "What is in these?",
			attachments,
			canSee: true,
		});

		expect(imageUrls(body)).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			"[ATTACHMENTS] Image not sent as a picture",
			expect.objectContaining({ reason: expect.any(String) }),
		);
	});

	it("is sent no picture for a BMP, which cannot be decoded, and is not told it cannot see", async () => {
		const conversationId = await newConversation();

		const body = await ask({
			conversationId,
			message: "What does this say?",
			attachments: [
				await readyImage(conversationId, "scan.bmp", {
					bytes: Buffer.from("BM"),
					mimeType: "image/bmp",
				}),
			],
			canSee: true,
		});

		expect(imageUrls(body)).toEqual([]);
		expect(userText(body)).toContain("Text read from scan.bmp");
		expect(userText(body)).not.toContain(CANNOT_SEE_IMAGES_GUIDANCE);
	});

	it("gets a plain text message when nothing is attached", async () => {
		const conversationId = await newConversation();

		const body = await ask({
			conversationId,
			message: "Hello there",
			canSee: true,
		});

		expect(lastUser(body).content).toEqual(expect.any(String));
		expect(userText(body)).toContain("Hello there");
		expect(userText(body)).not.toContain(CANNOT_SEE_IMAGES_GUIDANCE);
		expect(JSON.stringify(body)).not.toContain("image_url");
	});

	it("is not sent an earlier turn's picture again: the pixels belong to one turn", async () => {
		const conversationId = await newConversation();
		const photo = await readyImage(conversationId, "kitchen.png");
		const earlier = await createMessage(
			conversationId,
			"user",
			"What is this?",
		);
		await attachArtifactsToMessage({
			userId,
			conversationId,
			messageId: earlier.id,
			artifactIds: [photo.id],
		});
		await createMessage(conversationId, "assistant", "A kitchen.");

		const body = await ask({
			conversationId,
			message: "And what colour are the walls?",
			canSee: true,
		});

		expect(JSON.stringify(body)).toContain("kitchen.png");
		expect(JSON.stringify(body)).not.toContain("image_url");
	});
});

describe("a model that cannot see", () => {
	it("is sent no picture, is told so in one line, and still has the extracted text", async () => {
		const conversationId = await newConversation();

		const body = await ask({
			conversationId,
			message: "What is the total?",
			attachments: [await readyImage(conversationId, "receipt.png")],
			canSee: false,
		});

		expect(imageUrls(body)).toEqual([]);
		expect(JSON.stringify(body)).not.toContain("image_url");
		const text = userText(body);
		expect(text).toContain(CANNOT_SEE_IMAGES_GUIDANCE);
		expect(text).toContain("Text read from receipt.png");
		// The line rides the turn guidance, after the message, like the rest.
		expect(text.indexOf(CANNOT_SEE_IMAGES_GUIDANCE)).toBeGreaterThan(
			text.indexOf("## Turn Guidance"),
		);
	});

	it("is told nothing about pictures when the message attaches none", async () => {
		const conversationId = await newConversation();

		const body = await ask({
			conversationId,
			message: "Hello there",
			canSee: false,
		});

		expect(userText(body)).not.toContain(CANNOT_SEE_IMAGES_GUIDANCE);
	});

	it("is told nothing about pictures when the message attaches a document", async () => {
		const conversationId = await newConversation();
		const document = await createArtifact({
			userId,
			conversationId,
			type: "normalized_document",
			name: "notes.txt",
			mimeType: "text/plain",
			extension: "txt",
			sizeBytes: 40,
			contentText: "Meeting notes: ship the report on Friday morning.",
		});

		const body = await ask({
			conversationId,
			message: "Summarise the notes",
			attachments: [document],
			canSee: false,
		});

		expect(userText(body)).not.toContain(CANNOT_SEE_IMAGES_GUIDANCE);
	});
});

describe("buildConstructedContext", () => {
	const limits = {
		maxModelContext: 40_000,
		compactionUiThreshold: 32_000,
		targetConstructedContext: 24_000,
	};

	it("reports the pictures without reading a file when the model cannot see", async () => {
		const conversationId = await newConversation();
		const photo = await readyImage(conversationId, "a.png");

		const result = await buildConstructedContext({
			userId,
			conversationId,
			message: "What is this?",
			attachmentIds: [photo.id],
			contextLimits: limits,
			collectImages: false,
		});

		expect(result.turnImages.images).toEqual([]);
		expect(result.turnImages.hasImageAttachments).toBe(true);
	});

	it("prepares the pictures once and hands them to a rebuild", async () => {
		const conversationId = await newConversation();
		const photo = await readyImage(conversationId, "a.png");
		const turn = {
			userId,
			conversationId,
			message: "What is this?",
			attachmentIds: [photo.id],
			contextLimits: limits,
			collectImages: true,
		};
		const first = await buildConstructedContext(turn);
		expect(first.turnImages.images).toHaveLength(1);
		expect(first._reuseData?.turnImages).toBe(first.turnImages);

		// The file is gone: a rebuild that read it again would find nothing.
		await rm(join(process.cwd(), photo.storagePath ?? ""));
		const rebuilt = await buildConstructedContext({
			...turn,
			reuseFrom: first._reuseData,
		});

		expect(rebuilt.turnImages).toBe(first.turnImages);
		expect(rebuilt._reuseData).toBeUndefined();
	});

	it("gives up history to the pictures it carries, by their own prepared size", async () => {
		const conversationId = await newConversation();
		for (let turn = 0; turn < 14; turn += 1) {
			await createMessage(conversationId, "user", `Question ${turn}?`);
			await createMessage(
				conversationId,
				"assistant",
				`Answer ${turn}. ${"A fairly long answer sentence. ".repeat(180)}`,
			);
		}
		const attachmentIds = [
			(
				await readyImage(conversationId, "wide.png", {
					bytes: await photoBytes(1600, 1000),
				})
			).id,
			(
				await readyImage(conversationId, "square.png", {
					bytes: await photoBytes(1600, 1600),
				})
			).id,
		];
		const turn = {
			userId,
			conversationId,
			message: "Compare these with what we discussed",
			attachmentIds,
			contextLimits: limits,
		};

		const without = await buildConstructedContext({
			...turn,
			collectImages: false,
		});
		const withPictures = await buildConstructedContext({
			...turn,
			collectImages: true,
		});

		// 1,600 + 2,500 tokens: each picture at its own prepared size.
		expect(
			withPictures.turnImages.images.map(
				(entry) => entry.image.estimatedTokens,
			),
		).toEqual([1600, 2500]);
		expect(withPictures.historyWindow.includedTurnCount).toBeGreaterThan(0);
		expect(withPictures.historyWindow.includedTurnCount).toBeLessThan(
			without.historyWindow.includedTurnCount,
		);
	});
});
