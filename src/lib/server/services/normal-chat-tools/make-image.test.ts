// @vitest-environment node
//
// make_image end to end, short of the model: the real tool run over a real
// migrated database, the real job engine (started for the image kind) and a
// real fake ComfyUI on a loopback port. Picture files go to a temp working
// directory.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
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
import { useFakeComfyUi } from "$lib/server/services/images/testing/run-takes";
import type {
	TurnPicture,
	TurnPictureIndex,
	TurnPictureSource,
} from "$lib/server/services/images/turn-pictures";
import { warmModules } from "$lib/server/testing/warm-modules";
import { parseImageVersionBody } from "$lib/shared/artifacts/image-body";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import type { MakeImageInput } from "./make-image";

const userId = "user-1";
const conversationId = "conv-1";

let fixture: ImageFixture;
let workdir: string;
let fake: FakeComfyUi | null = null;

beforeAll(async () => {
	await warmModules([
		() => import("./make-image"),
		() => import("./index"),
		() => import("$lib/server/services/images/image-runner"),
		() => import("$lib/server/services/artifacts"),
	]);
}, 60_000);

beforeEach(async () => {
	fixture = createImageFixture("make-image");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "make-image-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
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
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

/** A fake picture server, with the image kind running on the engine against it. */
async function startPictureServer(
	options: Parameters<typeof createFakeComfyUi>[0] = {},
) {
	fake = await createFakeComfyUi(options);
	useFakeComfyUi(fake.baseUrl);
}

async function startEngine() {
	const { startJobs } = await import("$lib/server/services/jobs");
	const { imageJob } = await import("$lib/server/services/images/image-job");
	await startJobs([imageJob], { startInNonServingContextForTests: true });
}

/** The tool without an engine behind it: takes are queued and never rendered. */
async function configureOnly() {
	useFakeComfyUi("http://127.0.0.1:1");
}

async function run(
	input: Partial<MakeImageInput>,
	options: {
		turnPictures?: TurnPictureIndex | null;
		turnTakes?: import("$lib/server/services/images/turn-takes").TurnTakes;
		signal?: AbortSignal;
		waitBudgetMs?: number;
	} = {},
) {
	const { runMakeImageTool } = await import("./make-image");
	const { createTurnTakes } = await import(
		"$lib/server/services/images/turn-takes"
	);
	return runMakeImageTool({
		userId,
		conversationId,
		turnId: "turn-1",
		toolCallId: "call-1",
		input: { prompt: "a red door", ...input },
		turnPictures: options.turnPictures ?? null,
		turnTakes: options.turnTakes ?? createTurnTakes(),
		requestText: "draw a red door please",
		signal: options.signal ?? new AbortController().signal,
		waitBudgetMs: options.waitBudgetMs,
	});
}

async function rows() {
	const { db } = await import("$lib/server/db");
	return {
		cards: db.select().from(schema.imageCards).all(),
		takes: db
			.select()
			.from(schema.imageJobs)
			.orderBy(asc(schema.imageJobs.createdAt))
			.all(),
	};
}

async function until<T>(
	read: () => Promise<T> | T,
	done: (value: T) => boolean,
	timeoutMs = 20_000,
): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Gave up waiting; last value: ${JSON.stringify(value)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function storeFile(width = 1248, height = 832) {
	const { storeImageFile } = await import("$lib/server/services/images/files");
	return storeImageFile({
		userId,
		conversationId,
		role: "take",
		png: new Uint8Array(
			await sharp({
				create: { width, height, channels: 3, background: "#778899" },
			})
				.png()
				.toBuffer(),
		),
	});
}

function fileSource(
	fileId: string,
	extra: Partial<Extract<TurnPictureSource, { type: "image_file" }>> = {},
): TurnPictureSource {
	return {
		type: "image_file",
		fileId,
		name: "A picture",
		artifactId: null,
		role: "attached",
		...extra,
	};
}

function index(sources: TurnPictureSource[]): TurnPictureIndex {
	const pictures: TurnPicture[] = sources.map((source, i) => ({
		number: i + 1,
		source,
	}));
	return {
		pictures,
		byNumber: (number) => pictures.find((p) => p.number === number) ?? null,
		metadata: null,
	};
}

async function makeItem(seed = 123) {
	const file = await storeFile();
	const { createArtifact } = await import("$lib/server/services/artifacts");
	const { serializeImageVersionBody } = await import(
		"$lib/shared/artifacts/image-body"
	);
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "image",
		title: "Cosy room",
		body: serializeImageVersionBody({
			v: 1,
			fileId: file.id,
			width: 1248,
			height: 832,
			hasAlpha: false,
			baseFileId: null,
			sources: [],
			marks: null,
			prompt: "a cosy room",
			takeId: null,
			seed,
			anchorFileId: file.id,
			chainSinceAnchor: 0,
		}),
		author: "alfy",
		versionSummary: VERSION_SUMMARY.alfyPicture,
	});
	if (!created.ok) throw new Error("item not made");
	return { artifactId: created.artifact.id, file };
}

describe("a new picture from words", () => {
	it("makes one card and one take, and the picture is the version in use", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();

		const { modelPayload, metadata } = await run({
			title: "Red door",
			summary: "Made a red door",
		});

		expect(modelPayload).toEqual({
			ok: true,
			status: "succeeded",
			takeId: expect.any(String),
			imageId: expect.any(String),
			title: "Red door",
			inUse: true,
			retried: false,
			note: expect.stringContaining("on its card in the chat"),
		});
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			madeFrom: "words",
			title: "Red door",
			pickedTakeId: takes[0]?.id,
		});
		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error("not succeeded");
		}
		expect(metadata).toMatchObject({
			imageCardId: cards[0]?.id,
			imageTakeId: modelPayload.takeId,
			imageArtifactId: modelPayload.imageId,
		});
		// The model gets ids and a sentence, never an address.
		expect(JSON.stringify(modelPayload)).not.toMatch(/https?:|\/api\//);
		expect(takes[0]?.heldUntil).toBeNull();
	});

	it("tells the model in ASCII English whatever the person writes", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { modelPayload } = await run({ title: "Piros ajto" });
		const words = JSON.stringify(
			modelPayload.ok && modelPayload.status === "succeeded"
				? modelPayload.note
				: modelPayload,
		);
		expect(words).toMatch(/^[\x20-\x7e]*$/);
	});
});

