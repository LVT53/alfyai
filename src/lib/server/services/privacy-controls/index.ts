import { rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	adminConfig,
	analyticsConversations,
	announcementCampaigns,
	announcementCampaignSnapshots,
	artifacts,
	campaignAssets,
	conversationContextStatus,
	conversationTaskStates,
	conversationWorkingSetItems,
	deepResearchJobs,
	fileProductionJobAttempts,
	fileProductionJobs,
	memoryDirtyLedger,
	memoryEvents,
	memoryProjectionState,
	memoryProjects,
	memoryProjectTaskLinks,
	memoryReworkTelemetry,
	memoryReviewItems,
	semanticEmbeddings,
	taskCheckpoints,
	taskStateEvidenceLinks,
	userSkillDefinitions,
	usageEvents,
	users,
} from "$lib/server/db/schema";
import { verifyPassword } from "../auth";
import {
	deleteAllHonchoStateForUser,
	rotateHonchoPeerIdentity,
} from "../honcho";
import { hardDeleteArtifactsForUser } from "../knowledge";
import { clearMessageEvidenceForUser } from "../messages";
import { purgeUserData } from "../cleanup/user-cleanup";
import { requestActiveChatStreamsStopForUser } from "../chat-turn/active-streams";
import { cancelRunningResearchTasks } from "../deep-research/tasks";
import { quiesceUserMemoryMaintenance } from "../memory-maintenance";
import { advanceMemoryResetGeneration } from "../memory-profile";

export const DETACHED_SHARED_CONTENT_OWNER_ID = "detached-shared-content-owner";
export const DETACHED_SHARED_CONTENT_OWNER_EMAIL =
	"detached-shared-content-owner@alfyai.local";
const ACTIVE_DEEP_RESEARCH_STATUSES = [
	"awaiting_plan",
	"awaiting_approval",
	"approved",
	"running",
] as const;
const ACTIVE_FILE_PRODUCTION_STATUSES = ["queued", "running"] as const;

export type PrivacyControlPasswordResult =
	| { status: "not_found" }
	| { status: "incorrect_password" };

export type ClearMemoryAndKnowledgeResult =
	| { status: "cleared"; deletedArtifactIds: string[] }
	| PrivacyControlPasswordResult;

export type ClearWorkspaceDataResult =
	| { status: "reset" }
	| PrivacyControlPasswordResult;

export type AccountErasureResult =
	| { status: "deleted" }
	| PrivacyControlPasswordResult;

export async function clearMemoryAndKnowledge(
	userId: string,
	password: string,
): Promise<ClearMemoryAndKnowledgeResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	const deletedArtifactIds = await clearMemoryAndKnowledgeForUser(userId);
	return { status: "cleared", deletedArtifactIds };
}

export async function clearWorkspaceData(
	userId: string,
	password: string,
): Promise<ClearWorkspaceDataResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	await quiesceUserWorkspace(userId);
	await purgeUserData(userId);
	await rotateHonchoPeerIdentity(userId);

	return { status: "reset" };
}

export async function eraseUserAccount(
	userId: string,
	password: string,
): Promise<AccountErasureResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return { status: "not_found" };
	}

	const valid = await verifyPassword(password, user.passwordHash);
	if (!valid) {
		return { status: "incorrect_password" };
	}

	await eraseUserAccountData(userId);
	return { status: "deleted" };
}

export async function eraseUserAccountAsAdmin(userId: string): Promise<boolean> {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return false;
	}

	await eraseUserAccountData(userId);
	return true;
}

async function eraseUserAccountData(userId: string): Promise<void> {
	await quiesceUserWorkspace(userId);
	await purgeUserData(userId);
	await detachSharedContentAuthorship(userId);

	await db.transaction((tx) => {
		tx.delete(usageEvents).where(eq(usageEvents.userId, userId)).run();
		tx.delete(analyticsConversations)
			.where(eq(analyticsConversations.userId, userId))
			.run();
		tx.delete(users).where(eq(users.id, userId)).run();
	});

	await rm(join(process.cwd(), "data", "avatars", `${userId}.webp`), {
		force: true,
	});
}

