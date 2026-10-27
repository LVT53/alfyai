// The line that says Alfy is looking at the pictures, on the server, end to end:
// real attachments in the test database, the stream orchestrator and the real
// streaming model run, and a capturing fake provider that records what the model
// is sent.
//
// A streamed turn whose model is sent pictures says so once on the
// response-activity channel (`kind: "viewing_images"`, with how many), before
// any word of the answer. A turn with no pictures, or a model that cannot see,
// says nothing. The browser's half (the parser's allow-list, the status line and
// its two languages) is held by the component and parser tests.
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

import { setModelImageInput } from "../../src/lib/model-image-input";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { buildBaselineDepthMetadata } from "../../src/lib/server/services/chat-turn/depth-metadata";
import { decodeUiMessageStreamParts } from "../../src/lib/server/services/chat-turn/stream";
import { runChatStreamOrchestrator } from "../../src/lib/server/services/chat-turn/stream-orchestrator";
import type { ChatTurnPreflight } from "../../src/lib/server/services/chat-turn/types";
import { createConversation } from "../../src/lib/server/services/conversations";
import { createArtifact } from "../../src/lib/server/services/knowledge/store/core";
import type { Artifact } from "../../src/lib/server/services/knowledge/types";
import { createProviderModel } from "../../src/lib/server/services/provider-models";
import {
	createProvider,
	deleteProvider,
} from "../../src/lib/server/services/providers";
import {
	type Capture,
	capture,
	captures,
	installFakeProvider,
	removeFakeProvider,
} from "./language-capture";

type Part = { type: string; data?: Record<string, unknown> };
type ChatBody = { messages: Array<{ role: string; content: unknown }> };

let userId: string;
let email: string;
let directory: string;
let counter = 0;
/** The model id a turn is asked with, for a model the admin ticked "Can see images" on. */
let seeingModelId: string;
/** The same, for a model nobody ticked. */
let blindModelId: string;
/** Providers are global rows a worker's later test files would see: removed when this file is done. */
const providerIds: string[] = [];

beforeAll(async () => {
	installFakeProvider();
	directory = await mkdtemp(join(tmpdir(), "alfyai-vision-viewing-"));
	userId = randomUUID();
	email = `viewing-${randomUUID().slice(0, 6)}@example.com`;
	await db.insert(users).values({
		id: userId,
		email,
		passwordHash: "not-a-real-hash",
		name: "Alex Morgan",
		role: "user",
	});
	seeingModelId = await providerModel("seeing", true);
	blindModelId = await providerModel("blind", false);
});

afterAll(async () => {
	removeFakeProvider();
	for (const id of providerIds) await deleteProvider(id);
	await rm(directory, { recursive: true, force: true });
});

// The model run logs each step it finishes to the console, and a picture that
// cannot be read is logged; the output stays clean.
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A provider with one model, as the admin makes them; the model's id as a turn names it. */
async function providerModel(name: string, canSee: boolean): Promise<string> {
	const provider = await createProvider({
		name: `viewing-${name}-${randomUUID().slice(0, 6)}`,
		displayName: `Viewing ${name}`,
		baseUrl: `http://${name}.fake/v1`,
		apiKey: "k",
	});
	const model = await createProviderModel({
		providerId: provider.id,
		name: `${name}-model`,
		capabilitiesJson: canSee ? setModelImageInput("{}", true) : "{}",
	});
	providerIds.push(provider.id);
	return `provider:${provider.id}:${model.id}`;
}

async function photoBytes(): Promise<Buffer> {
	return sharp({
		create: { width: 64, height: 48, channels: 3, background: "#3366cc" },
	})
		.png()
		.toBuffer();
}

/** An image attachment whose text has been read, so it is ready to send. */
async function readyImage(
	conversationId: string,
	name: string,
	bytes?: Uint8Array,
): Promise<Artifact> {
	const content = bytes ?? (await photoBytes());
	counter += 1;
	const absolute = join(directory, `${counter}-${name}`);
	await writeFile(absolute, content);
	return createArtifact({
		userId,
		conversationId,
		type: "normalized_document",
		name,
		mimeType: "image/png",
		extension: "png",
		sizeBytes: content.byteLength,
		storagePath: relative(process.cwd(), absolute),
		contentText: `Text read from ${name}.`,
	});
}

function turnFor(
	conversationId: string,
	modelId: string,
	attachments: Artifact[],
): ChatTurnPreflight {
	return {
		conversationId,
		normalizedMessage: "What are these?",
		streamId: `stream-${randomUUID()}`,
		modelId: modelId as ChatTurnPreflight["modelId"],
		modelDisplayName: "Viewing model",
		skipPersistUserMessage: false,
		turnOrigin: "send",
		attachmentIds: attachments.map((artifact) => artifact.id),
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "thorough",
		thinkingMode: "auto",
		forceWebSearch: false,
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		depthMetadata: buildBaselineDepthMetadata({ reasoningDepth: "thorough" }),
	};
}

/**
 * Waits until the turn has stopped making requests: the terminal frame comes
 * before the post-turn work (memory, embeddings, the chips) is done, and that
 * work must not run into the next test, or past the end of this file.
 */
