// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const { storeImageFile, attachImageFilesToArtifact } = await import(
	"$lib/server/services/images/files"
);
const { GET } = await import("./+server");

function event(params: {
	fileId: string;
	userId: string | null;
	query?: string;
}) {
	return {
		params: { fileId: params.fileId },
		url: new URL(
			`http://localhost/api/images/files/${params.fileId}${params.query ?? ""}`,
		),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

async function status(call: Promise<Response>): Promise<Response | number> {
	try {
		return await call;
	} catch (error) {
		return (error as { status: number }).status;
	}
}

let fileId: string;

beforeEach(async () => {
	memory = createInMemoryDatabase();
	workdir = await mkdtemp(join(tmpdir(), "image-route-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	seedUser(memory, "u1");
	seedUser(memory, "u2");
	seedConversation(memory, { id: "c1", userId: "u1" });
	const png = await sharp({
		create: { width: 40, height: 20, channels: 3, background: "#123456" },
	})
		.png()
		.toBuffer();
	fileId = (
		await storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png: new Uint8Array(png),
		})
	).id;
});

afterEach(async () => {
	vi.restoreAllMocks();
	memory.close();
	await rm(workdir, { recursive: true, force: true });
});

async function storeLargePicture() {
	const png = await sharp({
		create: { width: 2048, height: 2048, channels: 3, background: "#336699" },
	})
		.png()
		.toBuffer();
	return storeImageFile({
		userId: "u1",
		conversationId: "c1",
		role: "take",
		png: new Uint8Array(png),
	});
}

describe("GET /api/images/files/[fileId]", () => {
	it("serves the PNG to its owner", async () => {
		const res = (await GET(event({ fileId, userId: "u1" }))) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Disposition")).toBeNull();
		const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
		expect(meta.width).toBe(40);
	});

	it("serves the thumbnail", async () => {
		const res = (await GET(
			event({ fileId, userId: "u1", query: "?variant=thumb" }),
		)) as Response;
		expect(res.status).toBe(200);
	});

	it("serves the original as the display copy of a picture within the display edge", async () => {
		const res = (await GET(
			event({ fileId, userId: "u1", query: "?variant=display" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
		expect(meta.width).toBe(40);
	});

	it("serves the display copy as lossless WebP", async () => {
		const large = await storeLargePicture();
		const res = (await GET(
			event({ fileId: large.id, userId: "u1", query: "?variant=display" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
		expect(meta.format).toBe("webp");
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);
	});

	it("makes the display copy on first request for a picture stored before it existed", async () => {
		const large = await storeLargePicture();
		const displayPath = join(
			workdir,
			"data",
			"image-files",
			"c1",
			`${large.id}.display.webp`,
		);
		await unlink(displayPath);
		expect(existsSync(displayPath)).toBe(false);
		const res = (await GET(
			event({ fileId: large.id, userId: "u1", query: "?variant=display" }),
		)) as Response;
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		expect(existsSync(displayPath)).toBe(true);
	});

	it("regenerates a truncated display copy and serves the whole one", async () => {
		const large = await storeLargePicture();
		const displayPath = join(
			workdir,
			"data",
			"image-files",
			"c1",
			`${large.id}.display.webp`,
		);
		const whole = new Uint8Array(await readFile(displayPath));
		await writeFile(displayPath, whole.subarray(0, 64));
		const res = (await GET(
			event({ fileId: large.id, userId: "u1", query: "?variant=display" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.byteLength).toBe(whole.byteLength);
		expect((await sharp(body).metadata()).format).toBe("webp");
	});

	it("serves the original when a broken display copy cannot be regenerated", async () => {
		const large = await storeLargePicture();
		const directory = join(workdir, "data", "image-files", "c1");
		const displayPath = join(directory, `${large.id}.display.webp`);
		const originalPath = join(directory, `${large.id}.png`);
		await writeFile(displayPath, "not a webp");
		// The display copy cannot be made from the original, but its bytes are
		// still readable: the route's answer is the original, only larger.
		await writeFile(originalPath, "not a png");
		const res = (await GET(
			event({ fileId: large.id, userId: "u1", query: "?variant=display" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("not a png");
		expect(existsSync(displayPath)).toBe(false);
	});

	it("downloads the full original whatever variant is named", async () => {
		const large = await storeLargePicture();
		for (const query of [
			"?download=1",
			"?download=1&variant=display",
			"?download=1&variant=thumb",
		]) {
			const res = (await GET(
				event({ fileId: large.id, userId: "u1", query }),
			)) as Response;
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("image/png");
			expect(res.headers.get("Content-Disposition")).toMatch(
				/^attachment; filename="picture\.png"/,
			);
			const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
			expect(meta.width).toBe(2048);
		}
	});

	it("answers 404 to another user and for an unknown id", async () => {
		expect(
			((await GET(event({ fileId, userId: "u2" }))) as Response).status,
		).toBe(404);
		expect(
			((await GET(event({ fileId: "nope", userId: "u1" }))) as Response).status,
		).toBe(404);
	});

	it("answers 401 with no session", async () => {
		expect(
			await status(Promise.resolve(GET(event({ fileId, userId: null })))),
		).toBe(401);
	});

	it("downloads as picture.png, or under the item's title", async () => {
		const plain = (await GET(
			event({ fileId, userId: "u1", query: "?download=1" }),
		)) as Response;
		expect(plain.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="picture\.png"/,
		);
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "a1",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "x",
				metadataJson: JSON.stringify({
					artifactType: "image",
					title: "Red fox",
				}),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await attachImageFilesToArtifact([fileId], "a1");
		const named = (await GET(
			event({ fileId, userId: "u1", query: "?download=1" }),
		)) as Response;
		expect(named.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename="Red fox\.png"/,
		);
	});

	it("encodes quotes and brackets in the name and strips direction controls", async () => {
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "a2",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "x",
				metadataJson: JSON.stringify({
					artifactType: "image",
					title: 'Mom\'s "room" (v*2) \u00e1\u202egnp.exe',
				}),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await attachImageFilesToArtifact([fileId], "a2");
		const res = (await GET(
			event({ fileId, userId: "u1", query: "?download=1" }),
		)) as Response;
		const header = res.headers.get("Content-Disposition") ?? "";
		const star = header.split("filename*=UTF-8''")[1] ?? "";
		expect(star).not.toMatch(/['()*]/);
		expect(star).toContain("Mom%27s");
		expect(star).toContain("%28v");
		expect(decodeURIComponent(star)).toBe(
			"Mom's - room - (v - 2) \u00e1gnp.exe.png",
		);
		expect(header).not.toContain("\u202e");
	});

	it("keeps an incognito chat's file to the request that names the chat", async () => {
		seedConversation(memory, {
			id: "inc",
			userId: "u1",
			memoryIncognito: true,
		});
		const png = await sharp({
			create: { width: 8, height: 8, channels: 3, background: "#fff" },
		})
			.png()
			.toBuffer();
		const secret = await storeImageFile({
			userId: "u1",
			conversationId: "inc",
			role: "take",
			png: new Uint8Array(png),
		});
		expect(
			((await GET(event({ fileId: secret.id, userId: "u1" }))) as Response)
				.status,
		).toBe(404);
		expect(
			(
				(await GET(
					event({
						fileId: secret.id,
						userId: "u1",
						query: "?conversationId=inc",
					}),
				)) as Response
			).status,
		).toBe(200);
	});
});
