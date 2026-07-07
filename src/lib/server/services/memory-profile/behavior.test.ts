import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

describe("memory profile foundation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-profile-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();

		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "memory-profile@example.com",
				passwordHash: "hash",
				name: "Memory Profile User",
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

	it("advances durable reset generation and rejects stale generation work", async () => {
		const {
			advanceMemoryResetGeneration,
			getCurrentMemoryResetGeneration,
			isCurrentMemoryResetGeneration,
		} = await import("./index");

		await expect(getCurrentMemoryResetGeneration("user-1")).resolves.toBe(0);

		const generation = await advanceMemoryResetGeneration("user-1");

		expect(generation).toBe(1);
		await expect(getCurrentMemoryResetGeneration("user-1")).resolves.toBe(1);
		await expect(
			isCurrentMemoryResetGeneration({
				userId: "user-1",
				resetGeneration: 0,
			}),
		).resolves.toBe(false);
		await expect(
			isCurrentMemoryResetGeneration({
				userId: "user-1",
				resetGeneration: 1,
			}),
		).resolves.toBe(true);
	});

	it("returns a public active profile read model with source chips and no raw memory rows", async () => {
		const {
			addMemoryProfileItemProvenance,
			createMemoryProfileItem,
			getMemoryProfileItemDetail,
			getMemoryProfileReadModel,
		} = await import("./index");

		const emptyProfile = await getMemoryProfileReadModel({ userId: "user-1" });

		expect(emptyProfile.categories.map((group) => group.category)).toEqual([
			"about_you",
			"preferences",
			"goals_ongoing_work",
			"constraints_boundaries",
		]);
		expect(emptyProfile.categories.flatMap((group) => group.items)).toEqual([]);
		expect(emptyProfile.review.visibleItems).toEqual([]);

		const activeItem = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers concise technical answers.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Suppressed sensitive profile fact.",
			status: "suppressed",
		});
		await addMemoryProfileItemProvenance({
			userId: "user-1",
			itemId: activeItem.id,
			sourceType: "user_statement",
			sourceId: "message-1",
			label: "Chat",
			summary: "User said this directly.",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const publicJson = JSON.stringify(profile);

		expect(profile.projectionRevision).toBe(2);
		expect(profile.categories[1]?.items).toEqual([
			expect.objectContaining({
				id: activeItem.id,
				category: "preferences",
				statement: "Prefers concise technical answers.",
				scope: { type: "global" },
				revision: 0,
			}),
		]);
		expect(publicJson).not.toContain("Suppressed sensitive profile fact");
		expect(publicJson).not.toContain("debug");

		const detail = await getMemoryProfileItemDetail({
			userId: "user-1",
			itemId: activeItem.id,
		});

		expect(detail).toEqual(
			expect.objectContaining({
				id: activeItem.id,
				sourceChips: [
					{
						id: expect.any(String),
						sourceType: "user_statement",
						label: "Chat",
						summary: "User said this directly.",
					},
				],
			}),
		);
	});

	it("exposes confidence, expiry class and expiresAt on card items and review expiry", async () => {
		const { createMemoryProfileItem, createOrUpdateMemoryReviewItem } =
			await import("./index");
		const { getMemoryProfileReadModel } = await import("./read-model");

		const statedItem = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers dark roast coffee.",
		});
		const inferredItem = await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "global" },
			statement: "Working toward a spring launch.",
		});
		const reviewNeededItem = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Might be moving to Berlin.",
			status: "review_needed",
		});

		const statedExpiry = new Date("2026-09-01T00:00:00.000Z");
		const reviewExpiry = new Date("2026-08-06T00:00:00.000Z");
		const { sqlite, db } = openSeedDatabase();
		db.update(schema.memoryProfileItems)
			.set({
				metadataJson: JSON.stringify({
					confidence: "stated",
					expiryClass: "time_bound",
				}),
				expiresAt: statedExpiry,
			})
			.where(eq(schema.memoryProfileItems.id, statedItem.id))
			.run();
		db.update(schema.memoryProfileItems)
			.set({
				metadataJson: JSON.stringify({
					confidence: "inferred",
					expiryClass: "durable",
				}),
			})
			.where(eq(schema.memoryProfileItems.id, inferredItem.id))
			.run();
		db.update(schema.memoryProfileItems)
			.set({ expiresAt: reviewExpiry })
			.where(eq(schema.memoryProfileItems.id, reviewNeededItem.id))
			.run();
		sqlite.close();

		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "judge:berlin-move",
			subjectLabel: "Might be moving to Berlin.",
			question: "Should I keep remembering this?",
			reason: "Inferred from conversation, not stated directly.",
			affectedItemIds: [reviewNeededItem.id],
			metadata: {
				category: "about_you",
				proposedStatement: "Might be moving to Berlin.",
			},
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const items = profile.categories.flatMap((group) => group.items);
		const stated = items.find((item) => item.id === statedItem.id);
		const inferred = items.find((item) => item.id === inferredItem.id);

		expect(stated).toMatchObject({
			confidence: "stated",
			expiryClass: "time_bound",
		});
		expect(stated?.expiresAt?.toISOString()).toBe(statedExpiry.toISOString());
		expect(inferred).toMatchObject({
			confidence: "inferred",
			expiryClass: "durable",
			expiresAt: null,
		});
		expect(profile.review.visibleItems[0]?.expiresAt).toBe(
			reviewExpiry.toISOString(),
		);
	});

	it("replaces the user id and legacy internal peer ids with the display name in profile and review text", async () => {
		const {
			createMemoryProfileItem,
			createOrUpdateMemoryReviewItem,
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
		} = await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "user-1 prefers concise answers.",
		});
		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "peer-id-review",
			subjectLabel: "Peer id review",
			question: "Should AlfyAI remember this?",
			reason: "Needs user confirmation before becoming active memory.",
			metadata: {
				category: "preferences",
				proposedStatement:
					"U-86dc59c7f2 prefers memory profile wording without raw ids.",
			},
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement:
				"U_86dc59c07f598be7de4c127cbf0da318 prefers cards without raw ids.",
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const serialized = JSON.stringify(profile);
		const preferenceStatements =
			profile.categories[1]?.items.map((item) => item.statement) ?? [];

		expect(preferenceStatements).toEqual(
			expect.arrayContaining([
				"Memory Profile User prefers concise answers.",
				"Memory Profile User prefers cards without raw ids.",
			]),
		);
		expect(profile.review.visibleItems[0]?.subject).toBe(
			"Memory Profile User prefers memory profile wording without raw ids.",
		);
		expect(serialized).not.toContain("user-1 prefers");
		expect(serialized).not.toContain("U-86dc59c7f2");
		expect(serialized).not.toContain("U_86dc59c07f598be7de4c127cbf0da318");

		const activeContext = await getActiveMemoryProfileContext({
			userId: "user-1",
		});
		const activeContextJson = JSON.stringify(activeContext);
		expect(activeContext.items.map((item) => item.statement)).toEqual(
			expect.arrayContaining([
				"Memory Profile User prefers concise answers.",
				"Memory Profile User prefers cards without raw ids.",
			]),
		);
		expect(activeContextJson).not.toContain("U-86dc59c7f2");
		expect(activeContextJson).not.toContain(
			"U_86dc59c07f598be7de4c127cbf0da318",
		);
	});

	it("keeps one active profile item for duplicate creates with the same stable item key", async () => {
		const { createMemoryProfileItem, getMemoryProfileReadModel } = await import(
			"./index"
		);

		const first = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers concise technical answers.",
		});
		const duplicate = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "  prefers   concise technical answers.  ",
		});

		expect(duplicate.id).toBe(first.id);
		expect(duplicate.itemKey).toBe(first.itemKey);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[1]?.items).toEqual([
			expect.objectContaining({
				id: first.id,
				statement: "Prefers concise technical answers.",
			}),
		]);
		expect(profile.projectionRevision).toBe(1);
	});

	it("does not silently revive suppressed or deleted items on duplicate create", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		const suppressed = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers short status updates.",
			slotKey: "memory-slot:test:suppressed-status-updates",
			status: "suppressed",
		});
		const duplicateSuppressed = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers short status updates.",
			slotKey: "memory-slot:test:suppressed-status-updates",
		});

		expect(duplicateSuppressed).toEqual(
			expect.objectContaining({
				id: suppressed.id,
				itemKey: suppressed.itemKey,
				status: "suppressed",
			}),
		);

		const active = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Amsterdam.",
			slotKey: "memory-slot:test:home-city",
		});
		const profileBeforeDelete = await getMemoryProfileReadModel({
			userId: "user-1",
		});
		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: active.id,
				expectedProjectionRevision: profileBeforeDelete.projectionRevision,
				patch: { status: "deleted" },
			}),
		).resolves.toEqual({
			status: "updated",
			projectionRevision: profileBeforeDelete.projectionRevision + 1,
		});

		const duplicateDeleted = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Amsterdam.",
			slotKey: "memory-slot:test:home-city",
		});

		expect(duplicateDeleted).toEqual(
			expect.objectContaining({
				id: active.id,
				itemKey: active.itemKey,
				status: "deleted",
			}),
		);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories.flatMap((group) => group.items)).toEqual([]);
	});

	it("rejects stale projection writes without overwriting newer profile state", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		const item = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Budapest.",
		});
		const firstRead = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: item.id,
				expectedProjectionRevision: firstRead.projectionRevision,
				patch: { statement: "Lives in Amsterdam." },
			}),
		).resolves.toEqual({ status: "updated", projectionRevision: 2 });

		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: item.id,
				expectedProjectionRevision: firstRead.projectionRevision,
				patch: { statement: "Lives in Rotterdam." },
			}),
		).resolves.toEqual({ status: "stale_projection" });

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[0]?.items[0]?.statement).toBe(
			"Lives in Amsterdam.",
		);
		expect(profile.projectionRevision).toBe(2);

		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: item.id,
				expectedProjectionRevision: profile.projectionRevision,
				patch: { status: "suppressed" },
			}),
		).resolves.toEqual({ status: "updated", projectionRevision: 3 });
		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: item.id,
				expectedProjectionRevision: profile.projectionRevision,
				patch: { statement: "Lives in Rotterdam.", status: "active" },
			}),
		).resolves.toEqual({ status: "stale_projection" });
		const suppressedProfile = await getMemoryProfileReadModel({
			userId: "user-1",
		});
		expect(suppressedProfile.categories[0]?.items).toEqual([]);
		expect(suppressedProfile.projectionRevision).toBe(3);
	});

	it("rekeys full profile edits so old and new statements dedupe to the correct rows", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		const edited = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers old answer style.",
		});
		const beforeEdit = await getMemoryProfileReadModel({ userId: "user-1" });
		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: edited.id,
				expectedProjectionRevision: beforeEdit.projectionRevision,
				patch: { statement: "Prefers new answer style." },
			}),
		).resolves.toMatchObject({ status: "updated" });

		const recreatedOld = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers old answer style.",
		});
		const duplicateNew = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers new answer style.",
		});

		expect(recreatedOld.id).not.toBe(edited.id);
		expect(duplicateNew.id).toBe(edited.id);

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(
			profile.categories[1]?.items.map((item) => item.statement).sort(),
		).toEqual(["Prefers new answer style.", "Prefers old answer style."]);
	});

	it("rejects profile edits that would collide with another active item's key", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		const source = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers original answer style.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers existing answer style.",
		});
		const beforeEdit = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: source.id,
				expectedProjectionRevision: beforeEdit.projectionRevision,
				patch: { statement: "Prefers existing answer style." },
			}),
		).resolves.toEqual({ status: "not_found" });

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.projectionRevision).toBe(beforeEdit.projectionRevision);
		expect(
			after.categories[1]?.items.map((item) => item.statement).sort(),
		).toEqual([
			"Prefers existing answer style.",
			"Prefers original answer style.",
		]);
	});

	it("dedupes review items, coalesces dirty work, and records fixed-family telemetry without raw text", async () => {
		const {
			MEMORY_DIRTY_REASONS,
			MEMORY_REVIEW_RESOLUTION_TYPES,
			MEMORY_REWORK_TELEMETRY_FAMILIES,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			recordMemoryReworkTelemetry,
			resolveMemoryReviewItem,
		} = await import("./index");

		expect(MEMORY_REVIEW_RESOLUTION_TYPES).toEqual([
			"use_fact",
			"edit_fact",
			"do_not_remember",
		]);
		expect(MEMORY_DIRTY_REASONS).toContain("possible_conflict");
		expect(MEMORY_DIRTY_REASONS).toContain("projection_reconciliation");
		expect(MEMORY_REWORK_TELEMETRY_FAMILIES).toContain("guided_review");

		const firstReview = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "home-city",
			subjectLabel: "home city",
			question: "Which home city should AlfyAI remember?",
			reason: "Conflicting profile evidence.",
			evidence: [{ sourceId: "message-1", sourceType: "chat" }],
		});
		const secondReview = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "home-city",
			subjectLabel: "home city",
			question: "Which home city should AlfyAI remember?",
			reason: "New conflicting evidence.",
			evidence: [{ sourceId: "message-2", sourceType: "chat" }],
		});

		expect(secondReview.id).toBe(firstReview.id);
		expect(secondReview.evidenceCount).toBe(2);
		expect(
			(await getMemoryProfileReadModel({ userId: "user-1" })).review
				.visibleItems,
		).toHaveLength(1);

		await resolveMemoryReviewItem({
			userId: "user-1",
			reviewItemId: firstReview.id,
			resolutionType: "do_not_remember",
		});
		expect(
			(await getMemoryProfileReadModel({ userId: "user-1" })).review
				.visibleItems,
		).toEqual([]);

		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_conflict",
			scope: { type: "global" },
			metadata: { subjectId: "home-city" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_conflict",
			scope: { type: "global" },
			metadata: { subjectId: "home-city" },
		});
		const dirtyEntries = await listPendingMemoryDirtyEntries({
			userId: "user-1",
		});
		expect(dirtyEntries).toEqual([
			expect.objectContaining({
				reason: "possible_conflict",
				count: 2,
				metadata: { subjectId: "home-city" },
			}),
		]);

		await recordMemoryReworkTelemetry({
			userId: "user-1",
			eventFamily: "guided_review",
			eventName: "review_resolved",
			category: "about_you",
			reason: "user_resolution",
			status: "resolved",
			count: 1,
			durationMs: 25,
			subjectId: "home-city",
			metadata: { resolutionType: "do_not_remember" },
		});
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		const telemetryJson = JSON.stringify(telemetry);
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "guided_review",
				eventName: "review_resolved",
				category: "about_you",
				metadata: { resolutionType: "do_not_remember" },
			}),
		]);
		expect(telemetryJson).not.toContain("raw");
		expect(telemetryJson).not.toContain("prompt excerpt");
		expect(telemetryJson).not.toContain("chat excerpt");
	});

	it("accepts an open review item into the active profile and closes the review", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "preferred-language",
			subjectLabel: "Prefers Hungarian labels.",
			question: "Should this be remembered?",
			reason: "Repeated user preference.",
			metadata: {
				category: "preferences",
				proposedStatement: "Prefers Hungarian labels.",
			},
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "accept",
			}),
		).resolves.toEqual({
			status: "updated",
			projectionRevision: before.projectionRevision + 1,
			itemId: expect.any(String),
			category: "preferences",
		});

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.visibleItems).toEqual([]);
		expect(after.categories[1]?.items).toEqual([
			expect.objectContaining({
				category: "preferences",
				statement: "Prefers Hungarian labels.",
			}),
		]);
		expect(after.projectionRevision).toBe(before.projectionRevision + 1);
	});

	it("recomputes expiresAt from expiresInDays when a time_bound review item is accepted", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "mentoring-time-bound",
			subjectLabel: "I am mentoring a colleague this quarter.",
			question: "Should I keep remembering this?",
			reason: "Inferred from conversation, not stated directly.",
			metadata: {
				category: "goals_ongoing_work",
				proposedStatement: "I am mentoring a colleague this quarter.",
				expiryClass: "time_bound",
				expiresInDays: 90,
			},
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		const applied = await applyMemoryReviewItemWithRevision({
			userId: "user-1",
			reviewItemId: review.id,
			expectedProjectionRevision: before.projectionRevision,
			action: "accept",
		});
		expect(applied).toMatchObject({ status: "updated" });
		expect(applied.status).toBe("updated");
		const itemId = applied.status === "updated" ? applied.itemId : null;
		expect(itemId).toEqual(expect.any(String));

		const { db } = await import("$lib/server/db");
		const [row] = await db
			.select({
				status: schema.memoryProfileItems.status,
				expiresAt: schema.memoryProfileItems.expiresAt,
			})
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, itemId as string));
		expect(row?.status).toBe("active");
		expect(row?.expiresAt).not.toBeNull();
		const expiresMs = (row?.expiresAt as Date).getTime();
		const expected90d = Date.now() + 90 * 86_400_000;
		expect(Math.abs(expiresMs - expected90d)).toBeLessThan(5 * 86_400_000);
	});

	it("shows the proposed memory text for review items with generic legacy labels", async () => {
		const { createOrUpdateMemoryReviewItem, getMemoryProfileReadModel } =
			await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "legacy-memory-curation:review-display",
			subjectLabel: "Legacy memory candidate",
			question: "Should AlfyAI remember this?",
			reason: "Needs user confirmation before becoming active memory.",
			metadata: {
				category: "preferences",
				proposedStatement: "Prefers Hungarian labels.",
			},
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.review.visibleItems).toEqual([
			{
				id: review.id,
				subject: "Prefers Hungarian labels.",
				question: "Should AlfyAI remember this?",
				reason: "Needs user confirmation before becoming active memory.",
				canAccept: true,
				expiresAt: null,
			},
		]);
	});

	it("deduplicates repeated legacy review candidates in the public read model", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "legacy-memory-curation:source-a",
			subjectLabel: "Prefers concise implementation plans.",
			question: "Should AlfyAI remember this?",
			reason: "Needs user confirmation before becoming active memory.",
			metadata: {
				category: "preferences",
				proposedStatement: "Prefers concise implementation plans.",
			},
		});
		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "legacy-memory-curation:source-b",
			subjectLabel: "Prefers concise implementation plans.",
			question: "Should AlfyAI remember this?",
			reason: "Needs user confirmation before becoming active memory.",
			metadata: {
				category: "preferences",
				proposedStatement: "  Prefers concise implementation plans.  ",
			},
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });

		expect(profile.review.openCount).toBe(1);
		expect(profile.review.overflowCount).toBe(0);
		expect(profile.review.items).toEqual([
			expect.objectContaining({
				subject: "Prefers concise implementation plans.",
				canAccept: true,
			}),
		]);

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: profile.review.items[0]?.id ?? "",
				expectedProjectionRevision: profile.projectionRevision,
				action: "dismiss",
			}),
		).resolves.toMatchObject({ status: "updated" });

		const afterDismiss = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(afterDismiss.review.openCount).toBe(0);
	});

	it("uses a deterministic category fallback when review metadata has no category", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "debug-tables",
			subjectLabel: "Avoid diagnostic memory tables.",
			question: "Should this be remembered?",
			reason: "User boundary for memory UI.",
			metadata: { proposedStatement: "Avoid diagnostic memory tables." },
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "accept",
			}),
		).resolves.toMatchObject({
			status: "updated",
			category: "constraints_boundaries",
		});

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.categories[3]?.items).toEqual([
			expect.objectContaining({
				category: "constraints_boundaries",
				statement: "Avoid diagnostic memory tables.",
			}),
		]);
	});

	it("accepts legacy review candidates into their curated category", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "legacy-memory-curation:category-preservation",
			subjectLabel: "Working on the memory rework rollout.",
			question: "Should AlfyAI remember this?",
			reason: "Needs user confirmation before becoming active memory.",
			metadata: {
				source: "legacy_memory_curation",
				category: "goals_ongoing_work",
				proposedStatement: "Working on the memory rework rollout.",
			},
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "accept",
			}),
		).resolves.toMatchObject({
			status: "updated",
			category: "goals_ongoing_work",
		});

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.categories[0]?.items).toEqual([]);
		expect(after.categories[2]?.items).toEqual([
			expect.objectContaining({
				category: "goals_ongoing_work",
				statement: "Working on the memory rework rollout.",
			}),
		]);
	});

	it("does not promote a generic review subject without an edited or proposed statement", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "document-related-memory-request",
			subjectLabel: "Document-related memory request",
			question: "Should this be remembered?",
			reason: "The intake gate could not safely admit this automatically.",
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "accept",
			}),
		).resolves.toEqual({ status: "not_found" });

		await expect(
			getActiveMemoryProfileContext({ userId: "user-1" }),
		).resolves.toMatchObject({ items: [] });
		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.visibleItems).toEqual([
			{
				id: review.id,
				subject: "Document-related memory request",
				question: "Should this be remembered?",
				reason: "The intake gate could not safely admit this automatically.",
				canAccept: false,
				expiresAt: null,
			},
		]);
	});

	it("keeps generic deferred review items distinct by subject key", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const first = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "post-turn-intake:document-related:first",
			subjectLabel: "Document-related memory request",
			question: "Should this be remembered?",
			reason: "The intake gate could not safely admit this automatically.",
		});
		const second = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "post-turn-intake:document-related:second",
			subjectLabel: "Document-related memory request",
			question: "Should this be remembered?",
			reason: "The intake gate could not safely admit this automatically.",
		});

		const before = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(before.review.openCount).toBe(2);
		expect(before.review.visibleItems.map((item) => item.id)).toEqual([
			first.id,
			second.id,
		]);

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: first.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "dismiss",
			}),
		).resolves.toMatchObject({ status: "updated" });

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.openCount).toBe(1);
		expect(after.review.visibleItems).toEqual([
			expect.objectContaining({ id: second.id }),
		]);
	});

	it("dismisses an open review item without creating an active profile item", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createOrUpdateMemoryReviewItem,
			getMemoryProfileReadModel,
		} = await import("./index");

		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "transient-ui-note",
			subjectLabel: "Transient UI note.",
			question: "Should this be remembered?",
			reason: "Low-value review candidate.",
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "dismiss",
			}),
		).resolves.toEqual({
			status: "updated",
			projectionRevision: before.projectionRevision + 1,
			itemId: null,
			category: null,
		});

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.visibleItems).toEqual([]);
		expect(after.categories.flatMap((group) => group.items)).toEqual([]);
	});

	it("dismisses review-needed active items from next-turn profile context", async () => {
		const {
			applyMemoryReviewItemWithRevision,
			createMemoryProfileItem,
			createOrUpdateMemoryReviewItem,
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
		} = await import("./index");

		const first = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers stale duplicate preference.",
			slotKey: "memory-slot:test:review-dismiss-a",
		});
		const second = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers stale duplicate preference.",
			slotKey: "memory-slot:test:review-dismiss-b",
		});
		const review = await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: "memory-profile:duplicate:review-dismiss",
			subjectLabel: "Duplicate stale preference.",
			question: "Which duplicate memory profile item should remain active?",
			reason: "Maintenance found duplicate active memory.",
			affectedItemIds: [first.id, second.id],
			metadata: {
				category: "preferences",
				proposedStatement: "Prefers stale duplicate preference.",
			},
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });

		await expect(
			applyMemoryReviewItemWithRevision({
				userId: "user-1",
				reviewItemId: review.id,
				expectedProjectionRevision: before.projectionRevision,
				action: "dismiss",
			}),
		).resolves.toEqual({
			status: "updated",
			projectionRevision: before.projectionRevision + 1,
			itemId: null,
			category: null,
		});

		await expect(
			getActiveMemoryProfileContext({ userId: "user-1" }),
		).resolves.toMatchObject({ items: [] });
		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.review.visibleItems).toEqual([]);
		expect(after.categories.flatMap((group) => group.items)).toEqual([]);
	});

	it("returns active memory profile context without deleted, suppressed, or UI-only fields", async () => {
		const {
			createMemoryProfileItem,
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		const active = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Amsterdam.",
		});
		const deleted = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers obsolete drafts.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "constraints_boundaries",
			scope: { type: "global" },
			statement: "Suppressed boundary.",
			status: "suppressed",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "global" },
			statement: "Inactive goal.",
			status: "inactive",
		});
		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		await updateMemoryProfileItemWithRevision({
			userId: "user-1",
			itemId: deleted.id,
			expectedProjectionRevision: profile.projectionRevision,
			patch: { status: "deleted" },
		});

		const context = await getActiveMemoryProfileContext({ userId: "user-1" });
		const contextJson = JSON.stringify(context);

		expect(context).toEqual({
			resetGeneration: 0,
			projectionRevision: profile.projectionRevision + 1,
			items: [
				expect.objectContaining({
					id: active.id,
					itemKey: active.itemKey,
					category: "about_you",
					statement: "Lives in Amsterdam.",
					scope: { type: "global" },
				}),
			],
		});
		expect(contextJson).not.toContain("Suppressed boundary.");
		expect(contextJson).not.toContain("Prefers obsolete drafts.");
		expect(contextJson).not.toContain("Inactive goal.");
		expect(contextJson).not.toContain("canEdit");
		expect(contextJson).not.toContain("canDelete");
		expect(contextJson).not.toContain("canSuppress");
		expect(contextJson).not.toContain("review");
	});

	it("includes global and applicable scoped memories in active prompt context", async () => {
		const { createMemoryProfileItem, getActiveMemoryProfileContext } =
			await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers global memory behavior.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "project", id: "project-1" },
			statement: "Project-specific private preference.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "project", id: "project-2" },
			statement: "Unrelated project preference.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "conversation", id: "conversation-1" },
			statement: "Conversation-specific goal.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "conversation", id: "conversation-2" },
			statement: "Unrelated conversation goal.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "constraints_boundaries",
			scope: { type: "document", id: "document-1" },
			statement: "Document-specific constraint.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "constraints_boundaries",
			scope: { type: "document", id: "document-2" },
			statement: "Unrelated document constraint.",
		});

		const context = await getActiveMemoryProfileContext({
			userId: "user-1",
			applicableScopes: [
				{ type: "project", id: "project-1" },
				{ type: "conversation", id: "conversation-1" },
				{ type: "document", id: "document-1" },
			],
		});

		expect(context.items.map((item) => item.statement)).toEqual(
			expect.arrayContaining([
				"Project-specific private preference.",
				"Conversation-specific goal.",
				"Document-specific constraint.",
				"Prefers global memory behavior.",
			]),
		);
		expect(context.items).toHaveLength(4);
		expect(JSON.stringify(context)).not.toContain(
			"Unrelated project preference.",
		);
		expect(JSON.stringify(context)).not.toContain(
			"Unrelated conversation goal.",
		);
		expect(JSON.stringify(context)).not.toContain(
			"Unrelated document constraint.",
		);
	});

	it("defaults active prompt context to global memories when no scoped applicability is provided", async () => {
		const { createMemoryProfileItem, getActiveMemoryProfileContext } =
			await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers global memory behavior.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "conversation", id: "conversation-1" },
			statement: "Conversation-specific goal.",
		});

		const context = await getActiveMemoryProfileContext({ userId: "user-1" });

		expect(context.items.map((item) => item.statement)).toEqual([
			"Prefers global memory behavior.",
		]);
	});

	it("lists projection-policy blocked statements across non-active profile states", async () => {
		const { createMemoryProfileItem, listProjectionPolicyBlockedStatements } =
			await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers active memory behavior.",
			status: "active",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Deleted profile statement.",
			status: "deleted",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Suppressed profile statement.",
			status: "suppressed",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Expired profile statement.",
			status: "expired",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Conflict blocked profile statement.",
			status: "blocked",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Review needed profile statement.",
			status: "review_needed",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Preserved legacy profile statement.",
			status: "preserved_legacy",
		});

		const statements = await listProjectionPolicyBlockedStatements({
			userId: "user-1",
		});

		expect(
			statements
				.map((statement) => ({
					status: statement.status,
					statement: statement.statement,
				}))
				.sort((left, right) => left.status.localeCompare(right.status)),
		).toEqual([
			{
				status: "blocked",
				statement: "Conflict blocked profile statement.",
			},
			{
				status: "deleted",
				statement: "Deleted profile statement.",
			},
			{
				status: "expired",
				statement: "Expired profile statement.",
			},
			{
				status: "preserved_legacy",
				statement: "Preserved legacy profile statement.",
			},
			{
				status: "review_needed",
				statement: "Review needed profile statement.",
			},
			{
				status: "suppressed",
				statement: "Suppressed profile statement.",
			},
		]);
	});

	it("expires overdue active profile items before read model or prompt context use", async () => {
		const { db } = await import("$lib/server/db");
		const {
			createMemoryProfileItem,
			getActiveMemoryProfileContext,
			getMemoryProfileReadModel,
		} = await import("./index");

		const expired = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers obsolete memory.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers current memory.",
		});
		await db
			.update(schema.memoryProfileItems)
			.set({ expiresAt: new Date("2026-01-01T00:00:00.000Z") })
			.where(eq(schema.memoryProfileItems.id, expired.id))
			.run();

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[1]?.items).toEqual([
			expect.objectContaining({ statement: "Prefers current memory." }),
		]);

		const context = await getActiveMemoryProfileContext({ userId: "user-1" });
		expect(context.items).toEqual([
			expect.objectContaining({ statement: "Prefers current memory." }),
		]);

		const rows = await db
			.select({
				id: schema.memoryProfileItems.id,
				status: schema.memoryProfileItems.status,
			})
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, expired.id));
		expect(rows).toEqual([{ id: expired.id, status: "expired" }]);
	});

	it("orders active memory profile context newest-first", async () => {
		const { db } = await import("$lib/server/db");
		const { createMemoryProfileItem, getActiveMemoryProfileContext } =
			await import("./index");

		const stale = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers stale profile context.",
		});
		const fresh = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers fresh profile context.",
		});
		await db
			.update(schema.memoryProfileItems)
			.set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
			.where(eq(schema.memoryProfileItems.id, stale.id))
			.run();
		await db
			.update(schema.memoryProfileItems)
			.set({ updatedAt: new Date("2026-06-01T00:00:00.000Z") })
			.where(eq(schema.memoryProfileItems.id, fresh.id))
			.run();

		const context = await getActiveMemoryProfileContext({ userId: "user-1" });

		expect(context.items.map((item) => item.statement)).toEqual([
			"Prefers fresh profile context.",
			"Prefers stale profile context.",
		]);
	});

	it("formats active memory profile context item-by-item with omitted counts", async () => {
		const { formatActiveMemoryProfileContextForPrompt } = await import(
			"./index"
		);
		const context = {
			resetGeneration: 0,
			projectionRevision: 1,
			items: [
				{
					id: "old-memory",
					itemKey: "old",
					category: "preferences" as const,
					statement: "Prefers stale profile context.",
					scope: { type: "global" as const },
					revision: 0,
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
				{
					id: "fresh-memory",
					itemKey: "fresh",
					category: "preferences" as const,
					statement: "Prefers fresh profile context.",
					scope: { type: "global" as const },
					revision: 0,
					updatedAt: new Date("2026-06-01T00:00:00.000Z"),
				},
				{
					id: "middle-memory",
					itemKey: "middle",
					category: "preferences" as const,
					statement: "Prefers middle profile context.",
					scope: { type: "global" as const },
					revision: 0,
					updatedAt: new Date("2026-03-01T00:00:00.000Z"),
				},
			],
		};

		const formatted = formatActiveMemoryProfileContextForPrompt(context, {
			maxTokens: 30,
		});

		expect(formatted.content).toContain("Prefers fresh profile context.");
		expect(formatted.content).not.toContain("Prefers stale profile context.");
		expect(formatted.content).toContain("Omitted: 2.");
		expect(formatted.estimatedTokens).toBeLessThanOrEqual(30);
		expect(formatted).toMatchObject({
			includedCount: 1,
			omittedCount: 2,
			includedItemIds: ["fresh-memory"],
		});
	});

	it("skips one oversized newest active memory instead of blanking later compact memories", async () => {
		const { formatActiveMemoryProfileContextForPrompt } = await import(
			"./index"
		);
		const context = {
			resetGeneration: 0,
			projectionRevision: 1,
			items: [
				{
					id: "huge-fresh-memory",
					itemKey: "huge-fresh",
					category: "preferences" as const,
					statement: `HUGE_NEWEST_MEMORY_SHOULD_NOT_SURVIVE ${"details ".repeat(2_000)}`,
					scope: { type: "global" as const },
					revision: 0,
					updatedAt: new Date("2026-06-01T00:00:00.000Z"),
				},
				{
					id: "compact-older-memory",
					itemKey: "compact-older",
					category: "preferences" as const,
					statement: "COMPACT_OLDER_MEMORY_SHOULD_SURVIVE.",
					scope: { type: "global" as const },
					revision: 0,
					updatedAt: new Date("2026-05-01T00:00:00.000Z"),
				},
			],
		};

		const formatted = formatActiveMemoryProfileContextForPrompt(context, {
			maxTokens: 60,
		});

		expect(formatted.content).toContain("COMPACT_OLDER_MEMORY_SHOULD_SURVIVE.");
		expect(formatted.content).not.toContain(
			"HUGE_NEWEST_MEMORY_SHOULD_NOT_SURVIVE",
		);
		expect(formatted.content).toContain(
			"Omitted active memory profile items: 1.",
		);
		expect(formatted).toMatchObject({
			includedCount: 1,
			omittedCount: 1,
			includedItemIds: ["compact-older-memory"],
		});
	});

	it("expires overdue review_needed items and resolves their open review rows", async () => {
		const {
			createMemoryProfileItem,
			createOrUpdateMemoryReviewItem,
			ensureProjectionState,
			expireOverdueReviewMemoryProfileItems,
			getCurrentMemoryResetGeneration,
			getMemoryProfileReadModel,
		} = await import("./index");

		const item = await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "global" },
			statement: "I am mentoring a colleague this quarter.",
			status: "review_needed",
		});
		const { db } = await import("$lib/server/db");
		await db
			.update(schema.memoryProfileItems)
			.set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") })
			.where(eq(schema.memoryProfileItems.id, item.id))
			.run();
		await createOrUpdateMemoryReviewItem({
			userId: "user-1",
			subjectKey: `judge:${item.itemKey}`,
			subjectLabel: "I am mentoring a colleague this quarter.",
			question: "Should I keep remembering this?",
			reason: "Inferred from conversation, not stated directly.",
			affectedItemIds: [item.id],
		});

		const beforeReadModel = await getMemoryProfileReadModel({
			userId: "user-1",
		});
		expect(beforeReadModel.review.openCount).toBe(1);

		const resetGeneration = await getCurrentMemoryResetGeneration("user-1");
		const projection = await ensureProjectionState({
			userId: "user-1",
			resetGeneration,
		});
		const expiredCount = await expireOverdueReviewMemoryProfileItems({
			userId: "user-1",
			resetGeneration,
			projectionStateId: projection.id,
		});
		expect(expiredCount).toBe(1);

		const [itemRow] = await db
			.select({ status: schema.memoryProfileItems.status })
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, item.id));
		expect(itemRow?.status).toBe("expired");

		const [reviewRow] = await db
			.select({ status: schema.memoryReviewItems.status })
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.subjectKey, `judge:${item.itemKey}`));
		expect(reviewRow?.status).not.toBe("open");

		const afterReadModel = await getMemoryProfileReadModel({
			userId: "user-1",
		});
		expect(afterReadModel.review.openCount).toBe(0);
	});
});
