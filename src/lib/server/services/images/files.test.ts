// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;
let workdir: string;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const files = await import("./files");

async function png(width: number, height: number, alpha = false) {
	const buffer = await sharp({
		create: {
			width,
			height,
			channels: alpha ? 4 : 3,
			background: alpha
				? { r: 10, g: 20, b: 30, alpha: 0.5 }
				: { r: 10, g: 20, b: 30 },
		},
	})
		.png()
		.toBuffer();
	return new Uint8Array(buffer);
}

/**
 * A picture past the display edge with enough detail that the test is about
 * real pixels: smooth colour fields, a little grain, and (with `alpha`) a
 * fully clear band and a half-clear one, so "alpha is kept where the original
 * had it" means something. Deterministic: the identity bar must not depend on
 * a random draw.
 */
async function photoPng(
	width = 2048,
	height = 1536,
	alpha = false,
): Promise<Uint8Array> {
	const channels = alpha ? 4 : 3;
	const data = Buffer.alloc(width * height * channels);
	let state = 123456789;
	const random = () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * channels;
			const grain = (random() - 0.5) * 6;
			const wave = Math.sin(x / 97) + Math.cos(y / 113);
			data[at] = clamp(128 + wave * 40 + grain);
			data[at + 1] = clamp(120 + Math.cos(x / 151) * 50 + grain);
			data[at + 2] = clamp(140 + Math.sin(y / 89) * 45 + grain);
			if (channels === 4) {
				// A clear band and a half-clear band across the picture.
				const share = x / width;
				data[at + 3] = share < 0.1 ? 0 : share < 0.3 ? 128 : 255;
			}
		}
	}
	return new Uint8Array(
		await sharp(data, { raw: { width, height, channels } }).png().toBuffer(),
	);
}

function clamp(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

/** Peak signal-to-noise ratio over every channel, in dB; Infinity for identical pixels. */
function psnr(a: Buffer, b: Buffer): number {
	let sum = 0;
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const difference = a[index] - b[index];
		sum += difference * difference;
	}
	const mse = sum / length;
	return mse === 0
		? Number.POSITIVE_INFINITY
		: 10 * Math.log10((255 * 255) / mse);
}

