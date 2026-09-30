// A picture of a board, kept: the export the reader downloads and a block's still
// image, against the real scope, the real generated-file path and a real
// database (only the disk is a map). What is asserted is every way a request can
// be wrong (whose board, what bytes, how big) and the two results that differ:
// the export is an ordinary produced file linked to the board, a poster is
// something nothing lists.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	EXPORT_PNG_MAX_BYTES,
	POSTER_PNG_MAX_BYTES,
} from "$lib/shared/artifacts/canvas-limits";
import { NOW, seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;
const disk = new Map<string, Buffer>();

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

// The disk is a map: nothing is written under the working directory. Named and
// default exports both, because the module system reads a built-in's names off
// its default.
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	const overrides = {
		mkdir: vi.fn(async () => undefined),
		writeFile: vi.fn(async (path: string, content: Buffer) => {
			disk.set(path, Buffer.from(content));
		}),
		readFile: vi.fn(async (path: string) => {
			const found = disk.get(path);
			if (!found) throw new Error(`ENOENT ${path}`);
			return found;
		}),
		access: vi.fn(async (path: string) => {
			if (!disk.has(path)) throw new Error(`ENOENT ${path}`);
		}),
		unlink: vi.fn(async (path: string) => {
			disk.delete(path);
		}),
	};
	return { ...original, ...overrides, default: { ...original, ...overrides } };
});

// A produced image is queued for reading back; that is the extraction ledger's
// business and is not what is asserted here.
vi.mock("$lib/server/services/extraction", () => ({
	startGeneratedFileReadback: vi.fn(async () => undefined),
}));

const { createArtifact, listArtifactsForConversation } = await import(
	"$lib/server/services/artifacts"
);
const { storeCanvasImage } = await import("./canvas-export");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const NORMAL = "conv-normal";
const INCOGNITO = "conv-incognito";
const STRANGER_CHAT = "conv-stranger";
const REPLY = "message-reply";

/** A whole PNG as far as its own structure goes: signature, header with a size, the end chunk. */
function png(
	params: { width?: number; height?: number; padding?: number } = {},
) {
	const { width = 800, height = 600, padding = 0 } = params;
	const signature = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	const header = Buffer.alloc(25);
	header.writeUInt32BE(13, 0);
	header.write("IHDR", 4, "ascii");
	header.writeUInt32BE(width, 8);
	header.writeUInt32BE(height, 12);
	header[16] = 8;
	header[17] = 2;
	const end = Buffer.from([
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	]);
	const chunks = [signature, header];
	if (padding > 0) {
		const filler = Buffer.alloc(12 + padding);
		filler.writeUInt32BE(padding, 0);
		filler.write("tEXt", 4, "ascii");
		chunks.push(filler);
	}
	chunks.push(end);
	return Buffer.concat(chunks);
}

const dataUrl = (bytes: Buffer, type = "image/png") =>
	`data:${type};base64,${bytes.toString("base64")}`;

async function board(
	conversationId: string,
	userId = OWNER,
	title = "Weekend board",
) {
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title,
		body: boardJson(emptyCanvasBody()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

function reply(conversationId: string, id: string, sequence: number) {
	memory.db
		.insert(schema.messages)
		.values({
			id,
			conversationId,
			messageSequence: sequence,
			role: "assistant",
			content: "Here is your board.",
			createdAt: NOW,
		})
		.run();
}

const files = () => memory.db.select().from(schema.chatGeneratedFiles).all();
const outputs = () =>
	memory.db
		.select()
		.from(schema.artifacts)
		.all()
		.filter((row) => row.type === "generated_output");

beforeEach(() => {
	disk.clear();
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: NORMAL, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CHAT, userId: STRANGER });
	reply(NORMAL, REPLY, 1);
});

afterEach(() => {
	memory.close();
});

