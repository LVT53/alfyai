// @vitest-environment node
//
// The one checked assumption behind `make_video`'s `videoCardId`: the id it
// reports for the card its row draws is the card the chat's read model returns
// for that take. The read model groups a take with no item by its `make_video`
// call and names the card after the group's FIRST take; `make_video` always
// queues a fresh item (`artifactId: null`) and one take per call, so the first
// take is this take. If a take that appends to an existing item is ever added,
// the tool must read the card id instead of assuming it, and this test fails.
//
// Everything but the picture and the wait is real here: the real `video` job
// kind (a real row), the real read model and a real migrated database.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { warmModules } from "$lib/server/testing/warm-modules";
import {
	createImageFixture,
	type ImageFixture,
} from "../images/testing/fixture";

vi.mock("../images/inputs", () => ({
	loadPicture: async () => ({
		png: new Uint8Array([1, 2, 3]),
		width: 1280,
		height: 720,
		fileId: "still-1",
	}),
	PictureUnreadableError: class PictureUnreadableError extends Error {},
}));

vi.mock("../images/requests", () => ({
	sourcesNamed: async () => ({
		ok: true,
		sources: [
			{
				type: "image_file",
				fileId: "still-1",
				name: "Harbour at dawn",
				artifactId: null,
				role: "attached",
			},
		],
	}),
}));

vi.mock("../images/picture-check/policy", () => ({
	isExplicitFilterOnFor: async () => false,
}));

vi.mock("../video-caption", () => ({
	buildVideoPrompt: async (idea: string) => idea,
}));

const userId = "user-1";
const conversationId = "conv-1";
let fixture: ImageFixture;
let workdir: string;

beforeEach(async () => {
	fixture = createImageFixture("make-video-card");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "make-video-card-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_LTX_URL = "http://127.0.0.1:9";
	vi.resetModules();
	await warmModules([
		() => import("./make-video"),
		() => import("../images/video/read-model"),
	]);
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
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

describe("the card id make_video reports", () => {
	it("is the card the read model makes for the take the call made", async () => {
		const { makeVideoInputSchema, runMakeVideoTool } = await import(
			"./make-video"
		);
		const { listConversationVideoCards } = await import(
			"../images/video/read-model"
		);
		const state = { takeId: null as string | null };
		const outcome = await runMakeVideoTool({
			userId,
			conversationId,
			toolCallId: "call-1",
			input: makeVideoInputSchema.parse({
				prompt: "the tide comes in slowly",
				picture: "1",
				title: "Harbour at dawn",
			}),
			requestText: "animate the harbour",
			turnPictures: null,
			signal: new AbortController().signal,
			state,
			waitForTake: async (takeId) => ({
				takeId,
				status: "succeeded",
				resultFileId: "clip-1",
				artifactId: "video-1",
				errorCode: null,
				retryable: false,
			}),
		});

		// The invariant: a fresh item, so the take is its card's first take.
		const { db } = await import("$lib/server/db");
		const [row] = await db
			.select({ requestJson: schema.videoJobs.requestJson })
			.from(schema.videoJobs)
			.where(eq(schema.videoJobs.id, state.takeId ?? ""))
			.limit(1);
		expect(JSON.parse(String(row?.requestJson)).artifactId).toBeNull();

		const cards = await listConversationVideoCards(userId, conversationId);
		expect(cards).toHaveLength(1);
		expect(outcome.metadata.videoCardId).toBe(cards[0].id);
		expect(outcome.metadata.videoTakeId).toBe(cards[0].take?.id);
		expect(outcome.modelPayload).toMatchObject({
			ok: true,
			status: "succeeded",
			takeId: cards[0].take?.id,
		});
	});
});