/** The stored original at the display copy's size, through the same kernel the store used (sharp's lanczos3). */
async function referenceAtDisplaySize(
	original: Uint8Array,
	display: Uint8Array,
): Promise<{ data: Buffer; width: number; height: number }> {
	const meta = await sharp(display).metadata();
	const { data, info } = await sharp(original)
		.resize({
			width: meta.width,
			height: meta.height,
			fit: "inside",
			withoutEnlargement: true,
		})
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

beforeEach(async () => {
	memory = createInMemoryDatabase();
	workdir = await mkdtemp(join(tmpdir(), "image-files-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	seedUser(memory, "u1");
	seedUser(memory, "u2");
	seedConversation(memory, { id: "c1", userId: "u1" });
	seedConversation(memory, { id: "c2", userId: "u1" });
	seedConversation(memory, { id: "inc", userId: "u1", memoryIncognito: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	memory.close();
	await rm(workdir, { recursive: true, force: true });
});

function onDisk(conversationId: string): string[] {
	const dir = join(workdir, "data", "image-files", conversationId);
	return existsSync(dir) ? ["exists"] : [];
}

describe("storeImageFile", () => {
	it("writes the picture and its thumbnail and one row", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(1000, 500),
		});
		expect(file).toMatchObject({
			userId: "u1",
			conversationId: "c1",
			artifactId: null,
			role: "take",
			width: 1000,
			height: 500,
			hasAlpha: false,
		});
		const dir = join(workdir, "data", "image-files", "c1");
		expect((await readdir(dir)).sort()).toEqual(
			[`${file.id}.png`, `${file.id}.thumb.png`].sort(),
		);
		const thumb = await files.readImageFileBytes(file, "thumb");
		const meta = await sharp(thumb).metadata();
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
			files.IMAGE_THUMB_LONG_EDGE,
		);
		const full = await files.readImageFileBytes(file, "full");
		expect(full.byteLength).toBe(file.sizeBytes);
		const rows = memory.db.select().from(schema.imageFiles).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.storagePath).toBe(`data/image-files/c1/${file.id}.png`);
	});

	it("marks an RGBA picture as having alpha", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "input",
			png: await png(64, 64, true),
		});
		expect(file.hasAlpha).toBe(true);
	});

	it("does not call a fully opaque RGBA picture see-through (an edit is stored as RGBA)", async () => {
		const opaque = new Uint8Array(
			await sharp({
				create: {
					width: 64,
					height: 64,
					channels: 4,
					background: { r: 10, g: 20, b: 30, alpha: 1 },
				},
			})
				.png()
				.toBuffer(),
		);
		expect((await sharp(opaque).metadata()).hasAlpha).toBe(true);
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: opaque,
		});
		expect(file.hasAlpha).toBe(false);
	});

	it("stores an opaque RGBA picture as RGB with no alpha channel", async () => {
		const opaque = new Uint8Array(
			await sharp({
				create: {
					width: 64,
					height: 64,
					channels: 4,
					background: { r: 10, g: 20, b: 30, alpha: 1 },
				},
			})
				.png()
				.toBuffer(),
		);
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: opaque,
		});
		const stored = await sharp(
			await files.readImageFileBytes(file, "full"),
		).metadata();
		expect(stored.channels).toBe(3);
		expect(stored.hasAlpha).toBe(false);
	});

	it("treats alpha that rounding left at 254 as opaque", async () => {
		const width = 32;
		const height = 32;
		const data = Buffer.alloc(width * height * 4, 200);
		for (let i = 3; i < data.length; i += 4) data[i] = 254;
		const rounded = new Uint8Array(
			await sharp(data, { raw: { width, height, channels: 4 } })
				.png()
				.toBuffer(),
		);
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: rounded,
		});
		expect(file.hasAlpha).toBe(false);
		const stored = await sharp(
			await files.readImageFileBytes(file, "full"),
		).metadata();
		expect(stored.channels).toBe(3);
	});

	it("keeps the alpha of a picture with truly transparent pixels", async () => {
		const width = 32;
		const height = 32;
		const data = Buffer.alloc(width * height * 4, 200);
		for (let i = 3; i < data.length; i += 4) data[i] = 255;
		for (let i = 0; i < 100; i++) data[i * 4 + 3] = 0;
		const cutout = new Uint8Array(
			await sharp(data, { raw: { width, height, channels: 4 } })
				.png()
				.toBuffer(),
		);
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: cutout,
		});
		expect(file.hasAlpha).toBe(true);
		const stored = await sharp(
			await files.readImageFileBytes(file, "full"),
		).metadata();
		expect(stored.channels).toBe(4);
	});

	it("refuses bytes that are not a PNG", async () => {
		const jpeg = new Uint8Array(
			await sharp({
				create: { width: 8, height: 8, channels: 3, background: "#fff" },
			})
				.jpeg()
				.toBuffer(),
		);
		await expect(
			files.storeImageFile({
				userId: "u1",
				conversationId: "c1",
				role: "take",
				png: jpeg,
			}),
		).rejects.toThrow();
		expect(onDisk("c1")).toEqual([]);
		expect(memory.db.select().from(schema.imageFiles).all()).toHaveLength(0);
	});

	it("leaves no file behind when the chat is gone", async () => {
		await expect(
			files.storeImageFile({
				userId: "u1",
				conversationId: "gone",
				role: "take",
				png: await png(32, 32),
			}),
		).rejects.toThrow();
		const dir = join(workdir, "data", "image-files", "gone");
		const left = existsSync(dir) ? await readdir(dir) : [];
		expect(left).toEqual([]);
		expect(memory.db.select().from(schema.imageFiles).all()).toHaveLength(0);
	});

	it("leaves no file behind when the row insert fails", async () => {
		// Delete the chat between the ownership check and the insert.
		const original = memory.db.insert.bind(memory.db);
		vi.spyOn(memory.db, "insert").mockImplementation(((table: never) => {
			memory.db.delete(schema.conversations).run();
			return original(table);
		}) as never);
		await expect(
			files.storeImageFile({
				userId: "u1",
				conversationId: "c1",
				role: "take",
				png: await png(32, 32),
			}),
		).rejects.toThrow();
		const dir = join(workdir, "data", "image-files", "c1");
		const left = existsSync(dir) ? await readdir(dir) : [];
		expect(left).toEqual([]);
	});

	it("refuses another person's chat", async () => {
		await expect(
			files.storeImageFile({
				userId: "u2",
				conversationId: "c1",
				role: "take",
				png: await png(32, 32),
			}),
		).rejects.toThrow();
		expect(onDisk("c1")).toEqual([]);
	});
});

