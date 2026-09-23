import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Guided Memory Review queue behavior for judge-inferred items: every review
// action (Accept / Edit / Remove) must move the underlying review_needed item
// out of review_needed, so nothing is left orphaned in the queue's item state.

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

const DAY_MS = 86_400_000;

/**
 * Seed a review item shaped exactly like the ones the Memory Judge opened in
 * production before this fix: a review_needed item with judge metadata, a
 * conversation provenance row, a 30-day review auto-expiry, and a `judge:`
 * review row carrying NO metadata (so no proposedStatement / category).
 */
async function seedLegacyShapedJudgeReview(params: {
	statement: string;
	category: "about_you" | "preferences" | "goals_ongoing_work";
	scope?: { type: "global" } | { type: "project"; id: string };
	itemMetadata?: Record<string, unknown>;
}) {
	const {
		addMemoryProfileItemProvenance,
		createMemoryProfileItem,
		setMemoryProfileItemMetadataAndExpiry,
	} = await import("./projection-store");
	const { createOrUpdateMemoryReviewItem } = await import("./review");
	const item = await createMemoryProfileItem({
		userId: "user-1",
		category: params.category,
		scope: params.scope ?? { type: "global" },
		statement: params.statement,
		status: "review_needed",
	});
	await setMemoryProfileItemMetadataAndExpiry({
		userId: "user-1",
		itemId: item.id,
		metadataJson: JSON.stringify(
			params.itemMetadata ?? {
				confidence: "inferred",
				expiryClass: "durable",
				origin: "judge_v1",
			},
		),
		expiresAt: new Date(Date.now() + 30 * DAY_MS),
	});
	await addMemoryProfileItemProvenance({
		userId: "user-1",
		itemId: item.id,
		sourceType: "conversation",
		sourceId: "conv-1",
		label: "Conversation",
		summary: "mentioned it",
	});
	const review = await createOrUpdateMemoryReviewItem({
		userId: "user-1",
		subjectKey: `judge:${item.itemKey}`,
		subjectLabel: params.statement,
		question: "Should I keep remembering this?",
		reason: "Inferred from conversation, not stated directly.",
		affectedItemIds: [item.id],
	});
	return { item, review };
}

async function readItem(itemId: string) {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select()
		.from(schema.memoryProfileItems)
		.where(eq(schema.memoryProfileItems.id, itemId));
	return row;
}

async function listItems() {
	const { db } = await import("$lib/server/db");
	return db
		.select()
		.from(schema.memoryProfileItems)
		.where(eq(schema.memoryProfileItems.userId, "user-1"));
}

async function countProvenance(itemId: string) {
	const { db } = await import("$lib/server/db");
	const rows = await db
		.select()
		.from(schema.memoryProfileItemProvenance)
		.where(
			and(
				eq(schema.memoryProfileItemProvenance.userId, "user-1"),
				eq(schema.memoryProfileItemProvenance.itemId, itemId),
			),
		);
	return rows.length;
}