async function untilQuiet(quietMs = 250, limitMs = 5_000): Promise<void> {
	const started = Date.now();
	let seen = captures.length;
	let quietSince = Date.now();
	while (Date.now() - started < limitMs) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (captures.length !== seen) {
			seen = captures.length;
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) {
			return;
		}
	}
}

/** One streamed turn, as the stream route hands it over: its parts, in order, and the model's requests. */
async function streamTurn(
	modelId: string,
	attachments: (conversationId: string) => Promise<Artifact[]>,
): Promise<{ parts: Part[]; chatRequests: Capture[] }> {
	const conversationId = (await createConversation(userId, "Pictures")).id;
	const files = await attachments(conversationId);
	let text = "";
	const requests = await capture("vision stream", async () => {
		const response = runChatStreamOrchestrator({
			user: { id: userId, email, displayName: "Alex Morgan", uiLanguage: "en" },
			turn: turnFor(conversationId, modelId, files),
			upstreamMessage: "What are these?",
			downstreamAbortSignal: new AbortController().signal,
			requestStartTime: Date.now(),
		});
		// The stream is finished when the body is: the terminal frame, then [DONE].
		text = await response.text();
		await untilQuiet();
	});
	const parts = decodeUiMessageStreamParts(text).flatMap((part) =>
		part === "[DONE]" ? [] : [part as unknown as Part],
	);
	// The chat call is the one that streams and carries the tools.
	return {
		parts,
		chatRequests: requests.filter((request) => request.body.stream === true),
	};
}

function viewingParts(parts: Part[]): Part[] {
	return parts.filter(
		(part) =>
			part.type === "data-response-activity" &&
			part.data?.kind === "viewing_images",
	);
}

function imageUrlCount(request: Capture): number {
	const body = request.body as unknown as ChatBody;
	const last = [...body.messages].reverse().find((m) => m.role === "user");
	return Array.isArray(last?.content)
		? (last.content as Array<{ type: string }>).filter(
				(part) => part.type === "image_url",
			).length
		: 0;
}

describe("a streamed turn that sends pictures", () => {
	it("says it is looking at them once, with how many, before the first word of the answer", async () => {
		const { parts, chatRequests } = await streamTurn(
			seeingModelId,
			async (conversationId) => [
				await readyImage(conversationId, "receipt.png"),
				await readyImage(conversationId, "screenshot.png"),
			],
		);

		const viewing = viewingParts(parts);
		expect(viewing).toHaveLength(1);
		expect(viewing[0].data).toMatchObject({
			id: "viewing-images",
			kind: "viewing_images",
			status: "running",
			count: 2,
		});
		// Nothing but the count: the file names stay out of the stream.
		expect(Object.keys(viewing[0].data ?? {}).sort()).toEqual([
			"count",
			"id",
			"kind",
			"occurredAt",
			"status",
		]);

		const firstText = parts.findIndex((part) => part.type === "text-delta");
		expect(firstText).toBeGreaterThan(-1);
		expect(parts.indexOf(viewing[0])).toBeLessThan(firstText);

		// And the count is the real thing: the model was sent two pictures.
		expect(chatRequests.map(imageUrlCount)).toContain(2);
	});

	it("counts the pictures that are sent, not the ones that were attached", async () => {
		const { parts, chatRequests } = await streamTurn(
			seeingModelId,
			async (conversationId) => [
				await readyImage(conversationId, "broken.png", Buffer.from("no")),
				await readyImage(conversationId, "first.png"),
				await readyImage(conversationId, "second.png"),
			],
		);

		const viewing = viewingParts(parts);
		expect(viewing).toHaveLength(1);
		expect(viewing[0].data?.count).toBe(2);
		expect(chatRequests.map(imageUrlCount)).toContain(2);
	});

	it("says it for one picture too, and the count is 1", async () => {
		const { parts } = await streamTurn(
			seeingModelId,
			async (conversationId) => [await readyImage(conversationId, "only.png")],
		);

		expect(viewingParts(parts).map((part) => part.data?.count)).toEqual([1]);
	});
});

describe("a streamed turn that sends no picture", () => {
	it("says nothing when nothing is attached", async () => {
		const { parts } = await streamTurn(seeingModelId, async () => []);

		expect(viewingParts(parts)).toEqual([]);
		// The turn itself ran: the answer streamed.
		expect(parts.some((part) => part.type === "text-delta")).toBe(true);
	});

	it("says nothing to a model that cannot see, though an image is attached", async () => {
		const { parts, chatRequests } = await streamTurn(
			blindModelId,
			async (conversationId) => [await readyImage(conversationId, "photo.png")],
		);

		expect(viewingParts(parts)).toEqual([]);
		expect(parts.some((part) => part.type === "text-delta")).toBe(true);
		expect(chatRequests.map(imageUrlCount)).not.toContain(1);
	});

	it("says nothing when no attached picture could be read", async () => {
		const { parts } = await streamTurn(
			seeingModelId,
			async (conversationId) => [
				await readyImage(conversationId, "broken.png", Buffer.from("no")),
			],
		);

		expect(viewingParts(parts)).toEqual([]);
	});
});
