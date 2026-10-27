// The Immich look, end to end: the app's own tool pack, the real photos tool and
// the plain model run, with a fake Immich (a search and thumbnails), a scripted
// fake provider that asks for the photos tool and then answers, and the real
// image preparation. The edges that are faked are the person's connection, the
// person's setting and where each model runs; everything between them is the
// code under test.
//
// The model asks to look ("look": true) and the thumbnails of the photos it
// found reach it in the step after the tool result, as pictures in a user
// message: to a model that can see, and to no other. For a person who keeps
// summarising local, a cloud model is sent no picture at all; a local model that
// can see reads them and only a summary goes on.
import { randomUUID } from "node:crypto";
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
	// The model that summarises connector data, and so the one that would look.
	process.env.MEMORY_CONSOLIDATION_MODEL = "model2";
});

const mocks = vi.hoisted(() => ({
	immichSmartSearch: vi.fn(),
	immichThumbnail: vi.fn(),
	modelIdCanSeeImages: vi.fn(),
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
	connection: {
		id: "conn-immich",
		userId: "user",
		provider: "immich",
		label: "Immich",
		accountIdentifier: "alex@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["photos"],
		config: { origin: "https://photos.example.com", immichUserId: "alex" },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: 0,
		updatedAt: 0,
	},
}));

vi.mock(
	"../../src/lib/server/services/connections/resolve",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/server/services/connections/resolve")
		>()),
		resolveActiveCapabilities: async () => new Set(["photos"]),
		resolveConnectionsForCapability: async () => [mocks.connection],
		needsDisambiguation: () => false,
	}),
);
vi.mock(
	"../../src/lib/server/services/connections/store",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/server/services/connections/store")
		>()),
		touchConnectionUsed: async () => undefined,
	}),
);
vi.mock(
	"../../src/lib/server/services/connections/providers/immich",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/server/services/connections/providers/immich")
		>()),
		immichSmartSearch: mocks.immichSmartSearch,
		immichThumbnail: mocks.immichThumbnail,
	}),
);
vi.mock(
	"../../src/lib/server/services/connections/locality",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/server/services/connections/locality")
		>()),
		hasLocalDistillEnabled: mocks.hasLocalDistillEnabled,
		isCloudModel: mocks.isCloudModel,
		distillConnectorPayload: mocks.distillConnectorPayload,
	}),
);
vi.mock(
	"../../src/lib/server/services/vision/model-vision",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/lib/server/services/vision/model-vision")
		>()),
		modelIdCanSeeImages: mocks.modelIdCanSeeImages,
	}),
);

import { eq } from "drizzle-orm";
import { createModelCapabilitySet } from "../../src/lib/model-capabilities";
import { getConfig } from "../../src/lib/server/config-store";
import { db } from "../../src/lib/server/db";
import { imageDescriptions, users } from "../../src/lib/server/db/schema";
import { buildBaselineDepthMetadata } from "../../src/lib/server/services/chat-turn/depth-metadata";
import { runPlainNormalChatSendModel } from "../../src/lib/server/services/chat-turn/plain-normal-chat-model-run";
import { createConversation } from "../../src/lib/server/services/conversations";
import { IMAGE_DESCRIPTION_PROMPT } from "../../src/lib/server/services/vision/describe";
import { STRIPPED_IMAGE_NOTE } from "../../src/lib/server/services/vision/turn-images";

type Message = {
	role: string;
	content: unknown;
	tool_call_id?: string;
	tool_calls?: unknown[];
};
type Part = { type: string; text?: string; image_url?: { url: string } };
type Recorded = {
	url: string;
	body: { messages: Message[]; tools?: unknown[] };
};

const SEEING = createModelCapabilitySet({
	imageMessageParts: {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	},
});

const QUESTION = "Which of my beach photos is the sharpest?";
const CLOUD_SUMMARY = "Three beach photos; the second is the sharpest.";
const LOCAL_DESCRIPTION = "A sandy beach under a clear sky.";

let userId: string;
let email: string;
/** Every request the fake provider has had since the test began. */
let requests: Recorded[] = [];
/** How many times the fake model asks for the photos before it answers. */
let rounds = 1;
/** How many calls to the photos tool it makes at once in each of those steps. */
let callsPerRound = 1;

