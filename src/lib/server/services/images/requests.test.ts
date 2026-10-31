// @vitest-environment node
//
// From a make_image call to the request a take is made with: a real migrated
// database, the real artifacts service and picture files in a temp working
// directory. Nothing is queued here (the tool's own tests do that), so no
// picture server is needed.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { serializeImageVersionBody } from "$lib/shared/artifacts/image-body";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import type { GraphTemplate } from "./comfyui/templates";
import type { TakeRequest } from "./take-request";
import { createImageFixture, type ImageFixture } from "./testing/fixture";
import type {
	TurnPicture,
	TurnPictureIndex,
	TurnPictureSource,
} from "./turn-pictures";

const userId = "user-1";
const conversationId = "conv-1";

let fixture: ImageFixture;
let workdir: string;
/** What the mocked artifact lookup knows: uploads by id, as the stored file they point at. */
const uploads = new Map<string, { storagePath: string; mimeType: string }>();

beforeAll(async () => {
	await warmModules([
		() => import("./requests"),
		() => import("./cards"),
		() => import("./files"),
		() => import("$lib/server/services/artifacts"),
	]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-requests");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "image-requests-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	uploads.clear();
	vi.resetModules();
	// Only the upload lookup is faked: the rest of the knowledge facade is real.
	vi.doMock("$lib/server/services/knowledge", async (importOriginal) => ({
		...(await importOriginal<
			typeof import("$lib/server/services/knowledge")
		>()),
		getArtifactForUser: vi.fn(async (_user: string, id: string) => {
			const upload = uploads.get(id);
			return upload ? { id, ...upload } : null;
		}),
	}));
});

afterEach(async () => {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.doUnmock("$lib/server/services/knowledge");
	vi.restoreAllMocks();
	await rm(workdir, { recursive: true, force: true });
});

async function png(width: number, height: number, color = "#778899") {
	return new Uint8Array(
		await sharp({ create: { width, height, channels: 3, background: color } })
			.png()
			.toBuffer(),
	);
}

async function storeFile(width = 1248, height = 832) {
	const { storeImageFile } = await import("./files");
	return storeImageFile({
		userId,
		conversationId,
		role: "take",
		png: await png(width, height),
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
			chainSinceAnchor: 2,
		}),
		author: "alfy",
		versionSummary: VERSION_SUMMARY.alfyPicture,
	});
	if (!created.ok) throw new Error("item not made");
	// A settled card attaches its pictures to the item; so does this stand-in.
	const { attachImageFilesToArtifact } = await import("./files");
	await attachImageFilesToArtifact([file.id], created.artifact.id);
	return { artifactId: created.artifact.id, file };
}

async function makeUpload(width: number, height: number) {
	const artifactId = randomUUID();
	const storagePath = join("data", "uploads", `${artifactId}.jpg`);
	await mkdir(dirname(join(workdir, storagePath)), { recursive: true });
	await writeFile(
		join(workdir, storagePath),
		await sharp({
			create: { width, height, channels: 3, background: "#aa6633" },
		})
			.jpeg()
			.toBuffer(),
	);
	uploads.set(artifactId, { storagePath, mimeType: "image/jpeg" });
	const source: TurnPictureSource = {
		type: "upload",
		artifactId,
		name: "rug.jpg",
		mimeType: "image/jpeg",
	};
	return source;
}

async function resolve(
	input: Partial<import("./requests").MakeImageRequestInput> & {
		prompt?: string;
	},
	options: {
		turnPictures?: TurnPictureIndex | null;
		turnTakes?: import("./turn-takes").TurnTakes;
		template?: GraphTemplate | null;
		requestText?: string;
	} = {},
) {
	const { resolveMakeImageRequest } = await import("./requests");
	const { createTurnTakes } = await import("./turn-takes");
	return resolveMakeImageRequest({
		userId,
		conversationId,
		input: { prompt: "a cosy room", ...input },
		turnPictures: options.turnPictures ?? null,
		turnTakes: options.turnTakes ?? createTurnTakes(),
		requestText: options.requestText ?? "",
		template: options.template,
	});
}

function request(overrides: Partial<TakeRequest> = {}): TakeRequest {
	return {
		v: 1,
		mode: "generate",
		prompt: "a cosy room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 1248, height: 832 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy room",
		summary: null,
		...overrides,
	};
}

describe("the pictures a call names", () => {
	it("refuses a number the message does not have and an id that is no Image", async () => {
		const file = await storeFile();
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
		const turnPictures = index([fileSource(file.id)]);

		for (const name of ["9", document.artifact.id, "no-such-id"]) {
			const result = await resolve({ pictures: [name] }, { turnPictures });
			expect(result).toMatchObject({ ok: false, refusal: "unknown_picture" });
		}
	});

	it("takes the picture number from the message and names the picture once however it is named", async () => {
		const item = await makeItem();
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const result = await resolve(
			{ pictures: ["1", item.artifactId] },
			{ turnPictures },
		);
		expect(result.ok && result.plan.sourceCount).toBe(1);
	});
});

