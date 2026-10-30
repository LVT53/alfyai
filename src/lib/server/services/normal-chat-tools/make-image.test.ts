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

type GuardReport = {
	miss: "nothing_changed" | "outside_marks" | null;
	changedShare: number;
	insideMarksShare: number | null;
};
const guardState = vi.hoisted(() => ({
	reports: [] as GuardReport[],
	call: 0,
}));
vi.mock("$lib/server/services/images/guards/guard-edit", () => ({
	guardEdit: async (params: { result: unknown }) => {
		const report =
			guardState.reports[
				Math.min(guardState.call, guardState.reports.length - 1)
			];
		guardState.call += 1;
		return {
			picture: params.result,
			mask: new Float32Array(0),
			measures: {
				dx: 0,
				dy: 0,
				scale: 1,
				global: false,
				reanchored: false,
				...report,
			},
			chainSinceAnchor: 1,
			anchorIsResult: false,
		};
	},
}));

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
	// A real guard over the fake's random-colour patch can read "nothing changed"
	// by chance and start an automatic retry, which would make takes-counting
	// tests flaky. The guard is tested on its own; here it reports a change.
	guardReporting([{ miss: null, changedShare: 0.1, insideMarksShare: null }]);
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
		retryMinLeftMs?: number;
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
		retryMinLeftMs: options.retryMinLeftMs,
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

