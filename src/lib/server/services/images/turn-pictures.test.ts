// @vitest-environment node
//
// The numbered pictures of one turn: a real migrated database, the real
// artifacts service and picture files in a temp working directory.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ImageMark,
	serializeImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

const userId = "user-1";
const otherUserId = "user-2";
const conversationId = "conv-1";
const incognitoId = "conv-incognito";

let fixture: ImageFixture;
let workdir: string;

// One migrated database for the file: every test makes its own pictures and
// items, and nothing here counts rows, so they do not disturb each other.
beforeAll(async () => {
	fixture = createImageFixture("turn-pictures");
	fixture.seedUser(userId);
	fixture.seedUser(otherUserId);
	fixture.seedConversation(conversationId, userId);
	fixture.seedConversation(incognitoId, userId);
	fixture.sqlite
		.prepare("UPDATE conversations SET memory_incognito = 1 WHERE id = ?")
		.run(incognitoId);
	fixture.seedConversation("conv-other", otherUserId);
	workdir = await mkdtemp(join(tmpdir(), "turn-pictures-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterAll(async () => {
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

async function png(color: string, width = 200, height = 100) {
	return new Uint8Array(
		await sharp({
			create: { width, height, channels: 3, background: color },
		})
			.png()
			.toBuffer(),
	);
}

async function storeFile(
	options: { userId?: string; conversationId?: string; color?: string } = {},
) {
	const { storeImageFile } = await import("./files");
	return storeImageFile({
		userId: options.userId ?? userId,
		conversationId: options.conversationId ?? conversationId,
		role: "take",
		png: await png(options.color ?? "#336699"),
	});
}

/**
 * An Image item whose newest version points at a fresh picture file, written as
 * the row the artifacts service writes (its real shape is read back through the
 * service in tests/integration/vision-current-turn.test.ts). Inserted directly:
 * the facade's import graph is large and a cold import inside a test body is
 * what made this file depend on how busy the machine was.
 */
async function imageItem(title: string) {
	const file = await storeFile();
	const artifactId = randomUUID();
	fixture.sqlite
		.prepare(
			"INSERT INTO artifacts (id, user_id, conversation_id, type, name, content_text, metadata_json) VALUES (?, ?, ?, 'normalized_document', ?, ?, ?)",
		)
		.run(
			artifactId,
			userId,
			conversationId,
			title,
			serializeImageVersionBody({
				v: 1,
				fileId: file.id,
				width: file.width,
				height: file.height,
				hasAlpha: false,
				baseFileId: null,
				sources: [],
				marks: null,
				prompt: null,
				takeId: null,
				seed: null,
				anchorFileId: null,
				chainSinceAnchor: 0,
			}),
			JSON.stringify({ artifactType: "image", title }),
		);
	return { file, artifactId };
}

const upload = (artifactId: string, name = `${artifactId}.jpg`) => ({
	artifactId,
	name,
	mimeType: "image/jpeg",
});

const MARK_A: ImageMark = { letter: "A", x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

async function resolve(
	overrides: Partial<{
		uploads: ReturnType<typeof upload>[];
		pictureRefs: Array<{ imageFileId: string; number: number }>;
		openImageArtifactId: string | null;
		marks: { imageFileId: string; marks: ImageMark[] } | null;
	}> = {},
) {
	const { resolveTurnPictures } = await import("./turn-pictures");
	return resolveTurnPictures({
		userId,
		conversationId,
		uploads: [],
		pictureRefs: [],
		openImageArtifactId: null,
		marks: null,
		...overrides,
	});
}

function numbers(index: Awaited<ReturnType<typeof resolve>>) {
	return index.pictures.map((picture) => [
		picture.number,
		picture.source.type === "upload"
			? picture.source.artifactId
			: picture.source.fileId,
	]);
}

describe("resolveTurnPictures", () => {
	it("keeps a ref's number and fills the free ones with the uploads, in attachment order", async () => {
		const x = await storeFile();

		const index = await resolve({
			uploads: [upload("a"), upload("b")],
			pictureRefs: [{ imageFileId: x.id, number: 1 }],
		});

		expect(numbers(index)).toEqual([
			[1, x.id],
			[2, "a"],
			[3, "b"],
		]);
		expect(index.byNumber(2)?.source).toMatchObject({
			type: "upload",
			artifactId: "a",
		});
		expect(index.byNumber(9)).toBeNull();
	});

	it("numbers the open picture after the uploads, and the marked copy last, painted and stored", async () => {
		const x = await storeFile();
		const open = await imageItem("Cosy living room");

		const index = await resolve({
			uploads: [upload("a"), upload("b")],
			pictureRefs: [{ imageFileId: x.id, number: 1 }],
			openImageArtifactId: open.artifactId,
			marks: { imageFileId: open.file.id, marks: [MARK_A] },
		});

		expect(index.pictures.map((picture) => picture.number)).toEqual([
			1, 2, 3, 4, 5,
		]);
		const openPicture = index.byNumber(4);
		expect(openPicture?.source).toMatchObject({
			type: "image_file",
			fileId: open.file.id,
			role: "open",
			name: "Cosy living room (open in the panel)",
			artifactId: open.artifactId,
		});
		const marked = index.byNumber(5);
		expect(marked?.source).toMatchObject({
			type: "image_file",
			role: "marked",
			name: "Picture 4 with the user's marks: A = red box",
			marks: [MARK_A],
		});
		// The marked copy is a real stored picture file of the person's.
		const { getImageFile, readImageFileBytes } = await import("./files");
		const markedId =
			marked?.source.type === "image_file" ? marked.source.fileId : "";
		const stored = await getImageFile({
			userId,
			fileId: markedId,
			conversationId,
		});
		expect(stored?.role).toBe("marked");
		const meta = await sharp(
			await readImageFileBytes(stored as never, "full"),
		).metadata();
		expect([meta.width, meta.height]).toEqual([200, 100]);
		expect(index.metadata).toEqual({
			refs: [{ imageFileId: x.id, number: 1, name: "Attached picture" }],
			// The uploads' numbers, so a sent message can number them as the model saw.
			uploads: [
				{ artifactId: "a", number: 2 },
				{ artifactId: "b", number: 3 },
			],
			open: { imageFileId: open.file.id, name: "Cosy living room" },
			marks: {
				imageFileId: open.file.id,
				markedFileId: markedId,
				letters: ["A"],
				boxes: [MARK_A],
			},
		});
	});

	it("gives one picture one number: an attached picture that is also open, and the same upload twice", async () => {
		const open = await imageItem("Cosy living room");

		const index = await resolve({
			uploads: [upload("a"), upload("a")],
			pictureRefs: [{ imageFileId: open.file.id, number: 1 }],
			openImageArtifactId: open.artifactId,
		});

		expect(numbers(index)).toEqual([
			[1, open.file.id],
			[2, "a"],
		]);
		expect(index.byNumber(1)?.source).toMatchObject({
			name: "Cosy living room (open in the panel)",
		});
		// The panel's picture is still recorded as open for the history.
		// Recorded once: on its ref, flagged open, and not again as `open`.
		expect(index.metadata?.open).toBeNull();
		expect(index.metadata?.refs).toEqual([
			{
				imageFileId: open.file.id,
				number: 1,
				name: "Cosy living room",
				open: true,
			},
		]);
	});

	it("numbers a ref whose number is repeated or out of range after the uploads, in the order given, and goes on", async () => {
		const [x, y, z, w] = [
			await storeFile(),
			await storeFile(),
			await storeFile(),
			await storeFile(),
		];

		const index = await resolve({
			uploads: [upload("a")],
			pictureRefs: [
				{ imageFileId: x.id, number: 1 },
				{ imageFileId: y.id, number: 1 },
				{ imageFileId: z.id, number: 99 },
				{ imageFileId: w.id, number: 0 },
				// The same file again is the same picture.
				{ imageFileId: x.id, number: 3 },
			],
		});

		expect(numbers(index)).toEqual([
			[1, x.id],
			[2, "a"],
			[3, y.id],
			[4, z.id],
			[5, w.id],
		]);
	});

	it("leaves out a ref the person can no longer read, and goes on", async () => {
		const mine = await storeFile();
		const { storeImageFile } = await import("./files");
		const theirs = await storeImageFile({
			userId: otherUserId,
			conversationId: "conv-other",
			role: "take",
			png: await png("#aa0000"),
		});

		const index = await resolve({
			pictureRefs: [
				{ imageFileId: theirs.id, number: 1 },
				{ imageFileId: mine.id, number: 2 },
			],
		});

		expect(index.pictures.map((picture) => picture.source.type)).toEqual([
			"image_file",
		]);
		expect(numbers(index)).toEqual([[1, mine.id]]);
	});

	it("takes a document or someone else's item as no open picture", async () => {
		const index = await resolve({
			uploads: [upload("a")],
			openImageArtifactId: "not-an-item",
		});
		expect(numbers(index)).toEqual([[1, "a"]]);
		expect(index.metadata).toBeNull();
	});
});

describe("uploadNumberOf", () => {
	it("answers an upload's number and refuses one the turn does not hold", async () => {
		const { uploadNumberOf } = await import("./turn-pictures");
		const x = await storeFile();
		const index = await resolve({
			uploads: [upload("a")],
			pictureRefs: [{ imageFileId: x.id, number: 1 }],
		});
		expect(uploadNumberOf(index)("a")).toBe(2);
		expect(() => uploadNumberOf(index)("nope")).toThrow(/no picture number/);
	});
});

describe("extraPicturesOf", () => {
	it("keys each stored picture image-file:<fileId> and reads it through the person's scope", async () => {
		const { extraPicturesOf } = await import("./turn-pictures");
		const x = await storeFile();
		const index = await resolve({
			uploads: [upload("a")],
			pictureRefs: [{ imageFileId: x.id, number: 1 }],
		});

		const extras = extraPicturesOf(index, { userId, conversationId });

		expect(extras.map(({ number, id }) => [number, id])).toEqual([
			[1, `image-file:${x.id}`],
		]);
		const prepared = await extras[0].load();
		expect(prepared.mediaType).toBe("image/jpeg");
		// Another person's scope reads nothing.
		const foreign = extraPicturesOf(index, {
			userId: otherUserId,
			conversationId,
		});
		await expect(foreign[0].load()).rejects.toThrow();
	});
});

describe("keepReadableRecordedPictures", () => {
	async function keep(params: {
		refs: Array<{ imageFileId: string; number: number }>;
		marks: { imageFileId: string; marks: ImageMark[] } | null;
		openImageArtifactId: string | null;
	}) {
		const { keepReadableRecordedPictures } = await import("./turn-pictures");
		return keepReadableRecordedPictures({ userId, conversationId, ...params });
	}

	it("drops a recorded picture that is gone, never reading it, and keeps the rest", async () => {
		const kept = await storeFile();
		const out = await keep({
			refs: [
				{ imageFileId: "file-deleted", number: 1 },
				{ imageFileId: kept.id, number: 2 },
			],
			marks: null,
			openImageArtifactId: null,
		});
		expect(out).toEqual({
			pictureRefs: [{ imageFileId: kept.id, number: 2 }],
			imageMarks: null,
		});
	});

	it("keeps marks on a surviving ref or on the picture open now, and drops them otherwise", async () => {
		const ref = await storeFile();
		const open = await imageItem("Cosy living room");
		const marks = (imageFileId: string) => ({ imageFileId, marks: [MARK_A] });

		expect(
			(
				await keep({
					refs: [{ imageFileId: ref.id, number: 1 }],
					marks: marks(ref.id),
					openImageArtifactId: null,
				})
			).imageMarks,
		).toEqual(marks(ref.id));
		expect(
			(
				await keep({
					refs: [],
					marks: marks(open.file.id),
					openImageArtifactId: open.artifactId,
				})
			).imageMarks,
		).toEqual(marks(open.file.id));
		// The marked picture is no longer open (the panel shows nothing / another).
		expect(
			(
				await keep({
					refs: [],
					marks: marks(open.file.id),
					openImageArtifactId: null,
				})
			).imageMarks,
		).toBeNull();
		// The marked ref was deleted.
		expect(
			(
				await keep({
					refs: [{ imageFileId: "gone", number: 1 }],
					marks: marks("gone"),
					openImageArtifactId: null,
				})
			).imageMarks,
		).toBeNull();
	});
});

describe("validatePictureRequest", () => {
	async function validate(
		overrides: Partial<{
			conversationId: string;
			pictureRefs: Array<{ imageFileId: string; number: number }>;
			imageMarks: { imageFileId: string; marks: ImageMark[] } | null;
			openImageArtifactId: string | null;
			userId: string;
		}> = {},
	) {
		const { validatePictureRequest } = await import("./turn-pictures");
		return validatePictureRequest({
			userId,
			conversationId,
			pictureRefs: [],
			imageMarks: null,
			openImageArtifactId: null,
			...overrides,
		});
	}

	it("accepts the person's own pictures, however many", async () => {
		const files = await Promise.all(
			Array.from({ length: 12 }, () => storeFile()),
		);
		expect(
			await validate({
				pictureRefs: files.map((file, index) => ({
					imageFileId: file.id,
					number: index + 1,
				})),
			}),
		).toBeNull();
	});

	it("refuses another person's picture as not found, never reading it", async () => {
		const { storeImageFile } = await import("./files");
		const theirs = await storeImageFile({
			userId: otherUserId,
			conversationId: "conv-other",
			role: "take",
			png: await png("#aa0000"),
		});
		expect(
			await validate({ pictureRefs: [{ imageFileId: theirs.id, number: 1 }] }),
		).toEqual({
			status: 404,
			error: "Picture not found",
			code: "picture_not_found",
		});
		expect(
			await validate({
				pictureRefs: [{ imageFileId: "no-such-file", number: 1 }],
			}),
		).toMatchObject({ status: 404 });
	});

	it("refuses a picture of an incognito chat that is not this one, and takes it in that chat", async () => {
		const hidden = await storeFile({ conversationId: incognitoId });
		const refs = [{ imageFileId: hidden.id, number: 1 }];
		expect(await validate({ pictureRefs: refs })).toMatchObject({
			status: 404,
		});
		expect(
			await validate({ pictureRefs: refs, conversationId: incognitoId }),
		).toBeNull();
	});

	it("refuses marks on a file that is neither the open picture nor an attached one", async () => {
		const x = await storeFile();
		const open = await imageItem("Cosy living room");
		const stray = await storeFile();
		const marks = (imageFileId: string) => ({ imageFileId, marks: [MARK_A] });

		expect(
			await validate({
				pictureRefs: [{ imageFileId: x.id, number: 1 }],
				imageMarks: marks(stray.id),
				openImageArtifactId: open.artifactId,
			}),
		).toEqual({
			status: 400,
			error: "Marks must be on the open picture or an attached one",
			code: "invalid_image_marks",
		});
		expect(
			await validate({
				pictureRefs: [{ imageFileId: x.id, number: 1 }],
				imageMarks: marks(x.id),
			}),
		).toBeNull();
		expect(
			await validate({
				imageMarks: marks(open.file.id),
				openImageArtifactId: open.artifactId,
			}),
		).toBeNull();
	});
});

// Fix round 1: the composer's numbers (components/chat/composer-pictures.ts) and
// the server's are one rule written twice. The same adds and removes go through
// both, and the numbers each gives a picture must be equal.
describe("composer and server number pictures alike", () => {
	type Add =
		| { kind: "upload"; id: string; mime: string }
		| { kind: "ref"; fileId: string };

	async function bothNumberings(
		adds: Add[],
		removeKeys: string[],
		duplicateUploadIds: string[] = [],
	) {
		const composer = await import("$lib/components/chat/composer-pictures");
		const { getFileType } = await import(
			"$lib/components/chat/attachment-file-type"
		);
		const keyOf = (add: Add) =>
			add.kind === "upload"
				? composer.pictureKey({ kind: "upload", artifactId: add.id })
				: composer.pictureKey({ kind: "ref", imageFileId: add.fileId });
		const isPictureUpload = (add: Add) =>
			add.kind === "upload" && getFileType(add.mime, `${add.id}`) === "image";
		// The composer sees each add land, then the removes.
		let order: readonly string[] = [];
		let present: Add[] = [];
		for (const add of adds) {
			present = [...present, add];
			order = composer.reconcilePictureOrder(
				order,
				present
					.filter((a) => a.kind === "ref" || isPictureUpload(a))
					.map(keyOf),
			);
		}
		present = present.filter((add) => !removeKeys.includes(keyOf(add)));
		order = composer.reconcilePictureOrder(
			order,
			present.filter((a) => a.kind === "ref" || isPictureUpload(a)).map(keyOf),
		);
		const composerNumbers = composer.numberPictures(order, () => true);

		// The server gets the refs under the composer's numbers, and the image
		// uploads in attachment order (a duplicate id is sent twice).
		const uploads = present
			.filter(isPictureUpload)
			.flatMap((add) =>
				add.kind === "upload" && duplicateUploadIds.includes(add.id)
					? [add, add]
					: [add],
			)
			.map((add) => upload((add as { id: string }).id));
		const refs = present
			.filter((add): add is Extract<Add, { kind: "ref" }> => add.kind === "ref")
			.map((add) => ({
				imageFileId: add.fileId,
				number: composerNumbers.get(keyOf(add)) as number,
			}));
		const index = await resolve({ uploads, pictureRefs: refs });
		const serverNumbers = new Map<string, number>();
		for (const picture of index.pictures) {
			if (picture.source.type === "upload") {
				serverNumbers.set(
					composer.pictureKey({
						kind: "upload",
						artifactId: picture.source.artifactId,
					}),
					picture.number,
				);
			} else if (picture.source.type === "image_file") {
				serverNumbers.set(
					composer.pictureKey({
						kind: "ref",
						imageFileId: picture.source.fileId,
					}),
					picture.number,
				);
			}
		}
		return { composerNumbers, serverNumbers };
	}

	it("agrees for a [pdf, jpg] message: the jpg is 1", async () => {
		const { composerNumbers, serverNumbers } = await bothNumberings(
			[
				{ kind: "upload", id: "doc-pdf", mime: "application/pdf" },
				{ kind: "upload", id: "photo-jpg", mime: "image/jpeg" },
			],
			[],
		);
		expect(composerNumbers.get("upload:photo-jpg")).toBe(1);
		expect(serverNumbers).toEqual(composerNumbers);
	});

	it("agrees when an artifact id is sent twice", async () => {
		const x = await storeFile();
		const { composerNumbers, serverNumbers } = await bothNumberings(
			[
				{ kind: "upload", id: "photo-a", mime: "image/jpeg" },
				{ kind: "ref", fileId: x.id },
				{ kind: "upload", id: "photo-b", mime: "image/png" },
			],
			[],
			["photo-a"],
		);
		expect(serverNumbers).toEqual(composerNumbers);
		expect(composerNumbers.size).toBe(3);
	});

	it("agrees after a remove in the middle, whichever kind was added first", async () => {
		const x = await storeFile();
		const y = await storeFile({ color: "#aa5533" });
		for (const adds of [
			[
				{ kind: "upload", id: "p1", mime: "image/jpeg" },
				{ kind: "ref", fileId: x.id },
				{ kind: "upload", id: "p2", mime: "image/jpeg" },
				{ kind: "ref", fileId: y.id },
			] as Add[],
			[
				{ kind: "ref", fileId: x.id },
				{ kind: "upload", id: "p1", mime: "image/jpeg" },
				{ kind: "ref", fileId: y.id },
				{ kind: "upload", id: "p2", mime: "image/jpeg" },
			] as Add[],
		]) {
			const { composerNumbers, serverNumbers } = await bothNumberings(adds, [
				`upload:p1`,
			]);
			expect([...composerNumbers.values()].sort()).toEqual([1, 2, 3]);
			expect(serverNumbers).toEqual(composerNumbers);
		}
	});
});
