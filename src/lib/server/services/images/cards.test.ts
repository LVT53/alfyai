// @vitest-environment node
//
// Cards: how a take becomes a version of an Image item. A real migrated
// database and the real artifacts service; picture files go to a temp working
// directory. Takes are inserted as landed rows (the runner's own landing is
// covered in image-runner.test.ts).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { parseImageVersionBody } from "$lib/shared/artifacts/image-body";
import { classifyVersionSummary } from "$lib/shared/artifacts/version-summaries";
import type { StoredTakeMeasures, TakeRequest } from "./take-request";
import { createImageFixture, type ImageFixture } from "./testing/fixture";

const userId = "user-1";
const conversationId = "conv-1";

let fixture: ImageFixture;
let workdir: string;

beforeEach(async () => {
	fixture = createImageFixture("image-cards");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	workdir = await mkdtemp(join(tmpdir(), "image-cards-"));
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

function request(overrides: Partial<TakeRequest> = {}): TakeRequest {
	return {
		v: 1,
		mode: "generate",
		prompt: "a cosy living room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 1248, height: 832 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy living room",
		summary: null,
		...overrides,
	};
}

async function png(color: string, width = 64, height = 64) {
	return new Uint8Array(
		await sharp({
			create: { width, height, channels: 3, background: color },
		})
			.png()
			.toBuffer(),
	);
}

async function storeFile(role: "input" | "take", color = "#336699") {
	const { storeImageFile } = await import("./files");
	return storeImageFile({
		userId,
		conversationId,
		role,
		png: await png(color),
	});
}

let tick = 1_700_000_000;

/** A take that has landed: succeeded, with a stored picture. */
async function landedTake(
	cardId: string,
	options: {
		request?: TakeRequest;
		heldUntil?: number | null;
		seed?: number;
		measures?: StoredTakeMeasures | null;
		file?: Awaited<ReturnType<typeof storeFile>>;
	} = {},
) {
	const { db } = await import("$lib/server/db");
	const file = options.file ?? (await storeFile("take"));
	const id = randomUUID();
	tick += 1;
	db.insert(schema.imageJobs)
		.values({
			id,
			userId,
			status: "succeeded",
			cardId,
			conversationId,
			origin: "turn",
			requestJson: JSON.stringify(options.request ?? request()),
			seed: options.seed ?? 7,
			heldUntil: options.heldUntil ?? null,
			resultFileId: file.id,
			measuresJson: options.measures ? JSON.stringify(options.measures) : null,
			createdAt: new Date(tick * 1000),
		})
		.run();
	return { id, file };
}

async function card(
	madeFrom: "words" | "photo" | "change" = "words",
	artifactId: string | null = null,
) {
	const { createCard } = await import("./cards");
	return (
		await createCard({
			userId,
			conversationId,
			turnId: "turn-1",
			artifactId,
			title: "Cosy living room",
			madeFrom,
			sourceCount: 0,
		})
	).cardId;
}

async function cardRow(cardId: string) {
	const { db } = await import("$lib/server/db");
	return db
		.select()
		.from(schema.imageCards)
		.where(eq(schema.imageCards.id, cardId))
		.get();
}

async function takeRow(takeId: string) {
	const { db } = await import("$lib/server/db");
	return db
		.select()
		.from(schema.imageJobs)
		.where(eq(schema.imageJobs.id, takeId))
		.get();
}

async function versions(artifactId: string) {
	const { listVersions } = await import("$lib/server/services/artifacts");
	return (await listVersions({ userId, artifactId, conversationId })).sort(
		(a, b) => a.versionNumber - b.versionNumber,
	);
}

async function bodyOf(artifactId: string, versionNumber: number) {
	const { getVersionBody } = await import("$lib/server/services/artifacts");
	const version = (await versions(artifactId)).find(
		(v) => v.versionNumber === versionNumber,
	);
	if (!version) return null;
	return parseImageVersionBody(
		await getVersionBody({
			userId,
			artifactId,
			versionId: version.id,
			conversationId,
		}),
	);
}

describe("when a take becomes the version in use", () => {
	it("does not promote a held take on landing; releasing the hold makes Alfy's first version", async () => {
		const { settleCard, releaseHold } = await import("./cards");
		const cardId = await card();
		const take = await landedTake(cardId, { heldUntil: Date.now() + 60_000 });

		expect(await settleCard(cardId, { preferTakeId: take.id })).toEqual({
			pickedTakeId: null,
			artifactId: null,
			versionNumber: null,
		});
		expect((await cardRow(cardId))?.artifactId).toBeNull();

		await releaseHold(take.id);
		const row = await cardRow(cardId);
		expect(row?.pickedTakeId).toBe(take.id);
		expect(row?.artifactId).toBeTruthy();
		const list = await versions(row?.artifactId ?? "");
		expect(list).toHaveLength(1);
		expect(list[0]?.author).toBe("alfy");
		expect(list[0]?.summary).toBe("Alfy made the picture");
		expect((await takeRow(take.id))?.versionNumber).toBe(1);
		expect((await takeRow(take.id))?.heldUntil).toBeNull();
	});

	it("starts a photo's item with the person's photo, then Alfy's change", async () => {
		const { settleCard } = await import("./cards");
		const upload = await storeFile("input", "#aa5533");
		const cardId = await card("photo");
		const take = await landedTake(cardId, {
			request: request({
				mode: "edit",
				baseFromUpload: true,
				inputs: [{ fileId: upload.id, role: "base", name: "photo.jpg" }],
				anchor: { fileId: upload.id, chainSinceAnchor: 0 },
			}),
			measures: {
				chainSinceAnchor: 1,
				anchorIsResult: false,
			} as StoredTakeMeasures,
		});

		const settled = await settleCard(cardId, { preferTakeId: take.id });
		expect(settled.versionNumber).toBe(2);
		const list = await versions(settled.artifactId ?? "");
		expect(list.map((v) => [v.versionNumber, v.author, v.summary])).toEqual([
			[1, "user", "The user's photo"],
			[2, "alfy", "Alfy changed the picture"],
		]);
		// Version 1 is the canvas-sized copy the take was made from; the upload
		// itself is the chat attachment and is never touched.
		const first = await bodyOf(settled.artifactId ?? "", 1);
		expect(first?.fileId).toBe(upload.id);
		expect(first?.prompt).toBeNull();
		expect(first?.takeId).toBeNull();
		expect(first?.anchorFileId).toBe(upload.id);
		const second = await bodyOf(settled.artifactId ?? "", 2);
		expect(second?.baseFileId).toBe(upload.id);
		expect(second?.anchorFileId).toBe(upload.id);
		expect(second?.chainSinceAnchor).toBe(1);
	});

	it("gives four takes landing together one pick (show me four)", async () => {
		const { settleCard } = await import("./cards");
		const cardId = await card();
		const takes = [];
		for (let i = 0; i < 4; i++)
			takes.push(await landedTake(cardId, { seed: i }));

		const results = await Promise.all(
			takes.map((take) => settleCard(cardId, { preferTakeId: take.id })),
		);
		const row = await cardRow(cardId);
		expect(row?.artifactId).toBeTruthy();
		expect(await versions(row?.artifactId ?? "")).toHaveLength(1);
		const numbered = [];
		for (const take of takes) {
			if ((await takeRow(take.id))?.versionNumber !== null)
				numbered.push(take.id);
		}
		expect(numbered).toEqual([row?.pickedTakeId]);
		expect(
			new Set(results.map((r) => r.pickedTakeId).filter(Boolean)).size,
		).toBe(1);
		const { db } = await import("$lib/server/db");
		const items = db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.conversationId, conversationId))
			.all();
		expect(items).toHaveLength(1);
	});

	it("prefers the named take over an older one, and never picks a hidden take", async () => {
		const { settleCard, hideTake } = await import("./cards");
		const cardId = await card();
		const older = await landedTake(cardId);
		const newer = await landedTake(cardId);
		await settleCard(cardId, { preferTakeId: newer.id });
		expect((await cardRow(cardId))?.pickedTakeId).toBe(newer.id);

		const other = await card();
		const hidden = await landedTake(other);
		const shown = await landedTake(other);
		await hideTake(hidden.id);
		await settleCard(other);
		expect((await cardRow(other))?.pickedTakeId).toBe(shown.id);

		await expect(hideTake(newer.id)).rejects.toThrow();
		expect((await takeRow(newer.id))?.hidden).toBe(0);
		expect((await takeRow(older.id))?.versionNumber).toBeNull();
	});

	it("leaves the item gone when the Image item was deleted while a take rendered", async () => {
		const { settleCard } = await import("./cards");
		const { deleteLibraryArtifact } = await import(
			"$lib/server/services/artifacts"
		);
		const firstCard = await card();
		const first = await landedTake(firstCard);
		const made = await settleCard(firstCard);
		const artifactId = made.artifactId ?? "";

		const changeCard = await card("change", artifactId);
		const late = await landedTake(changeCard);
		await deleteLibraryArtifact(userId, artifactId);
		expect((await cardRow(changeCard))?.artifactId).toBeNull();

		await expect(
			settleCard(changeCard, { preferTakeId: late.id }),
		).resolves.toEqual({
			pickedTakeId: null,
			artifactId: null,
			versionNumber: null,
		});
		const row = await cardRow(changeCard);
		expect(row?.artifactId).toBeNull();
		expect(row?.pickedTakeId).toBeNull();
		const { db } = await import("$lib/server/db");
		expect(
			db
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.conversationId, conversationId))
				.all(),
		).toHaveLength(0);
		expect(first.id).toBeTruthy();
	});

	it("brings nothing back and leaves no file when the whole chat went", async () => {
		const { settleCard } = await import("./cards");
		const { db } = await import("$lib/server/db");
		const { deleteImageFilesForConversation } = await import("./files");
		const cardId = await card();
		const take = await landedTake(cardId);
		await deleteImageFilesForConversation(conversationId);
		db.delete(schema.conversations)
			.where(eq(schema.conversations.id, conversationId))
			.run();

		await expect(
			settleCard(cardId, { preferTakeId: take.id }),
		).resolves.toEqual({
			pickedTakeId: null,
			artifactId: null,
			versionNumber: null,
		});
		expect(db.select().from(schema.artifacts).all()).toHaveLength(0);
		expect(
			existsSync(join(workdir, "data", "image-files", conversationId)),
		).toBe(false);
	});
});