async function bytesOfFile(fileId: string): Promise<Uint8Array> {
	const { getImageFile, readImageFileBytes } = await import(
		"$lib/server/services/images/files"
	);
	const file = await getImageFile({ userId, fileId, conversationId });
	if (!file) throw new Error("no such picture file");
	return readImageFileBytes(file, "full");
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
	// A settled card attaches its pictures to the item; so does this stand-in.
	const { attachImageFilesToArtifact } = await import(
		"$lib/server/services/images/files"
	);
	await attachImageFilesToArtifact([file.id], created.artifact.id);
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

describe("the title the model gives", () => {
	// Task 17 (rehearsal P2): the description said "For a new picture", so a change
	// of the person's photo (which starts a new Image) came without one and was
	// named after their first sentence. Any call that does not change an Image of
	// this chat in place starts one, and that one needs a title.
	it("asks for a title for every Image a call starts, a changed photo included", async () => {
		const { makeImageInputSchema } = await import("./make-image");
		const description = makeImageInputSchema.shape.title.description ?? "";
		expect(description).not.toMatch(/^For a new picture/);
		expect(description).toMatch(/photo/i);
		expect(description).toMatch(/2-5 words/);
		expect(description).toMatch(/never restating the request/i);
		expect(description).toMatch(/Title Case in English/);
		expect(description).toMatch(/normal capitalisation in Hungarian/);
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
		// Picture 3's bytes, as the take's own copy (a picture is never shared as an input).
		const baseId = JSON.parse(takes[0]?.requestJson ?? "{}").inputs[0].fileId;
		expect(baseId).not.toBe(files[2]?.id);
		expect(await bytesOfFile(baseId)).toEqual(
			await bytesOfFile(files[2]?.id ?? ""),
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
		// A refusal keeps the model's sentence for the model only: the row the
		// person reads is made from the code.
		const refused = await run({}, { turnTakes, waitBudgetMs: 0 });
		expect(refused.metadata).toMatchObject({ imageRefusal: "too_many_calls" });
		expect(refused.metadata).not.toHaveProperty("error");
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(4);
		expect(new Set(takes.map((take) => take.seed)).size).toBe(4);
	});
});

describe("parallel calls in one step", () => {
	it("share one card and make one Image item: four identical new-picture calls at once", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const results = await Promise.all(
			[0, 1, 2, 3].map(() => run({}, { turnTakes })),
		);
		for (const result of results) {
			expect(result.modelPayload).toMatchObject({ ok: true });
		}
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(4);
		const { db } = await import("$lib/server/db");
		expect(
			db
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.conversationId, conversationId))
				.all(),
		).toHaveLength(1);
		expect(cards[0]?.pickedTakeId).toBeTruthy();
	});

	it("respects the four-takes cap when the calls arrive together", async () => {
		await configureOnly();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const results = await Promise.all(
			[0, 1, 2, 3, 4, 5].map(() => run({}, { turnTakes, waitBudgetMs: 0 })),
		);
		const payloads = results.map((result) => result.modelPayload);
		expect(payloads.filter((p) => p.ok)).toHaveLength(4);
		expect(
			payloads.filter(
				(p) => !p.ok && "errorCode" in p && p.errorCode === "too_many_takes",
			),
		).toHaveLength(2);
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(4);
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
		const { db } = await import("$lib/server/db");
		for (let i = 0; i < 2; i++) {
			await run(
				{ pictures: ["1"], startNew: true },
				{ turnPictures, turnTakes, waitBudgetMs: 0 },
			);
			if (i === 0) {
				// Take 1 lands with a stored picture of its own before the second
				// call: the second must still be based on the item, not on this.
				const landed = await storeFile();
				db.update(schema.imageJobs)
					.set({ status: "succeeded", resultFileId: landed.id })
					.run();
			}
		}
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(2);
		expect(takes[0]?.resultFileId).toBeTruthy();
		// Take 1 became its own new item; the item it was started from is untouched.
		expect(cards[0]?.artifactId).not.toBe(item.artifactId);
		for (const take of takes) {
			const request = JSON.parse(take.requestJson);
			// A new item is not an in-place change: it gets its own copy of the base.
			expect(request.inputs[0].fileId).not.toBe(item.file.id);
			expect(await bytesOfFile(request.inputs[0].fileId)).toEqual(
				await bytesOfFile(item.file.id),
			);
			expect(request.anchor.fileId).toBe(request.inputs[0].fileId);
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

describe("the explicit-picture filter, before rendering", () => {
	async function exempt() {
		fixture.sqlite
			.prepare(
				"update users set explicit_picture_filter_exempt = 1 where id = ?",
			)
			.run(userId);
	}

	it("refuses an explicit request before anything is submitted, and tells the model plainly in ASCII", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();

		const { modelPayload, metadata } = await run({
			prompt: "a nude woman on a beach",
		});

		expect(modelPayload).toMatchObject({
			ok: false,
			errorCode: "explicit_request",
		});
		if (modelPayload.ok) throw new Error("not refused");
		expect(modelPayload.message).toMatch(/^[\x20-\x7e]*$/);
		expect(modelPayload.message).toMatch(/do not call make_image again/i);
		expect(metadata).toMatchObject({
			ok: false,
			imageRefusal: "explicit_request",
		});
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(0);
		expect(takes).toHaveLength(0);
		expect(fake?.prompts.size ?? 0).toBe(0);
	});

	it("checks the title too", async () => {
		await configureOnly();
		const { modelPayload } = await run({
			prompt: "a woman on a beach",
			title: "Meztelen nő",
		});
		expect(modelPayload).toMatchObject({ errorCode: "explicit_request" });
	});

	it("lets an ordinary request with a look-alike word through", async () => {
		await configureOnly();
		const { modelPayload } = await run(
			{ prompt: "a nude-coloured sofa in a bright living room" },
			{ waitBudgetMs: 0 },
		);
		expect(modelPayload).not.toMatchObject({ errorCode: "explicit_request" });
	});

	it("does not refuse for an exempt person", async () => {
		await configureOnly();
		await exempt();
		const { modelPayload } = await run(
			{ prompt: "a nude woman, figure study" },
			{ waitBudgetMs: 0 },
		);
		expect(modelPayload).not.toMatchObject({ errorCode: "explicit_request" });
	});

	it("does not refuse once the filter is off for the install", async () => {
		await configureOnly();
		const { getConfig } = await import("$lib/server/config-store");
		getConfig().imageExplicitFilterEnabled = false;
		const { modelPayload } = await run(
			{ prompt: "a nude woman, figure study" },
			{ waitBudgetMs: 0 },
		);
		expect(modelPayload).not.toMatchObject({ errorCode: "explicit_request" });
	});

	it("tells the model in the tool description to decline, unless the person is not filtered", async () => {
		useFakeComfyUi("http://127.0.0.1:8188");
		const { createNormalChatTools } = await import("./index");
		const describe = (explicitPictureFilter?: boolean) =>
			(
				createNormalChatTools({
					userId,
					conversationId,
					turnId: "turn-1",
					...(explicitPictureFilter === undefined
						? {}
						: { explicitPictureFilter }),
				}).tools.make_image as unknown as { description: string }
			).description;
		expect(describe()).toMatch(/explicit/i);
		expect(describe(true)).toMatch(/explicit/i);
		expect(describe(false)).not.toMatch(/explicit/i);
		expect(describe(true)).toMatch(/^[\x20-\x7e]*$/);
	});
});

describe("the explicit-picture filter, after rendering", () => {
	const solid =
		(colour: string) => async (input: { width: number; height: number }) =>
			new Uint8Array(
				await sharp({
					create: {
						width: input.width,
						height: input.height,
						channels: 3,
						background: colour,
					},
				})
					.png()
					.toBuffer(),
			);

	it("tells the model the picture was blocked, plainly and without a retry", async () => {
		const { STUB_EXPLICIT_COLOUR } = await import(
			"$lib/server/services/images/picture-check/classifier"
		);
		await startPictureServer({ render: solid(STUB_EXPLICIT_COLOUR) });
		await startEngine();

		const { modelPayload, metadata } = await run({ prompt: "a red door" });

		expect(modelPayload).toMatchObject({
			ok: false,
			status: "failed",
			errorCode: "image_blocked",
			retryable: false,
		});
		if (modelPayload.ok) throw new Error("not failed");
		expect(modelPayload.message).toMatch(/^[\x20-\x7e]*$/);
		expect(modelPayload.message).toMatch(/blocked/);
		expect(modelPayload.message).toMatch(/do not call make_image again/i);
		expect(metadata).toMatchObject({
			ok: false,
			imageStatus: "failed",
			imageError: "image_blocked",
		});
		const { cards, takes } = await rows();
		expect(cards[0]?.pickedTakeId).toBeNull();
		expect(takes[0]?.resultFileId).toBeNull();
	});

	it("says a picture that could not be checked was not shown, and offers the model no retry", async () => {
		const { STUB_UNAVAILABLE_COLOUR } = await import(
			"$lib/server/services/images/picture-check/classifier"
		);
		await startPictureServer({ render: solid(STUB_UNAVAILABLE_COLOUR) });
		await startEngine();
		const { modelPayload, metadata } = await run({ prompt: "a red door" });
		expect(modelPayload).toMatchObject({
			ok: false,
			errorCode: "image_unchecked",
			retryable: false,
		});
		expect(metadata).toMatchObject({ imageError: "image_unchecked" });
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

describe("a retry the model asks for", () => {
	it("replaces a generated take, once: the original leaves the tray, a second retry and an unknown take are refused", async () => {
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
		// The new take replaced the old one on the card; the old one is off the tray.
		expect(takes[0]?.hidden).toBe(1);
		expect((await rows()).cards[0]?.pickedTakeId).toBe(takes[1]?.id);

		// The retry itself may not be retried, and the hidden original is unknown.
		const retryId = (retry.modelPayload as { takeId: string }).takeId;
		expect(
			(await run({ retryOf: retryId }, { turnTakes })).modelPayload,
		).toMatchObject({ ok: false, errorCode: "retry_twice" });
		expect(
			(await run({ retryOf: first.modelPayload.takeId }, { turnTakes }))
				.modelPayload,
		).toMatchObject({ ok: false, errorCode: "retry_unknown" });
		expect(
			(await run({ retryOf: "no-such-take" }, { turnTakes })).modelPayload,
		).toMatchObject({ ok: false, errorCode: "retry_unknown" });
	});

	it("hides the take it repeats when that one was not the pick", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const one = await run({ title: "Door" }, { turnTakes });
		const two = await run({ title: "Door" }, { turnTakes });
		if (
			!two.modelPayload.ok ||
			two.modelPayload.status !== "succeeded" ||
			two.modelPayload.inUse
		) {
			throw new Error(
				`second take should be on the tray: ${JSON.stringify(two)}`,
			);
		}
		expect(one.modelPayload).toMatchObject({ inUse: true });

		const retry = await run(
			{ retryOf: two.modelPayload.takeId },
			{ turnTakes },
		);

		expect(retry.modelPayload).toMatchObject({ ok: true, retried: true });
		const { takes } = await rows();
		expect(
			takes.find(
				(t) => t.id === (two.modelPayload as { takeId: string }).takeId,
			)?.hidden,
		).toBe(1);
	});

	it("moves the pick of a take that is already in use: the item keeps both versions in History", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();

		const first = await run({ summary: "Made a red door" }, { turnTakes });
		if (!first.modelPayload.ok || first.modelPayload.status !== "succeeded") {
			throw new Error(`first did not succeed: ${JSON.stringify(first)}`);
		}
		const firstTakeId = first.modelPayload.takeId;
		const retry = await run({ retryOf: firstTakeId }, { turnTakes });
		if (!retry.modelPayload.ok || retry.modelPayload.status !== "succeeded") {
			throw new Error(`retry did not succeed: ${JSON.stringify(retry)}`);
		}

		expect(retry.modelPayload).toMatchObject({ inUse: true, retried: true });
		const { cards, takes } = await rows();
		expect(cards[0]?.pickedTakeId).toBe(retry.modelPayload.takeId);
		expect(takes.find((t) => t.id === firstTakeId)?.hidden).toBe(1);
		const { db } = await import("$lib/server/db");
		const versions = db
			.select()
			.from(schema.artifactVersions)
			.where(
				eq(
					schema.artifactVersions.artifactId,
					retry.modelPayload.imageId ?? "",
				),
			)
			.orderBy(asc(schema.artifactVersions.versionNumber))
			.all();
		// The missed take stays in History; the retry is the version in use.
		expect(versions).toHaveLength(2);
		expect(parseImageVersionBody(versions[1]?.body ?? null)?.takeId).toBe(
			retry.modelPayload.takeId,
		);
	});
});

/**
 * Replaces the pixel guard with one that keeps the render as it is and reports
 * the measures given for each take in turn (the last one repeats). The guard's
 * own measuring is tested with the guard; these tests are about what the tool
 * does with a miss, and a real guard over a 1 MP picture would make them slow
 * enough to fail under load.
 */
function guardReporting(reports: GuardReport[]) {
	guardState.reports = reports;
	guardState.call = 0;
	return { calls: () => guardState.call };
}

describe("the automatic retry of a clear miss", () => {
	it("makes the take again once when nothing changed: one visible take, the first hidden, retried true", async () => {
		const guard = guardReporting([
			{ miss: "nothing_changed", changedShare: 0, insideMarksShare: null },
			{ miss: null, changedShare: 0.1, insideMarksShare: null },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload, metadata } = await run({
			pictures: [artifactId],
			summary: "Made the door red",
		});

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error(`not succeeded: ${JSON.stringify(modelPayload)}`);
		}
		expect(guard.calls()).toBe(2);
		const { cards, takes } = await rows();
		expect(takes).toHaveLength(2);
		expect(takes[0]).toMatchObject({ hidden: 1 });
		expect(takes[1]).toMatchObject({
			hidden: 0,
			origin: "auto_retry",
			retryOf: takes[0]?.id,
			retried: 1,
			heldUntil: null,
		});
		expect(takes[1]?.seed).not.toBe(takes[0]?.seed);
		expect(modelPayload).toMatchObject({
			takeId: takes[1]?.id,
			inUse: true,
			retried: true,
		});
		expect(metadata).toMatchObject({
			imageRetried: true,
			imageTakeId: takes[1]?.id,
		});
		expect(cards[0]?.pickedTakeId).toBe(takes[1]?.id);
		const { db } = await import("$lib/server/db");
		const versions = db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, artifactId))
			.all();
		// The item's own version and the one change: the missed take never became one.
		expect(versions).toHaveLength(2);
	});

	it("retries a change outside the marks and shows the retry that landed inside them", async () => {
		guardReporting([
			{ miss: "outside_marks", changedShare: 0.2, insideMarksShare: 0 },
			{ miss: null, changedShare: 0.1, insideMarksShare: 0.9 },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload } = await run({ pictures: [artifactId] });

		const { takes } = await rows();
		expect(takes.map((t) => t.hidden)).toEqual([1, 0]);
		expect(modelPayload).toMatchObject({
			ok: true,
			retried: true,
			takeId: takes[1]?.id,
		});
	});

	it("when both missed, keeps the one with more change inside the marks and hides the other", async () => {
		guardReporting([
			{ miss: "outside_marks", changedShare: 0.3, insideMarksShare: 0.4 },
			{ miss: "outside_marks", changedShare: 0.2, insideMarksShare: 0 },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload } = await run({ pictures: [artifactId] });

		const { takes, cards } = await rows();
		expect(takes.map((t) => t.hidden)).toEqual([0, 1]);
		expect(cards[0]?.pickedTakeId).toBe(takes[0]?.id);
		expect(modelPayload).toMatchObject({
			ok: true,
			retried: true,
			takeId: takes[0]?.id,
		});
	});

	it("does not retry a change that landed", async () => {
		const guard = guardReporting([
			{ miss: null, changedShare: 0.1, insideMarksShare: null },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload } = await run({ pictures: [artifactId] });

		expect(guard.calls()).toBe(1);
		expect(modelPayload).toMatchObject({ retried: false });
		expect((await rows()).takes).toHaveLength(1);
	});

	it("does not retry with less than 25 s of the wait left", async () => {
		const guard = guardReporting([
			{ miss: "nothing_changed", changedShare: 0, insideMarksShare: null },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload } = await run(
			{ pictures: [artifactId] },
			{ waitBudgetMs: 20_000 },
		);

		expect(guard.calls()).toBe(1);
		expect(modelPayload).toMatchObject({ ok: true, retried: false });
		expect((await rows()).takes).toHaveLength(1);
	});

	/** A render that answers the base picture at once the first time and after `delayMs` the second time. */
	function slowSecondRender(delayMs: number) {
		let calls = 0;
		return async (input: { images: Uint8Array[] }) => {
			calls += 1;
			if (calls > 1) await new Promise((r) => setTimeout(r, delayMs));
			const base = input.images[0];
			if (!base) throw new Error("no input picture");
			return base;
		};
	}

	const MISS_THEN_FINE = [
		{
			miss: "nothing_changed" as const,
			changedShare: 0,
			insideMarksShare: null,
		},
		{ miss: null, changedShare: 0.1, insideMarksShare: null },
	];

	/** A render that answers the base picture at once the first time and only once released the second time, so no timing decides the test. */
	function gatedSecondRender() {
		let calls = 0;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			release: () => release(),
			render: async (input: { images: Uint8Array[] }) => {
				calls += 1;
				if (calls > 1) await gate;
				const base = input.images[0];
				if (!base) throw new Error("no input picture");
				return base;
			},
		};
	}

	it("shows only the first take when the retry has not landed by the end of the call: the retry lands hidden", async () => {
		guardReporting(MISS_THEN_FINE);
		const gated = gatedSecondRender();
		await startPictureServer({ steps: 2, render: gated.render });
		await startEngine();
		const { artifactId } = await makeItem();

		// The call ends (a watchdog-style abort, no reason) while the retry is
		// still waiting on the picture server; nothing here depends on a clock.
		const controller = new AbortController();
		const running = run(
			{ pictures: [artifactId] },
			{
				waitBudgetMs: 60_000,
				retryMinLeftMs: 0,
				signal: controller.signal,
			},
		);
		await until(
			async () => (await rows()).takes,
			(takes) => takes.length === 2 && takes[1]?.status === "running",
		);
		controller.abort();
		const { modelPayload } = await running;

		const early = (await rows()).takes;
		expect(early).toHaveLength(2);
		expect(early[1]?.hidden).toBe(1);
		expect(modelPayload).toMatchObject({
			ok: true,
			status: "succeeded",
			takeId: early[0]?.id,
		});
		gated.release();
		const landed = await until(
			async () => (await rows()).takes[1],
			(take) => take?.status === "succeeded",
		);
		const { cards, takes } = await rows();
		expect(landed?.hidden).toBe(1);
		expect(takes[0]?.hidden).toBe(0);
		expect(cards[0]?.pickedTakeId).toBe(takes[0]?.id);
	});

	it("the composer's Stop during a retry that has started leaves it to land hidden, the first take stays shown", async () => {
		guardReporting(MISS_THEN_FINE);
		await startPictureServer({ steps: 2, render: slowSecondRender(1500) });
		await startEngine();
		const picture = fake;
		if (!picture) throw new Error("no picture server");
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const { artifactId } = await makeItem();
		const controller = new AbortController();
		const call = run(
			{ pictures: [artifactId] },
			{
				signal: controller.signal,
				waitBudgetMs: 60_000,
				retryMinLeftMs: 0,
			},
		);
		await until(
			async () => [...picture.prompts.values()],
			(statuses) => statuses.length === 2 && statuses.includes("running"),
		);
		// Two prompts and one running: the first is done, the running one is the retry's.
		controller.abort(new UserStopReason());
		const { modelPayload } = await call;

		const { takes } = await rows();
		expect(modelPayload).toMatchObject({ ok: true, takeId: takes[0]?.id });
		expect(takes[1]?.hidden).toBe(1);
		const landed = await until(
			async () => (await rows()).takes[1],
			(take) => take?.status === "succeeded" || take?.status === "cancelled",
		);
		expect(landed?.status).toBe("succeeded");
		expect((await rows()).cards[0]?.pickedTakeId).toBe(takes[0]?.id);
	});

	it("does not retry again a take the model itself asked to be made again", async () => {
		// The first take fails (cheap); the model's retry then lands without a change.
		const guard = guardReporting([
			{ miss: "nothing_changed", changedShare: 0, insideMarksShare: null },
		]);
		await startPictureServer({ steps: 2, fail: "execution" });
		await startEngine();
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const { artifactId } = await makeItem();
		const first = await run({ pictures: [artifactId] }, { turnTakes });
		if (first.modelPayload.ok || !("status" in first.modelPayload)) {
			throw new Error("first did not fail");
		}
		fake?.setOptions({ steps: 2, fail: undefined });

		const retry = await run(
			{ retryOf: first.modelPayload.takeId },
			{ turnTakes },
		);

		// It missed (nothing changed), and no third take was made on its own.
		expect(guard.calls()).toBe(1);
		expect((await rows()).takes).toHaveLength(2);
		expect(retry.modelPayload).toMatchObject({ ok: true, retried: true });
	});
});

describe("pickBetterTake", () => {
	const landed = (
		measures: Partial<{
			miss: "nothing_changed" | "outside_marks" | null;
			changedShare: number;
			insideMarksShare: number | null;
		}> = {},
	) =>
		({
			takeId: "t",
			status: "succeeded",
			phase: null,
			resultFileId: "f",
			errorCode: null,
			retryable: false,
			measures: {
				dx: 0,
				dy: 0,
				scale: 1,
				changedShare: 0.1,
				insideMarksShare: null,
				global: false,
				reanchored: false,
				miss: null,
				chainSinceAnchor: 1,
				anchorIsResult: false,
				...measures,
			},
		}) as import("$lib/server/services/images/wait").TakeSnapshot;

	it("takes the retry, unless it did not land or only it missed", async () => {
		const { pickBetterTake } = await import("./make-image");
		const missed = landed({ miss: "nothing_changed", changedShare: 0 });
		const failed = {
			...landed(),
			status: "failed",
		} as import("$lib/server/services/images/wait").TakeSnapshot;

		expect(pickBetterTake(missed, landed())).toBe("retry");
		expect(pickBetterTake(missed, failed)).toBe("first");
		expect(pickBetterTake(landed(), missed)).toBe("first");
		expect(pickBetterTake(landed(), landed())).toBe("retry");
	});

	it("when both missed, keeps the one with more change inside the marks, else more change overall", async () => {
		const { pickBetterTake } = await import("./make-image");
		const outside = (changedShare: number, inside: number) =>
			landed({
				miss: "outside_marks",
				changedShare,
				insideMarksShare: inside,
			});

		// The first has more change inside the marks.
		expect(pickBetterTake(outside(0.3, 0.4), outside(0.2, 0.0))).toBe("first");
		// The retry has more.
		expect(pickBetterTake(outside(0.2, 0.0), outside(0.3, 0.4))).toBe("retry");
		// No marks: more change overall.
		const barely = (changedShare: number) =>
			landed({ miss: "nothing_changed", changedShare });
		expect(pickBetterTake(barely(0.001), barely(0.0))).toBe("first");
		expect(pickBetterTake(barely(0.0), barely(0.001))).toBe("retry");
	});
});

describe("the look at the result", () => {
	async function lookRun(
		input: Partial<MakeImageInput>,
		options: Parameters<typeof run>[1] & {
			queue?: import("$lib/server/services/vision/step-images").StepImageQueue;
			modelCanSee?: boolean;
		},
	) {
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);
		const queue = options.queue ?? createStepImageQueue();
		const { runMakeImageTool } = await import("./make-image");
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const result = await runMakeImageTool({
			userId,
			conversationId,
			turnId: "turn-1",
			toolCallId: "call-1",
			input: { prompt: "make the door red", ...input },
			turnPictures: options.turnPictures ?? null,
			turnTakes: options.turnTakes ?? createTurnTakes(),
			requestText: "make the door red",
			signal: options.signal ?? new AbortController().signal,
			waitBudgetMs: options.waitBudgetMs,
			stepImages: queue,
			modelCanSee: options.modelCanSee,
		});
		return { ...result, queue };
	}

	it("queues the result under its label with the number of the picture it was changed from", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const base = await storeFile();

		const { modelPayload, queue } = await lookRun(
			{ pictures: ["1"] },
			{ turnPictures: index([fileSource(base.id)]) },
		);

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error(`not succeeded: ${JSON.stringify(modelPayload)}`);
		}
		const entries = queue.drain();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.label).toBe(
			`Result of make_image (takeId ${modelPayload.takeId}), changed from picture 1:`,
		);
		expect(entries[0]?.images).toHaveLength(1);
		expect(entries[0]?.images[0]?.artifactId).toMatch(/^image-file:/);
		expect(modelPayload.note).toBe(
			`The result follows as a picture. If pictures the user asked for are still not made, call make_image for them before you write. Then say in one or two sentences what changed. If it clearly missed (the wrong thing changed), call make_image once with retryOf "${modelPayload.takeId}".`,
		);
		expect(queue.room()).toBe(7);
	});

	it("shows the base first under Before: when the message did not carry it (two of the eight)", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload, queue } = await lookRun(
			{ pictures: [artifactId] },
			{},
		);

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error(`not succeeded: ${JSON.stringify(modelPayload)}`);
		}
		const entries = queue.drain();
		expect(entries.map((e) => e.label)).toEqual([
			"Before:",
			`Result of make_image (takeId ${modelPayload.takeId}):`,
		]);
		expect(queue.room()).toBe(6);
	});

	it("does not tell the model to retry a take that was already made again", async () => {
		guardReporting([
			{ miss: "nothing_changed", changedShare: 0, insideMarksShare: null },
			{ miss: null, changedShare: 0.1, insideMarksShare: null },
		]);
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { artifactId } = await makeItem();

		const { modelPayload, queue } = await lookRun(
			{ pictures: [artifactId] },
			{},
		);

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error("not succeeded");
		}
		expect(modelPayload.retried).toBe(true);
		expect(modelPayload.note).toContain("already made again once");
		expect(modelPayload.note).not.toContain("retryOf");
		expect(queue.drain().length).toBeGreaterThan(0);
	});

	it("labels a new picture with no number", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();

		const { modelPayload, queue } = await lookRun({}, {});

		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error("not succeeded");
		}
		expect(queue.drain().map((e) => e.label)).toEqual([
			`Result of make_image (takeId ${modelPayload.takeId}):`,
		]);
	});

	it("shares the eight with the photos look: with one place left only the result is shown", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);
		const queue = createStepImageQueue();
		queue.reserve(7);
		const { artifactId } = await makeItem();

		const { queue: used } = await lookRun(
			{ pictures: [artifactId] },
			{ queue },
		);

		expect(used.drain().map((e) => e.label)).toHaveLength(1);
		expect(used.room()).toBe(0);
	});

	it("with no room left there is no look, and the note says the picture is on its card", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createStepImageQueue } = await import(
			"$lib/server/services/vision/step-images"
		);

		const { modelPayload, queue } = await lookRun(
			{},
			{ queue: createStepImageQueue({ budget: 0 }) },
		);

		expect(queue.drain()).toEqual([]);
		expect(modelPayload).toMatchObject({
			ok: true,
			status: "succeeded",
			note: expect.stringContaining("on its card in the chat"),
		});
	});

	it("gives a model that cannot see no look and a note that claims no picture was shown", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();

		const { modelPayload, queue } = await lookRun({}, { modelCanSee: false });

		expect(queue.drain()).toEqual([]);
		expect(queue.room()).toBe(8);
		if (!modelPayload.ok || modelPayload.status !== "succeeded") {
			throw new Error(`not succeeded: ${JSON.stringify(modelPayload)}`);
		}
		expect(modelPayload.note).toContain("on its card in the chat");
		expect(modelPayload.note).not.toContain("follows as a picture");
		expect(modelPayload.note).not.toContain("retryOf");
		expect((await rows()).takes).toHaveLength(1);
	});

	it("gives a picture that lands after the wait no look", async () => {
		await startPictureServer({ steps: 4, stepDelayMs: 200 });
		await startEngine();

		const { modelPayload, queue } = await lookRun({}, { waitBudgetMs: 300 });

		expect(modelPayload).toMatchObject({ ok: true, status: "running" });
		await until(
			async () => (await rows()).takes[0]?.status,
			(status) => status === "succeeded",
		);
		expect(queue.drain()).toEqual([]);
		expect(queue.room()).toBe(8);
	});
});