describe("the export the reader downloads", () => {
	it("stores the PNG as a produced file on the chat's newest reply, linked to the board", async () => {
		const id = await board(NORMAL);
		reply(NORMAL, "message-later", 2);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png({ width: 1200, height: 900 })),
		});
		expect(result).toMatchObject({ ok: true, width: 1200, height: 900 });
		if (!result.ok) return;

		const [file] = files();
		expect(file).toMatchObject({
			id: result.fileId,
			conversationId: NORMAL,
			userId: OWNER,
			filename: "Weekend board.png",
			mimeType: "image/png",
			assistantMessageId: "message-later",
		});
		expect(
			disk.get(join(process.cwd(), "data", "chat-files", file.storagePath)),
		).toEqual(png({ width: 1200, height: 900 }));

		// Ruling 18: a produced file is `generated_output`, never re-typed.
		const [made] = outputs();
		expect(made).toMatchObject({
			type: "generated_output",
			conversationId: NORMAL,
		});
		expect(JSON.parse(made.metadataJson ?? "{}")).toMatchObject({
			originalChatFileId: result.fileId,
		});
		const links = memory.db.select().from(schema.artifactLinks).all();
		expect(links).toContainEqual(
			expect.objectContaining({
				artifactId: made.id,
				relatedArtifactId: id,
				linkType: "used_in_output",
				userId: OWNER,
			}),
		);
	});

	it("shows in the panel's list as a File, beside the board, and writes no version of the board", async () => {
		const id = await board(NORMAL);
		const before = memory.db
			.select()
			.from(schema.artifactVersions)
			.all().length;
		await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png()),
		});
		const listed = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: NORMAL,
		});
		expect(listed.map((card) => card.kind).sort()).toEqual(["canvas", "file"]);
		expect(memory.db.select().from(schema.artifactVersions).all()).toHaveLength(
			before,
		);
	});

	it("still hands over the file when the chat has no reply to hang it from, and lists nothing", async () => {
		memory.db.delete(schema.messages).run();
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png()),
		});
		expect(result.ok).toBe(true);
		expect(files()).toHaveLength(1);
		expect(files()[0].assistantMessageId).toBeNull();
		expect(outputs()).toHaveLength(0);
	});

	it("names the file after the board and keeps a title with a slash from becoming a path", async () => {
		const id = await board(NORMAL, OWNER, "Q3/Q4 plan");
		await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png()),
		});
		expect(files()[0].filename).toBe("Q3-Q4 plan.png");
	});
});

describe("whose board it is", () => {
	it("answers a stranger's board, a missing one and a document alike, and stores nothing", async () => {
		const strangers = await board(STRANGER_CHAT, STRANGER);
		const document = await createArtifact({
			userId: OWNER,
			conversationId: NORMAL,
			kind: "document",
			title: "Notes",
			body: "hello",
			author: "user",
			versionSummary: "Created",
		});
		if (!document.ok) throw new Error(document.reason);
		const answers = await Promise.all(
			[strangers, "no-such-board", document.artifact.id].map((artifactId) =>
				storeCanvasImage({
					userId: OWNER,
					artifactId,
					source: "canvas-export",
					dataUrl: dataUrl(png()),
				}),
			),
		);
		expect(answers).toEqual([
			{ ok: false, reason: "not_found" },
			{ ok: false, reason: "not_found" },
			{ ok: false, reason: "not_found" },
		]);
		expect(files()).toHaveLength(0);
		expect(outputs()).toHaveLength(0);
	});

	it("reads an incognito chat's board only when the request names that chat", async () => {
		const id = await board(INCOGNITO);
		reply(INCOGNITO, "message-incognito", 1);
		const request = {
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png()),
		};
		expect(await storeCanvasImage(request)).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(files()).toHaveLength(0);
		expect(
			await storeCanvasImage({ ...request, conversationId: INCOGNITO }),
		).toMatchObject({
			ok: true,
		});
		expect(files()[0].conversationId).toBe(INCOGNITO);
	});

	it("puts nothing in the chat of someone who names another user's chat", async () => {
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: STRANGER,
			artifactId: id,
			conversationId: NORMAL,
			source: "canvas-export",
			dataUrl: dataUrl(png()),
		});
		expect(result).toEqual({ ok: false, reason: "not_found" });
		expect(files()).toHaveLength(0);
	});
});

