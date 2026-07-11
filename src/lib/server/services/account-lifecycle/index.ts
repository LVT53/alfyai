import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	adminConfig,
	announcementCampaignSnapshots,
	announcementCampaigns,
	artifacts,
	campaignAssets,
	fileProductionJobAttempts,
	fileProductionJobs,
	userSkillDefinitions,
	users,
} from "$lib/server/db/schema";
import { cancelActiveAtlasJobsForUser, deleteAtlasJobsForUser } from "../atlas";
import { deleteAllChatFilesForUser } from "../chat-files";
import { requestActiveChatStreamsStopForUser } from "../chat-turn/active-streams";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	hardDeleteArtifactsForUser,
} from "../knowledge";
import { quiesceUserMemoryMaintenance } from "../memory-maintenance";
import { advanceMemoryResetGeneration } from "../memory-profile/reset-generation";
import { clearMessageEvidenceForUser } from "../messages";
import {
	explicitErasureTables,
	tablesForResetScope,
} from "./user-scoped-tables";

export const DETACHED_SHARED_CONTENT_OWNER_ID = "detached-shared-content-owner";
export const DETACHED_SHARED_CONTENT_OWNER_EMAIL =
	"detached-shared-content-owner@alfyai.local";
const ACTIVE_FILE_PRODUCTION_STATUSES = ["queued", "running"] as const;

/**
 * ONE owner for the account lifecycle. Every destructive account operation —
 * full Account Erasure, Clear Memory and Knowledge, Clear Workspace Data — flows
 * through this module, which holds:
 *   1. the ordered quiesce → cleanup sequence (ADR-0030), and
 *   2. a single user-scoped-table registry (`USER_SCOPED_TABLES`) that drives the
 *      explicit-delete paths, replacing the two hand-maintained delete-lists that
 *      used to shadow each other and the FK cascade.
 *
 * Erasure semantics (ADR-0029): after full erasure NO person-linked row survives
 * for any user-scoped table. The REAL mechanism is the `ON DELETE CASCADE` from
 * `users.id` fired by deleting the user row; the registry only carries the two
 * paths the cascade cannot serve — the memory/workspace resets that KEEP the user
 * row, and the two analytics rollups that have no FK to `users`.
 */

/**
 * Delete every row in the given reset scope for a user whose account row is
 * KEPT. Because the user row survives, the `users` FK cascade does not fire, so
 * these deletes are explicit. Registry order is FK-safe (children before
 * parents, `conversations` last).
 */
function deleteResetScopeRows(userId: string, scope: "memory" | "workspace") {
	db.transaction((tx) => {
		for (const entry of tablesForResetScope(scope)) {
			tx.delete(entry.table).where(eq(entry.userColumn, userId)).run();
		}
	});
}

/**
 * Clear Memory and Knowledge: wipe learned memory + durable knowledge while
 * KEEPING the account, chats, and generated chat outputs. Returns the ids of the
 * hard-deleted (non-generated) knowledge artifacts.
 */
export async function clearMemoryAndKnowledgeForUser(
	userId: string,
): Promise<string[]> {
	await advanceMemoryResetGeneration(userId);

	const artifactRows = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(
			and(eq(artifacts.userId, userId), ne(artifacts.type, "generated_output")),
		);
	const deletedArtifactIds = artifactRows.map((row) => row.id).sort();

	if (deletedArtifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, deletedArtifactIds);
	}

	deleteResetScopeRows(userId, "memory");

	await clearMessageEvidenceForUser(userId);
	return deletedArtifactIds;
}

/**
 * Clear Workspace Data: wipe conversations and their derived state (and durable
 * knowledge/files) while KEEPING the account and historical analytics. Also the
 * shared DB-purge step of full Account Erasure (before the user row is deleted).
 */
export async function purgeUserData(userId: string): Promise<void> {
	await cancelActiveAtlasJobsForUser(userId);
	await deleteAllChatFilesForUser(userId);
	await deleteAtlasJobsForUser(userId);

	const ownershipScope = await getArtifactOwnershipScope(userId);
	const artifactRows = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(buildArtifactVisibilityCondition({ userId, ownershipScope }));
	const artifactIds = artifactRows.map((row) => row.id);
	if (artifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, artifactIds);
	}

	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	});

	deleteResetScopeRows(userId, "workspace");
}

/**
 * Full Account Erasure DB + filesystem sequence: quiesce running work, purge the
 * workspace, detach shared authorship, then delete the analytics rollups (no FK
 * cascade reaches them) AND the user row (whose cascade wipes everything else) in
 * one transaction, and finally remove the avatar file.
 */
export async function eraseUserAccountData(userId: string): Promise<void> {
	await quiesceUserWorkspace(userId);
	await purgeUserData(userId);
	await detachSharedContentAuthorship(userId);
	deleteUserRowAndExplicitAnalytics(userId);

	await rm(join(process.cwd(), "data", "avatars", `${userId}.webp`), {
		force: true,
	});
}

