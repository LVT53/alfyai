// @vitest-environment node
//
// The pictures a take is made from: a real migrated database, picture files in
// a temp working directory. The upload lookup is the one faked thing.

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
import { warmModules } from "$lib/server/testing/warm-modules";
import { MARK_COLOURS } from "$lib/shared/artifacts/image-body";
import { createImageFixture, type ImageFixture } from "./testing/fixture";
import type { TurnPictureSource } from "./turn-pictures";

const userId = "user-1";
const conversationId = "conv-1";

let fixture: ImageFixture;
let workdir: string;
const uploads = new Map<string, { storagePath: string; mimeType: string }>();

beforeAll(async () => {
	await warmModules([() => import("./inputs"), () => import("./files")]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-inputs");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "image-inputs-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	uploads.clear();
	vi.resetModules();
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

async function storeFile(width: number, height: number, color = "#808080") {
	const { storeImageFile } = await import("./files");
	return storeImageFile({
		userId,
		conversationId,
		role: "take",
		png: new Uint8Array(
			await sharp({
				create: { width, height, channels: 3, background: color },
			})
				.png()
				.toBuffer(),
		),
	});
}

function fileSource(fileId: string, name = "A picture"): TurnPictureSource {
	return {
		type: "image_file",
		fileId,
		name,
		artifactId: null,
		role: "attached",
	};
}

async function bytesOf(fileId: string): Promise<Uint8Array> {
	const { getImageFile, readImageFileBytes } = await import("./files");
	const file = await getImageFile({ userId, fileId, conversationId });
	if (!file) throw new Error("no such file");
	return readImageFileBytes(file, "full");
}

describe("the base", () => {
	it("turns an uploaded 4032x3024 JPEG into a 1184x896 PNG", async () => {
		const artifactId = randomUUID();
		const storagePath = join("data", "uploads", `${artifactId}.jpg`);
		await mkdir(dirname(join(workdir, storagePath)), { recursive: true });
		await writeFile(
			join(workdir, storagePath),
			await sharp({
				create: {
					width: 4032,
					height: 3024,
					channels: 3,
					background: "#aa6633",
				},
			})
				.jpeg()
				.toBuffer(),
		);
		uploads.set(artifactId, { storagePath, mimeType: "image/jpeg" });
		const { prepareTakeInputs } = await import("./inputs");

		const inputs = await prepareTakeInputs({
			userId,
			conversationId,
			base: {
				type: "upload",
				artifactId,
				name: "rug.jpg",
				mimeType: "image/jpeg",
			},
			references: [],
			marked: null,
			canvas: { width: 1184, height: 896 },
		});

		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toMatchObject({ role: "base", name: "rug.jpg" });
		const meta = await sharp(await bytesOf(inputs[0]?.fileId ?? "")).metadata();
		expect(meta).toMatchObject({ format: "png", width: 1184, height: 896 });
	});

	it("reuses a stored picture that is already the canvas size", async () => {
		const file = await storeFile(1248, 832);
		const { prepareTakeInputs } = await import("./inputs");
		const inputs = await prepareTakeInputs({
			userId,
			conversationId,
			base: fileSource(file.id),
			references: [],
			marked: null,
			canvas: { width: 1248, height: 832 },
		});
		expect(inputs).toEqual([
			{ fileId: file.id, role: "base", name: "A picture" },
		]);
	});

	it("says in one sentence that an upload it cannot find is unreadable", async () => {
		const { prepareTakeInputs, PictureUnreadableError } = await import(
			"./inputs"
		);
		await expect(
			prepareTakeInputs({
				userId,
				conversationId,
				base: {
					type: "upload",
					artifactId: "gone",
					name: "rug.jpg",
					mimeType: "image/jpeg",
				},
				references: [],
				marked: null,
				canvas: { width: 1184, height: 896 },
			}),
		).rejects.toBeInstanceOf(PictureUnreadableError);
	});
});

describe("a reference", () => {
	it("is resized to about one megapixel in its own shape", async () => {
		const big = await storeFile(2000, 1000);
		const { prepareTakeInputs } = await import("./inputs");
		const inputs = await prepareTakeInputs({
			userId,
			conversationId,
			base: null,
			references: [fileSource(big.id, "wide.png")],
			marked: null,
			canvas: { width: 1248, height: 832 },
		});
		expect(inputs[0]).toMatchObject({ role: "reference", name: "wide.png" });
		expect(inputs[0]?.fileId).not.toBe(big.id);
		const meta = await sharp(await bytesOf(inputs[0]?.fileId ?? "")).metadata();
		const area = (meta.width ?? 0) * (meta.height ?? 0);
		expect(Math.abs(area - 1_048_576) / 1_048_576).toBeLessThan(0.01);
		expect(Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 2)).toBeLessThan(
			0.01,
		);
	});

	it("is not enlarged when it is already smaller", async () => {
		const small = await storeFile(600, 400);
		const { prepareTakeInputs } = await import("./inputs");
		const inputs = await prepareTakeInputs({
			userId,
			conversationId,
			base: null,
			references: [fileSource(small.id)],
			marked: null,
			canvas: { width: 1248, height: 832 },
		});
		expect(inputs[0]?.fileId).toBe(small.id);
	});
});

describe("the marked copy", () => {
	it("is painted again on the canvas-sized base, boxes where they were drawn", async () => {
		const base = await storeFile(640, 480);
		const copy = await storeFile(640, 480);
		const { prepareTakeInputs } = await import("./inputs");
		const inputs = await prepareTakeInputs({
			userId,
			conversationId,
			base: fileSource(base.id),
			references: [],
			marked: {
				source: fileSource(
					copy.id,
					"Picture 1 with the user's marks: A = red box",
				),
				marks: [{ letter: "A", x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
			},
			canvas: { width: 1184, height: 896 },
		});

		expect(inputs.map((input) => input.role)).toEqual(["base", "marked"]);
		const marked = inputs[1];
		const { data, info } = await sharp(await bytesOf(marked?.fileId ?? ""))
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect([info.width, info.height]).toEqual([1184, 896]);
		const at = (x: number, y: number) => {
			const offset = (y * info.width + x) * 3;
			return [data[offset], data[offset + 1], data[offset + 2]];
		};
		// Far from the box the base is untouched; on the box's left edge the stroke is the mark's colour.
		expect(at(20, 20)).toEqual([128, 128, 128]);
		const hex = MARK_COLOURS.A.replace("#", "");
		const colour = [0, 2, 4].map((i) =>
			Number.parseInt(hex.slice(i, i + 2), 16),
		);
		const edgeX = Math.round(0.25 * 1184);
		const onEdge = [-4, -2, 0, 2, 4].some((dx) =>
			at(edgeX + dx, 448).every(
				(value, i) => Math.abs((value ?? 0) - (colour[i] ?? 0)) < 6,
			),
		);
		expect(onEdge).toBe(true);
	});
});