describe("what is accepted as a PNG", () => {
	const cases: [string, unknown, "not_png" | "too_large"][] = [
		["a JPEG data URL", dataUrl(png(), "image/jpeg"), "not_png"],
		["a data URL that is not base64", "data:image/png,hello", "not_png"],
		["text with no data URL", "hello", "not_png"],
		["a value that is not text", { url: "x" }, "not_png"],
		[
			"bytes that say PNG and are not",
			dataUrl(Buffer.from("GIF89a-not-a-png-at-all-really-not".repeat(3))),
			"not_png",
		],
		[
			"a PNG cut short (no end chunk)",
			dataUrl(png().subarray(0, 40)),
			"not_png",
		],
		[
			"base64 with characters that are not base64",
			"data:image/png;base64,@@@@",
			"not_png",
		],
		[
			"a header that says the picture is empty",
			dataUrl(png({ width: 0, height: 10 })),
			"not_png",
		],
	];
	for (const [name, value, reason] of cases) {
		it(`refuses ${name} with ${reason} and stores nothing`, async () => {
			const id = await board(NORMAL);
			const result = await storeCanvasImage({
				userId: OWNER,
				artifactId: id,
				source: "canvas-export",
				dataUrl: value,
			});
			expect(result).toEqual({ ok: false, reason });
			expect(files()).toHaveLength(0);
			expect(disk.size).toBe(0);
		});
	}

	it("refuses a picture past the export's byte cap, without decoding it", async () => {
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png({ padding: EXPORT_PNG_MAX_BYTES })),
		});
		expect(result).toEqual({ ok: false, reason: "too_large" });
		expect(files()).toHaveLength(0);
	});

	it("refuses a picture larger than a browser could have drawn on a side", async () => {
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-export",
			dataUrl: dataUrl(png({ width: 20_000, height: 100 })),
		});
		expect(result).toEqual({ ok: false, reason: "too_large" });
	});

	it("keeps a poster to its own, smaller, cap", async () => {
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-poster",
			nodeId: "app-1",
			dataUrl: dataUrl(
				png({ width: 640, height: 400, padding: POSTER_PNG_MAX_BYTES }),
			),
		});
		expect(result).toEqual({ ok: false, reason: "too_large" });
		expect(files()).toHaveLength(0);
	});

	it("refuses a request that is not shaped like one", async () => {
		const id = await board(NORMAL);
		for (const request of [
			{ source: "somewhere-else" },
			{ source: undefined },
			{ source: "canvas-poster" },
			{ source: "canvas-poster", nodeId: "" },
			{ source: "canvas-poster", nodeId: 12 },
		]) {
			expect(
				await storeCanvasImage({
					userId: OWNER,
					artifactId: id,
					dataUrl: dataUrl(png()),
					...request,
				}),
			).toEqual({ ok: false, reason: "invalid_request" });
		}
		expect(files()).toHaveLength(0);
	});
});

describe("a block's poster", () => {
	it("is a file that hangs from no reply and has no artifact: nothing lists it", async () => {
		const id = await board(NORMAL);
		const result = await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-poster",
			nodeId: "app-1",
			dataUrl: dataUrl(png({ width: 640, height: 400 })),
		});
		expect(result).toMatchObject({ ok: true, width: 640, height: 400 });
		expect(files()).toHaveLength(1);
		expect(files()[0]).toMatchObject({
			filename: `canvas-poster-${id}-app-1.png`,
			assistantMessageId: null,
			mimeType: "image/png",
		});
		expect(outputs()).toHaveLength(0);
		const listed = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: NORMAL,
		});
		expect(listed.map((card) => card.kind)).toEqual(["canvas"]);
	});

	it("replaces the poster it is a new picture of, and only that one", async () => {
		const id = await board(NORMAL);
		const send = (nodeId: string) =>
			storeCanvasImage({
				userId: OWNER,
				artifactId: id,
				source: "canvas-poster",
				nodeId,
				dataUrl: dataUrl(png({ width: 640, height: 400 })),
			});
		const first = await send("app-1");
		await send("map-1");
		const second = await send("app-1");
		if (!first.ok || !second.ok) throw new Error("stored");
		const names = files()
			.map((file) => file.filename)
			.sort();
		expect(names).toEqual([
			`canvas-poster-${id}-app-1.png`,
			`canvas-poster-${id}-map-1.png`,
		]);
		expect(files().map((file) => file.id)).toContain(second.fileId);
		expect(files().map((file) => file.id)).not.toContain(first.fileId);
		// The replaced picture is gone from the disk too.
		expect(disk.size).toBe(2);
	});

	it("keeps a block id from becoming a path in the file's name", async () => {
		const id = await board(NORMAL);
		await storeCanvasImage({
			userId: OWNER,
			artifactId: id,
			source: "canvas-poster",
			nodeId: "../../etc/passwd",
			dataUrl: dataUrl(png({ width: 640, height: 400 })),
		});
		expect(files()[0].filename).toBe(`canvas-poster-${id}--etc-passwd.png`);
		expect(files()[0].storagePath.startsWith(`${NORMAL}/`)).toBe(true);
	});
});