describe("picking and replacing", () => {
	it("appends the person's pick as a version and moves the pick", async () => {
		const { settleCard, useTake } = await import("./cards");
		const cardId = await card();
		const a = await landedTake(cardId);
		const b = await landedTake(cardId);
		const settled = await settleCard(cardId, { preferTakeId: a.id });

		expect(await useTake({ userId, takeId: a.id })).toEqual({
			ok: false,
			reason: "already_in_use",
		});
		const used = await useTake({ userId, takeId: b.id, conversationId });
		expect(used).toEqual({ ok: true, versionNumber: 2 });
		expect((await cardRow(cardId))?.pickedTakeId).toBe(b.id);
		const list = await versions(settled.artifactId ?? "");
		expect(list[1]?.author).toBe("user");
		expect(list[1]?.summary).toBe("Picked another take");
		expect(
			classifyVersionSummary({
				author: "user",
				summary: list[1]?.summary ?? "",
				versionNumber: 2,
			}).kind,
		).toBe("picked_take");
		expect((await takeRow(b.id))?.versionNumber).toBe(2);
	});

	it("answers useTake with the reason", async () => {
		const { useTake } = await import("./cards");
		const cardId = await card();
		const held = await landedTake(cardId, { heldUntil: Date.now() + 60_000 });
		expect(await useTake({ userId: "someone", takeId: held.id })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await useTake({ userId, takeId: "nope" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await useTake({ userId, takeId: held.id })).toEqual({
			ok: false,
			reason: "not_ready",
		});
	});

	it("settles a card that has no pick when a take is used", async () => {
		const { useTake } = await import("./cards");
		const cardId = await card();
		const take = await landedTake(cardId);
		expect(await useTake({ userId, takeId: take.id })).toEqual({
			ok: true,
			versionNumber: 1,
		});
		expect((await cardRow(cardId))?.pickedTakeId).toBe(take.id);
	});

	it("replaces the pick with Alfy's retry, keeps both versions and hides the old take", async () => {
		const { settleCard, replacePick } = await import("./cards");
		const cardId = await card();
		const old = await landedTake(cardId, {
			request: request({ summary: "Warmer light" }),
		});
		const settled = await settleCard(cardId, { preferTakeId: old.id });
		const retry = await landedTake(cardId);

		expect(await replacePick({ cardId, takeId: retry.id })).toEqual({
			versionNumber: 2,
		});
		expect((await cardRow(cardId))?.pickedTakeId).toBe(retry.id);
		expect((await takeRow(old.id))?.hidden).toBe(1);
		const list = await versions(settled.artifactId ?? "");
		expect(list.map((v) => [v.author, v.summary])).toEqual([
			["alfy", "Warmer light"],
			["alfy", "Warmer light"],
		]);
	});
});

describe("the boot sweep", () => {
	it("promotes a take whose hold ran out and leaves one still held", async () => {
		const { settleHeldCards } = await import("./cards");
		const expired = await card();
		const stillHeld = await card();
		await landedTake(expired, { heldUntil: Date.now() - 1000 });
		await landedTake(stillHeld, { heldUntil: Date.now() + 60_000 });

		expect(await settleHeldCards()).toBe(1);
		expect((await cardRow(expired))?.pickedTakeId).toBeTruthy();
		expect((await cardRow(stillHeld))?.pickedTakeId).toBeNull();
	});
});

describe("the version body", () => {
	it("carries the base, references, marks, prompt, seed and take", async () => {
		const { versionBodyForTake } = await import("./cards");
		const file = await storeFile("take");
		const body = versionBodyForTake(
			{
				id: "take-9",
				seed: 99,
				request: request({
					mode: "edit",
					prompt: "make the sofa red",
					inputs: [
						{ fileId: "base-1", role: "base", name: "room.png" },
						{ fileId: "ref-1", role: "reference", name: "sofa.png" },
					],
					marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
					anchor: { fileId: "anchor-1", chainSinceAnchor: 1 },
				}),
				measures: {
					chainSinceAnchor: 2,
					anchorIsResult: false,
				} as StoredTakeMeasures,
			},
			file,
		);
		expect(body).toMatchObject({
			fileId: file.id,
			baseFileId: "base-1",
			sources: [{ fileId: "ref-1", name: "sofa.png" }],
			marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
			prompt: "make the sofa red",
			seed: 99,
			takeId: "take-9",
			anchorFileId: "anchor-1",
			chainSinceAnchor: 2,
		});
	});

	it("makes the take's own file the anchor on a global change, and a new picture its own anchor", async () => {
		const { versionBodyForTake } = await import("./cards");
		const file = await storeFile("take");
		const edit = versionBodyForTake(
			{
				id: "t",
				seed: 1,
				request: request({
					mode: "edit",
					inputs: [{ fileId: "base-1", role: "base", name: "a" }],
					anchor: { fileId: "anchor-1", chainSinceAnchor: 3 },
				}),
				measures: {
					chainSinceAnchor: 0,
					anchorIsResult: true,
				} as StoredTakeMeasures,
			},
			file,
		);
		expect([edit.anchorFileId, edit.chainSinceAnchor]).toEqual([file.id, 0]);
		const fresh = versionBodyForTake(
			{ id: "t2", seed: 1, request: request(), measures: null },
			file,
		);
		expect([fresh.anchorFileId, fresh.chainSinceAnchor]).toEqual([file.id, 0]);
	});
});