/**
 * The one transaction that removes the user identity: delete the analytics
 * rollups that carry no FK to `users` (so the cascade never reaches them), then
 * delete the `users` row — whose `ON DELETE CASCADE` removes every remaining
 * user-scoped row.
 */
function deleteUserRowAndExplicitAnalytics(userId: string) {
	db.transaction((tx) => {
		for (const entry of explicitErasureTables()) {
			tx.delete(entry.table).where(eq(entry.userColumn, userId)).run();
		}
		tx.delete(users).where(eq(users.id, userId)).run();
	});
}

async function detachSharedContentAuthorship(userId: string): Promise<void> {
	const detachedOwnerId = await resolveDetachedSharedContentOwnerId(userId);

	db.transaction((tx) => {
		if (detachedOwnerId) {
			tx.update(campaignAssets)
				.set({
					uploadedByUserId: detachedOwnerId,
					updatedAt: new Date(),
				})
				.where(eq(campaignAssets.uploadedByUserId, userId))
				.run();
			tx.update(userSkillDefinitions)
				.set({
					userId: detachedOwnerId,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(userSkillDefinitions.userId, userId),
						eq(userSkillDefinitions.ownership, "system"),
					),
				)
				.run();
		}

		tx.update(announcementCampaigns)
			.set({ createdByUserId: null, updatedAt: new Date() })
			.where(eq(announcementCampaigns.createdByUserId, userId))
			.run();
		tx.update(announcementCampaigns)
			.set({ publishedByUserId: null, updatedAt: new Date() })
			.where(eq(announcementCampaigns.publishedByUserId, userId))
			.run();
		tx.update(announcementCampaignSnapshots)
			.set({ publishedByUserId: null })
			.where(eq(announcementCampaignSnapshots.publishedByUserId, userId))
			.run();
		tx.update(adminConfig)
			.set({ updatedBy: "detached", updatedAt: new Date() })
			.where(eq(adminConfig.updatedBy, userId))
			.run();
	});
}

async function resolveDetachedSharedContentOwnerId(
	userId: string,
): Promise<string | null> {
	const [ownedAsset] = await db
		.select({ id: campaignAssets.id })
		.from(campaignAssets)
		.where(eq(campaignAssets.uploadedByUserId, userId))
		.limit(1);
	const [ownedSystemSkill] = await db
		.select({ id: userSkillDefinitions.id })
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "system"),
			),
		)
		.limit(1);

	if (!ownedAsset && !ownedSystemSkill) {
		return null;
	}

	const [existingDetachedOwner] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, DETACHED_SHARED_CONTENT_OWNER_ID))
		.limit(1);
	if (existingDetachedOwner) {
		return existingDetachedOwner.id;
	}

	await db
		.insert(users)
		.values({
			id: DETACHED_SHARED_CONTENT_OWNER_ID,
			email: DETACHED_SHARED_CONTENT_OWNER_EMAIL,
			passwordHash: "",
			name: "Detached shared content owner",
			role: "user",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoNothing({ target: users.id })
		.run();

	return DETACHED_SHARED_CONTENT_OWNER_ID;
}

/**
 * Stop or cancel user-owned running work before destructive cleanup so no
 * background worker or stream can recreate messages, files, memory, or analytics
 * after erasure was requested (ADR-0030).
 */
export async function quiesceUserWorkspace(userId: string): Promise<void> {
	requestActiveChatStreamsStopForUser(userId);
	await cancelActiveAtlasJobsForUser(userId);
	await cancelActiveFileProductionForUser(userId);
	await quiesceUserMemoryMaintenance(userId);
}

async function cancelActiveFileProductionForUser(
	userId: string,
): Promise<void> {
	const now = new Date();
	const activeJobs = await db
		.select({
			id: fileProductionJobs.id,
			currentAttemptId: fileProductionJobs.currentAttemptId,
		})
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				inArray(fileProductionJobs.status, ACTIVE_FILE_PRODUCTION_STATUSES),
			),
		);
	if (activeJobs.length === 0) return;

	const activeAttemptIds = activeJobs
		.map((job) => job.currentAttemptId)
		.filter((id): id is string => Boolean(id));

	db.transaction((tx) => {
		if (activeAttemptIds.length > 0) {
			tx.update(fileProductionJobAttempts)
				.set({
					status: "cancelled",
					finishedAt: now,
					updatedAt: now,
				})
				.where(inArray(fileProductionJobAttempts.id, activeAttemptIds))
				.run();
		}

		tx.update(fileProductionJobs)
			.set({
				status: "cancelled",
				stage: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: now,
				cancelRequestedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.userId, userId),
					inArray(fileProductionJobs.status, ACTIVE_FILE_PRODUCTION_STATUSES),
				),
			)
			.run();
	});
}
