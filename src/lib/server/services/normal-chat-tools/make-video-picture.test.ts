// @vitest-environment node
//
// The failing live sequence, end to end: make_image makes a picture, then
// make_video animates it WITHOUT the model knowing any id — the way a turn
// that says "make me a picture and animate it" actually runs. The picture half
// is the real tool over the real fake ComfyUI; the video half queues a real
// take on the real kind and the wait is injected, so nothing renders a clip.
//
// The addressing rules are all here, against real rows: no picture animates
// what the turn just made, a takeId from make_image works, a title is refused
// with what the turn offers, an earlier message's picture number still works,
// and another person's takeId is still refused.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "$lib/server/db/schema";
import { warmModules } from "$lib/server/testing/warm-modules";
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "../images/comfyui/testing/fake-comfyui";
import {
	createImageFixture,
	type ImageFixture,
} from "../images/testing/fixture";
import { useFakeComfyUi } from "../images/testing/run-takes";
import type { TurnPictureIndex } from "../images/turn-pictures";
import type { TurnTakes } from "../images/turn-takes";

const userId = "user-1";
const otherUserId = "user-2";
const conversationId = "conv-1";
const otherConversationId = "conv-2";

let fixture: ImageFixture;
let workdir: string;
let fake: FakeComfyUi | null = null;

beforeAll(async () => {
	await warmModules([
		() => import("./make-image"),
		() => import("./make-video"),
		() => import("../images/image-runner"),
		() => import("$lib/server/services/artifacts"),
	]);
}, 60_000);