describe("guided memory review queue for judge items", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-review-queue-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "review-queue@example.com",
				passwordHash: "hash",
				name: "Review Queue User",
			})
			.run();
		sqlite.close();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported in a failed test.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("offers Accept on a judge review row and promotes the item in place with its category, scope, and provenance", async () => {
		const { item } = await seedLegacyShapedJudgeReview({
			statement: "I am learning Irish.",
			category: "goals_ongoing_work",
			scope: { type: "project", id: "project-1" },
		});
		const { getMemoryProfileReadModel } = await import("./read-model");
		const { applyMemoryReviewItemWithRevision } = await import("./review");

		const before = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(before.review.visibleItems).toEqual([
			expect.objectContaining({
				subject: "I am learning Irish.",
				canAccept: true,
			}),
		]);

		const result = await applyMemoryReviewItemWithRevision({
			userId: "user-1",
			reviewItemId: before.review.visibleItems[0]?.id ?? "",
			expectedProjectionRevision: before.projectionRevision,
			action: "accept",
		});
		expect(result).toEqual({
			status: "updated",
			projectionRevision: before.projectionRevision + 1,
			itemId: item.id,
			category: "goals_ongoing_work",
		});

		const row = await readItem(item.id);
		expect(row?.status).toBe("active");
		expect(row?.category).toBe("goals_ongoing_work");
		expect(row?.scopeType).toBe("project");
		expect(row?.scopeId).toBe("project-1");
		// A durable fact leaves the 30-day review window once accepted.
		expect(row?.expiresAt).toBeNull();
		// Provenance stays honest (judge_v1) while the explicit endorsement
		// marker makes the accepted fact user-protected.
		expect(JSON.parse(row?.metadataJson ?? "{}")).toMatchObject({
			origin: "judge_v1",
			confidence: "inferred",
			reviewResolution: "accepted",
			endorsement: "user_accepted",
			userConfirmedAt: expect.any(String),
		});
		const { isUserAuthoredMemoryMetadata, isUserProtectedMemoryMetadata } =
			await import("./types");
		expect(isUserAuthoredMemoryMetadata(row?.metadataJson)).toBe(false);
		expect(isUserProtectedMemoryMetadata(row?.metadataJson)).toBe(true);
		expect(await countProvenance(item.id)).toBe(1);
		expect(await listItems()).toHaveLength(1);

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.openCount).toBe(0);
	});

	it("applies the item's own factual horizon when a time_bound judge item is accepted", async () => {
		const { item, review } = await seedLegacyShapedJudgeReview({
			statement: "I am looking for a flat in Limerick.",
			category: "goals_ongoing_work",
			itemMetadata: {
				confidence: "inferred",
				expiryClass: "time_bound",
				origin: "judge_v1",
				expiresInDays: 90,
			},
		});
		const { getMemoryProfileReadModel } = await import("./read-model");
		const { applyMemoryReviewItemWithRevision } = await import("./review");
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await applyMemoryReviewItemWithRevision({
			userId: "user-1",
			reviewItemId: review.id,
			expectedProjectionRevision: before.projectionRevision,
			action: "accept",
		});

		const row = await readItem(item.id);
		expect(row?.status).toBe("active");
		const expiresMs = (row?.expiresAt as Date).getTime();
		expect(Math.abs(expiresMs - (Date.now() + 90 * DAY_MS))).toBeLessThan(
			DAY_MS,
		);
	});

	it("Remove moves the judge item out of review_needed instead of orphaning it", async () => {
		const { item, review } = await seedLegacyShapedJudgeReview({
			statement: "I am tired of meetings.",
			category: "about_you",
		});
		const { getActiveMemoryProfileContext } = await import("./active-context");
		const { getMemoryProfileReadModel } = await import("./read-model");
		const { applyMemoryReviewItemWithRevision } = await import("./review");
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "dismiss",
			}),
		).resolves.toMatchObject({ status: "updated", itemId: null });

		const row = await readItem(item.id);
		expect(row?.status).toBe("suppressed");
		expect(row?.suppressedAt).not.toBeNull();
		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.openCount).toBe(0);
		await expect(
			getActiveMemoryProfileContext({ userId: "user-1" }),
		).resolves.toMatchObject({ items: [] });
	});

	it("Edit replaces the original: one active item in the original category/scope, original retired and pointing at it", async () => {
		const { item, review } = await seedLegacyShapedJudgeReview({
			statement: "I like hiking.",
			// A statement the old category guesser would have filed under
			// preferences ("prefer"); the original category must win.
			category: "about_you",
			scope: { type: "project", id: "project-9" },
		});
		const { getMemoryProfileReadModel } = await import("./read-model");
		const { applyMemoryReviewItemWithRevision } = await import("./review");
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		const result = await applyMemoryReviewItemWithRevision({
			userId: "user-1",
			reviewItemId: review.id,
			expectedProjectionRevision: before.projectionRevision,
			action: "edit",
			statement: "I prefer hiking in the mountains.",
		});
		expect(result).toMatchObject({
			status: "updated",
			category: "about_you",
		});
		const editedId = result.status === "updated" ? result.itemId : null;
		expect(editedId).toEqual(expect.any(String));
		expect(editedId).not.toBe(item.id);

		const items = await listItems();
		const active = items.filter((row) => row.status === "active");
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			id: editedId,
			statement: "I prefer hiking in the mountains.",
			category: "about_you",
			scopeType: "project",
			scopeId: "project-9",
		});
		expect(active[0]?.expiresAt).toBeNull();
		expect(JSON.parse(active[0]?.metadataJson ?? "{}")).toMatchObject({
			origin: "user_authored",
		});
		// Provenance of the original travels with the replacement.
		expect(await countProvenance(editedId as string)).toBe(1);

		const original = await readItem(item.id);
		expect(original?.status).toBe("retired");
		expect(JSON.parse(original?.metadataJson ?? "{}")).toMatchObject({
			supersededBy: editedId,
			retiredReason: "review_edited",
		});
		expect(items.some((row) => row.status === "review_needed")).toBe(false);

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.openCount).toBe(0);
	});

	it("Accept with a curated proposed statement retires the stale original instead of leaving it in review_needed", async () => {
		const { createMemoryProfileItem, setMemoryProfileItemMetadataAndExpiry } =
			await import("./projection-store");
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
		} = await import("./review");
		const { getMemoryProfileReadModel } = await import("./read-model");
		const original = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "user likes terse answers maybe",
			status: "review_needed",
		});
		await setMemoryProfileItemMetadataAndExpiry({
			userId: "user-1",
			itemId: original.id,
			metadataJson: JSON.stringify({
				source: "legacy_memory_curation",
				legacyCurationDecision: "review",
			}),
		});
		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "legacy-memory-curation:terse",
			subjectLabel: "Prefers terse answers.",
			question: "Should AlfyAI remember this?",
			reason: "Legacy memory needs confirmation before becoming active.",
			affectedItemIds: [original.id],
			metadata: {
				source: "legacy_memory_curation",
				category: "preferences",
				proposedStatement: "Prefers terse answers.",
			},
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		const result = await applyMemoryReviewItemWithRevision({
			userId: "user-1",
			reviewItemId: review.id,
			expectedProjectionRevision: before.projectionRevision,
			action: "accept",
		});
		const acceptedId = result.status === "updated" ? result.itemId : null;

		const items = await listItems();
		expect(items.filter((row) => row.status === "active")).toEqual([
			expect.objectContaining({
				id: acceptedId,
				statement: "Prefers terse answers.",
				category: "preferences",
			}),
		]);
		expect(
			JSON.parse((await readItem(acceptedId as string))?.metadataJson ?? "{}"),
		).toMatchObject({ endorsement: "user_accepted" });
		const stale = await readItem(original.id);
		expect(stale?.status).toBe("retired");
		expect(JSON.parse(stale?.metadataJson ?? "{}")).toMatchObject({
			supersededBy: acceptedId,
		});
	});

	it("keeps same-statement judge reviews in different scopes as separate cards; accepting one leaves the other", async () => {
		const { createOrUpdateMemoryReviewItem } = await import("./review");
		const judgeMetadata = {
			source: "memory_judge",
			category: "goals_ongoing_work",
			proposedStatement: "I am learning Irish.",
			expiryClass: "durable",
		};
		const global = await seedLegacyShapedJudgeReview({
			statement: "I am learning Irish.",
			category: "goals_ongoing_work",
		});
		const project = await seedLegacyShapedJudgeReview({
			statement: "I am learning Irish.",
			category: "goals_ongoing_work",
			scope: { type: "project", id: "project-1" },
		});
		// Give both rows the metadata the judge writes today, so their category
		// and proposed statement match exactly.
		for (const seeded of [global, project]) {
			await createOrUpdateMemoryReviewItem({
				userId: "user-1",
				subjectKey: `judge:${seeded.item.itemKey}`,
				subjectLabel: "I am learning Irish.",
				question: "Should I keep remembering this?",
				reason: "Inferred from conversation, not stated directly.",
				affectedItemIds: [seeded.item.id],
				metadata: judgeMetadata,
			});
		}
		const { getMemoryProfileReadModel } = await import("./read-model");
		const { applyMemoryReviewItemWithRevision } = await import("./review");

		const before = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(before.review.openCount).toBe(2);
		expect(before.review.items.map((item) => item.id).sort()).toEqual(
			[global.review.id, project.review.id].sort(),
		);

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: global.review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "accept",
			}),
		).resolves.toMatchObject({ status: "updated", itemId: global.item.id });

		expect((await readItem(global.item.id))?.status).toBe("active");
		expect((await readItem(project.item.id))?.status).toBe("review_needed");
		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.openCount).toBe(1);
		expect(after.review.items.map((item) => item.id)).toEqual([
			project.review.id,
		]);
	});

	it("does not offer Accept for a generic review subject with no proposal and no judge item", async () => {
		const { createOrUpdateMemoryReviewItem } = await import("./review");
		const { getMemoryProfileReadModel } = await import("./read-model");
		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "post-turn-intake:document-related:x",
			subjectLabel: "Document-related memory request",
			question: "Should this be remembered?",
			reason: "The intake gate could not safely admit this automatically.",
		});
		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.review.visibleItems[0]?.canAccept).toBe(false);
	});
});