describe("the display copy", () => {
	it("is written at store time for a picture past the display edge, on the long edge, without alpha", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await photoPng(),
		});
		const dir = join(workdir, "data", "image-files", "c1");
		expect((await readdir(dir)).sort()).toEqual(
			[
				`${file.id}.png`,
				`${file.id}.thumb.png`,
				`${file.id}.display.webp`,
			].sort(),
		);
		const display = await files.readImageDisplayBytes(file);
		expect(display).not.toBeNull();
		const meta = await sharp(display as Uint8Array).metadata();
		expect(meta.format).toBe("webp");
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(
			files.IMAGE_DISPLAY_LONG_EDGE,
		);
		expect(meta.hasAlpha).toBe(false);
		expect((display as Uint8Array).byteLength).toBeLessThan(file.sizeBytes);
	});

	it("is not written for a picture whose long edge is already within the display edge", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(1500, 900),
		});
		const dir = join(workdir, "data", "image-files", "c1");
		expect((await readdir(dir)).sort()).toEqual(
			[`${file.id}.png`, `${file.id}.thumb.png`].sort(),
		);
		// Its original IS its display copy.
		expect(await files.readImageDisplayBytes(file)).toBeNull();
	});

	it.each([
		["an opaque picture", false],
		["a transparent picture", true],
	])(
		"is perceptually identical to %s",
		async (_label, alpha) => {
			const source = await photoPng(2048, 1536, alpha);
			const file = await files.storeImageFile({
				userId: "u1",
				conversationId: "c1",
				role: "take",
				png: source,
				mayBeSeeThrough: alpha,
			});
			expect(file.hasAlpha).toBe(alpha);
			const display = await files.readImageDisplayBytes(file);
			expect(display).not.toBeNull();
			const original = await files.readImageFileBytes(file, "full");
			const reference = await referenceAtDisplaySize(
				original,
				display as Uint8Array,
			);
			const decoded = await sharp(display as Uint8Array)
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			expect(decoded.info.width).toBe(reference.width);
			expect(decoded.info.height).toBe(reference.height);
			expect(decoded.info.channels).toBe(4);
			expect(psnr(decoded.data, reference.data)).toBeGreaterThanOrEqual(40);

			if (alpha) {
				// The clear band stays clear and the opaque rest stays opaque: the
				// checkerboard must not be lost.
				const alphaAt = (fraction: number) =>
					decoded.data[
						(Math.floor(decoded.info.height / 2) * decoded.info.width +
							Math.floor(decoded.info.width * fraction)) *
							4 +
							3
					];
				expect(alphaAt(0.05)).toBe(0);
				expect(alphaAt(0.2)).toBe(128);
				expect(alphaAt(0.6)).toBe(255);
			} else {
				const alphaMinimum = Math.min(
					...Array.from({ length: 4096 }, (_, index) => {
						const at =
							Math.floor(
								(index / 4096) * (decoded.info.width * decoded.info.height),
							) *
								4 +
							3;
						return decoded.data[at] as number;
					}),
				);
				expect(alphaMinimum).toBe(255);
			}
		},
		30_000,
	);

	it("is made from the full PNG on first request for a picture stored before display copies, and kept", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await photoPng(),
		});
		const displayPath = join(
			workdir,
			"data",
			"image-files",
			"c1",
			`${file.id}.display.webp`,
		);
		await unlink(displayPath);
		expect(existsSync(displayPath)).toBe(false);
		const display = await files.readImageDisplayBytes(file);
		expect(display).not.toBeNull();
		expect(existsSync(displayPath)).toBe(true);
		expect(
			await readFile(displayPath).then((bytes) =>
				bytes.subarray(0, 4).toString(),
			),
		).toBe("RIFF");
		expect((await sharp(await readFile(displayPath)).metadata()).format).toBe(
			"webp",
		);
	});

	it("shares one generation between two concurrent requests for the same picture", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await photoPng(),
		});
		await unlink(
			join(workdir, "data", "image-files", "c1", `${file.id}.display.webp`),
		);
		const [first, second] = await Promise.all([
			files.readImageDisplayBytes(file),
			files.readImageDisplayBytes(file),
		]);
		// One promise: both callers hold the same bytes, not two generations.
		expect(first).toBe(second);
	});

	it("goes with the picture when the picture is discarded", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await photoPng(),
		});
		const dir = join(workdir, "data", "image-files", "c1");
		expect((await readdir(dir)).length).toBe(3);
		await files.discardStoredImageFile(file);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("getImageFile", () => {
	it("gives null to another user", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		expect(await files.getImageFile({ userId: "u2", fileId: file.id })).toBe(
			null,
		);
		expect(
			(await files.getImageFile({ userId: "u1", fileId: file.id }))?.id,
		).toBe(file.id);
		expect(await files.getImageFile({ userId: "u1", fileId: "nope" })).toBe(
			null,
		);
	});

	it("shows an incognito chat's file only to the request that names the chat", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "inc",
			role: "take",
			png: await png(32, 32),
		});
		expect(await files.getImageFile({ userId: "u1", fileId: file.id })).toBe(
			null,
		);
		expect(
			await files.getImageFile({
				userId: "u1",
				fileId: file.id,
				conversationId: "c1",
			}),
		).toBe(null);
		expect(
			(
				await files.getImageFile({
					userId: "u1",
					fileId: file.id,
					conversationId: "inc",
				})
			)?.id,
		).toBe(file.id);
	});
});

