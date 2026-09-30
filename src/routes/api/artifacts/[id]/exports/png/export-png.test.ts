// The route behind a board's PNG export and its blocks' posters, through the real
// scope, service and database (the disk is a map). The service's own rules have
// their own file; what is asserted here is what only the route can get wrong:
// who may call it, how much of a body it will read, and that a stranger's board
// answers as a missing one before the picture is looked at.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import { EXPORT_PNG_MAX_BYTES } from "$lib/shared/artifacts/canvas-limits";

let memory: InMemoryDatabase;
const disk = new Map<string, Buffer>();

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

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

vi.mock("$lib/server/services/extraction", () => ({
	startGeneratedFileReadback: vi.fn(async () => undefined),
}));

const { createArtifact } = await import("$lib/server/services/artifacts");
const { POST } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const NORMAL = "conv-normal";
const INCOGNITO = "conv-incognito";
const STRANGER_CHAT = "conv-stranger";

function png(width = 800, height = 600): Buffer {
	const signature = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	const header = Buffer.alloc(25);
	header.writeUInt32BE(13, 0);
	header.write("IHDR", 4, "ascii");
	header.writeUInt32BE(width, 8);
	header.writeUInt32BE(height, 12);
	const end = Buffer.from([
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	]);
	return Buffer.concat([signature, header, end]);
}
const dataUrl = (bytes: Buffer, type = "image/png") =>
	`data:${type};base64,${bytes.toString("base64")}`;

function event(params: {
	artifactId: string;
	userId: string | null;
	conversationId?: string | null;
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	const url = `http://localhost/api/artifacts/${params.artifactId}/exports/png${query}`;
	return {
		params: { id: params.artifactId },
		url: new URL(url),
		request: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...params.headers },
			body:
				params.rawBody ??
				JSON.stringify(
					params.body ?? { source: "canvas-export", dataUrl: dataUrl(png()) },
				),
		}),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

async function board(conversationId: string, userId = OWNER) {
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Board",
		body: boardJson(emptyCanvasBody()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
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
	memory.db
		.insert(schema.messages)
		.values({
			id: "reply",
			conversationId: NORMAL,
			messageSequence: 1,
			role: "assistant",
			content: "Here is your board.",
			createdAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

describe("POST /api/artifacts/[id]/exports/png", () => {
	it("stores a valid capture as one generated_output linked to the board, and answers where", async () => {
		const id = await board(NORMAL);
		const response = await POST(event({ artifactId: id, userId: OWNER }));

		expect(response.status).toBe(200);
		const answer = await response.json();
		expect(answer).toEqual({
			ok: true,
			fileId: files()[0].id,
			width: 800,
			height: 600,
		});
		expect(outputs()).toHaveLength(1);
		expect(
			memory.db
				.select()
				.from(schema.artifactLinks)
				.all()
				.filter((link) => link.linkType === "used_in_output"),
		).toEqual([
			expect.objectContaining({
				artifactId: outputs()[0].id,
				relatedArtifactId: id,
			}),
		]);
	});

	it("refuses a data URL that is not a PNG with a 415 and stores nothing", async () => {
		const id = await board(NORMAL);
		for (const dataUrlValue of [
			dataUrl(png(), "image/jpeg"),
			dataUrl(Buffer.from("not a picture at all, just words in base64 form")),
			"https://example.com/x.png",
		]) {
			const response = await POST(
				event({
					artifactId: id,
					userId: OWNER,
					body: { source: "canvas-export", dataUrl: dataUrlValue },
				}),
			);
			expect(response.status, dataUrlValue.slice(0, 30)).toBe(415);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "not_png",
			});
		}
		expect(files()).toHaveLength(0);
	});

	it("answers 413 for a body past the cap, by its declared length and by its actual length", async () => {
		const id = await board(NORMAL);
		const declared = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				headers: { "content-length": String(EXPORT_PNG_MAX_BYTES * 2) },
			}),
		);
		expect(declared.status).toBe(413);
		const actual = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				rawBody: JSON.stringify({
					source: "canvas-export",
					dataUrl: `data:image/png;base64,${"A".repeat(Math.ceil((EXPORT_PNG_MAX_BYTES * 4) / 3) + 4096)}`,
				}),
			}),
		);
		expect(actual.status).toBe(413);
		await expect(actual.json()).resolves.toEqual({
			ok: false,
			reason: "too_large",
		});
		expect(files()).toHaveLength(0);
	});

	it("answers 413 for a picture a browser could not have drawn, even inside the body cap", async () => {
		const id = await board(NORMAL);
		const response = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				body: { source: "canvas-export", dataUrl: dataUrl(png(30_000, 20)) },
			}),
		);
		expect(response.status).toBe(413);
		expect(files()).toHaveLength(0);
	});

	it("answers another user's board exactly as a missing id, byte for byte, whatever the picture", async () => {
		const theirs = await board(STRANGER_CHAT, STRANGER);

		const foreign = await POST(event({ artifactId: theirs, userId: OWNER }));
		const missing = await POST(
			event({ artifactId: "no-such-board", userId: OWNER }),
		);
		const foreignNotPng = await POST(
			event({
				artifactId: theirs,
				userId: OWNER,
				body: { source: "canvas-export", dataUrl: "hello" },
			}),
		);

		expect(foreign.status).toBe(404);
		expect(await foreign.text()).toBe(await missing.text());
		expect(foreignNotPng.status).toBe(404);
		expect(files()).toHaveLength(0);
		expect(outputs()).toHaveLength(0);
	});

	it("keeps an incognito chat's board to that chat", async () => {
		const id = await board(INCOGNITO);
		expect((await POST(event({ artifactId: id, userId: OWNER }))).status).toBe(
			404,
		);
		expect(files()).toHaveLength(0);
		expect(
			(
				await POST(
					event({ artifactId: id, userId: OWNER, conversationId: INCOGNITO }),
				)
			).status,
		).toBe(200);
		expect(files()[0].conversationId).toBe(INCOGNITO);
	});

	it("answers 401 to a caller who is not signed in, before anything is read", async () => {
		const id = await board(NORMAL);
		let status: number | null = null;
		try {
			const response = await POST(event({ artifactId: id, userId: null }));
			status = response.status;
		} catch (error) {
			status = (error as { status?: number }).status ?? null;
		}
		expect(status).toBe(401);
		expect(files()).toHaveLength(0);
	});

	it("answers 400 for a body that is not a JSON object, and for a poster with no block", async () => {
		const id = await board(NORMAL);
		for (const rawBody of ["not json", "[]", "null", '"text"']) {
			expect(
				(await POST(event({ artifactId: id, userId: OWNER, rawBody }))).status,
				rawBody,
			).toBe(400);
		}
		const noBlock = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				body: { source: "canvas-poster", dataUrl: dataUrl(png(640, 400)) },
			}),
		);
		expect(noBlock.status).toBe(400);
		expect(files()).toHaveLength(0);
	});

	it("stores a block's poster without listing it: no reply, no artifact", async () => {
		const id = await board(NORMAL);
		const response = await POST(
			event({
				artifactId: id,
				userId: OWNER,
				body: {
					source: "canvas-poster",
					nodeId: "map-1",
					dataUrl: dataUrl(png(640, 400)),
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			width: 640,
			height: 400,
		});
		expect(files()[0]).toMatchObject({ assistantMessageId: null });
		expect(outputs()).toHaveLength(0);
	});
});