describe("naming pictures", () => {
	it("resolves a picture number through the message, and refuses what it does not hold", async () => {
		await configureOnly();
		const files = await Promise.all([1, 2, 3, 4].map(() => storeFile()));
		const turnPictures = index(files.map((file) => fileSource(file.id)));
		const { createArtifact } = await import("$lib/server/services/artifacts");
		const document = await createArtifact({
			userId,
			conversationId,
			kind: "document",
			title: "Notes",
			body: "# Notes",
			author: "alfy",
			versionSummary: VERSION_SUMMARY.alfyPicture,
		});
		if (!document.ok) throw new Error("document not made");

		const made = await run(
			{ pictures: ["3"] },
			{ turnPictures, waitBudgetMs: 0 },
		);
		expect(made.modelPayload).toMatchObject({ ok: true, status: "running" });
		const { takes } = await rows();
		expect(JSON.parse(takes[0]?.requestJson ?? "{}").inputs[0].fileId).toBe(
			files[2]?.id,
		);

		for (const picture of ["9", document.artifact.id]) {
			const refused = await run({ pictures: [picture] }, { turnPictures });
			expect(refused.modelPayload).toMatchObject({
				ok: false,
				errorCode: "unknown_picture",
			});
		}
		expect((await rows()).takes).toHaveLength(1);
	});

	it("takes at most the cap per call: five of six are refused naming 4, four go through", async () => {
		await configureOnly();
		const files = await Promise.all([1, 2, 3, 4, 5, 6].map(() => storeFile()));
		const turnPictures = index(files.map((file) => fileSource(file.id)));

		const five = await run(
			{ pictures: ["1", "2", "3", "4", "5"] },
			{ turnPictures, waitBudgetMs: 0 },
		);
		expect(five.modelPayload).toMatchObject({
			ok: false,
			errorCode: "too_many_pictures",
			message: expect.stringContaining("at most 4 pictures"),
		});
		expect((await rows()).takes).toHaveLength(0);

		const four = await run(
			{ pictures: ["1", "2", "3", "4"] },
			{ turnPictures, waitBudgetMs: 0 },
		);
		expect(four.modelPayload).toMatchObject({ ok: true, status: "running" });
		expect((await rows()).takes).toHaveLength(1);
	});
});

