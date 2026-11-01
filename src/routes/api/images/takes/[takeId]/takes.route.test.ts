// @vitest-environment node
//
// Use this, Stop and Try again on a take: ownership first (another person's
// take is a 404), then the take's state (409 when it cannot be acted on).
// A migrated database file, the real artifacts service and the job engine.

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
import {
	createFakeComfyUi,
	type FakeComfyUi,
} from "$lib/server/services/images/comfyui/testing/fake-comfyui";
import {
	createImageFixture,
	type ImageFixture,
} from "$lib/server/services/images/testing/fixture";
import {
	drainImageTakes,
	useFakeComfyUi,
} from "$lib/server/services/images/testing/run-takes";
import {
	insertTake,
	takeRequest,
} from "$lib/server/services/images/testing/takes";
import { warmModules } from "$lib/server/testing/warm-modules";

let fixture: ImageFixture;
let workdir: string;
let fake: FakeComfyUi | null = null;

beforeAll(async () => {
	await warmModules([
		() => import("./use/+server"),
		() => import("./stop/+server"),
		() => import("./retry/+server"),
		() => import("$lib/server/services/images/image-job"),
		() => import("$lib/server/services/images/files"),
		() => import("$lib/server/services/jobs"),
	]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-take-routes");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedCard({ id: "card-1", userId: "u1", conversationId: "c1" });
	workdir = await mkdtemp(join(tmpdir(), "image-take-routes-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
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
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

function event(takeId: string, userId: string | null, query = "") {
	return {
		params: { takeId },
		url: new URL(`http://localhost/api/images/takes/${takeId}/x${query}`),
		locals: {
			user: userId ? { id: userId, role: "user" } : undefined,
		},
	} as never;
}

async function call(
	run: () => Promise<Response>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	try {
		const res = await run();
		return { status: res.status, body: await res.json() };
	} catch (error) {
		return { status: (error as { status: number }).status, body: {} };
	}
}

const base = { userId: "u1", conversationId: "c1", cardId: "card-1" };

async function readTake(takeId: string) {
	const { db } = await import("$lib/server/db");
	return db
		.select()
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.get();
}

async function landedFile() {
	const { storeImageFile } = await import("$lib/server/services/images/files");
	return storeImageFile({
		userId: "u1",
		conversationId: "c1",
		role: "take",
		png: new Uint8Array(
			await sharp({
				create: { width: 64, height: 64, channels: 3, background: "#336699" },
			})
				.png()
				.toBuffer(),
		),
	});
}

async function makeIncognito() {
	const { db } = await import("$lib/server/db");
	db.update(schema.conversations)
		.set({ memoryIncognito: true })
		.where(eq(schema.conversations.id, "c1"))
		.run();
}

describe("incognito chats on every take action", () => {
	it("answers 404 and changes nothing unless the chat is named", async () => {
		const use = (await import("./use/+server")).POST;
		const stop = (await import("./stop/+server")).POST;
		const retry = (await import("./retry/+server")).POST;
		const file = await landedFile();
		const done = await insertTake({ ...base, resultFileId: file.id });
		const queued = await insertTake({ ...base, status: "queued" });
		const failed = await insertTake({ ...base, status: "failed" });
		await makeIncognito();

		expect((await call(() => use(event(done, "u1")) as never)).status).toBe(
			404,
		);
		expect((await call(() => stop(event(queued, "u1")) as never)).status).toBe(
			404,
		);
		expect((await call(() => retry(event(failed, "u1")) as never)).status).toBe(
			404,
		);
		expect((await readTake(queued))?.status).toBe("queued");
		expect((await readTake(failed))?.status).toBe("failed");
		expect((await readTake(done))?.versionNumber).toBeNull();

		const named = "?conversationId=c1";
		expect(
			(await call(() => use(event(done, "u1", named)) as never)).status,
		).toBe(200);
		expect(
			(await call(() => stop(event(queued, "u1", named)) as never)).status,
		).toBe(200);
		expect(
			(await call(() => retry(event(failed, "u1", named)) as never)).status,
		).toBe(200);
	});

	it("treats a hidden take as not found for Stop and Try again", async () => {
		const stop = (await import("./stop/+server")).POST;
		const retry = (await import("./retry/+server")).POST;
		const queued = await insertTake({
			...base,
			status: "queued",
			hidden: true,
		});
		const failed = await insertTake({
			...base,
			status: "failed",
			hidden: true,
		});
		expect((await call(() => stop(event(queued, "u1")) as never)).status).toBe(
			404,
		);
		expect((await call(() => retry(event(failed, "u1")) as never)).status).toBe(
			404,
		);
	});
});

describe("POST /api/images/takes/[takeId]/use", () => {
	it("answers the version number for a finished take", async () => {
		const { POST } = await import("./use/+server");
		const file = await landedFile();
		const takeId = await insertTake({ ...base, resultFileId: file.id });
		const res = await call(() => POST(event(takeId, "u1")) as never);
		expect(res).toEqual({ status: 200, body: { versionNumber: 1 } });
	});

	it("answers 409 not_ready for a take that has not finished", async () => {
		const { POST } = await import("./use/+server");
		const takeId = await insertTake({ ...base, status: "running" });
		const res = await call(() => POST(event(takeId, "u1")) as never);
		expect(res).toEqual({ status: 409, body: { error: "not_ready" } });
	});

	it("answers 404 for another person's take, an unknown take, and no session 401", async () => {
		const { POST } = await import("./use/+server");
		const file = await landedFile();
		const takeId = await insertTake({ ...base, resultFileId: file.id });
		expect((await call(() => POST(event(takeId, "u2")) as never)).status).toBe(
			404,
		);
		expect((await call(() => POST(event("nope", "u1")) as never)).status).toBe(
			404,
		);
		expect((await call(() => POST(event(takeId, null)) as never)).status).toBe(
			401,
		);
	});

	it("takes an incognito chat only when the request names it", async () => {
		const { db } = await import("$lib/server/db");
		const { POST } = await import("./use/+server");
		const file = await landedFile();
		const takeId = await insertTake({ ...base, resultFileId: file.id });
		db.update(schema.conversations)
			.set({ memoryIncognito: true })
			.where(eq(schema.conversations.id, "c1"))
			.run();
		const named = await call(
			() => POST(event(takeId, "u1", "?conversationId=c1")) as never,
		);
		expect(named.status).toBe(200);
	});
});

describe("POST /api/images/takes/[takeId]/stop", () => {
	it("stops a queued take", async () => {
		const { POST } = await import("./stop/+server");
		const takeId = await insertTake({ ...base, status: "queued" });
		const res = await call(() => POST(event(takeId, "u1")) as never);
		expect(res).toEqual({ status: 200, body: { ok: true } });
		expect((await readTake(takeId))?.status).toBe("cancelled");
	});

	it("answers 409 for a finished take and 404 for another person's", async () => {
		const { POST } = await import("./stop/+server");
		const done = await insertTake({ ...base, status: "succeeded" });
		expect((await call(() => POST(event(done, "u1")) as never)).status).toBe(
			409,
		);
		const queued = await insertTake({ ...base, status: "queued" });
		expect((await call(() => POST(event(queued, "u2")) as never)).status).toBe(
			404,
		);
		expect((await readTake(queued))?.status).toBe("queued");
	});

	it("interrupts our own prompt while ComfyUI is rendering it", async () => {
		fake = await createFakeComfyUi({ steps: 30, stepDelayMs: 100 });
		useFakeComfyUi(fake.baseUrl);
		const { enqueueTake } = await import(
			"$lib/server/services/images/image-job"
		);
		const { POST } = await import("./stop/+server");
		const { takeId } = await enqueueTake({
			...base,
			toolCallId: "call-1",
			origin: "turn",
			retryOf: null,
			request: takeRequest({ canvas: { width: 256, height: 256 } }),
			seed: 4242,
			heldUntil: null,
		});
		const draining = drainImageTakes();
		let rendering = false;
		for (let polls = 0; polls < 600 && !rendering; polls += 1) {
			rendering = (await readTake(takeId))?.phase === "rendering";
			if (!rendering) await new Promise((resolve) => setTimeout(resolve, 15));
		}
		if (!rendering) throw new Error("The take never reached rendering.");
		const promptId = [...fake.prompts.keys()][0];

		const res = await call(() => POST(event(takeId, "u1")) as never);
		await draining;

		expect(res.status).toBe(200);
		expect((await readTake(takeId))?.status).toBe("cancelled");
		expect(fake.requests.find((r) => r.path === "/interrupt")?.json).toEqual({
			prompt_id: promptId,
		});
	});
});

describe("POST /api/images/takes/[takeId]/retry", () => {
	it("queues a failed or a cancelled take again", async () => {
		const { POST } = await import("./retry/+server");
		for (const status of ["failed", "cancelled"] as const) {
			const takeId = await insertTake({ ...base, status, retryable: true });
			const res = await call(() => POST(event(takeId, "u1")) as never);
			expect(res).toEqual({ status: 200, body: { ok: true } });
			expect((await readTake(takeId))?.status).toBe("queued");
		}
	});

	it("answers 409 for a take that is not failed or cancelled", async () => {
		const { POST } = await import("./retry/+server");
		for (const status of ["queued", "running", "succeeded"] as const) {
			const takeId = await insertTake({ ...base, status });
			expect(
				(await call(() => POST(event(takeId, "u1")) as never)).status,
			).toBe(409);
		}
	});

	it("answers 404 for another person's take", async () => {
		const { POST } = await import("./retry/+server");
		const takeId = await insertTake({ ...base, status: "failed" });
		expect((await call(() => POST(event(takeId, "u2")) as never)).status).toBe(
			404,
		);
		expect((await readTake(takeId))?.status).toBe("failed");
	});
});