describe("deleting", () => {
	it("never removes the pictures root for an id that is not one folder name", async () => {
		await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		for (const id of ["", ".", "..", "c1/..", "..\\c1", "a\0b"]) {
			await files.deleteImageFilesForConversation(id);
		}
		expect(onDisk("c1")).toEqual(["exists"]);
	});

	it("deleting a chat's files removes rows and folder", async () => {
		await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		const other = await files.storeImageFile({
			userId: "u1",
			conversationId: "c2",
			role: "take",
			png: await png(32, 32),
		});
		expect(await files.deleteImageFilesForConversation("c1")).toBe(1);
		expect(onDisk("c1")).toEqual([]);
		expect(onDisk("c2")).toEqual(["exists"]);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.all()
				.map((r) => r.id),
		).toEqual([other.id]);
	});

	it("deleting an item's files leaves the chat's other files", async () => {
		const mine = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		const rest = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "a1",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "Cat",
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await files.attachImageFilesToArtifact([mine.id], "a1");
		expect(await files.deleteImageFilesForArtifact("a1")).toBe(1);
		const left = await readdir(join(workdir, "data", "image-files", "c1"));
		expect(left.sort()).toEqual(
			[`${rest.id}.png`, `${rest.id}.thumb.png`].sort(),
		);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.all()
				.map((r) => r.id),
		).toEqual([rest.id]);
	});

	it("claims only unowned files of the item's own person and chat", async () => {
		seedConversation(memory, { id: "c9", userId: "u1" });
		const mk = (id: string) =>
			memory.db
				.insert(schema.artifacts)
				.values({
					id,
					userId: "u1",
					conversationId: "c1",
					type: "artifact",
					name: id,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.run();
		mk("a1");
		mk("a2");
		const store = async (conversationId: string) =>
			files.storeImageFile({
				userId: "u1",
				conversationId,
				role: "take",
				png: await png(32, 32),
			});
		const free = await store("c1");
		const other = await store("c1");
		const elsewhere = await store("c9");
		await files.attachImageFilesToArtifact([other.id], "a1");
		await files.attachImageFilesToArtifact(
			[free.id, other.id, elsewhere.id],
			"a2",
		);
		const owner = (id: string) =>
			memory.db
				.select()
				.from(schema.imageFiles)
				.all()
				.find((row) => row.id === id)?.artifactId;
		expect(owner(free.id)).toBe("a2");
		expect(owner(other.id)).toBe("a1");
		expect(owner(elsewhere.id)).toBeNull();
		// Claiming again for its own item is fine.
		await files.attachImageFilesToArtifact([free.id], "a2");
		expect(owner(free.id)).toBe("a2");
	});

	it("deleting a person's files removes theirs only", async () => {
		seedConversation(memory, { id: "c3", userId: "u2" });
		await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		await files.storeImageFile({
			userId: "u2",
			conversationId: "c3",
			role: "take",
			png: await png(32, 32),
		});
		expect(await files.deleteImageFilesForUser("u1")).toBe(1);
		expect(onDisk("c1")).toEqual([]);
		expect(onDisk("c3")).toEqual(["exists"]);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.where(eq(schema.imageFiles.userId, "u2"))
				.all(),
		).toHaveLength(1);
	});
});

describe("imageFileDownloadName", () => {
	it("is the item's title, else picture.png", async () => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(32, 32),
		});
		expect(await files.imageFileDownloadName(file)).toBe("picture.png");
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "a1",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "ignored",
				metadataJson: JSON.stringify({
					artifactType: "image",
					title: "Red / fox",
				}),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await files.attachImageFilesToArtifact([file.id], "a1");
		const attached = await files.getImageFile({
			userId: "u1",
			fileId: file.id,
		});
		expect(attached?.artifactId).toBe("a1");
		expect(await files.imageFileDownloadName(attached as never)).toBe(
			"Red - fox.png",
		);
	});

	// Task 17 (rehearsal): a title that is a sentence ("…living room.") or that
	// already names the type is saved through the shared download-name rule, so
	// never "room..png" and never "Sunset.png.png".
	it.each([
		[
			"This is a photo of my living room.",
			"This is a photo of my living room.png",
		],
		["Sunset.png", "Sunset.png"],
		["Sunset.PNG", "Sunset.PNG"],
		["Notes. ", "Notes.png"],
		["v2.5 draft", "v2.5 draft.png"],
	])("saves %j as %j", async (title, expected) => {
		const file = await files.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: await png(8, 8),
		});
		const id = `a-${expected}`;
		memory.db
			.insert(schema.artifacts)
			.values({
				id,
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "ignored",
				metadataJson: JSON.stringify({ artifactType: "image", title }),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await files.attachImageFilesToArtifact([file.id], id);
		const attached = await files.getImageFile({
			userId: "u1",
			fileId: file.id,
		});
		expect(await files.imageFileDownloadName(attached as never)).toBe(expected);
	});
});