function jsonResponse(message: Record<string, unknown>, finish: string) {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-1",
			object: "chat.completion",
			created: 0,
			model: "fake",
			choices: [{ index: 0, message, finish_reason: finish }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/**
 * The fake provider. A chat request that carries the tools and no tool result
 * yet gets a call to the photos tool with `look: true`; the next one gets an
 * answer. A request to the local model (the one that looks for a cloud model)
 * gets a description.
 */
async function fakeFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url =
		typeof input === "string"
			? input
			: String((input as URL).href ?? (input as Request).url);
	const body = JSON.parse(String(init?.body ?? "{}")) as Recorded["body"];
	requests.push({ url, body });
	if (url.startsWith("http://model2.fake")) {
		return jsonResponse(
			{ role: "assistant", content: LOCAL_DESCRIPTION },
			"stop",
		);
	}
	const hasPhotosTool = JSON.stringify(body.tools ?? []).includes('"photos"');
	const askedBefore = body.messages.filter(
		(message) => message.role === "assistant" && message.tool_calls,
	).length;
	if (hasPhotosTool && askedBefore < rounds) {
		return jsonResponse(
			{
				role: "assistant",
				content: null,
				tool_calls: Array.from({ length: callsPerRound }, (_, index) => ({
					id: `call-look-${askedBefore + 1}-${index + 1}`,
					type: "function",
					function: {
						name: "photos",
						arguments: JSON.stringify({
							action: "search",
							query: "beach",
							look: true,
						}),
					},
				})),
			},
			"tool_calls",
		);
	}
	return jsonResponse(
		{ role: "assistant", content: "The second one." },
		"stop",
	);
}

async function webp(color: string): Promise<ArrayBuffer> {
	const bytes = await sharp({
		create: { width: 900, height: 600, channels: 3, background: color },
	})
		.webp()
		.toBuffer();
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

beforeAll(async () => {
	vi.stubGlobal("fetch", fakeFetch);
	userId = randomUUID();
	email = `look-${randomUUID().slice(0, 6)}@example.com`;
	await db.insert(users).values({
		id: userId,
		email,
		passwordHash: "not-a-real-hash",
		name: "Alex Morgan",
		role: "user",
	});
});

afterAll(() => {
	vi.unstubAllGlobals();
});

// The model run logs each step it finishes; the output stays clean.
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	requests = [];
	rounds = 1;
	callsPerRound = 1;
	for (const mock of [
		mocks.immichSmartSearch,
		mocks.immichThumbnail,
		mocks.modelIdCanSeeImages,
		mocks.hasLocalDistillEnabled,
		mocks.isCloudModel,
		mocks.distillConnectorPayload,
	]) {
		mock.mockReset();
	}
	foundPhotos(3);
	mocks.immichThumbnail.mockImplementation(
		async (
			_user: string,
			_connection: string,
			params: { assetId: string },
		) => ({
			bytes: await webp(colourOf(Number(params.assetId.split("-")[1]))),
			contentType: "image/webp",
		}),
	);
	mocks.distillConnectorPayload.mockResolvedValue({ distilled: CLOUD_SUMMARY });
});

afterEach(() => {
	warn.mockRestore();
});

/** The photos the fake Immich finds: one-beach.jpg, two-beach.jpg, ... */
function foundPhotos(count: number) {
	const names = [
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
	];
	mocks.immichSmartSearch.mockResolvedValue(
		Array.from({ length: count }, (_, index) => ({
			id: `asset-${index + 1}`,
			fileName: `${names[index]}-beach.jpg`,
			takenAt: "2026-06-01T09:55:00.000Z",
			type: "IMAGE",
			thumbnailPath: `/api/assets/asset-${index + 1}/thumbnail`,
		})),
	);
}

