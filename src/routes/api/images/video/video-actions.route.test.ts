// @vitest-environment node
//
// The video card's buttons on the server: Stop, Try again and Another, each
// owned by the person and scoped to the chat the request names. A migrated
// database and the real job engine; the renderer never runs (nothing claims
// the take here).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	createImageFixture,
	type ImageFixture,
} from "$lib/server/services/images/testing/fixture";
import type { VideoTakeRequest } from "$lib/server/services/images/video/request";
import { warmModules } from "$lib/server/testing/warm-modules";

let fixture: ImageFixture;
let workdir: string;

beforeAll(async () => {
	await warmModules([
		() => import("./takes/[takeId]/stop/+server"),
		() => import("./takes/[takeId]/retry/+server"),
		() => import("./cards/[cardId]/another/+server"),
		() => import("$lib/server/services/images/video/video-job"),
		() => import("$lib/server/services/jobs"),
	]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("video-actions");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedConversation("c2", "u1");
	workdir = await mkdtemp(join(tmpdir(), "video-actions-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.COMFYUI_LTX_URL = "http://127.0.0.1:9";
	vi.resetModules();
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

async function insertTake(input: {
	userId?: string;
	conversationId?: string;
	status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	errorCode?: string | null;
	toolCallId?: string | null;
	seed?: number;
	request?: VideoTakeRequest;
}): Promise<string> {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const id = randomUUID();
	db.insert(schema.videoJobs)
		.values({
			id,
			userId: input.userId ?? "u1",
			conversationId: input.conversationId ?? "c1",
			artifactId: null,
			toolCallId: input.toolCallId ?? "call-1",
			origin: "turn",
			retryOf: null,
			requestJson: JSON.stringify(input.request ?? request()),
			seed: input.seed ?? 7,
			status: input.status ?? "succeeded",
			errorCode: input.errorCode ?? null,
			createdAt: new Date(),
		})
		.run();
	return id;
}

async function readTake(takeId: string) {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	return db
		.select()
		.from(schema.videoJobs)
		.where(eq(schema.videoJobs.id, takeId))
		.get();
}

function takeEvent(
	kind: "takes" | "cards",
	id: string,
	userId: string,
	query = "",
) {
	const path =
		kind === "takes"
			? `/api/images/video/takes/${id}/stop`
			: `/api/images/video/cards/${id}/another`;
	return {
		params: kind === "takes" ? { takeId: id } : { cardId: id },
		url: new URL(`http://localhost${path}${query}`),
		locals: { user: { id: userId, role: "user" } },
	} as never;
}

describe("POST /api/images/video/takes/[takeId]/stop", () => {
	it("stops the person's own running take", async () => {
		const { POST } = await import("./takes/[takeId]/stop/+server");
		const takeId = await insertTake({ status: "running" });
		const res = (await POST(
			takeEvent("takes", takeId, "u1", "?conversationId=c1"),
		)) as Response;
		expect(res.status).toBe(200);
		expect(await readTake(takeId)).toMatchObject({
			status: "cancelled",
			cancelInterrupt: 1,
		});
	});

	it("answers 404 for another person's take and 409 for a settled one", async () => {
		const { POST } = await import("./takes/[takeId]/stop/+server");
		const running = await insertTake({ status: "running" });
		const settled = await insertTake({ status: "succeeded" });
		expect(
			((await POST(takeEvent("takes", running, "u2"))) as Response).status,
		).toBe(404);
		expect(
			((await POST(takeEvent("takes", settled, "u1"))) as Response).status,
		).toBe(409);
	});
});

describe("POST /api/images/video/takes/[takeId]/retry", () => {
	it("requeues a failed take", async () => {
		const { POST } = await import("./takes/[takeId]/retry/+server");
		const takeId = await insertTake({
			status: "failed",
			errorCode: "video_render_failed",
		});
		const res = (await POST(takeEvent("takes", takeId, "u1"))) as Response;
		expect(res.status).toBe(200);
		expect((await readTake(takeId))?.status).toBe("queued");
	});

	it("refuses a blocked take and another person's", async () => {
		const { POST } = await import("./takes/[takeId]/retry/+server");
		const blocked = await insertTake({
			status: "failed",
			errorCode: "video_blocked",
		});
		const failed = await insertTake({ status: "failed" });
		expect(
			((await POST(takeEvent("takes", blocked, "u1"))) as Response).status,
		).toBe(409);
		expect(
			((await POST(takeEvent("takes", failed, "u2"))) as Response).status,
		).toBe(404);
	});
});

describe("POST /api/images/video/cards/[cardId]/another", () => {
	it("queues the card's request again, on the same item and tool call", async () => {
		const { POST } = await import("./cards/[cardId]/another/+server");
		const first = await insertTake({
			status: "succeeded",
			toolCallId: "call-7",
			seed: 41,
		});
		const res = (await POST(
			takeEvent("cards", first, "u1", "?conversationId=c1"),
		)) as Response;
		expect(res.status).toBe(201);
		const { takeId } = (await res.json()) as { takeId: string };
		const another = await readTake(takeId);
		expect(another).toMatchObject({
			userId: "u1",
			conversationId: "c1",
			origin: "another",
			toolCallId: "call-7",
			status: "queued",
		});
		expect(another?.seed).not.toBe(41);
		expect(
			JSON.parse(another?.requestJson ?? "{}") as VideoTakeRequest,
		).toMatchObject({ title: "Harbour at dusk", durationSeconds: 5 });
	});

	it("answers 404 for another person's card", async () => {
		const { POST } = await import("./cards/[cardId]/another/+server");
		const card = await insertTake({ status: "succeeded" });
		expect(
			((await POST(takeEvent("cards", card, "u2"))) as Response).status,
		).toBe(404);
	});
});
