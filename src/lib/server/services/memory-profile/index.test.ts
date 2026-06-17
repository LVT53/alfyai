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
		vi.doUnmock("../honcho");
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
		expect(publicJson).not.toContain("honcho");
		expect(publicJson).not.toContain("confidence");
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
			},
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
		const { formatActiveMemoryProfileContextForPrompt } = await import("./index");
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
		const { formatActiveMemoryProfileContextForPrompt } = await import("./index");
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
		expect(formatted.content).not.toContain("HUGE_NEWEST_MEMORY_SHOULD_NOT_SURVIVE");
		expect(formatted.content).toContain("Omitted active memory profile items: 1.");
		expect(formatted).toMatchObject({
			includedCount: 1,
			omittedCount: 1,
			includedItemIds: ["compact-older-memory"],
		});
	});

	it("reconciles telemetry-only dirty ledger entries and completes them", async () => {
		const {
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		await markMemoryDirty({
			userId: "user-1",
			reason: "deferred_intake",
			metadata: { reviewItemId: "review-1" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "stale_projection",
			metadata: { projectionStateId: "projection-1" },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toEqual({
			claimed: 2,
			completed: 2,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		const telemetryJson = JSON.stringify(telemetry);
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "dirty_ledger_acknowledged",
				reason: "deferred_intake",
				status: "completed",
				subjectId: "review-1",
			}),
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "dirty_ledger_acknowledged",
				reason: "stale_projection",
				status: "completed",
				subjectId: "projection-1",
			}),
		]);
		expect(telemetryJson).not.toContain("raw");
		expect(telemetryJson).not.toContain("chat excerpt");
		expect(telemetryJson).not.toContain("prompt excerpt");
	});

	it("creates one generic review for exact active duplicate dirty entries without reviving or merging items", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		const first = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers compact implementation notes.",
			slotKey: "memory-slot:test:duplicate-a",
		});
		const second = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "  prefers compact   implementation notes. ",
			slotKey: "memory-slot:test:duplicate-b",
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_duplicate",
			metadata: { itemId: first.id },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "review_generation",
			metadata: { itemId: second.id },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toMatchObject({
			claimed: 2,
			completed: 2,
			failed: 0,
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.categories[1]?.items.map((item) => item.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
		expect(profile.review.items).toEqual([
			{
				id: expect.any(String),
				subject: "Duplicate memory profile items",
				question: "Which duplicate memory profile item should remain active?",
				reason:
					"Maintenance found exact active duplicate memory profile items.",
				canAccept: false,
			},
		]);
		expect(JSON.stringify(profile.review.items)).not.toContain(
			"compact implementation",
		);
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
	});

	it("creates conflict reviews only when dirty metadata has a deterministic subject", async () => {
		const {
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_conflict",
			metadata: { conflictDetector: "deterministic" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_conflict",
			scope: { type: "project", id: "project-1" },
			metadata: { subjectKey: "home-city" },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toMatchObject({
			claimed: 2,
			completed: 2,
			failed: 0,
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(profile.review.items).toEqual([
			{
				id: expect.any(String),
				subject: "Memory profile conflict",
				question: "Which memory profile value should AlfyAI keep?",
				reason: "Maintenance found a deterministic conflict marker.",
				canAccept: false,
			},
		]);
		expect(JSON.stringify(profile.review.items)).not.toContain("home-city");

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry.map((entry) => entry.eventName)).toEqual([
			"dirty_ledger_acknowledged",
			"dirty_ledger_conflict_review_created",
		]);
	});

	it("only claims current reset generation dirty rows and respects the batch size", async () => {
		const {
			advanceMemoryResetGeneration,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		const stale = await markMemoryDirty({
			userId: "user-1",
			reason: "stale_projection",
			metadata: { projectionStateId: "stale-projection" },
		});
		await advanceMemoryResetGeneration("user-1");
		await markMemoryDirty({
			userId: "user-1",
			reason: "stale_projection",
			scope: { type: "global" },
			metadata: { projectionStateId: "current-projection" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "deferred_intake",
			scope: { type: "project", id: "project-1" },
			metadata: { reviewItemId: "review-1" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "honcho_reconciliation",
			scope: { type: "conversation", id: "conversation-1" },
			metadata: { itemId: "item-1" },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 2,
			}),
		).resolves.toEqual({
			claimed: 2,
			completed: 2,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});

		const pendingCurrent = await listPendingMemoryDirtyEntries({
			userId: "user-1",
		});
		expect(pendingCurrent).toHaveLength(1);
		expect(pendingCurrent[0]?.reason).toBe("honcho_reconciliation");

		const { db } = await import("$lib/server/db");
		const staleRows = await db
			.select({
				id: schema.memoryDirtyLedger.id,
				status: schema.memoryDirtyLedger.status,
				resetGeneration: schema.memoryDirtyLedger.resetGeneration,
			})
			.from(schema.memoryDirtyLedger)
			.where(eq(schema.memoryDirtyLedger.id, stale.id));
		expect(staleRows).toEqual([
			{
				id: stale.id,
				status: "pending",
				resetGeneration: 0,
			},
		]);
	});

	it("reclaims stale claimed dirty rows after a worker crash", async () => {
		const {
			listPendingMemoryDirtyEntries,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");
		const { db } = await import("$lib/server/db");
		const ledgerId = `dirty-${randomUUID()}`;
		const now = Date.now();
		await db
			.insert(schema.memoryDirtyLedger)
			.values({
				id: ledgerId,
				userId: "user-1",
				resetGeneration: 0,
				scopeType: "global",
				scopeId: "",
				reason: "deferred_intake",
				status: "claimed",
				count: 1,
				reasonMetadataJson: JSON.stringify({ reviewItemId: "review-1" }),
				firstMarkedAt: new Date(now - 700_000),
				lastMarkedAt: new Date(now - 700_000),
				claimedAt: new Date(now - 700_000),
			})
			.run();

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				staleClaimMs: 1_000,
			}),
		).resolves.toEqual({
			claimed: 1,
			completed: 1,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});

		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
		const rows = await db
			.select({
				id: schema.memoryDirtyLedger.id,
				status: schema.memoryDirtyLedger.status,
				completedAt: schema.memoryDirtyLedger.completedAt,
			})
			.from(schema.memoryDirtyLedger)
			.where(eq(schema.memoryDirtyLedger.id, ledgerId));
		expect(rows).toEqual([
			{
				id: ledgerId,
				status: "completed",
				completedAt: expect.any(Date),
			},
		]);
	});

	it("runs legacy migration over a supplied bounded batch without exposing preserved rows", async () => {
		const {
			getActiveMemoryProfileContext,
			listMemoryReworkTelemetry,
			migrateLegacyMemoryForUser,
		} = await import("./index");
		const { db } = await import("$lib/server/db");

		await expect(
			migrateLegacyMemoryForUser({
				userId: "user-1",
				batchSize: 5,
				legacyBatch: {
					totalAvailable: 1600,
					candidates: [
						{
							id: "legacy-active",
							content: "User prefers concise technical answers.",
							scope: "assistant_about_user",
							sessionId: null,
							createdAt: Date.now(),
						},
						{
							id: "legacy-preserved",
							content: "Might be interested in acoustic guitars.",
							scope: "assistant_about_user",
							sessionId: null,
							createdAt: Date.now() - 1,
						},
						{
							id: "legacy-junk",
							content:
								"Assistant: Sure, here is the draft I can write for you.",
							scope: "assistant_about_user",
							sessionId: null,
							createdAt: Date.now() - 2,
						},
					],
				},
			}),
		).resolves.toEqual({
			status: "completed",
			inspected: 3,
			active: 1,
			preserved: 1,
			rejected: 1,
			totalAvailable: 1600,
		});

		const activeContext = await getActiveMemoryProfileContext({
			userId: "user-1",
		});
		expect(activeContext.items).toEqual([
			expect.objectContaining({
				category: "preferences",
				statement: "Prefers concise technical answers.",
			}),
		]);
		expect(JSON.stringify(activeContext)).not.toContain("acoustic guitars");

		const rows = await db
			.select({
				statement: schema.memoryProfileItems.statement,
				status: schema.memoryProfileItems.status,
			})
			.from(schema.memoryProfileItems)
			.orderBy(schema.memoryProfileItems.statement);
		expect(rows).toEqual([
			{
				statement: "Might be interested in acoustic guitars.",
				status: "preserved_legacy",
			},
			{
				statement: "Prefers concise technical answers.",
				status: "active",
			},
		]);

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "legacy_migration_completed",
				reason: "legacy_migration",
				status: "completed",
				count: 3,
				metadata: {
					activeCount: 1,
					inspectedCount: 3,
					preservedCount: 1,
					rejectedCount: 1,
					requestedLimit: 5,
					totalAvailable: 1600,
				},
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain(
			"concise technical answers",
		);
		expect(JSON.stringify(telemetry)).not.toContain("acoustic guitars");
	});

	it("discards stale-generation legacy migration output without recreating memory state after reset", async () => {
		const {
			advanceMemoryResetGeneration,
			getActiveMemoryProfileContext,
			getCurrentMemoryResetGeneration,
			listMemoryReworkTelemetry,
			migrateLegacyMemoryForUser,
		} = await import("./index");
		const { db } = await import("$lib/server/db");

		const startedResetGeneration =
			await getCurrentMemoryResetGeneration("user-1");
		await advanceMemoryResetGeneration("user-1");

		await expect(
			migrateLegacyMemoryForUser({
				userId: "user-1",
				batchSize: 1,
				startedResetGeneration,
				legacyBatch: {
					totalAvailable: 1,
					candidates: [
						{
							id: "legacy-after-reset",
							content: "User prefers detailed implementation notes.",
							scope: "assistant_about_user",
							sessionId: null,
							createdAt: Date.now(),
						},
					],
				},
			}),
		).resolves.toEqual({
			status: "stale_generation",
			inspected: 1,
			active: 0,
			preserved: 0,
			rejected: 0,
			totalAvailable: 1,
		});

		await expect(
			getActiveMemoryProfileContext({ userId: "user-1" }),
		).resolves.toMatchObject({ resetGeneration: 1, items: [] });
		await expect(
			listMemoryReworkTelemetry({ userId: "user-1" }),
		).resolves.toEqual([]);
		const rows = await db
			.select({ id: schema.memoryProfileItems.id })
			.from(schema.memoryProfileItems);
		expect(rows).toEqual([]);
	});

	it("acknowledges legacy migration dirty rows as unavailable when no bounded legacy batch is provided", async () => {
		const {
			listMemoryReworkTelemetry,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		await markMemoryDirty({
			userId: "user-1",
			reason: "legacy_migration",
			metadata: { legacyCandidateEstimate: 1600 },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 1,
			}),
		).resolves.toEqual({
			claimed: 1,
			completed: 1,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "legacy_migration_unavailable",
				reason: "legacy_migration",
				status: "skipped",
				metadata: expect.objectContaining({
					ledgerEntryId: expect.any(String),
					scopeType: "global",
					scopeId: "",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("legacyCandidateEstimate");
	});

	it("acknowledges legacy migration dirty rows as unavailable when the injected loader fails", async () => {
		const {
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");
		const loadLegacyMemoryCandidates = vi.fn(async () => {
			throw new Error("raw legacy memory text should not be reported");
		});

		await markMemoryDirty({
			userId: "user-1",
			reason: "legacy_migration",
			metadata: { legacyCandidateEstimate: 1600 },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 1,
				loadLegacyMemoryCandidates,
			}),
		).resolves.toEqual({
			claimed: 1,
			completed: 1,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});

		expect(loadLegacyMemoryCandidates).toHaveBeenCalledWith("user-1", {
			limit: 5,
			excludeSourceIds: [],
			startPage: 1,
			maxPages: 4,
		});
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "legacy_migration_unavailable",
				reason: "legacy_migration",
				status: "skipped",
				metadata: expect.objectContaining({
					ledgerEntryId: expect.any(String),
					scopeType: "global",
					scopeId: "",
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain(
			"raw legacy memory text should not be reported",
		);
		expect(JSON.stringify(telemetry)).not.toContain("legacyCandidateEstimate");
	});

	it("reconciles legacy migration dirty rows with an injected bounded legacy batch", async () => {
		const {
			getActiveMemoryProfileContext,
			listMemoryReworkTelemetry,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");
		const { db } = await import("$lib/server/db");
		const loadLegacyMemoryCandidates = vi.fn(async () => ({
			totalAvailable: 1600,
			nextPage: null,
			exhausted: true,
			candidates: [
				{
					id: "legacy-active",
					content: "User prefers concise technical answers.",
					scope: "assistant_about_user" as const,
					sessionId: null,
					createdAt: Date.now(),
				},
				{
					id: "legacy-preserved",
					content: "Might be interested in acoustic guitars.",
					scope: "assistant_about_user" as const,
					sessionId: null,
					createdAt: Date.now() - 1,
				},
			],
		}));

		await markMemoryDirty({
			userId: "user-1",
			reason: "legacy_migration",
			metadata: { legacyCandidateEstimate: 1600 },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 1,
				loadLegacyMemoryCandidates,
			}),
		).resolves.toEqual({
			claimed: 1,
			completed: 1,
			failed: 0,
			skipped: 0,
			timedOut: false,
		});

		expect(loadLegacyMemoryCandidates).toHaveBeenCalledWith("user-1", {
			limit: 5,
			excludeSourceIds: [],
			startPage: 1,
			maxPages: 4,
		});
		const activeContext = await getActiveMemoryProfileContext({
			userId: "user-1",
		});
		expect(activeContext.items).toEqual([
			expect.objectContaining({
				category: "preferences",
				statement: "Prefers concise technical answers.",
			}),
		]);

		const rows = await db
			.select({
				statement: schema.memoryProfileItems.statement,
				status: schema.memoryProfileItems.status,
			})
			.from(schema.memoryProfileItems)
			.orderBy(schema.memoryProfileItems.statement);
		expect(rows).toEqual([
			{
				statement: "Might be interested in acoustic guitars.",
				status: "preserved_legacy",
			},
			{
				statement: "Prefers concise technical answers.",
				status: "active",
			},
		]);

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "legacy_migration_completed",
				reason: "legacy_migration",
				status: "completed",
				count: 2,
				metadata: expect.objectContaining({
					activeCount: 1,
					preservedCount: 1,
					requestedLimit: 5,
					totalAvailable: 1600,
				}),
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("concise technical answers");
		expect(JSON.stringify(telemetry)).not.toContain("acoustic guitars");
	});

	it("continues legacy migration with bounded page cursors instead of unbounded exclusions", async () => {
		const {
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");
		const batches = [
			{
				totalAvailable: 12,
				nextPage: 2,
				exhausted: false,
				candidates: [
					{
						id: "legacy-page-1",
						content: "User prefers short answers.",
						scope: "assistant_about_user" as const,
						sessionId: null,
						createdAt: Date.now(),
					},
				],
			},
			{
				totalAvailable: 12,
				nextPage: null,
				exhausted: true,
				candidates: [
					{
						id: "legacy-page-2",
						content: "User prefers English reports.",
						scope: "assistant_about_user" as const,
						sessionId: null,
						createdAt: Date.now() - 1,
					},
				],
			},
		];
		const loadLegacyMemoryCandidates = vi.fn(async () => {
			const batch = batches.shift();
			if (!batch) throw new Error("unexpected legacy batch request");
			return batch;
		});

		await markMemoryDirty({
			userId: "user-1",
			reason: "legacy_migration",
			metadata: { legacyCandidateEstimate: 12 },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 1,
				loadLegacyMemoryCandidates,
			}),
		).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([
			expect.objectContaining({
				reason: "legacy_migration",
				metadata: expect.objectContaining({
					legacyCandidateEstimate: 12,
					legacyExcludedSourceIds: ["legacy-page-1"],
					legacyNextPage: 2,
				}),
			}),
		]);

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({
				userId: "user-1",
				batchSize: 1,
				loadLegacyMemoryCandidates,
			}),
		).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });

		expect(loadLegacyMemoryCandidates).toHaveBeenNthCalledWith(1, "user-1", {
			limit: 5,
			excludeSourceIds: [],
			startPage: 1,
			maxPages: 4,
		});
		expect(loadLegacyMemoryCandidates).toHaveBeenNthCalledWith(2, "user-1", {
			limit: 5,
			excludeSourceIds: ["legacy-page-1"],
			startPage: 2,
			maxPages: 4,
		});
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
	});

	it("does not create duplicate reviews from suppressed or deleted profile items", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			listPendingMemoryDirtyEntries,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
			updateMemoryProfileItemWithRevision,
		} = await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers compact implementation notes.",
			slotKey: "memory-slot:test:active-duplicate-source",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers compact implementation notes.",
			slotKey: "memory-slot:test:suppressed-duplicate-source",
			status: "suppressed",
		});
		const deleted = await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers compact implementation notes.",
			slotKey: "memory-slot:test:deleted-duplicate-source",
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });
		await updateMemoryProfileItemWithRevision({
			userId: "user-1",
			itemId: deleted.id,
			expectedProjectionRevision: before.projectionRevision,
			patch: { status: "deleted" },
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "possible_duplicate",
			metadata: { itemId: deleted.id },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toMatchObject({
			claimed: 1,
			completed: 1,
			failed: 0,
		});

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		expect(after.categories[1]?.items).toHaveLength(1);
		expect(after.review.items).toEqual([]);
		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).resolves.toEqual([]);
	});

	it("verifies profile-action reconciliation without exposing or reviving non-active rows", async () => {
		const {
			createMemoryProfileItem,
			getMemoryProfileReadModel,
			listMemoryReworkTelemetry,
			markMemoryDirty,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");

		await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Amsterdam.",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "preferences",
			scope: { type: "global" },
			statement: "Suppressed preference.",
			status: "suppressed",
		});
		await createMemoryProfileItem({
			userId: "user-1",
			category: "goals_ongoing_work",
			scope: { type: "global" },
			statement: "Inactive goal.",
			status: "inactive",
		});
		await markMemoryDirty({
			userId: "user-1",
			reason: "profile_action_reconciliation",
			metadata: { itemId: "profile-action-1" },
		});

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toMatchObject({
			claimed: 1,
			completed: 1,
			failed: 0,
		});

		const profile = await getMemoryProfileReadModel({ userId: "user-1" });
		const profileJson = JSON.stringify(profile);
		expect(profile.categories.flatMap((group) => group.items)).toEqual([
			expect.objectContaining({ statement: "Lives in Amsterdam." }),
		]);
		expect(profileJson).not.toContain("Suppressed preference.");
		expect(profileJson).not.toContain("Inactive goal.");

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "maintenance",
				eventName: "dirty_ledger_profile_action_read_model_verified",
				reason: "profile_action_reconciliation",
				status: "completed",
				metadata: {
					ledgerEntryId: expect.any(String),
					activeContextCount: 1,
					nonActiveProfileItemCount: 2,
				},
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("Suppressed preference.");
		expect(JSON.stringify(telemetry)).not.toContain("Inactive goal.");
	});

	it("requeues a failed claimed dirty row and records privacy-safe error telemetry", async () => {
		const {
			listMemoryReworkTelemetry,
			listPendingMemoryDirtyEntries,
			reconcileMemoryProfileDirtyLedgerForUser,
		} = await import("./index");
		const { db } = await import("$lib/server/db");
		const now = new Date();
		const ledgerId = `dirty-${randomUUID()}`;
		await db
			.insert(schema.memoryDirtyLedger)
			.values({
				id: ledgerId,
				userId: "user-1",
				resetGeneration: 0,
				scopeType: "global",
				scopeId: "",
				reason: "unsupported_reason",
				status: "pending",
				count: 1,
				reasonMetadataJson: JSON.stringify({
					subjectId: "subject-1",
				}),
				firstMarkedAt: now,
				lastMarkedAt: now,
			})
			.run();

		await expect(
			reconcileMemoryProfileDirtyLedgerForUser({ userId: "user-1" }),
		).resolves.toEqual({
			claimed: 1,
			completed: 0,
			failed: 1,
			skipped: 0,
			timedOut: false,
		});

		await expect(
			listPendingMemoryDirtyEntries({ userId: "user-1" }),
		).rejects.toThrow("Unsupported memory dirty reason: unsupported_reason");
		const rows = await db
			.select({
				id: schema.memoryDirtyLedger.id,
				status: schema.memoryDirtyLedger.status,
				claimedAt: schema.memoryDirtyLedger.claimedAt,
			})
			.from(schema.memoryDirtyLedger)
			.where(eq(schema.memoryDirtyLedger.id, ledgerId));
		expect(rows).toEqual([
			{
				id: ledgerId,
				status: "pending",
				claimedAt: null,
			},
		]);

		const telemetry = await listMemoryReworkTelemetry({ userId: "user-1" });
		expect(telemetry).toEqual([
			expect.objectContaining({
				eventFamily: "error_fallback",
				eventName: "dirty_ledger_reconciliation_failed",
				reason: "unsupported_reason",
				status: "retry_pending",
				subjectId: "subject-1",
				metadata: {
					ledgerEntryId: ledgerId,
					errorName: "Error",
				},
			}),
		]);
		expect(JSON.stringify(telemetry)).not.toContain("raw");
	});
});