describe("how many pictures one call takes", () => {
	it("is the lower of the cap and the graph's slots: cap 4, graph 3", async () => {
		const { GRAPH_TEMPLATES } = await import("./comfyui/templates");
		const edit = GRAPH_TEMPLATES.edit;
		if (!edit) throw new Error("no edit graph");
		const threeSlots: GraphTemplate = {
			...edit,
			slots: { ...edit.slots, images: edit.slots.images.slice(0, 3) },
		};
		const files = await Promise.all([1, 2, 3, 4].map(() => storeFile()));
		const turnPictures = index(files.map((file) => fileSource(file.id)));

		const four = await resolve(
			{ pictures: ["1", "2", "3", "4"] },
			{ turnPictures, template: threeSlots },
		);
		expect(four).toMatchObject({ ok: false, refusal: "too_many_pictures" });
		expect(!four.ok && four.message).toBe(
			"make_image takes at most 3 pictures per call. Pass the ones the picture needs, or ask the user which.",
		);

		const three = await resolve(
			{ pictures: ["1", "2", "3"] },
			{ turnPictures, template: threeSlots },
		);
		expect(three.ok).toBe(true);
	});

	it("counts the marked copy among them", async () => {
		const { GRAPH_TEMPLATES } = await import("./comfyui/templates");
		const edit = GRAPH_TEMPLATES.edit;
		if (!edit) throw new Error("no edit graph");
		const twoSlots: GraphTemplate = {
			...edit,
			slots: { ...edit.slots, images: edit.slots.images.slice(0, 2) },
		};
		const [a, b, marked] = await Promise.all([1, 2, 3].map(() => storeFile()));
		const turnPictures = index([
			fileSource(a.id),
			fileSource(b.id),
			fileSource(marked.id, {
				role: "marked",
				marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
			}),
		]);
		const result = await resolve(
			{ pictures: ["1", "2", "3"] },
			{ turnPictures, template: twoSlots },
		);
		expect(result).toMatchObject({ ok: false, refusal: "too_many_pictures" });
	});
});

describe("which card a call belongs to", () => {
	it("gives one card key to the same request and another to a different one", async () => {
		const a = await resolve({ prompt: "a red door", size: "tall" });
		const again = await resolve({ prompt: "a red door", size: "tall" });
		const other = await resolve({ prompt: "a blue door", size: "tall" });
		if (!a.ok || !again.ok || !other.ok) throw new Error("not resolved");
		expect(a.plan.cardKey).toMatch(/^new:[0-9a-f]{64}$/);
		expect(again.plan.cardKey).toBe(a.plan.cardKey);
		expect(other.plan.cardKey).not.toBe(a.plan.cardKey);
	});

	it("changes an Image item in place on its own card, and startNew makes a separate picture", async () => {
		const item = await makeItem();
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const change = await resolve({ pictures: ["1"] }, { turnPictures });
		if (!change.ok) throw new Error("not resolved");
		expect(change.plan).toMatchObject({
			cardKey: `item:${item.artifactId}`,
			artifactId: item.artifactId,
			madeFrom: "change",
		});

		const apart = await resolve(
			{ pictures: ["1"], startNew: true },
			{ turnPictures },
		);
		if (!apart.ok) throw new Error("not resolved");
		expect(apart.plan.cardKey).toMatch(/^new:/);
		expect(apart.plan.artifactId).toBeNull();
		expect(apart.plan.madeFrom).toBe("pictures");
	});

	it("refuses the fifth take of a card", async () => {
		const { createTurnTakes } = await import("./turn-takes");
		const turnTakes = createTurnTakes();
		const first = await resolve({}, { turnTakes });
		if (!first.ok) throw new Error("not resolved");
		turnTakes.rememberCard(first.plan.cardKey, "card-1");
		for (let i = 0; i < 4; i++) {
			turnTakes.noteTake({
				takeId: `take-${i}`,
				cardId: "card-1",
				cardKey: first.plan.cardKey,
				callKey: first.plan.callKey,
				seed: i + 1,
				request: first.plan.request,
				isRetry: false,
			});
		}
		const fifth = await resolve({}, { turnTakes });
		expect(fifth).toMatchObject({ ok: false, refusal: "too_many_takes" });
	});
});