/** A colour for each photo, so that no two thumbnails have the same bytes. */
function colourOf(number: number): string {
	const channel = (n: number) => ((n * 53) % 200) + 28;
	return `#${[channel(number), channel(number + 3), channel(number + 6)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}

/** The provider of the attempt: by default a model of the fake provider's. */
function provider(canSee: boolean, baseUrl = "http://model1.fake/v1") {
	return {
		id: "fake",
		modelId: "model1" as const,
		name: "fake",
		displayName: "Fake Model",
		baseUrl,
		modelName: "fake-model-1",
		apiKey: "k1",
		...(canSee ? { capabilities: SEEING } : {}),
	};
}

/** One plain chat turn in which the model looks at the photos it finds. */
async function askToLook(params: {
	chatModelCanSee: boolean;
	baseUrl?: string;
}) {
	const conversationId = (await createConversation(userId, "Beach photos")).id;
	const result = await runPlainNormalChatSendModel({
		userId,
		runtimeConfig: getConfig(),
		message: QUESTION,
		conversationId,
		modelId: "model1",
		user: { id: userId, displayName: "Alex Morgan", email },
		depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
		enabledConnectionCapabilities: ["photos"],
		overrideProvider: provider(params.chatModelCanSee, params.baseUrl),
	});
	// The requests the chat model had: before the tool ran, and after.
	const chat = requests.filter(
		(request) =>
			!request.url.startsWith("http://model2.fake") &&
			JSON.stringify(request.body.tools ?? []).includes('"photos"'),
	);
	return { result, chat };
}

function partsOf(message: Message | undefined): Part[] {
	return Array.isArray(message?.content) ? (message.content as Part[]) : [];
}

describe("the model asks to look at the photos it found", () => {
	it("shows a model that can see small thumbnails of them in the step after the tool result", async () => {
		mocks.modelIdCanSeeImages.mockResolvedValue(true);
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(false);

		const { result, chat } = await askToLook({ chatModelCanSee: true });

		expect(chat).toHaveLength(2);
		const [before, after] = chat;
		// Before the tool ran, no picture.
		expect(JSON.stringify(before?.body)).not.toContain("image_url");
		// After it: the call, its result, then the pictures as a user message.
		const messages = after?.body.messages ?? [];
		expect(messages.at(-2)?.role).toBe("tool");
		const picturesMessage = messages.at(-1);
		expect(picturesMessage?.role).toBe("user");
		const parts = partsOf(picturesMessage);
		expect(parts.map((part) => part.type)).toEqual([
			"text",
			"image_url",
			"image_url",
			"image_url",
		]);
		expect(parts[0]?.text).toBe(
			"Thumbnails from the photos tool, in result order: 1 = one-beach.jpg, 2 = two-beach.jpg, 3 = three-beach.jpg",
		);
		// What it was sent is what the preparer makes of an Immich thumbnail: a
		// JPEG no longer than 512 px on its long side.
		for (const part of parts.slice(1)) {
			const url = part.image_url?.url ?? "";
			expect(url).toMatch(/^data:image\/jpeg;base64,/);
			const meta = await sharp(
				Buffer.from(url.split(",")[1] ?? "", "base64"),
			).metadata();
			expect([meta.format, meta.width, meta.height]).toEqual([
				"jpeg",
				512,
				341,
			]);
		}
		// The tool result says they follow, and the call is recorded as having
		// shown three (the activity row reads it).
		const toolResult = JSON.parse(String(messages.at(-2)?.content)) as {
			message: string;
		};
		expect(toolResult.message).toContain("3 thumbnails follow");
		expect(result.normalChatToolCalls?.[0]).toMatchObject({
			name: "photos",
			input: { action: "search", query: "beach", look: true },
			metadata: expect.objectContaining({ ok: true, viewedCount: 3 }),
		});
	});

	it("leaves the pixels out of everything that is kept: the record of the call, the descriptions, the next turn's history", async () => {
		mocks.modelIdCanSeeImages.mockResolvedValue(true);
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(false);

		const { result } = await askToLook({ chatModelCanSee: true });

		const sent = requests
			.flatMap((request) => partsOf(request.body.messages.at(-1)))
			.map((part) => part.image_url?.url ?? "")
			.filter(Boolean);
		expect(sent.length).toBeGreaterThan(0);
		const recorded = JSON.stringify(result.toolCalls);
		for (const url of sent) {
			expect(recorded).not.toContain(url.split(",")[1] ?? "never");
		}
		// A thumbnail is not an artifact: no description is asked for or kept.
		expect(
			requests.filter((request) =>
				JSON.stringify(request.body).includes(IMAGE_DESCRIPTION_PROMPT),
			),
		).toEqual([]);
		expect(
			await db
				.select()
				.from(imageDescriptions)
				.where(eq(imageDescriptions.userId, userId)),
		).toEqual([]);
	});

	it("gives an attempt on a model that cannot see the label and a note, never the pixels", async () => {
		// The tool decided for a model that sees; this attempt runs on one that
		// does not (a fallback, or a model nobody ticked).
		mocks.modelIdCanSeeImages.mockResolvedValue(true);
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(false);

		const { chat } = await askToLook({ chatModelCanSee: false });

		const after = chat.at(-1);
		expect(JSON.stringify(after?.body)).not.toContain("image_url");
		expect(JSON.stringify(after?.body)).not.toContain("base64,");
		expect(partsOf(after?.body.messages.at(-1))).toEqual([
			{
				type: "text",
				text: "Thumbnails from the photos tool, in result order: 1 = one-beach.jpg, 2 = two-beach.jpg, 3 = three-beach.jpg",
			},
			{ type: "text", text: STRIPPED_IMAGE_NOTE },
		]);
	});

	it("sends a cloud model no picture for a person who keeps summarising local: a local model looks, and only the summary goes on", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockImplementation(
			async (id: string) => id === "model1",
		);
		// The cloud model itself could see; it is not asked to.
		mocks.modelIdCanSeeImages.mockResolvedValue(true);

		const { result, chat } = await askToLook({ chatModelCanSee: true });

		// Every request to the cloud model, whole: no picture, no thumbnail bytes,
		// no file name, no word the local model said.
		expect(chat).toHaveLength(2);
		const cloudSaw = JSON.stringify(chat.map((request) => request.body));
		expect(cloudSaw).not.toContain("image_url");
		expect(cloudSaw).not.toContain("base64,");
		expect(cloudSaw).not.toContain("one-beach.jpg");
		expect(cloudSaw).not.toContain(LOCAL_DESCRIPTION);
		expect(cloudSaw).toContain(CLOUD_SUMMARY);
		// The local model read the three thumbnails, as pictures.
		const local = requests.filter((request) =>
			request.url.startsWith("http://model2.fake"),
		);
		expect(local).toHaveLength(3);
		for (const request of local) {
			expect(JSON.stringify(request.body)).toContain("data:image/jpeg;base64,");
		}
		// What it said went to the summary, not to the cloud model.
		expect(mocks.distillConnectorPayload).toHaveBeenCalledWith(
			expect.objectContaining({
				rawText: expect.stringContaining(`looks like: ${LOCAL_DESCRIPTION}`),
			}),
		);
		// Nothing was queued for the model, so the row has nothing to count.
		expect(result.normalChatToolCalls?.[0]?.metadata).toMatchObject({
			viewedCount: 0,
		});
	});

	it("sends a cloud model no picture, and looks at nothing, when no local model can see", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockImplementation(
			async (id: string) => id === "model1",
		);
		mocks.modelIdCanSeeImages.mockResolvedValue(false);

		const { chat } = await askToLook({ chatModelCanSee: true });

		expect(mocks.immichThumbnail).not.toHaveBeenCalled();
		expect(
			requests.filter((request) =>
				request.url.startsWith("http://model2.fake"),
			),
		).toEqual([]);
		const cloudSaw = JSON.stringify(chat.map((request) => request.body));
		expect(cloudSaw).not.toContain("image_url");
		expect(cloudSaw).toContain("could not be looked at");
	});
});

// A person who keeps summarising local has the pictures cleared for a model on
// their own box. The tool decides for the model the turn started on; the attempt
// that is sent them can be on another host (a failover to a cloud model that is
// ticked "Can see images"), and then it gets neither pictures nor names.
describe("the attempt that is sent the pictures of a person who keeps summarising local", () => {
	const cloud = "https://api.cloud.example/v1";
	const onTheBox = "http://127.0.0.1:18081/v1";

	function keepLocalWithALocalModel() {
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		// The model the tool decides for is local: pixels are the answer.
		mocks.isCloudModel.mockResolvedValue(false);
		mocks.modelIdCanSeeImages.mockResolvedValue(true);
	}

	it("shows a model on the box that can see the thumbnails, with the names", async () => {
		keepLocalWithALocalModel();

		const { chat } = await askToLook({
			chatModelCanSee: true,
			baseUrl: onTheBox,
		});

		const parts = partsOf(chat.at(-1)?.body.messages.at(-1));
		expect(parts.map((part) => part.type)).toEqual([
			"text",
			"image_url",
			"image_url",
			"image_url",
		]);
		expect(parts[0]?.text).toContain("1 = one-beach.jpg");
	});

	it("sends a cloud model that can see no picture and no name in the step that follows the tool", async () => {
		keepLocalWithALocalModel();

		const { chat } = await askToLook({ chatModelCanSee: true, baseUrl: cloud });

		const wire = JSON.stringify(chat.map((request) => request.body));
		expect(wire).not.toContain("image_url");
		expect(wire).not.toContain("base64,");
		// What the step added says that pictures were here, and names no photo.
		// (The tool's own result text is gated for the model the turn started on,
		// as every connector's is.)
		const added = chat.at(-1)?.body.messages.at(-1);
		expect(partsOf(added)).toEqual([
			{
				type: "text",
				text: "Thumbnails from the photos tool, in result order: 1, 2, 3",
			},
			{ type: "text", text: STRIPPED_IMAGE_NOTE },
		]);
	});
});

// A turn may show the model eight thumbnails, however many looks it asks for and
// however many it asks for in one step.
describe("the turn's eight thumbnails", () => {
	beforeEach(() => {
		mocks.modelIdCanSeeImages.mockResolvedValue(true);
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		mocks.isCloudModel.mockResolvedValue(false);
	});

	function pictureCount(message: Message | undefined): number {
		return partsOf(message).filter((part) => part.type === "image_url").length;
	}

	function toolResults(request: Recorded | undefined): string[] {
		return (request?.body.messages ?? [])
			.filter((message) => message.role === "tool")
			.map((message) => String(message.content));
	}

	it("tells a second look in the same reply that the limit is used up, and still hands it its search", async () => {
		foundPhotos(8);
		rounds = 2;

		const { result, chat } = await askToLook({ chatModelCanSee: true });

		// Three steps: the first look, the second, the answer.
		expect(chat).toHaveLength(3);
		expect(pictureCount(chat[1]?.body.messages.at(-1))).toBe(8);
		// The second look's step carries no new picture: its result is the last
		// message, and it says the limit is used up.
		const lastOfThird = chat[2]?.body.messages.at(-1);
		expect(lastOfThird?.role).toBe("tool");
		const [, secondResult] = toolResults(chat[2]).map(
			(text) => JSON.parse(text) as { message: string; results: unknown[] },
		);
		expect(secondResult?.message).toContain(
			"No thumbnails are left for this reply (at most 8 are shown in one reply)",
		);
		expect(secondResult?.results).toHaveLength(8);
		expect(JSON.stringify(chat[2]?.body)).not.toContain("image_url");
		expect(
			result.normalChatToolCalls?.map((call) => call.metadata?.viewedCount),
		).toEqual([8, 0]);
		// And only eight were ever downloaded.
		expect(mocks.immichThumbnail).toHaveBeenCalledTimes(8);
	});

	it("shares the eight between two looks asked for in one step: eight pictures in the step, not ten", async () => {
		foundPhotos(5);
		callsPerRound = 2;

		const { result, chat } = await askToLook({ chatModelCanSee: true });

		expect(chat).toHaveLength(2);
		const messages = chat[1]?.body.messages ?? [];
		// The two calls' results, then the pictures of each look as a user message.
		const lastResult = messages.map((m) => m.role).lastIndexOf("tool");
		const added = messages.slice(lastResult + 1);
		expect(added.map((message) => message.role)).toEqual(["user", "user"]);
		const pictures = added.map(pictureCount);
		expect(pictures.reduce((sum, count) => sum + count, 0)).toBe(8);
		expect([...pictures].sort()).toEqual([3, 5]);
		const messagesOfResults = toolResults(chat[1]).map(
			(text) => JSON.parse(text) as { message: string },
		);
		expect(
			messagesOfResults.filter((r) =>
				r.message.includes("allowed in one reply"),
			),
		).toHaveLength(1);
		expect(
			result.normalChatToolCalls
				?.map((call) => call.metadata?.viewedCount)
				.sort(),
		).toEqual([3, 5]);
	});
});