beforeEach(async () => {
	fixture = createImageFixture("make-video-picture");
	fixture.seedUser(userId);
	fixture.seedUser(otherUserId);
	fixture.seedConversation(conversationId, userId);
	fixture.seedConversation(otherConversationId, otherUserId);
	workdir = await mkdtemp(join(tmpdir(), "make-video-picture-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_LTX_URL = "http://127.0.0.1:9";
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { stopJobs, resetJobsForTests } = await import(
			"$lib/server/services/jobs"
		);
		stopJobs();
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	await fake?.close();
	fake = null;
	useFakeComfyUi(null);
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	delete process.env.COMFYUI_LTX_URL;
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

async function startPictureServer() {
	fake = await createFakeComfyUi({ steps: 2 });
	useFakeComfyUi(fake.baseUrl);
	const { startJobs } = await import("$lib/server/services/jobs");
	const { imageJob } = await import("../images/image-job");
	await startJobs([imageJob], { startInNonServingContextForTests: true });
}

/** The real make_image call: a picture from words, the way the live turn made one. */
async function makePicture(turnTakes: TurnTakes) {
	const { runMakeImageTool } = await import("./make-image");
	const { modelPayload } = await runMakeImageTool({
		userId,
		conversationId,
		turnId: "turn-1",
		toolCallId: "image-call-1",
		input: {
			prompt: "a cat in a birthday hat",
			title: "Cat in Birthday Hat",
		},
		turnPictures: null,
		turnTakes,
		requestText: "Make me a cat picture and animate it",
		signal: new AbortController().signal,
	});
	return modelPayload;
}

/** The real make_video call; the take is queued for real and the wait never renders it. */
async function makeVideo(
	turnTakes: TurnTakes,
	input: {
		picture?: string;
		prompt?: string;
		title?: string;
	},
	options: {
		userId?: string;
		conversationId?: string;
		turnPictures?: TurnPictureIndex | null;
	} = {},
) {
	const { makeVideoInputSchema, runMakeVideoTool } = await import(
		"./make-video"
	);
	return runMakeVideoTool({
		userId: options.userId ?? userId,
		conversationId: options.conversationId ?? conversationId,
		toolCallId: "video-call-1",
		input: makeVideoInputSchema.parse({
			prompt: "the cat blinks slowly, the camera stays still",
			title: "Cat Blinking",
			...input,
		}),
		requestText: "Make me a cat picture and animate it",
		turnPictures: options.turnPictures ?? null,
		turnTakes,
		signal: new AbortController().signal,
		state: { takeId: null },
		waitForTake: async (takeId) => ({
			takeId,
			status: "queued",
			resultFileId: null,
			artifactId: null,
			errorCode: null,
			retryable: false,
		}),
	});
}

/** The picture file the image take stored, from its own row. */
async function resultFileOf(takeId: string): Promise<string> {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select({ resultFileId: schema.imageJobs.resultFileId })
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.limit(1);
	if (!row?.resultFileId) throw new Error("the picture take stored no file");
	return row.resultFileId;
}

/** The video takes queued so far, as their requests. */
async function videoRequests() {
	const { db } = await import("$lib/server/db");
	const { parseVideoTakeRequest } = await import("../images/video/request");
	const rows = await db.select().from(schema.videoJobs).all();
	return rows.map((row) => parseVideoTakeRequest(row.requestJson));
}

async function storePicture(): Promise<string> {
	const { storeImageFile } = await import("../images/files");
	const file = await storeImageFile({
		userId,
		conversationId,
		role: "take",
		png: new Uint8Array(
			await sharp({
				create: { width: 640, height: 480, channels: 3, background: "#556677" },
			})
				.png()
				.toBuffer(),
		),
	});
	return file.id;
}

function indexOf(
	fileId: string,
	name = "An earlier picture",
): TurnPictureIndex {
	const pictures = [
		{
			number: 1,
			source: {
				type: "image_file" as const,
				fileId,
				name,
				artifactId: null,
				role: "attached" as const,
			},
		},
	];
	return {
		pictures,
		metadata: null,
		byNumber: (number) => pictures.find((p) => p.number === number) ?? null,
	};
}

function messageOf(payload: { ok: boolean; message?: string }): string {
	return payload.ok ? "" : String(payload.message ?? "");
}

describe("the picture make_video animates", () => {
	it("makes the picture and animates it in one turn, with no picture named", async () => {
		await startPictureServer();
		const { createTurnTakes } = await import("../images/turn-takes");
		const turnTakes = createTurnTakes();

		const image = await makePicture(turnTakes);
		expect(image).toMatchObject({ ok: true, status: "succeeded" });
		const pictureFileId = await resultFileOf(
			(image as { takeId: string }).takeId,
		);

		const video = await makeVideo(turnTakes, {});
		expect(video.modelPayload).toMatchObject({ ok: true, status: "running" });
		const requests = await videoRequests();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.sourceFileId).toBe(pictureFileId);

		// What make_image hands back says how to animate it, without an id hunt.
		const imageId = (image as { imageId: string | null }).imageId;
		expect((image as { note: string }).note).toContain(
			`make_video with picture "${imageId}"`,
		);
		expect((image as { note: string }).note).toContain(
			"or with no picture at all",
		);
	});

	it("animates the picture a make_image takeId names", async () => {
		await startPictureServer();
		const { createTurnTakes } = await import("../images/turn-takes");
		const turnTakes = createTurnTakes();
		const image = await makePicture(turnTakes);
		const takeId = (image as { takeId: string }).takeId;
		const pictureFileId = await resultFileOf(takeId);

		const video = await makeVideo(turnTakes, { picture: takeId });
		expect(video.modelPayload).toMatchObject({ ok: true, status: "running" });
		const requests = await videoRequests();
		expect(requests[0]?.sourceFileId).toBe(pictureFileId);
	});

	it("refuses a title, and says how to name the picture this turn made", async () => {
		await startPictureServer();
		const { createTurnTakes } = await import("../images/turn-takes");
		const turnTakes = createTurnTakes();
		const image = await makePicture(turnTakes);
		const takeId = (image as { takeId: string }).takeId;

		const video = await makeVideo(turnTakes, {
			picture: "Cat in Birthday Hat",
		});
		expect(video.modelPayload).toMatchObject({
			ok: false,
			errorCode: "unknown_picture",
		});
		const message = messageOf(video.modelPayload);
		expect(message).toContain(
			'make_video has no picture "Cat in Birthday Hat"',
		);
		expect(message).toContain('leaving "picture" out');
		expect(message).toContain(takeId);
		expect(message).toContain('"Cat in Birthday Hat"');
		expect(await videoRequests()).toHaveLength(0);
	});

	it("still animates a picture number from an earlier message", async () => {
		const fileId = await storePicture();
		const { createTurnTakes } = await import("../images/turn-takes");
		const video = await makeVideo(
			createTurnTakes(),
			{ picture: "1" },
			{ turnPictures: indexOf(fileId) },
		);
		expect(video.modelPayload).toMatchObject({ ok: true, status: "running" });
		const requests = await videoRequests();
		expect(requests[0]?.sourceFileId).toBe(fileId);
	});

	it("refuses another person's takeId", async () => {
		await startPictureServer();
		const { createTurnTakes } = await import("../images/turn-takes");
		const image = await makePicture(createTurnTakes());
		const takeId = (image as { takeId: string }).takeId;

		const video = await makeVideo(
			createTurnTakes(),
			{ picture: takeId },
			{ userId: otherUserId, conversationId: otherConversationId },
		);
		expect(video.modelPayload).toMatchObject({
			ok: false,
			errorCode: "unknown_picture",
		});
		expect(await videoRequests()).toHaveLength(0);
	});
});