describe("what a call is made from", () => {
	it("makes a new picture from words on the default canvas, or the shape and quality asked for", async () => {
		const plain = await resolve({});
		const phone = await resolve({ size: "tall", print: true });
		if (!plain.ok || !phone.ok) throw new Error("not resolved");
		expect(plain.plan).toMatchObject({ madeFrom: "words", sourceCount: 0 });
		expect(plain.plan.request).toMatchObject({
			mode: "generate",
			canvas: { width: 1248, height: 832 },
			inputs: [],
			baseFromUpload: false,
		});
		expect(phone.plan.request.canvas).toEqual({ width: 1536, height: 2752 });
	});

	it("starts an item from a photo: the upload is the base and version 1", async () => {
		const upload = await makeUpload(640, 480);
		const result = await resolve(
			{ pictures: ["1"] },
			{ turnPictures: index([upload]) },
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan).toMatchObject({
			madeFrom: "photo",
			artifactId: null,
			sourceCount: 1,
		});
		expect(result.plan.request).toMatchObject({
			mode: "edit",
			baseFromUpload: true,
			canvas: { width: 1184, height: 896 },
		});
		expect(result.plan.request.inputs).toHaveLength(1);
		expect(result.plan.request.inputs[0]).toMatchObject({
			role: "base",
			name: "rug.jpg",
		});
		// Its own anchor, chain 0.
		expect(result.plan.request.anchor).toEqual({
			fileId: result.plan.request.inputs[0]?.fileId,
			chainSinceAnchor: 0,
		});
	});

	it("changes the version in use of an item: its file, its shape, a seed unlike its own, its anchor and chain", async () => {
		const item = await makeItem(123);
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const result = await resolve(
			{ pictures: ["1"], summary: "Painted the door red" },
			{ turnPictures },
		);
		if (!result.ok) throw new Error("not resolved");
		const { request: made } = result.plan;
		expect(made.mode).toBe("edit");
		expect(made.inputs).toEqual([
			{ fileId: item.file.id, role: "base", name: "Cosy room" },
		]);
		expect(made.canvas).toEqual({ width: 1248, height: 832 });
		expect(made.avoidSeeds).toEqual([123]);
		expect(made.baseFromUpload).toBe(false);
		expect(made.anchor).toEqual({
			fileId: item.file.id,
			chainSinceAnchor: 2,
		});
		expect(made.summary).toBe("Painted the door red");
		expect(result.plan.title).toBe("Cosy room");
	});

	it("builds the next change in a turn on this turn's newest finished take of the card", async () => {
		const item = await makeItem(123);
		const turnPictures = index([
			fileSource(item.file.id, { artifactId: item.artifactId, role: "open" }),
		]);
		const { createCard } = await import("./cards");
		const { createTurnTakes } = await import("./turn-takes");
		const { cardId } = await createCard({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId: item.artifactId,
			title: "Cosy room",
			madeFrom: "change",
			sourceCount: 1,
		});
		const landed = await storeFile();
		const { db } = await import("$lib/server/db");
		db.insert(schema.imageJobs)
			.values({
				id: "take-1",
				userId,
				status: "succeeded",
				cardId,
				conversationId,
				origin: "turn",
				requestJson: JSON.stringify(
					request({
						mode: "edit",
						inputs: [{ fileId: item.file.id, role: "base", name: "Cosy room" }],
						anchor: { fileId: item.file.id, chainSinceAnchor: 2 },
					}),
				),
				seed: 777,
				heldUntil: Date.now() + 100_000,
				resultFileId: landed.id,
				measuresJson: JSON.stringify({
					chainSinceAnchor: 3,
					anchorIsResult: false,
				}),
			})
			.run();
		const turnTakes = createTurnTakes();
		turnTakes.rememberCard(`item:${item.artifactId}`, cardId);

		const result = await resolve(
			{ pictures: ["1"] },
			{ turnPictures, turnTakes },
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.cardId).toBe(cardId);
		// An unpicked take's picture is copied, never shared: its own card may still pick it.
		expect(result.plan.request.inputs[0]?.fileId).not.toBe(landed.id);
		expect(result.plan.request.inputs[0]?.role).toBe("base");
		expect(result.plan.request.avoidSeeds).toEqual([777]);
		expect(result.plan.request.anchor).toEqual({
			fileId: item.file.id,
			chainSinceAnchor: 3,
		});
	});

	it("takes the other pictures as references and counts only them as its sources", async () => {
		const [a, b, c] = await Promise.all([1, 2, 3].map(() => storeFile()));
		const result = await resolve(
			{ pictures: ["1", "2", "3"] },
			{
				turnPictures: index([a, b, c].map((file) => fileSource(file.id))),
			},
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan).toMatchObject({ madeFrom: "pictures", sourceCount: 3 });
		expect(result.plan.request.inputs.map((input) => input.role)).toEqual([
			"base",
			"reference",
			"reference",
		]);
	});

	it("changes the marked upload when only its marked copy is named", async () => {
		const photo = await makeUpload(600, 400);
		const copy = await storeFile();
		const marks = [{ letter: "A" as const, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }];
		const turnPictures: TurnPictureIndex = {
			...index([photo, fileSource(copy.id, { role: "marked", marks })]),
			metadata: {
				refs: [],
				open: null,
				marks: {
					uploadArtifactId:
						photo.type === "upload" ? photo.artifactId : undefined,
					markedFileId: copy.id,
					letters: ["A"],
				},
			},
		};
		const result = await resolve({ pictures: ["2"] }, { turnPictures });
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.madeFrom).toBe("photo");
		expect(result.plan.request.baseFromUpload).toBe(true);
		expect(result.plan.request.marks).toEqual(marks);
	});

	it("paints the marked copy on the base and keeps the boxes on the request", async () => {
		const base = await storeFile();
		const copy = await storeFile();
		const marks = [{ letter: "A" as const, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }];
		const turnPictures = index([
			fileSource(base.id),
			fileSource(copy.id, { role: "marked", marks }),
		]);
		const result = await resolve({ pictures: ["1", "2"] }, { turnPictures });
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.sourceCount).toBe(1);
		expect(result.plan.request.marks).toEqual(marks);
		expect(result.plan.request.inputs.map((input) => input.role)).toEqual([
			"base",
			"marked",
		]);
	});

	it("falls back to the first eight words of the person's message for a title", async () => {
		const result = await resolve(
			{},
			{
				requestText: "please draw me a cosy living room with a big window",
			},
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.title).toBe("please draw me a cosy living room with");
	});

	// Task 17 (rehearsal P2): with no title from the model, a photo's change was
	// named "This is a photo of my living room." — the person's sentence, its dot
	// and all ("room..png"). The fallback stops at the sentence's end and keeps no
	// closing punctuation.
	it("keeps the fallback to the first sentence, without its closing punctuation", async () => {
		const result = await resolve(
			{},
			{
				requestText:
					"Sunset over the lake. Make it warmer and add a boat please",
			},
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.title).toBe("Sunset over the lake");
	});

	// Fix round 1 (review Minor 4): an abbreviation's dot is not a sentence's end.
	it.each([
		[
			"Dr. Kovács's office, warmer light please",
			"Dr. Kovács's office, warmer light please",
		],
		[
			"Mrs. Smith wants the kitchen brighter. Keep the rest",
			"Mrs. Smith wants the kitchen brighter",
		],
		[
			"A kert pl. a fák legyenek zöldebbek. Köszi",
			"A kert pl. a fák legyenek zöldebbek",
		],
		[
			"J. R. R. Tolkien style castle on a hill",
			"J. R. R. Tolkien style castle on a",
		],
	])("does not cut %j at an abbreviation", async (requestText, title) => {
		const result = await resolve({}, { requestText });
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.title).toBe(title);
	});

	it("prefers the model's own title over the person's words", async () => {
		const result = await resolve(
			{ title: "Green sofa room" },
			{
				requestText: "This is a photo of my living room. Make the sofa green.",
			},
		);
		if (!result.ok) throw new Error("not resolved");
		expect(result.plan.title).toBe("Green sofa room");
	});
});

