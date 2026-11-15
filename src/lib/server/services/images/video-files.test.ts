// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

const videoFiles = await import("./video-files");
const pictures = await import("./files");

/** A minimal but real ISO-BMFF header: box length, `ftyp`, a brand, then payload. */
function mp4(byteLength = 4096): Uint8Array {
	const buffer = Buffer.alloc(byteLength);
	buffer.writeUInt32BE(byteLength, 0);
	buffer.write("ftypisom", 4, "latin1");
	buffer.writeUInt32BE(0x00000200, 12);
	for (let index = 16; index < byteLength; index++) {
		buffer[index] = (index * 37) % 251;
	}
	return new Uint8Array(buffer);
}

/** A frame: a deterministic PNG the size of the clip, with enough detail that resizing is a real resize. */
async function frame(width = 640, height = 360): Promise<Uint8Array> {
	const channels = 3;
	const data = Buffer.alloc(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * channels;
			data[at] = (x * 7 + y) % 256;
			data[at + 1] = (y * 11 + x * 3) % 256;
			data[at + 2] = Math.round(
				128 + 100 * Math.sin(x / 24) * Math.cos(y / 18),
			);
		}
	}
	return new Uint8Array(
		await sharp(data, { raw: { width, height, channels } }).png().toBuffer(),
	);
}

function hasWebpSignature(bytes: Uint8Array): boolean {
	const riff = [0x52, 0x49, 0x46, 0x46];
	const webp = [0x57, 0x45, 0x42, 0x50];
	return (
		bytes.byteLength >= 12 &&
		riff.every((byte, index) => bytes[index] === byte) &&
		webp.every((byte, index) => bytes[8 + index] === byte)
	);
}

function directory(conversationId: string): string {
	return join(workdir, "data", "image-files", conversationId);
}

async function listFiles(conversationId: string): Promise<string[]> {
	const dir = directory(conversationId);
	return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

beforeEach(async () => {
	memory = createInMemoryDatabase();
	workdir = await mkdtemp(join(tmpdir(), "video-files-"));
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

describe("storeVideoFile", () => {
	it("writes the clip, its poster and its thumbnail and one row, and keeps the duration on it", async () => {
		const bytes = mp4();
		const file = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: bytes,
			poster: await frame(),
			durationMs: 5000,
		});

		expect(file).toMatchObject({
			userId: "u1",
			conversationId: "c1",
			artifactId: null,
			role: "take",
			width: 640,
			height: 360,
			durationMs: 5000,
			sizeBytes: bytes.byteLength,
		});
		expect(file.storagePath).toBe(`data/image-files/c1/${file.id}.mp4`);
		expect(await listFiles("c1")).toEqual([
			`${file.id}.mp4`,
			`${file.id}.poster.webp`,
			`${file.id}.thumb.webp`,
		]);

		const rows = memory.db.select().from(schema.imageFiles).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.durationMs).toBe(5000);
	});

	it("reads the clip, the poster and the thumbnail back as their own formats", async () => {
		const bytes = mp4();
		const file = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: bytes,
			poster: await frame(1920, 1080),
			durationMs: 10000,
		});

		const clip = await videoFiles.readVideoFileBytes(file, "video");
		expect(clip).toEqual(bytes);

		const poster = await videoFiles.readVideoFileBytes(file, "poster");
		expect(hasWebpSignature(poster)).toBe(true);
		const posterMeta = await sharp(poster).metadata();
		expect(posterMeta.format).toBe("webp");
		expect(Math.max(posterMeta.width ?? 0, posterMeta.height ?? 0)).toBe(
			videoFiles.VIDEO_POSTER_LONG_EDGE,
		);

		const thumb = await videoFiles.readVideoFileBytes(file, "thumb");
		expect(hasWebpSignature(thumb)).toBe(true);
		const thumbMeta = await sharp(thumb).metadata();
		expect(
			Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0),
		).toBeLessThanOrEqual(pictures.IMAGE_THUMB_LONG_EDGE);
	});

	it("refuses anything that is not an MP4 the way the picture store refuses a non-PNG", async () => {
		for (const notMp4 of [
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			new Uint8Array(0),
			new Uint8Array(16),
		]) {
			await expect(
				videoFiles.storeVideoFile({
					userId: "u1",
					conversationId: "c1",
					role: "take",
					mp4: notMp4,
					poster: await frame(),
					durationMs: 5000,
				}),
			).rejects.toThrow(/MP4/);
		}
		expect(await listFiles("c1")).toEqual([]);
		expect(memory.db.select().from(schema.imageFiles).all()).toHaveLength(0);
	});

	it("refuses a chat the person does not own, and stores in an incognito chat of their own", async () => {
		seedConversation(memory, { id: "theirs", userId: "u2" });
		await expect(
			videoFiles.storeVideoFile({
				userId: "u1",
				conversationId: "theirs",
				role: "take",
				mp4: mp4(),
				poster: await frame(),
				durationMs: 5000,
			}),
		).rejects.toThrow(/chat for this video is gone/);

		const secret = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "inc",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});
		expect(secret.conversationId).toBe("inc");
	});

	it("runs the caller's explicit-picture check on the poster exactly as it will be stored", async () => {
		const seen: { bytes: Uint8Array; width: number; height: number }[] = [];
		let filesDuringCheck: string[] = [];
		const file = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
			checkPoster: async (input) => {
				seen.push(input);
				filesDuringCheck = await listFiles("c1");
				return "shown";
			},
		});
		expect(seen).toHaveLength(1);
		expect(hasWebpSignature(seen[0]?.bytes ?? new Uint8Array())).toBe(true);
		expect(seen[0]?.width).toBe(640);
		expect(seen[0]?.height).toBe(360);
		// The check runs before anything is written, so a refusal leaves no files.
		expect(filesDuringCheck).toEqual([]);
		expect(await listFiles("c1")).toHaveLength(3);
		expect(file.id).toBeTruthy();
	});

	it("stores nothing when the poster check is blocked or cannot run", async () => {
		for (const verdict of ["blocked", "unchecked"] as const) {
			const error = await videoFiles
				.storeVideoFile({
					userId: "u1",
					conversationId: "c1",
					role: "take",
					mp4: mp4(),
					poster: await frame(),
					durationMs: 5000,
					checkPoster: async () => verdict,
				})
				.then(
					() => null,
					(thrown: unknown) => thrown,
				);
			expect(error).toBeInstanceOf(videoFiles.VideoPosterRefusedError);
			expect(error).toMatchObject({ verdict });
		}
		expect(await listFiles("c1")).toEqual([]);
		expect(memory.db.select().from(schema.imageFiles).all()).toHaveLength(0);
	});
});