describe("repeating a call for options", () => {
	it("shares one card across four identical calls, refuses the fifth take and the ninth call", async () => {
		await configureOnly();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const results = [];
		for (let i = 0; i < 9; i++) {
			results.push(
				(await run({}, { turnTakes, waitBudgetMs: 0 })).modelPayload,
			);
		}

		for (const payload of results.slice(0, 4)) {
			expect(payload).toMatchObject({ ok: true, status: "running" });
		}
		for (const payload of results.slice(4, 8)) {
			expect(payload).toMatchObject({
				ok: false,
				errorCode: "too_many_takes",
			});
		}
		expect(results[8]).toMatchObject({
			ok: false,
			errorCode: "too_many_calls",
		});
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(4);
		expect(new Set(takes.map((take) => take.seed)).size).toBe(4);
	});
});

describe("changing a picture", () => {
	it("makes the open item's version the first picture, on its edit canvas, with a seed unlike its own", async () => {
		await configureOnly();
		const item = await makeItem(123);
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);

		const { modelPayload } = await run(
			{ pictures: ["1"], summary: "Painted the door red" },
			{ turnPictures, waitBudgetMs: 0 },
		);

		expect(modelPayload).toMatchObject({ ok: true, status: "running" });
		const { cards, takes } = await rows();
		expect(cards[0]).toMatchObject({
			madeFrom: "change",
			artifactId: item.artifactId,
		});
		const request = JSON.parse(takes[0]?.requestJson ?? "{}");
		expect(request.mode).toBe("edit");
		expect(request.inputs[0]).toMatchObject({
			fileId: item.file.id,
			role: "base",
		});
		expect(request.canvas).toEqual({ width: 1248, height: 832 });
		expect(request.avoidSeeds).toEqual([123]);
		expect(takes[0]?.seed).not.toBe(123);
	});

	it("two identical startNew calls are both based on the item's version, not on each other", async () => {
		await configureOnly();
		const item = await makeItem(123);
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		for (let i = 0; i < 2; i++) {
			await run(
				{ pictures: ["1"], startNew: true },
				{ turnPictures, turnTakes, waitBudgetMs: 0 },
			);
		}
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(cards[0]?.artifactId).toBeNull();
		for (const take of takes) {
			const request = JSON.parse(take.requestJson);
			expect(request.inputs[0].fileId).toBe(item.file.id);
			expect(request.anchor.fileId).toBe(item.file.id);
		}
	});

	it("an identical call again is another option on the same base; a different prompt builds on the newest finished take", async () => {
		await configureOnly();
		const item = await makeItem(123);
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const opts = { turnPictures, turnTakes, waitBudgetMs: 0 };
		await run({ pictures: ["1"], prompt: "make the door blue" }, opts);
		// The first take lands.
		const landed = await storeFile();
		const { db } = await import("$lib/server/db");
		const first = (await rows()).takes[0];
		db.update(schema.imageJobs)
			.set({ status: "succeeded", resultFileId: landed.id, seed: 777 })
			.where(eq(schema.imageJobs.id, first?.id ?? ""))
			.run();

		await run({ pictures: ["1"], prompt: "make the door blue" }, opts);
		await run({ pictures: ["1"], prompt: "now make it green" }, opts);

		const requests = (await rows()).takes.map((take) =>
			JSON.parse(take.requestJson),
		);
		expect(requests[1].inputs[0].fileId).toBe(item.file.id);
		expect(requests[1].avoidSeeds).toEqual([123]);
		expect(requests[2].inputs[0].fileId).toBe(landed.id);
		expect(requests[2].avoidSeeds).toEqual([777]);
	});

	it("never changes an item of another chat in place: it starts a new item from a copy stored in this chat", async () => {
		await configureOnly();
		fixture.seedConversation("conv-2", userId);
		const other = await (async () => {
			const { storeImageFile } = await import(
				"$lib/server/services/images/files"
			);
			const { createArtifact } = await import("$lib/server/services/artifacts");
			const { serializeImageVersionBody } = await import(
				"$lib/shared/artifacts/image-body"
			);
			const file = await storeImageFile({
				userId,
				conversationId: "conv-2",
				role: "take",
				png: new Uint8Array(
					await sharp({
						create: {
							width: 1248,
							height: 832,
							channels: 3,
							background: "#123456",
						},
					})
						.png()
						.toBuffer(),
				),
			});
			const created = await createArtifact({
				userId,
				conversationId: "conv-2",
				kind: "image",
				title: "Elsewhere",
				body: serializeImageVersionBody({
					v: 1,
					fileId: file.id,
					width: 1248,
					height: 832,
					hasAlpha: false,
					baseFileId: null,
					sources: [],
					marks: null,
					prompt: "p",
					takeId: null,
					seed: 5,
					anchorFileId: file.id,
					chainSinceAnchor: 0,
				}),
				author: "alfy",
				versionSummary: VERSION_SUMMARY.alfyPicture,
			});
			if (!created.ok) throw new Error("item not made");
			return { artifactId: created.artifact.id, file };
		})();

		const { modelPayload } = await run(
			{ pictures: [other.artifactId], title: "Copy" },
			{ waitBudgetMs: 0 },
		);

		expect(modelPayload).toMatchObject({ ok: true, status: "running" });
		const { cards, takes } = await rows();
		expect(cards[0]?.artifactId).toBeNull();
		const request = JSON.parse(takes[0]?.requestJson ?? "{}");
		expect(request.baseFromUpload).toBe(true);
		expect(request.inputs[0].fileId).not.toBe(other.file.id);
		const { db } = await import("$lib/server/db");
		const copy = db
			.select()
			.from(schema.imageFiles)
			.where(eq(schema.imageFiles.id, request.inputs[0].fileId))
			.get();
		expect(copy?.conversationId).toBe(conversationId);
		expect(request.avoidSeeds).toEqual([5]);
	});

	it("names an item by its id as well as by its number", async () => {
		await configureOnly();
		const item = await makeItem();
		const { modelPayload } = await run(
			{ pictures: [item.artifactId] },
			{ waitBudgetMs: 0 },
		);
		expect(modelPayload).toMatchObject({ ok: true, status: "running" });
		expect((await rows()).cards[0]?.artifactId).toBe(item.artifactId);
	});

	it("starts an item from a photo: version 1 is the photo, version 2 is the change", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		// An upload: a JPEG on disk and the artifact lookup pointing at it.
		const { writeFile, mkdir } = await import("node:fs/promises");
		const storagePath = join("data", "uploads", "rug.jpg");
		await mkdir(join(workdir, "data", "uploads"), { recursive: true });
		await writeFile(
			join(workdir, storagePath),
			await sharp({
				create: { width: 640, height: 480, channels: 3, background: "#aa6633" },
			})
				.jpeg()
				.toBuffer(),
		);
		vi.doMock("$lib/server/services/knowledge", async (importOriginal) => ({
			...(await importOriginal<
				typeof import("$lib/server/services/knowledge")
			>()),
			getArtifactForUser: vi.fn(async () => ({
				id: "upload-1",
				storagePath,
				mimeType: "image/jpeg",
			})),
		}));
		const turnPictures = index([
			{
				type: "upload",
				artifactId: "upload-1",
				name: "rug.jpg",
				mimeType: "image/jpeg",
			},
		]);

		const { modelPayload } = await run(
			{ pictures: ["1"], title: "Rug", summary: "Made the rug blue" },
			{ turnPictures },
		);
		vi.doUnmock("$lib/server/services/knowledge");

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error(`not succeeded: ${JSON.stringify(modelPayload)}`);
		}
		const { db } = await import("$lib/server/db");
		const versions = db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, modelPayload.imageId ?? ""))
			.orderBy(asc(schema.artifactVersions.versionNumber))
			.all();
		expect(versions).toHaveLength(2);
		const photo = parseImageVersionBody(versions[0]?.body ?? null);
		const change = parseImageVersionBody(versions[1]?.body ?? null);
		expect(photo).toMatchObject({ takeId: null, prompt: null, seed: null });
		expect(photo?.fileId).toBe(change?.baseFileId);
		expect(change).toMatchObject({ takeId: modelPayload.takeId });
		expect((await rows()).cards[0]?.madeFrom).toBe("photo");
	});
});

