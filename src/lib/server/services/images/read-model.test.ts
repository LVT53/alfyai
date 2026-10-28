// @vitest-environment node
//
// The card read model: cards oldest first, their visible takes oldest first,
// and only the owner's.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createImageFixture, type ImageFixture } from "./testing/fixture";
import { insertTake, takeRequest } from "./testing/takes";

let fixture: ImageFixture;
let workdir: string;

beforeAll(async () => {
	await warmModules([
		() => import("./cards"),
		() => import("./files"),
		() => import("./read-model"),
	]);
}, 30_000);

beforeEach(async () => {
	fixture = createImageFixture("image-read-model");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedConversation("c2", "u2");
	workdir = await mkdtemp(join(tmpdir(), "image-read-model-"));
	vi.spyOn(process, "cwd").mockReturnValue(workdir);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
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

async function makeCard(turnId: string, userId = "u1", conversationId = "c1") {
	const { createCard } = await import("./cards");
	return (
		await createCard({
			userId,
			conversationId,
			turnId,
			artifactId: null,
			title: `Card ${turnId}`,
			madeFrom: "words",
			sourceCount: 0,
		})
	).cardId;
}

describe("listConversationImageCards", () => {
	it("lists cards and visible takes oldest first, with phase, queue, progress, file and sizes", async () => {
		const { storeImageFile } = await import("./files");
		const { listConversationImageCards } = await import("./read-model");
		const first = await makeCard("t1");
		const second = await makeCard("t2");
		const png = new Uint8Array(
			await sharp({
				create: { width: 64, height: 32, channels: 3, background: "#336699" },
			})
				.png()
				.toBuffer(),
		);
		const file = await storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "take",
			png,
		});
		const done = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: first,
			resultFileId: file.id,
			request: takeRequest({
				mode: "edit",
				inputs: [
					{ fileId: "base-1", role: "base", name: "room.png" },
					{ fileId: "ref-1", role: "reference", name: "sofa.png" },
				],
			}),
		});
		const hidden = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: first,
			hidden: true,
		});
		const running = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: first,
			status: "running",
			phase: "rendering",
			phaseAt: 1_700_000_500_000,
			queueAhead: 2,
			progressPercent: 40,
		});
		const failed = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: second,
			status: "failed",
			errorCode: "picture_server_unreachable",
			retryable: true,
		});

		const cards = await listConversationImageCards("u1", "c1");
		expect(cards.map((card) => card.id)).toEqual([first, second]);
		expect(cards[0].takes.map((take) => take.id)).toEqual([done, running]);
		expect(cards[0].takes.map((take) => take.id)).not.toContain(hidden);
		expect(cards[0].takes[0]).toMatchObject({
			status: "succeeded",
			fileId: file.id,
			width: 64,
			height: 32,
			hasAlpha: false,
			baseFileId: "base-1",
			sourceFileIds: ["ref-1"],
			canvas: { width: 1248, height: 832 },
			retried: false,
		});
		expect(cards[0].takes[1]).toMatchObject({
			status: "running",
			phase: "rendering",
			phaseAt: 1_700_000_500_000,
			queueAhead: 2,
			progressPercent: 40,
			fileId: null,
		});
		expect(cards[0].takes[0].createdAt).toBeGreaterThan(1_700_000_000_000);
		expect(cards[1].takes[0]).toMatchObject({
			id: failed,
			status: "failed",
			errorCode: "picture_server_unreachable",
			retryable: true,
		});
	});

	it("says where a take came from, whether it is held, and what it retries", async () => {
		const { listConversationImageCards } = await import("./read-model");
		const card = await makeCard("t1");
		const first = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
		});
		const retry = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			origin: "retry",
			retryOf: first,
			heldUntil: Date.now() + 100_000,
		});
		const expired = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			origin: "another",
			heldUntil: Date.now() - 1_000,
		});
		const [view] = await listConversationImageCards("u1", "c1");
		const byId = new Map(view.takes.map((take) => [take.id, take]));
		expect(byId.get(first)).toMatchObject({
			origin: "turn",
			retryOf: null,
			held: false,
		});
		expect(byId.get(retry)).toMatchObject({
			origin: "retry",
			retryOf: first,
			held: true,
		});
		expect(byId.get(expired)).toMatchObject({ origin: "another", held: false });
	});

	it("passes the server's automatic retry on as auto_retry, so the card can fold it (and only it)", async () => {
		const { listConversationImageCards } = await import("./read-model");
		const card = await makeCard("t1");
		const first = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
		});
		const auto = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			origin: "auto_retry",
			retryOf: first,
			heldUntil: Date.now() + 100_000,
		});
		const unknown = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			origin: "something_else",
		});
		const [view] = await listConversationImageCards("u1", "c1");
		const byId = new Map(view.takes.map((take) => [take.id, take]));
		expect(byId.get(auto)).toMatchObject({
			origin: "auto_retry",
			retryOf: first,
			held: true,
		});
		expect(byId.get(unknown)).toMatchObject({ origin: "turn" });
	});

	it("reserves the exact size the picture will have: the canvas for a new picture, the base file's size for an edit", async () => {
		const { storeImageFile } = await import("./files");
		const { listConversationImageCards } = await import("./read-model");
		const card = await makeCard("t1");
		const base = await storeImageFile({
			userId: "u1",
			conversationId: "c1",
			role: "input",
			png: new Uint8Array(
				await sharp({
					create: {
						width: 1184,
						height: 888,
						channels: 3,
						background: "#336699",
					},
				})
					.png()
					.toBuffer(),
			),
		});
		const made = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			request: takeRequest({ canvas: { width: 1248, height: 832 } }),
		});
		const edit = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			request: takeRequest({
				mode: "edit",
				canvas: { width: 1184, height: 896 },
				inputs: [{ fileId: base.id, role: "base", name: "room.png" }],
			}),
		});
		const gone = await insertTake({
			userId: "u1",
			conversationId: "c1",
			cardId: card,
			request: takeRequest({
				mode: "edit",
				canvas: { width: 1184, height: 896 },
				inputs: [{ fileId: "missing", role: "base", name: "room.png" }],
			}),
		});
		const [view] = await listConversationImageCards("u1", "c1");
		const byId = new Map(view.takes.map((take) => [take.id, take]));
		expect(byId.get(made)?.box).toEqual({ width: 1248, height: 832 });
		expect(byId.get(edit)?.box).toEqual({ width: 1184, height: 888 });
		// A base file that cannot be found falls back to the canvas.
		expect(byId.get(gone)?.box).toEqual({ width: 1184, height: 896 });
	});

	it("answers nothing for another person's chat", async () => {
		const { listConversationImageCards } = await import("./read-model");
		const card = await makeCard("t1", "u2", "c2");
		await insertTake({
			userId: "u2",
			conversationId: "c2",
			cardId: card,
		});
		expect(await listConversationImageCards("u1", "c2")).toEqual([]);
		expect(await listConversationImageCards("u2", "c2")).toHaveLength(1);
	});
});
