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
import {
	createImageFixture,
	type ImageFixture,
	warmModules,
} from "./testing/fixture";
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
