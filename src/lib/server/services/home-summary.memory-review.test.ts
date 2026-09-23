/**
 * The home-screen "memories need review" notice count and dismissal
 * lifecycle, against a real database.
 *
 * Three things this pins:
 *  - the count is the SAME number `getMemoryProfileReadModel(...)` gives the
 *    Knowledge → Memory tab badge (no second "needs review" definition), but
 *    forced to 0 when the user's memory master toggle is off;
 *  - dismissal is per user, not per item, and does not expire on its own —
 *    it stays dismissed until an open review item NEWER than the dismissal
 *    exists;
 *  - one user's open items never leak into another user's count.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function orm() {
	return drizzle(sqlite, { schema });
}

function seedUser(userId: string, memoryEnabled = true): void {
	orm()
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			memoryEnabled,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

function seedReviewItem(params: {
	userId: string;
	subjectKey: string;
	createdAt: Date;
}): void {
	orm()
		.insert(schema.memoryReviewItems)
		.values({
			id: randomUUID(),
			userId: params.userId,
			subjectKey: params.subjectKey,
			subjectLabel: params.subjectKey,
			question: "Is this still true?",
			reason: "Two conflicting statements.",
			createdAt: params.createdAt,
			updatedAt: params.createdAt,
		})
		.run();
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-home-summary-memory-review-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(orm(), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
		try {
			unlinkSync(path);
		} catch {
			// Only -wal/-shm are ever legitimately absent.
		}
	}
	vi.resetModules();
});

async function homeSummaryModule() {
	return import("./home-summary");
}

async function summaryFor(userId: string, now: Date) {
	const { clearHomeSummaryCache, getHomeSummary } = await homeSummaryModule();
	clearHomeSummaryCache();
	return getHomeSummary({ userId, now });
}

const NOW = new Date("2026-09-10T12:00:00Z");

describe("memoryReviewCount", () => {
	it("matches the Knowledge → Memory tab's own read model", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });
		seedReviewItem({ userId, subjectKey: "b", createdAt: NOW });

		const { getMemoryProfileReadModel } = await import(
			"./memory-profile/read-model"
		);
		const profile = await getMemoryProfileReadModel({ userId });

		const summary = await summaryFor(userId, NOW);
		expect(summary.memoryReviewCount).toBe(profile.review.openCount);
		expect(summary.memoryReviewCount).toBe(2);
	});

	it("is 0 when the user has no open review items", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const summary = await summaryFor(userId, NOW);
		expect(summary.memoryReviewCount).toBe(0);
		expect(summary.memoryReviewNoticeDismissed).toBe(true);
	});

	it("is 0 when the user's memory master toggle is off, even with open items", async () => {
		const userId = randomUUID();
		seedUser(userId, false);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const summary = await summaryFor(userId, NOW);
		expect(summary.memoryReviewCount).toBe(0);
		expect(summary.memoryReviewNoticeDismissed).toBe(true);
	});

	it("never counts another user's open review items", async () => {
		const mine = randomUUID();
		const theirs = randomUUID();
		seedUser(mine);
		seedUser(theirs);
		seedReviewItem({ userId: theirs, subjectKey: "a", createdAt: NOW });
		seedReviewItem({ userId: theirs, subjectKey: "b", createdAt: NOW });
		seedReviewItem({ userId: theirs, subjectKey: "c", createdAt: NOW });

		expect((await summaryFor(mine, NOW)).memoryReviewCount).toBe(0);
		expect((await summaryFor(theirs, NOW)).memoryReviewCount).toBe(3);
	});
});

describe("memoryReviewNoticeDismissed", () => {
	it("is false (show the notice) until the user dismisses it", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const summary = await summaryFor(userId, NOW);
		expect(summary.memoryReviewCount).toBe(1);
		expect(summary.memoryReviewNoticeDismissed).toBe(false);
	});

	it("becomes true right after dismissal, with nothing new since", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const { dismissMemoryReviewNotice } = await homeSummaryModule();
		await dismissMemoryReviewNotice(userId, new Date(NOW.getTime() + 60_000));

		const summary = await summaryFor(userId, new Date(NOW.getTime() + 120_000));
		expect(summary.memoryReviewCount).toBe(1);
		expect(summary.memoryReviewNoticeDismissed).toBe(true);
	});

	it("does not expire on its own after a week, unlike the suggestion-rail event log", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const { dismissMemoryReviewNotice } = await homeSummaryModule();
		await dismissMemoryReviewNotice(userId, NOW);

		const muchLater = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
		const summary = await summaryFor(userId, muchLater);
		expect(summary.memoryReviewNoticeDismissed).toBe(true);
	});

	it("comes back once a review item newer than the dismissal appears", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const dismissedAt = new Date(NOW.getTime() + 60_000);
		const { dismissMemoryReviewNotice } = await homeSummaryModule();
		await dismissMemoryReviewNotice(userId, dismissedAt);

		// Confirmed dismissed first.
		expect(
			(await summaryFor(userId, new Date(dismissedAt.getTime() + 1_000)))
				.memoryReviewNoticeDismissed,
		).toBe(true);

		// A new review item lands after the dismissal.
		const newItemAt = new Date(dismissedAt.getTime() + 2_000);
		seedReviewItem({ userId, subjectKey: "b", createdAt: newItemAt });

		const summary = await summaryFor(
			userId,
			new Date(newItemAt.getTime() + 1_000),
		);
		expect(summary.memoryReviewCount).toBe(2);
		expect(summary.memoryReviewNoticeDismissed).toBe(false);
	});

	it("does NOT come back merely because the page was reloaded (no new item)", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedReviewItem({ userId, subjectKey: "a", createdAt: NOW });

		const { dismissMemoryReviewNotice } = await homeSummaryModule();
		await dismissMemoryReviewNotice(userId, new Date(NOW.getTime() + 60_000));

		// Two separate reads, simulating two separate page loads.
		for (const offset of [200_000, 400_000]) {
			const summary = await summaryFor(
				userId,
				new Date(NOW.getTime() + offset),
			);
			expect(summary.memoryReviewNoticeDismissed).toBe(true);
		}
	});
});