async function detachSharedContentAuthorship(userId: string): Promise<void> {
	const detachedOwnerId = await resolveDetachedSharedContentOwnerId(userId);

	await db.transaction((tx) => {
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

async function quiesceUserWorkspace(userId: string): Promise<void> {
	requestActiveChatStreamsStopForUser(userId);
	await cancelActiveDeepResearchForUser(userId);
	await cancelActiveFileProductionForUser(userId);
	await quiesceUserMemoryMaintenance(userId);
}

async function cancelActiveDeepResearchForUser(userId: string): Promise<void> {
	const now = new Date();
	const activeJobs = await db
		.select({ id: deepResearchJobs.id })
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				inArray(deepResearchJobs.status, ACTIVE_DEEP_RESEARCH_STATUSES),
			),
		);

	if (activeJobs.length === 0) return;

	await db
		.update(deepResearchJobs)
		.set({
			status: "cancelled",
			stage: "cancelled_by_request",
			cancelledAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				inArray(deepResearchJobs.status, ACTIVE_DEEP_RESEARCH_STATUSES),
			),
		);

	await Promise.all(
		activeJobs.map((job) =>
			cancelRunningResearchTasks({
				userId,
				jobId: job.id,
				reason: "Account Erasure cancelled active Deep Research work.",
				now,
			}),
		),
	);
}

async function cancelActiveFileProductionForUser(userId: string): Promise<void> {
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

	await db.transaction((tx) => {
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

async function clearMemoryAndKnowledgeForUser(
	userId: string,
): Promise<string[]> {
	await advanceMemoryResetGeneration(userId);
	await deleteAllHonchoStateForUser(userId);
	await rotateHonchoPeerIdentity(userId);

	const artifactRows = await db
		.select({ id: artifacts.id })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				ne(artifacts.type, "generated_output"),
			),
		);
	const deletedArtifactIds = artifactRows.map((row) => row.id).sort();

	if (deletedArtifactIds.length > 0) {
		await hardDeleteArtifactsForUser(userId, deletedArtifactIds);
	}

	await db.transaction((tx) => {
		tx.delete(taskStateEvidenceLinks)
			.where(eq(taskStateEvidenceLinks.userId, userId))
			.run();
		tx.delete(taskCheckpoints).where(eq(taskCheckpoints.userId, userId)).run();
		tx.delete(memoryProjectTaskLinks)
			.where(eq(memoryProjectTaskLinks.userId, userId))
			.run();
		tx.delete(conversationTaskStates)
			.where(eq(conversationTaskStates.userId, userId))
			.run();
		tx.delete(memoryProjects).where(eq(memoryProjects.userId, userId)).run();
		tx.delete(memoryEvents).where(eq(memoryEvents.userId, userId)).run();
		tx.delete(memoryProjectionState)
			.where(eq(memoryProjectionState.userId, userId))
			.run();
		tx.delete(memoryReviewItems)
			.where(eq(memoryReviewItems.userId, userId))
			.run();
		tx.delete(memoryDirtyLedger)
			.where(eq(memoryDirtyLedger.userId, userId))
			.run();
		tx.delete(memoryReworkTelemetry)
			.where(eq(memoryReworkTelemetry.userId, userId))
			.run();
		tx.delete(semanticEmbeddings)
			.where(eq(semanticEmbeddings.userId, userId))
			.run();
		tx.delete(conversationWorkingSetItems)
			.where(eq(conversationWorkingSetItems.userId, userId))
			.run();
		tx.delete(conversationContextStatus)
			.where(eq(conversationContextStatus.userId, userId))
			.run();
	});

	await clearMessageEvidenceForUser(userId);
	return deletedArtifactIds;
}