describe("getVideoFile and picture rows", () => {
	it("answers the video behind a file the caller already read", async () => {
		const stored = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});
		const read = await pictures.getImageFile({
			userId: "u1",
			fileId: stored.id,
		});
		expect(read).not.toBeNull();
		const video = await videoFiles.getVideoFile(read as never);
		expect(video).toMatchObject({
			id: stored.id,
			durationMs: 5000,
			storagePath: `data/image-files/c1/${stored.id}.mp4`,
		});
	});

	it("answers null for a picture row, so a picture is still a picture", async () => {
		const png = await sharp({
			create: { width: 20, height: 10, channels: 3, background: "#123456" },
		})
			.png()
			.toBuffer();
		const picture = await pictures.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: new Uint8Array(png),
		});
		expect(await videoFiles.getVideoFile(picture)).toBeNull();
	});
});

describe("video file cleanup", () => {
	it("discards the clip, poster, thumbnail and row even when the row is already gone", async () => {
		const stored = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});
		memory.db
			.delete(schema.imageFiles)
			.where(eq(schema.imageFiles.id, stored.id))
			.run();
		await videoFiles.discardStoredVideoFile(stored);
		expect(await listFiles("c1")).toEqual([]);
	});

	it("deletes every video of a chat by id and leaves the other chat's files alone", async () => {
		const kept = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c2",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});
		const first = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});
		const second = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});

		await videoFiles.deleteVideoFilesById([first.id, second.id]);

		expect(await listFiles("c1")).toEqual([]);
		expect(await listFiles("c2")).toEqual([
			`${kept.id}.mp4`,
			`${kept.id}.poster.webp`,
			`${kept.id}.thumb.webp`,
		]);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.where(eq(schema.imageFiles.conversationId, "c1"))
				.all(),
		).toHaveLength(0);
	});

	it("deletes a chat's videos with their side files, and no picture row it does not own", async () => {
		const png = await sharp({
			create: { width: 20, height: 10, channels: 3, background: "#123456" },
		})
			.png()
			.toBuffer();
		const picture = await pictures.storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: new Uint8Array(png),
		});
		const video = await videoFiles.storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: mp4(),
			poster: await frame(),
			durationMs: 5000,
		});

		const deleted = await videoFiles.deleteVideoFilesForConversation("c1");

		expect(deleted).toBe(1);
		expect(await listFiles("c1")).toEqual([
			`${picture.id}.png`,
			`${picture.id}.thumb.png`,
		]);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.where(eq(schema.imageFiles.id, video.id))
				.all(),
		).toHaveLength(0);
		expect(
			memory.db
				.select()
				.from(schema.imageFiles)
				.where(eq(schema.imageFiles.id, picture.id))
				.all(),
		).toHaveLength(1);
	});
});