describe("a picture that takes longer than the wait", () => {
	it("answers still being made, and the take becomes the version in use when it lands", async () => {
		await startPictureServer({ steps: 4, stepDelayMs: 200 });
		await startEngine();

		const { modelPayload } = await run({}, { waitBudgetMs: 300 });

		expect(modelPayload).toMatchObject({
			ok: true,
			status: "running",
			takeId: expect.any(String),
			note: expect.stringContaining("still being made"),
		});
		const { cards } = await rows();
		expect(cards[0]?.pickedTakeId).toBeNull();
		await until(
			async () => (await rows()).cards[0]?.pickedTakeId,
			(picked) => picked === (modelPayload as { takeId: string }).takeId,
		);
		expect((await rows()).takes[0]).toMatchObject({
			status: "succeeded",
			heldUntil: null,
			versionNumber: 1,
		});
	});
});

describe("a render that fails", () => {
	it("answers failed with the code and whether it can be tried again", async () => {
		await startPictureServer({ fail: "execution" });
		await startEngine();

		const { modelPayload, metadata } = await run({});

		expect(modelPayload).toMatchObject({
			ok: false,
			status: "failed",
			errorCode: "image_render_failed",
			retryable: true,
		});
		expect(metadata).toMatchObject({ ok: false, imageStatus: "failed" });
	});
});