describe("a retry", () => {
	it("makes the same request again with a seed unlike the first's, once", async () => {
		const { createTurnTakes } = await import("./turn-takes");
		const turnTakes = createTurnTakes();
		const { createCard } = await import("./cards");
		const { cardId } = await createCard({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId: null,
			title: "Cosy room",
			madeFrom: "words",
			sourceCount: 0,
		});
		const { db } = await import("$lib/server/db");
		db.insert(schema.imageJobs)
			.values({
				id: "take-1",
				userId,
				status: "succeeded",
				cardId,
				conversationId,
				origin: "turn",
				requestJson: JSON.stringify(request()),
				seed: 41,
			})
			.run();
		turnTakes.noteTake({
			takeId: "take-1",
			cardId,
			cardKey: "new:abc",
			callKey: "new:abc",
			seed: 41,
			request: request(),
			isRetry: false,
		});

		const retry = await resolve({ retryOf: "take-1" }, { turnTakes });
		if (!retry.ok) throw new Error("not resolved");
		expect(retry.plan).toMatchObject({ cardId, retryOf: "take-1" });
		expect(retry.plan.request.avoidSeeds).toEqual([41]);

		turnTakes.markRetried("take-1");
		expect(await resolve({ retryOf: "take-1" }, { turnTakes })).toMatchObject({
			ok: false,
			refusal: "retry_twice",
		});
		expect(await resolve({ retryOf: "nope" }, { turnTakes })).toMatchObject({
			ok: false,
			refusal: "retry_unknown",
		});
	});
});
