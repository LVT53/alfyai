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
	headers?: Record<string, string>;
}) {
	const url = new URL(
		`http://localhost/api/images/files/${params.fileId}${params.query ?? ""}`,
	);
	return {
		params: { fileId: params.fileId },
		url,
		request: new Request(url, { headers: params.headers ?? {} }),
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

/** A picture past the large edge: its `?variant=large` is a real 2560 px WebP. */
async function storeHugePicture() {
	const png = await sharp({
		create: { width: 3000, height: 2000, channels: 3, background: "#336699" },
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

/** The tag the route gives the stored picture for a query, held to a strong ETag. */
async function etagOf(query = ""): Promise<string> {
	const res = (await GET(event({ fileId, userId: "u1", query }))) as Response;
	expect(res.status).toBe(200);
	const etag = res.headers.get("ETag") ?? "";
	expect(etag).toMatch(/^"[^"]+"$/);
	return etag;
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

	it("carries a strong ETag and answers 304 with no body to its own If-None-Match", async () => {
		const first = (await GET(event({ fileId, userId: "u1" }))) as Response;
		expect(first.status).toBe(200);
		const etag = first.headers.get("ETag") ?? "";
		expect(etag).toMatch(/^"[^"]+"$/);

		const revalidated = (await GET(
			event({ fileId, userId: "u1", headers: { "If-None-Match": etag } }),
		)) as Response;
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get("ETag")).toBe(etag);
		expect(revalidated.headers.get("Cache-Control")).toBe(
			"private, max-age=3600",
		);
		expect(revalidated.body).toBeNull();
		// A 304 carries no representation, so no length for one.
		expect(revalidated.headers.get("Content-Length")).toBeNull();
	});

	it("answers 200 to a tag that does not match, and 304 to a list, a weak tag or * that does", async () => {
		const etag = await etagOf();
		const stale = (await GET(
			event({
				fileId,
				userId: "u1",
				headers: { "If-None-Match": '"an-older-picture"' },
			}),
		)) as Response;
		expect(stale.status).toBe(200);
		expect(stale.headers.get("ETag")).toBe(etag);

		for (const ifNoneMatch of [
			`"an-older-picture", ${etag}`,
			`W/${etag}`,
			"*",
		]) {
			const res = (await GET(
				event({
					fileId,
					userId: "u1",
					headers: { "If-None-Match": ifNoneMatch },
				}),
			)) as Response;
			expect(res.status, ifNoneMatch).toBe(304);
		}
	});

	it("gives the full, thumb, display, large and download representations their own tags", async () => {
		const queries = [
			"",
			"?variant=thumb",
			"?variant=display",
			"?variant=large",
			"?download=1",
		];
		const tags = await Promise.all(queries.map((query) => etagOf(query)));
		expect(new Set(tags).size).toBe(queries.length);
		// A download is the full original whatever variant is named: one tag.
		expect(await etagOf("?download=1&variant=thumb")).toBe(tags[4]);
		expect(await etagOf("?download=1&variant=large")).toBe(tags[4]);

		for (const [index, query] of queries.entries()) {
			const res = (await GET(
				event({
					fileId,
					userId: "u1",
					query,
					headers: { "If-None-Match": tags[index] },
				}),
			)) as Response;
			expect(res.status, query).toBe(304);
		}
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

	it("serves the large copy as WebP, on the picture route's own cache and ETag rules", async () => {
		const huge = await storeHugePicture();
		const res = (await GET(
			event({ fileId: huge.id, userId: "u1", query: "?variant=large" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		// Every representation is immutable for its file id, so a second view
		// inside the hour is a cache hit, not a refetch.
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		const etag = res.headers.get("ETag") ?? "";
		expect(etag).toMatch(/^"[^"]+"$/);
		const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
		expect(meta.format).toBe("webp");
		expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(2560);

		const revalidated = (await GET(
			event({
				fileId: huge.id,
				userId: "u1",
				query: "?variant=large",
				headers: { "If-None-Match": etag },
			}),
		)) as Response;
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get("ETag")).toBe(etag);
		expect(revalidated.headers.get("Cache-Control")).toBe(
			"private, max-age=3600",
		);
		expect(revalidated.body).toBeNull();
	}, 30_000);

	it("serves the original as the large copy of a picture within the large edge", async () => {
		const large = await storeLargePicture();
		const res = (await GET(
			event({ fileId: large.id, userId: "u1", query: "?variant=large" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
		expect(meta.width).toBe(2048);
	});

	it("makes the large copy on first request for a picture stored before it existed", async () => {
		const huge = await storeHugePicture();
		const largePath = join(
			workdir,
			"data",
			"image-files",
			"c1",
			`${huge.id}.large.webp`,
		);
		expect(existsSync(largePath)).toBe(false);
		const res = (await GET(
			event({ fileId: huge.id, userId: "u1", query: "?variant=large" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/webp");
		expect(existsSync(largePath)).toBe(true);
		// The second request is answered from beside the picture.
		const again = (await GET(
			event({ fileId: huge.id, userId: "u1", query: "?variant=large" }),
		)) as Response;
		expect(again.status).toBe(200);
		expect(again.headers.get("ETag")).toBe(res.headers.get("ETag"));
	}, 30_000);

	it("serves the original when a broken large copy cannot be regenerated", async () => {
		const huge = await storeHugePicture();
		const directory = join(workdir, "data", "image-files", "c1");
		const largePath = join(directory, `${huge.id}.large.webp`);
		const originalPath = join(directory, `${huge.id}.png`);
		await writeFile(largePath, "not a webp");
		// The large copy cannot be made from the original, but its bytes are
		// still readable: the route's answer is the original, only larger.
		await writeFile(originalPath, "not a png");
		const res = (await GET(
			event({ fileId: huge.id, userId: "u1", query: "?variant=large" }),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("not a png");
		expect(existsSync(largePath)).toBe(false);
	}, 30_000);

	it("keeps the large copy to the picture's owner and its chat's scope", async () => {
		const huge = await storeHugePicture();
		expect(
			(
				(await GET(
					event({ fileId: huge.id, userId: "u2", query: "?variant=large" }),
				)) as Response
			).status,
		).toBe(404);
		const etag = `"${huge.id}:large"`;
		expect(
			(
				(await GET(
					event({
						fileId: huge.id,
						userId: "u2",
						query: "?variant=large",
						headers: { "If-None-Match": etag },
					}),
				)) as Response
			).status,
		).toBe(404);
	});

	it("downloads the full original whatever variant is named", async () => {
		const large = await storeLargePicture();
		for (const query of [
			"?download=1",
			"?download=1&variant=display",
			"?download=1&variant=large",
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

	it("answers 404 before any 304 to a picture the caller cannot have", async () => {
		const etag = await etagOf();
		expect(
			(
				(await GET(
					event({ fileId, userId: "u2", headers: { "If-None-Match": etag } }),
				)) as Response
			).status,
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
