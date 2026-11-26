import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	adminConfig,
	announcementCampaignSnapshots,
	announcementCampaigns,
	artifacts,
	campaignAssets,
	memoryAccounts,
	userSkillDefinitions,
	users,
} from "$lib/server/db/schema";
import { cancelActiveAtlasJobsForUser, deleteAtlasJobsForUser } from "../atlas";
import { deleteAllChatFilesForUser } from "../chat-files";
import { requestActiveChatStreamsStopForUser } from "../chat-turn/active-streams";
import { cancelActiveDocumentExtractionForUser } from "../extraction";
import { cancelActiveFileProductionForUser } from "../file-production";
import { deleteImageFilesForUser } from "../images/files";
import { cancelImageTakesForUser } from "../images/image-job";
import { cancelVideoTakesForUser } from "../images/video/video-job";
import {
	buildArtifactVisibilityCondition,
	getArtifactOwnershipScope,
	hardDeleteArtifactsForUser,
} from "../knowledge";
import { quiesceUserMemoryMaintenance } from "../memory-maintenance";
import { prepareNativeMemoryErasure } from "../memory-profile/delivery-job";
import { clearMessageEvidenceForUser } from "../messages";
import { compactSearchIndex } from "../workspace-search/search-index";
import {
	explicitErasureTables,
	tablesForResetScope,
} from "./user-scoped-tables";

export const DETACHED_SHARED_CONTENT_OWNER_ID = "detached-shared-content-owner";
export const DETACHED_SHARED_CONTENT_OWNER_EMAIL =
	"detached-shared-content-owner@alfyai.local";

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
function deleteResetScopeRows(
	tx: AccountLifecycleTransaction,
	userId: string,
	scope: "memory" | "workspace",
) {
	for (const entry of tablesForResetScope(scope)) {
		tx.delete(entry.table).where(eq(entry.userColumn, userId)).run();
	}
}

function erasureOwner(userId: string, token: string) {
	return and(
		eq(memoryAccounts.userId, userId),
		eq(memoryAccounts.erasureToken, token),
	);
}

function ownsErasure(
	userId: string,
	token: string,
	database: Pick<typeof db, "select"> = db,
) {
	return !!database
		.select({ id: memoryAccounts.userId })
		.from(memoryAccounts)
		.where(erasureOwner(userId, token))
		.get();
}

function finishReset(
	tx: AccountLifecycleTransaction,
	userId: string,
	token: string,
) {
	tx.update(memoryAccounts)
		.set({ lifecycleState: "active", erasureToken: null })
		.where(erasureOwner(userId, token))
		.run();
}

/**
 * Clear Memory and Knowledge: wipe learned memory + durable knowledge while
 * KEEPING the account, chats, and generated chat outputs. Returns the ids of the
 * hard-deleted (non-generated) knowledge artifacts.
 */
export async function clearMemoryAndKnowledgeForUser(
	userId: string,
	options: { artifactScope?: "all-owned" } = {},
): Promise<string[]> {
	const token = await prepareNativeMemoryErasure(
		userId,
		options.artifactScope === "all-owned" ? "erasing_all_owned" : "erasing",
	);
	if (!token) return [];

	const ownershipScope =
		options.artifactScope === "all-owned"
			? await getArtifactOwnershipScope(userId, { includeIncognito: true })
			: null;
	if (!ownsErasure(userId, token)) return [];
	const artifactRows = db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(
			ownershipScope
				? buildArtifactVisibilityCondition({ userId, ownershipScope })
				: and(
						eq(artifacts.userId, userId),
						ne(artifacts.type, "generated_output"),
					),
		)
		.all();
	const deletedArtifactIds = artifactRows.map((row) => row.id).sort();

	if (deletedArtifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, deletedArtifactIds);
	}

	db.transaction((tx) => {
		if (!ownsErasure(userId, token, tx)) return;
		deleteResetScopeRows(tx, userId, "memory");
		clearMessageEvidenceForUser(userId, tx);
		finishReset(tx, userId, token);
	});
	// The deleted knowledge's words leave the search index's pages too.
	if (deletedArtifactIds.length > 0) compactSearchIndex();
	return deletedArtifactIds;
}

/**
 * Clear Workspace Data: wipe conversations and their derived state (and durable
 * knowledge/files) while KEEPING the account and historical analytics. Also the
 * shared DB-purge step of full Account Erasure (before the user row is deleted).
 */
export async function purgeUserData(userId: string): Promise<void> {
	const token = await prepareNativeMemoryErasure(userId, "erasing_workspace");
	if (!token) return;
	await purgeOwnedWorkspace(userId, token, false);
	// The cleared chats' and files' words leave the search index's pages too.
	compactSearchIndex();
}