describe("a retry", () => {
	it("makes the take again once, with another seed, and refuses a second", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();

		const first = await run({}, { turnTakes });
		if (!first.modelPayload.ok || first.modelPayload.status !== "succeeded") {
			throw new Error("first did not succeed");
		}
		const retry = await run(
			{ retryOf: first.modelPayload.takeId },
			{ turnTakes },
		);
		expect(retry.modelPayload).toMatchObject({
			ok: true,
			status: "succeeded",
			retried: true,
		});
		const { takes } = await rows();
		expect(takes).toHaveLength(2);
		expect(takes[1]).toMatchObject({
			origin: "retry",
			retryOf: first.modelPayload.takeId,
		});
		expect(takes[1]?.seed).not.toBe(takes[0]?.seed);

		const again = await run(
			{ retryOf: first.modelPayload.takeId },
			{ turnTakes },
		);
		expect(again.modelPayload).toMatchObject({
			ok: false,
			errorCode: "retry_twice",
		});
	});
});

describe("when the call is cut short", () => {
	async function callThenAbort(reason: unknown) {
		await configureOnly();
		const controller = new AbortController();
		const call = run({}, { signal: controller.signal, waitBudgetMs: 60_000 });
		await until(
			async () => (await rows()).takes[0],
			(take) => Boolean(take),
		);
		controller.abort(reason);
		return call;
	}

	it("a watchdog, a timeout or an abort with no reason only lets go: the take stays and lands later onto its card", async () => {
		for (const reason of [
			undefined,
			new Error("Timed out waiting for upstream stream activity"),
			new Error("make_image timed out after 120000ms"),
		]) {
			const { modelPayload } = await callThenAbort(reason);
			expect(modelPayload).toMatchObject({ ok: true, status: "running" });
			const { takes } = await rows();
			expect(takes.at(-1)).toMatchObject({ status: "queued", heldUntil: null });
		}
	});

	it("the composer's Stop cancels a take that has not started", async () => {
		// The picture server's address is read when the config first loads.
		await configureOnly();
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const { modelPayload } = await callThenAbort(new UserStopReason());

		expect(modelPayload).toMatchObject({
			ok: false,
			status: "failed",
			errorCode: "image_stopped",
			retryable: false,
		});
		const { takes } = await rows();
		expect(takes[0]?.status).toBe("cancelled");
		expect(takes[0]?.heldUntil).toBeNull();
	});
});

describe("the tool in the set", () => {
	async function toolNames() {
		const { createNormalChatTools } = await import("./index");
		return Object.keys(
			createNormalChatTools({
				userId,
				conversationId,
				turnId: "turn-1",
			}).tools,
		);
	}

	it("is offered only when a picture server is configured", async () => {
		useFakeComfyUi(null);
		expect(await toolNames()).not.toContain("make_image");

		vi.resetModules();
		useFakeComfyUi("http://127.0.0.1:8188");
		expect(await toolNames()).toContain("make_image");
	});

	it("says it is not configured when called without a server", async () => {
		useFakeComfyUi(null);
		const { modelPayload } = await run({});
		expect(modelPayload).toMatchObject({
			ok: false,
			errorCode: "not_configured",
		});
	});
});
