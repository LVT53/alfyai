// @vitest-environment node
// @always-run: exercises file or process inputs outside Vitest’s import graph.
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

const { storeVideoFile } = await import(
	"$lib/server/services/images/video-files"
);
const { attachImageFilesToArtifact, storeImageFile } = await import(
	"$lib/server/services/images/files"
);
const { makeTestClip } = await import(
	"$lib/server/services/images/video/testing/video-clip"
);
const { GET } = await import("./+server");

function mp4(byteLength = 4096): Uint8Array {
	const buffer = Buffer.alloc(byteLength);
	buffer.writeUInt32BE(byteLength, 0);
	buffer.write("ftypisom", 4, "latin1");
	for (let index = 16; index < byteLength; index++) {
		buffer[index] = (index * 37) % 251;
	}
	return new Uint8Array(buffer);
}

async function frame(width = 640, height = 360): Promise<Uint8Array> {
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3;
			data[at] = (x * 7 + y) % 256;
			data[at + 1] = (y * 11 + x * 3) % 256;
			data[at + 2] = Math.round(128 + 100 * Math.sin(x / 24));
		}
	}
	return new Uint8Array(
		await sharp(data, { raw: { width, height, channels: 3 } })
			.png()
			.toBuffer(),
	);
}

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

/** The files in a chat's image directory, sorted: the clip, its poster, thumb and GIF. */
async function filesOf(conversationId = "c1"): Promise<string[]> {
	const dir = join(workdir, "data", "image-files", conversationId);
	return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

/** Runs `work` with no binaries on PATH: the way a box without ffmpeg answers. */
async function withoutPath<T>(work: () => Promise<T>): Promise<T> {
	const original = process.env.PATH;
	process.env.PATH = "";
	try {
		return await work();
	} finally {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	}
}

/** A clip ffmpeg can really decode, so the GIF conversion runs for real. */
async function storeRealClip(seconds = 1): Promise<{
	id: string;
	bytes: Uint8Array;
}> {
	const bytes = await makeTestClip({ size: 64, seconds });
	const file = await storeVideoFile({
		userId: "u1",
		conversationId: "c1",
		role: "take",
		mp4: bytes,
		poster: await frame(64, 36),
		durationMs: seconds * 1000,
	});
	return { id: file.id, bytes };
}

function gifRequest(fileId: string): Promise<Response> {
	return GET(
		event({
			fileId,
			userId: "u1",
			query: "?download=1&format=gif",
		}),
	) as Promise<Response>;
}

const SIZE = 4096;
let clip: Uint8Array;
let fileId: string;

beforeEach(async () => {
	memory = createInMemoryDatabase();
	workdir = await mkdtemp(join(tmpdir(), "video-route-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	seedUser(memory, "u1");
	seedUser(memory, "u2");
	seedConversation(memory, { id: "c1", userId: "u1" });
	clip = mp4(SIZE);
	fileId = (
		await storeVideoFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			mp4: clip,
			poster: await frame(),
			durationMs: 5000,
		})
	).id;
});

afterEach(async () => {
	vi.restoreAllMocks();
	memory.close();
	await rm(workdir, { recursive: true, force: true });
});

function get(query = "", headers: Record<string, string> = {}) {
	return GET(
		event({ fileId, userId: "u1", query, headers }),
	) as Promise<Response>;
}

describe("GET /api/images/files/[fileId] for a video", () => {
	it("serves the whole mp4 with byte ranges advertised", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("video/mp4");
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		expect(res.headers.get("Content-Length")).toBe(String(SIZE));
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Disposition")).toBeNull();
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(clip);
	});

	it("answers a byte range with 206, the right Content-Range and only those bytes", async () => {
		const cases: Array<{
			range: string;
			start: number;
			end: number;
		}> = [
			{ range: "bytes=0-99", start: 0, end: 99 },
			{ range: "bytes=4000-", start: 4000, end: SIZE - 1 },
			{ range: `bytes=4000-${SIZE * 2}`, start: 4000, end: SIZE - 1 },
			{ range: "bytes=-50", start: SIZE - 50, end: SIZE - 1 },
		];
		for (const { range, start, end } of cases) {
			const res = await get("", { Range: range });
			expect(res.status, range).toBe(206);
			expect(res.headers.get("Content-Type"), range).toBe("video/mp4");
			expect(res.headers.get("Accept-Ranges"), range).toBe("bytes");
			expect(res.headers.get("Content-Range"), range).toBe(
				`bytes ${start}-${end}/${SIZE}`,
			);
			expect(res.headers.get("Content-Length"), range).toBe(
				String(end - start + 1),
			);
			expect(new Uint8Array(await res.arrayBuffer()), range).toEqual(
				clip.slice(start, end + 1),
			);
		}
	});

	it("answers an unsatisfiable range with 416 and the clip's size", async () => {
		for (const range of [
			`bytes=${SIZE}-`,
			`bytes=${SIZE + 10}-${SIZE + 20}`,
			"bytes=-0",
		]) {
			const res = await get("", { Range: range });
			expect(res.status, range).toBe(416);
			expect(res.headers.get("Content-Range"), range).toBe(`bytes */${SIZE}`);
			expect(res.headers.get("Accept-Ranges"), range).toBe("bytes");
			expect(res.body, range).toBeNull();
		}
	});

	it("ignores a malformed or multi-range request and serves the whole clip", async () => {
		for (const range of [
			"bytes=abc",
			"bytes=0-99, 200-299",
			"items=0-99",
			"bytes=",
		]) {
			const res = await get("", { Range: range });
			expect(res.status, range).toBe(200);
			expect(res.headers.get("Content-Range"), range).toBeNull();
			expect(new Uint8Array(await res.arrayBuffer()), range).toEqual(clip);
		}
	});

	it("serves the poster and the thumbnail as WebP", async () => {
		for (const variant of ["poster", "thumb"]) {
			const res = await get(`?variant=${variant}`);
			expect(res.status, variant).toBe(200);
			expect(res.headers.get("Content-Type"), variant).toBe("image/webp");
			const body = new Uint8Array(await res.arrayBuffer());
			expect(Buffer.from(body.subarray(8, 12)).toString(), variant).toBe(
				"WEBP",
			);
			expect(res.headers.get("Content-Disposition"), variant).toBeNull();
		}
	});

	it("downloads the original mp4, with the item's title and the original length", async () => {
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "a-video",
				userId: "u1",
				conversationId: "c1",
				type: "artifact",
				name: "x",
				metadataJson: JSON.stringify({
					artifactType: "video",
					title: "Harbour at dawn",
				}),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		await attachImageFilesToArtifact([fileId], "a-video");

		for (const query of [
			"?download=1",
			"?download=1&variant=poster",
			"?download=1&variant=thumb",
		]) {
			const res = await get(query);
			expect(res.status, query).toBe(200);
			expect(res.headers.get("Content-Type"), query).toBe("video/mp4");
			expect(res.headers.get("Content-Length"), query).toBe(String(SIZE));
			expect(res.headers.get("Content-Disposition"), query).toMatch(
				/^attachment; filename="Harbour at dawn\.mp4"/,
			);
			expect(new Uint8Array(await res.arrayBuffer()), query).toEqual(clip);
		}

		// A download is the whole file, whatever range it was asked for.
		const ranged = await get("?download=1", { Range: "bytes=0-99" });
		expect(ranged.status).toBe(200);
		expect(ranged.headers.get("Content-Range")).toBeNull();
		expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(clip);
	});

	it("gives the video and the poster their own strong ETags and answers 304", async () => {
		const video = await get();
		const poster = await get("?variant=poster");
		const videoTag = video.headers.get("ETag") ?? "";
		const posterTag = poster.headers.get("ETag") ?? "";
		expect(videoTag).toMatch(/^"[^"]+"$/);
		expect(posterTag).toMatch(/^"[^"]+"$/);
		expect(videoTag).not.toBe(posterTag);

		const revalidated = await get("", { "If-None-Match": videoTag });
		expect(revalidated.status).toBe(304);
		expect(revalidated.body).toBeNull();
		expect(revalidated.headers.get("ETag")).toBe(videoTag);
	});

	it("keeps the picture path's ownership scoping exactly", async () => {
		expect((await GET(event({ fileId, userId: "u2" }))).status).toBe(404);
		expect((await GET(event({ fileId: "nope", userId: "u1" }))).status).toBe(
			404,
		);
		expect(
			await status(Promise.resolve(GET(event({ fileId, userId: null })))),
		).toBe(401);

		seedConversation(memory, {
			id: "inc",
			userId: "u1",
			memoryIncognito: true,
		});
		const secret = await storeVideoFile({
			userId: "u1",
			conversationId: "inc",
			role: "take",
			mp4: clip,
			poster: await frame(64, 36),
			durationMs: 5000,
		});
		expect((await GET(event({ fileId: secret.id, userId: "u1" }))).status).toBe(
			404,
		);
		expect(
			(
				await GET(
					event({
						fileId: secret.id,
						userId: "u1",
						query: "?conversationId=inc",
					}),
				)
			).status,
		).toBe(200);
	});
});