async function purgeOwnedWorkspace(
	userId: string,
	token: string,
	keepErasing: boolean,
) {
	if (!ownsErasure(userId, token)) return;
	await cancelActiveAtlasJobsForUser(userId);
	// Clear Workspace does not quiesce first: stop the takes before their files go.
	await cancelImageTakesForUser(userId);
	await cancelVideoTakesForUser(userId);
	if (!ownsErasure(userId, token)) return;
	await deleteAllChatFilesForUser(userId);
	if (!ownsErasure(userId, token)) return;
	await deleteImageFilesForUser(userId);
	if (!ownsErasure(userId, token)) return;
	await deleteAtlasJobsForUser(userId);

	const ownershipScope = await getArtifactOwnershipScope(userId, {
		includeIncognito: true,
	});
	if (!ownsErasure(userId, token)) return;
	const artifactRows = db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(buildArtifactVisibilityCondition({ userId, ownershipScope }))
		.all();
	const artifactIds = artifactRows.map((row) => row.id);
	if (artifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, artifactIds);
	}

	if (!ownsErasure(userId, token)) return;
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	});

	db.transaction((tx) => {
		if (!ownsErasure(userId, token, tx)) return;
		deleteResetScopeRows(tx, userId, "workspace");
		if (!keepErasing) finishReset(tx, userId, token);
	});
}

/**
 * The self-service erasure refused because the account is the only admin: an
 * admin can no longer manage the app if they delete themselves. It is thrown by
 * the row-deleting transaction, so an identity delete that raced past the check
 * made before the purge still cannot remove the last admin.
 */
export class LastAdminAccountError extends Error {
	constructor() {
		super("The last admin account cannot be deleted.");
		this.name = "LastAdminAccountError";
	}
}

export interface EraseUserAccountDataOptions {
	/**
	 * Refuse to delete the last admin inside the delete transaction. Off by
	 * default: the admin panel's erasure path keeps its old behaviour.
	 */
	refuseLastAdmin?: boolean;
}

type AccountLifecycleTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

/**
 * True when `userId` is an admin and the only one. Role and admin count are read
 * in one transaction so a concurrent role change cannot split them.
 */
export async function isLastAdminAccount(userId: string): Promise<boolean> {
	return db.transaction((tx) => isLastAdminAccountIn(tx, userId));
}

function isLastAdminAccountIn(
	tx: AccountLifecycleTransaction,
	userId: string,
): boolean {
	const user = tx
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (user?.role !== "admin") return false;

	const admins = tx
		.select({ count: count(users.id) })
		.from(users)
		.where(eq(users.role, "admin"))
		.get();
	return Number(admins?.count ?? 0) <= 1;
}

/**
 * Full Account Erasure DB + filesystem sequence: quiesce running work, purge the
 * workspace, detach shared authorship, then delete the analytics rollups (no FK
 * cascade reaches them) AND the user row (whose cascade wipes everything else) in
 * one transaction, and finally remove the avatar file.
 */
export async function eraseUserAccountData(
	userId: string,
	options: EraseUserAccountDataOptions = {},
): Promise<void> {
	const token = await prepareNativeMemoryErasure(userId, "erasing_account");
	if (!token || !ownsErasure(userId, token)) return;
	await quiesceUserWorkspace(userId);
	await purgeOwnedWorkspace(userId, token, true);
	if (!ownsErasure(userId, token)) return;
	await detachSharedContentAuthorship(userId, token);
	if (!deleteUserRowAndExplicitAnalytics(userId, token, options)) return;
	// The erased person's words leave the search index's pages, not only its
	// answers (a deleted row's entries stay in the pages until they are merged).
	compactSearchIndex();

	await rm(join(process.cwd(), "data", "avatars", `${userId}.webp`), {
		force: true,
	});
}

/**
 * The one transaction that removes the user identity: delete the analytics
 * rollups that carry no FK to `users` (so the cascade never reaches them), then
 * delete the `users` row — whose `ON DELETE CASCADE` removes every remaining
 * user-scoped row. When the erasure asks for the last-admin guard, the same
 * invariant is re-checked here, before anything is deleted.
 */
function deleteUserRowAndExplicitAnalytics(
	userId: string,
	token: string,
	options: EraseUserAccountDataOptions = {},
) {
	return db.transaction((tx) => {
		if (!ownsErasure(userId, token, tx)) return false;
		if (options.refuseLastAdmin && isLastAdminAccountIn(tx, userId)) {
			throw new LastAdminAccountError();
		}
		for (const entry of explicitErasureTables()) {
			tx.delete(entry.table).where(eq(entry.userColumn, userId)).run();
		}
		tx.delete(users).where(eq(users.id, userId)).run();
		return true;
	});
}

async function detachSharedContentAuthorship(
	userId: string,
	token: string,
): Promise<void> {
	const detachedOwnerId = await resolveDetachedSharedContentOwnerId(userId);

	db.transaction((tx) => {
		if (!ownsErasure(userId, token, tx)) return;
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
	// File production and extraction are on the job engine: a job being produced or
	// parsed when erasure started is cancelled and its run told at once, instead of
	// storing a file, or a normalized artifact and its chunk rows, into an account
	// that asked to be forgotten.
	await cancelActiveFileProductionForUser(userId);
	await cancelActiveDocumentExtractionForUser(userId);
	// A take being rendered when erasure started stops at once and stores no
	// picture or clip into an account that asked to be forgotten.
	await cancelImageTakesForUser(userId);
	await cancelVideoTakesForUser(userId);
	await quiesceUserMemoryMaintenance(userId);
}