describe("the wait keeps the stream alive", () => {
	it("ticks once a second while the take is being made", async () => {
		await startPictureServer({ steps: 4, stepDelayMs: 600 });
		await startEngine();
		const { runMakeImageTool } = await import("./make-image");
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const onTick = vi.fn();

		await runMakeImageTool({
			userId,
			conversationId,
			turnId: "turn-1",
			toolCallId: "call-1",
			input: { prompt: "a red door" },
			turnPictures: null,
			turnTakes: createTurnTakes(),
			requestText: "a red door",
			signal: new AbortController().signal,
			onTick,
		});

		// A take of about 2.4 s: at least two ticks, whatever the load.
		expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
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

describe("the composer's Stop and the picture server's queue", () => {
	it("deletes a prompt that is still waiting in the picture server's queue", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const picture = fake;
		if (!picture) throw new Error("no picture server");
		picture.holdQueue(true);
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const controller = new AbortController();
		const call = run({}, { signal: controller.signal, waitBudgetMs: 60_000 });
		// The prompt is waiting in ComfyUI's queue under the id the take recorded
		// before posting it, so the Stop deletes it there.
		await until(
			async () => ({
				statuses: [...picture.prompts.values()],
				checkpoint: (await rows()).takes[0]?.checkpoint ?? null,
			}),
			({ statuses, checkpoint }) =>
				statuses.includes("pending") && checkpoint !== null,
		);

		controller.abort(new UserStopReason());
		const { modelPayload, metadata } = await call;

		expect(modelPayload).toMatchObject({
			ok: false,
			status: "failed",
			errorCode: "image_stopped",
		});
		// The row the person reads says stopped, from a flag, not from the model's text.
		expect(metadata).toMatchObject({ imageStopped: true });
		expect(metadata).not.toHaveProperty("error");
		expect([...picture.prompts.values()]).toEqual([]);
		expect((await rows()).takes[0]?.status).toBe("cancelled");
		// The cancel wakes the worker; let its drain pass end before the database closes.
		const { drainImageTakes } = await import(
			"$lib/server/services/images/testing/run-takes"
		);
		await drainImageTakes();
	});

	it("never interrupts a render that ComfyUI has started, even before the take's phase shows it", async () => {
		// ComfyUI starts the prompt at once and takes a while to begin work, so the
		// take's phase lags behind: the race the rule is about.
		await startPictureServer({ steps: 2, startDelayMs: 700 });
		await startEngine();
		const picture = fake;
		if (!picture) throw new Error("no picture server");
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const controller = new AbortController();
		const call = run({}, { signal: controller.signal, waitBudgetMs: 60_000 });
		await until(
			async () => [...picture.prompts.values()],
			(statuses) => statuses.includes("running"),
		);

		controller.abort(new UserStopReason());
		const { modelPayload } = await call;

		expect(modelPayload).toMatchObject({ ok: true, status: "running" });
		const landed = await until(
			async () => (await rows()).takes[0],
			(take) => take?.status === "succeeded" || take?.status === "cancelled",
		);
		expect(landed?.status).toBe("succeeded");
		expect(
			picture.requests.some((request) => request.path === "/interrupt"),
		).toBe(false);
		expect(landed?.heldUntil).toBeNull();
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

	it("two tool packs of one turn (a stream and its rerun) share the turn's cards instead of making the picture twice", async () => {
		await startPictureServer({ steps: 2 });
		await startEngine();
		const { createNormalChatTools } = await import("./index");
		const { createTurnTakes } = await import(
			"$lib/server/services/images/turn-takes"
		);
		const turnTakes = createTurnTakes();
		const callOn = async (id: string) => {
			const pack = createNormalChatTools({
				userId,
				conversationId,
				turnId: `turn-${id}`,
				turnTakes,
			});
			const tool = pack.tools.make_image as unknown as {
				execute: (input: unknown, options: unknown) => Promise<unknown>;
			};
			return tool.execute(
				{ prompt: "a red door" },
				{
					toolCallId: id,
					messages: [],
					abortSignal: new AbortController().signal,
				},
			);
		};
		await callOn("first");
		await callOn("rerun");
		const { cards, takes } = await rows();
		expect(cards).toHaveLength(1);
		expect(takes).toHaveLength(2);
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