describe("GET /api/images/files/[fileId] as a GIF", () => {
	it("answers ?download=1&format=gif as an image/gif attachment, and ignores Range", async () => {
		const real = await storeRealClip();
		const res = (await GET(
			event({
				fileId: real.id,
				userId: "u1",
				query: "?download=1&format=gif",
				headers: { Range: "bytes=0-99" },
			}),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/gif");
		expect(res.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename=".+\.gif"/,
		);
		expect(res.headers.get("Accept-Ranges")).toBeNull();
		expect(res.headers.get("Content-Range")).toBeNull();
		const body = new Uint8Array(await res.arrayBuffer());
		expect(Buffer.from(body.subarray(0, 6)).toString("latin1")).toMatch(
			/^GIF8[79]a$/,
		);
		expect(res.headers.get("Content-Length")).toBe(String(body.byteLength));
		expect(await filesOf()).toContain(`${real.id}.gif`);
	});

	it("serves the GIF it already made, without needing ffmpeg again", async () => {
		const real = await storeRealClip();
		const first = await gifRequest(real.id);
		expect(first.status).toBe(200);
		const bytes = new Uint8Array(await first.arrayBuffer());

		const second = await withoutPath(() => gifRequest(real.id));
		expect(second.status).toBe(200);
		expect(second.headers.get("Content-Type")).toBe("image/gif");
		expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
	});

	it("gives the GIF its own strong ETag and answers 304", async () => {
		const real = await storeRealClip();
		const first = await gifRequest(real.id);
		const tag = first.headers.get("ETag") ?? "";
		expect(tag).toMatch(/^"[^"]+"$/);
		const clipResponse = (await GET(
			event({ fileId: real.id, userId: "u1" }),
		)) as Response;
		expect(tag).not.toBe(clipResponse.headers.get("ETag"));
		const revalidated = (await GET(
			event({
				fileId: real.id,
				userId: "u1",
				query: "?download=1&format=gif",
				headers: { "If-None-Match": tag },
			}),
		)) as Response;
		expect(revalidated.status).toBe(304);
		expect(revalidated.body).toBeNull();
	});

	it("removes a cached file that is not a whole GIF and makes it again once", async () => {
		const real = await storeRealClip();
		await writeFile(
			join(workdir, "data", "image-files", "c1", `${real.id}.gif`),
			"half",
		);
		const res = await gifRequest(real.id);
		expect(res.status).toBe(200);
		const body = new Uint8Array(await res.arrayBuffer());
		expect(Buffer.from(body.subarray(0, 6)).toString("latin1")).toMatch(
			/^GIF8[79]a$/,
		);
		const files = await filesOf();
		expect(files).toContain(`${real.id}.gif`);
		expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("answers a missing ffmpeg as the take's media-unavailable meaning, and stores nothing", async () => {
		const real = await storeRealClip();
		const res = await withoutPath(() => gifRequest(real.id));
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			error: "video_media_unavailable",
		});
		const files = await filesOf();
		expect(files).not.toContain(`${real.id}.gif`);
		expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("answers a failed conversion as an error, never as another format", async () => {
		// The beforeEach clip is a signature and noise: ffmpeg cannot decode it.
		const res = await gifRequest(fileId);
		expect(res.status).toBe(500);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(await res.json()).toMatchObject({ error: "video_media_failed" });
		const files = await filesOf();
		expect(files).not.toContain(`${fileId}.gif`);
		expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("never answers a GIF for a picture row, whatever was asked for", async () => {
		const png = new Uint8Array(
			await sharp({
				create: { width: 20, height: 10, channels: 3, background: "#123456" },
			})
				.png()
				.toBuffer(),
		);
		const picture = await storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png,
		});
		const res = (await GET(
			event({
				fileId: picture.id,
				userId: "u1",
				query: "?download=1&format=gif",
			}),
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Content-Disposition")).toMatch(
			/^attachment; filename=".+\.png"/,
		);
		expect(await filesOf()).not.toContain(`${picture.id}.gif`);
	});

	it("never answers a GIF for a row that is not a clip (no duration)", async () => {
		const real = await storeRealClip();
		memory.db
			.update(schema.imageFiles)
			.set({ durationMs: null })
			.where(eq(schema.imageFiles.id, real.id))
			.run();
		const res = await gifRequest(real.id);
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Type")).not.toBe("image/gif");
		expect(await filesOf()).not.toContain(`${real.id}.gif`);
	});

	it("keeps the picture path's ownership scoping for the GIF", async () => {
		const real = await storeRealClip();
		expect(
			(
				await GET(
					event({
						fileId: real.id,
						userId: "u2",
						query: "?download=1&format=gif",
					}),
				)
			).status,
		).toBe(404);
		expect(
			(
				await GET(
					event({
						fileId: "nope",
						userId: "u1",
						query: "?download=1&format=gif",
					}),
				)
			).status,
		).toBe(404);
		expect(
			await status(
				Promise.resolve(
					GET(
						event({
							fileId: real.id,
							userId: null,
							query: "?download=1&format=gif",
						}),
					),
				),
			),
		).toBe(401);
		expect(await filesOf()).not.toContain(`${real.id}.gif`);
	});

	it("leaves a player's request alone when format=gif is not a download", async () => {
		const real = await storeRealClip();
		const whole = (await GET(
			event({ fileId: real.id, userId: "u1", query: "?format=gif" }),
		)) as Response;
		expect(whole.status).toBe(200);
		expect(whole.headers.get("Content-Type")).toBe("video/mp4");
		expect(whole.headers.get("Accept-Ranges")).toBe("bytes");

		const ranged = (await GET(
			event({
				fileId: real.id,
				userId: "u1",
				query: "?format=gif",
				headers: { Range: "bytes=0-99" },
			}),
		)) as Response;
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("Content-Type")).toBe("video/mp4");
		expect(await filesOf()).not.toContain(`${real.id}.gif`);
	});

	it("keeps the mp4 download byte for byte, format=mp4 or absent", async () => {
		const real = await storeRealClip();
		for (const query of ["?download=1", "?download=1&format=mp4"]) {
			const res = (await GET(
				event({ fileId: real.id, userId: "u1", query }),
			)) as Response;
			expect(res.status, query).toBe(200);
			expect(res.headers.get("Content-Type"), query).toBe("video/mp4");
			expect(res.headers.get("Content-Disposition"), query).toMatch(
				/^attachment; filename=".+\.mp4"/,
			);
			expect(new Uint8Array(await res.arrayBuffer()), query).toEqual(
				real.bytes,
			);
		}
	});
});
