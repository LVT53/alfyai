// @vitest-environment node
//
// The video card read model: one card per video item (or per tool call while
// the item does not exist yet), the newest take drawn, only the owner's and
// only this chat's. The card body's own contract is
// `components/artifacts/video/video-card-view.ts`; this is the shape it reads.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { warmModules } from "$lib/server/testing/warm-modules";
import { createImageFixture, type ImageFixture } from "../testing/fixture";
import type { VideoTakeRequest } from "./request";

let fixture: ImageFixture;
let workdir: string;

beforeAll(async () => {
	await warmModules([() => import("./read-model")]);
});

beforeEach(async () => {
	fixture = createImageFixture("video-read-model");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedConversation("c2", "u1");
	fixture.seedConversation("c3", "u2");
	workdir = await mkdtemp(join(tmpdir(), "video-read-model-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

function request(overrides: Partial<VideoTakeRequest> = {}): VideoTakeRequest {
	return {
		v: 1,
		prompt: "the harbour at dusk, a slow tide",
		durationSeconds: 5,
		sourceFileId: "still-1",
		title: "Harbour at dusk",
		summary: null,
		artifactId: null,
		explicitVariant: false,
		...overrides,
	};
}

let tick = 1_700_000_000;

async function insertVideoTake(input: {
	userId?: string;
	conversationId?: string;
	status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	phase?: string | null;
	phaseAt?: number | null;
	queueAhead?: number | null;
	etaAt?: number | null;
	errorCode?: string | null;
	retryable?: boolean;
	toolCallId?: string | null;
	artifactId?: string | null;
	resultFileId?: string | null;
	request?: VideoTakeRequest;
}): Promise<string> {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const id = randomUUID();
	tick += 1;
	db.insert(schema.videoJobs)
		.values({
			id,
			userId: input.userId ?? "u1",
			conversationId: input.conversationId ?? "c1",
			artifactId: input.artifactId ?? null,
			toolCallId: input.toolCallId ?? null,
			origin: "turn",
			retryOf: null,
			requestJson: JSON.stringify(input.request ?? request()),
			seed: tick,
			status: input.status ?? "succeeded",
			phase: input.phase ?? null,
			phaseAt: input.phaseAt ?? null,
			queueAhead: input.queueAhead ?? null,
			etaAt: input.etaAt ?? null,
			errorCode: input.errorCode ?? null,
			retryable: input.retryable ?? false,
			resultFileId: input.resultFileId ?? null,
			createdAt: new Date(tick * 1000),
		})
		.run();
	return id;
}

async function insertImageFile(input: {
	id: string;
	userId?: string;
	conversationId?: string;
	width: number;
	height: number;
	durationMs?: number | null;
}): Promise<string> {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	db.insert(schema.imageFiles)
		.values({
			id: input.id,
			userId: input.userId ?? "u1",
			conversationId: input.conversationId ?? "c1",
			role: "take",
			width: input.width,
			height: input.height,
			hasAlpha: 0,
			sizeBytes: 1024,
			durationMs: input.durationMs ?? null,
			storagePath: `data/image-files/c1/${input.id}.mp4`,
		})
		.run();
	return input.id;
}

describe("listConversationVideoCards", () => {
	it("serializes a running take and a settled take, oldest card first", async () => {
		const { listConversationVideoCards } = await import("./read-model");
		await insertImageFile({
			id: "still-1",
			width: 1920,
			height: 1080,
		});
		await insertImageFile({
			id: "still-2",
			width: 1080,
			height: 1920,
		});
		await insertImageFile({
			id: "clip-1",
			width: 704,
			height: 1280,
			durationMs: 10_000,
		});
		// The take is expected 8 s after the read: the card is sent the seconds
		// left as of the read, not the finish time (no clock is shared).
		const readAt = 1_700_000_600_000;
		vi.spyOn(Date, "now").mockReturnValue(readAt);
		const running = await insertVideoTake({
			status: "running",
			phase: "rendering",
			phaseAt: 1_700_000_500_000,
			queueAhead: 2,
			etaAt: readAt + 8_000,
			toolCallId: "call-running",
		});
		const settled = await insertVideoTake({
			status: "succeeded",
			toolCallId: "call-settled",
			resultFileId: "clip-1",
			request: request({
				durationSeconds: 10,
				sourceFileId: "still-2",
				title: "A portrait clip",
			}),
		});

		const cards = await listConversationVideoCards("u1", "c1");

		expect(cards).toHaveLength(2);
		expect(cards[0]).toEqual({
			id: running,
			conversationId: "c1",
			artifactId: null,
			title: "Harbour at dusk",
			width: 1280,
			height: 704,
			durationMs: 5000,
			take: {
				id: running,
				status: "running",
				phase: "rendering",
				phaseAt: 1_700_000_500_000,
				queueAhead: 2,
				etaSeconds: 8,
				errorCode: null,
				retryable: false,
				toolCallId: "call-running",
				createdAt: expect.any(Number),
				clip: null,
			},
		});
		expect(cards[1]).toMatchObject({
			id: settled,
			conversationId: "c1",
			title: "A portrait clip",
			// The still is 16:9 but the clip landed portrait: the landed clip's
			// own shape wins once there is one.
			width: 704,
			height: 1280,
			durationMs: 10_000,
			take: {
				id: settled,
				status: "succeeded",
				phase: null,
				queueAhead: null,
				etaSeconds: null,
				errorCode: null,
				retryable: false,
				toolCallId: "call-settled",
				clip: {
					v: 1,
					fileId: "clip-1",
					posterFileId: "clip-1",
					width: 704,
					height: 1280,
					durationMs: 10_000,
					sourceFileId: "still-2",
				},
			},
		});
	});

	it("draws the newest take of one video item, on the card its first take named", async () => {
		const { listConversationVideoCards } = await import("./read-model");
		const first = await insertVideoTake({
			status: "succeeded",
			toolCallId: "call-1",
			resultFileId: null,
		});
		// "Another": the page queues it for the same item, with the first take's
		// tool call, while the new render runs.
		const another = await insertVideoTake({
			status: "running",
			phase: "starting",
			toolCallId: "call-1",
		});

		const cards = await listConversationVideoCards("u1", "c1");

		expect(cards).toHaveLength(1);
		expect(cards[0]?.id).toBe(first);
		expect(cards[0]?.take?.id).toBe(another);
		expect(cards[0]?.take?.status).toBe("running");
	});

	it("keeps a failed first take and the Another that lands as one card", async () => {
		const { listConversationVideoCards } = await import("./read-model");
		const failed = await insertVideoTake({
			status: "failed",
			errorCode: "video_render_failed",
			retryable: true,
			toolCallId: "call-1",
		});
		// The item the landed take made.
		const { db } = await import("$lib/server/db");
		const schema = await import("$lib/server/db/schema");
		db.insert(schema.artifacts)
			.values({
				id: "video-1",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "Harbour at dusk",
				metadataJson: JSON.stringify({ artifactType: "video" }),
			})
			.run();
		await insertImageFile({
			id: "clip-2",
			width: 1280,
			height: 704,
			durationMs: 5000,
		});
		// "Another" queues its take with the first take's call and no item yet
		// (there was no artifact to name); once it lands, its row records the
		// item it made on its own.
		const landed = await insertVideoTake({
			status: "succeeded",
			toolCallId: "call-1",
			artifactId: "video-1",
			resultFileId: "clip-2",
		});

		const cards = await listConversationVideoCards("u1", "c1");

		// The message's row names the call's first take (`videoCardId`), so one
		// card is what makes it resolve to the clip: that id, the landed take on
		// it, and the clip attached.
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			id: failed,
			artifactId: "video-1",
			title: "Harbour at dusk",
			take: {
				id: landed,
				status: "succeeded",
				clip: {
					fileId: "clip-2",
					posterFileId: "clip-2",
					sourceFileId: "still-1",
				},
			},
		});
	});

	it("keeps only this person's and this conversation's takes", async () => {
		const { listConversationVideoCards } = await import("./read-model");
		const mine = await insertVideoTake({ status: "succeeded" });
		await insertVideoTake({ status: "succeeded", conversationId: "c2" });
		await insertVideoTake({
			status: "succeeded",
			userId: "u2",
			conversationId: "c3",
		});

		const cards = await listConversationVideoCards("u1", "c1");

		expect(cards.map((card) => card.id)).toEqual([mine]);
	});

	it("serializes a failed take's words and a cancelled one, oldest first", async () => {
		const { listConversationVideoCards } = await import("./read-model");
		const failed = await insertVideoTake({
			status: "failed",
			phase: "rendering",
			errorCode: "video_render_failed",
			retryable: true,
			toolCallId: "call-failed",
		});
		const cancelled = await insertVideoTake({
			status: "cancelled",
			toolCallId: "call-cancelled",
		});

		const cards = await listConversationVideoCards("u1", "c1");

		expect(cards.map((card) => card.id)).toEqual([failed, cancelled]);
		expect(cards[0]?.take).toMatchObject({
			status: "failed",
			errorCode: "video_render_failed",
			retryable: true,
			clip: null,
		});
		expect(cards[1]?.take).toMatchObject({ status: "cancelled", clip: null });
	});
});
